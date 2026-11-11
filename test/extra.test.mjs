import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot, cleanup, startFakeServer } from './helpers.mjs';
import { createServer } from '../src/server/serve.js';
import { defaultConfig } from '../src/server/config.js';

async function boot({ withFake = true } = {}) {
  const env = makeTempRoot();
  const fake = withFake ? await startFakeServer() : { url: '', calls: [], close: async () => {} };
  const config = {
    ...defaultConfig(),
    enabled: true,
    token: 'test-token',
    ui_token: 'test-ui',
    port: 0,
    data_root: env.root,
    allowed_project_ids: []
  };
  const instance = createServer({ config, officialRoot: env.root });
  const address = await instance.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'X-UI-Token': 'test-ui', 'Content-Type': 'application/json' };
  const req = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
  return { env, fake, instance, req, base };
}

async function pointEnv(req, env, fake) {
  const { openProject } = await import('../src/store/target.js');
  const target = openProject({ officialRoot: env.root, projectId: env.projectId });
  for (const envId of ['1', '2503d4840ac010']) {
    const file = target.readJson(`project/envs/${envId}.json`, null);
    if (!file) continue;
    file.server_list = [{ name: 'default', server_id: '1', sort: 1000, uri: fake.url }];
    file.env_var_list = { ...(file.env_var_list || {}), base: { value: fake.url } };
    target.writeJson(`project/envs/${envId}.json`, file);
  }
}

async function makeApi(req, env, { name = 'test', method = 'GET', url }) {
  const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
    name,
    target_type: 'api',
    method,
    url
  });
  return api.data.target_id;
}

/* ================= 接口用例 ================= */

test('用例：增删改查', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: 'https://api.test/x' });

    const empty = await req('GET', `/api/projects/${env.projectId}/apis/${id}/cases`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data.cases, []);

    const created = await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, {
      name: '正常用例',
      expect_status: '200',
      input: { query: { page: '1' } }
    });
    assert.equal(created.data.ok, true);
    assert.ok(created.data.case.case_id);
    assert.equal(created.data.total, 1);

    const caseId = created.data.case.case_id;

    const updated = await req('PUT', `/api/projects/${env.projectId}/apis/${id}/cases/${caseId}`, {
      case: { ...created.data.case, name: '改名后', expect_status: '201' }
    });
    assert.equal(updated.data.case.name, '改名后');
    assert.equal(updated.data.case.expect_status, '201');

    const list = await req('GET', `/api/projects/${env.projectId}/apis/${id}/cases`);
    assert.equal(list.data.cases.length, 1);
    assert.equal(list.data.cases[0].name, '改名后');

    const del = await req('DELETE', `/api/projects/${env.projectId}/apis/${id}/cases/${caseId}`);
    assert.equal(del.data.deleted, true);
    assert.equal(del.data.total, 0);

    const after = await req('GET', `/api/projects/${env.projectId}/apis/${id}/cases`);
    assert.equal(after.data.cases.length, 0);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('用例：随接口文件持久化（保存后重新读取仍在）', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: 'https://api.test/y' });

    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, { name: 'A' });
    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, { name: 'B' });

    // 直接读工作区文件确认存在 data.cases
    const { openProject } = await import('../src/store/target.js');
    const { readApiFile } = await import('../src/store/apis.js');
    const target = openProject({ officialRoot: env.root, projectId: env.projectId });
    const file = readApiFile(target, id);
    assert.ok(Array.isArray(file.data.cases));
    assert.equal(file.data.cases.length, 2);
    assert.deepEqual(file.data.cases.map((c) => c.name), ['A', 'B']);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('用例：批量执行并校验期望', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);

    const id = await makeApi(req, env, { url: '{{base}}/users/42', name: 'ping' });

    // 期望 200 + 包含 alice -> 通过
    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, {
      name: '正常',
      expect_status: '200',
      expect_body_contains: 'alice'
    });
    // 期望 500 -> 失败
    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, {
      name: '期望错误状态码',
      expect_status: '500'
    });

    const run = await req('POST', `/api/projects/${env.projectId}/cases/run`, { target_id: id });
    assert.equal(run.status, 200);
    assert.equal(run.data.total, 2);
    assert.equal(run.data.passed, 1);
    assert.equal(run.data.failed, 1);

    const okCase = run.data.results.find((r) => r.name === '正常');
    assert.equal(okCase.passed, true);
    assert.equal(okCase.status_code, 200);

    const badCase = run.data.results.find((r) => r.name === '期望错误状态码');
    assert.equal(badCase.passed, false);
    assert.match(badCase.message || '', /期望状态码 500/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('用例：只执行启用的用例', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/users/42' });

    const a = await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, { name: '启用' });
    const b = await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, { name: '禁用' });
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}/cases/${b.data.case.case_id}`, {
      case: { ...b.data.case, enabled: 0 }
    });

    const run = await req('POST', `/api/projects/${env.projectId}/cases/run`, { target_id: id });
    assert.equal(run.data.total, 1);
    assert.equal(run.data.results[0].name, '启用');
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('用例：项目级汇总', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const a = await makeApi(req, env, { url: 'https://api.test/a', name: '接口A' });
    const b = await makeApi(req, env, { url: 'https://api.test/b', name: '接口B' });

    await req('POST', `/api/projects/${env.projectId}/apis/${a}/cases`, { name: 'A1' });
    await req('POST', `/api/projects/${env.projectId}/apis/${b}/cases`, { name: 'B1' });
    await req('POST', `/api/projects/${env.projectId}/apis/${b}/cases`, { name: 'B2' });

    const all = await req('GET', `/api/projects/${env.projectId}/cases`);
    assert.equal(all.data.cases.length, 3);
    assert.ok(all.data.cases.every((c) => c.api_name && c.target_id));
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

/* ================= 压测 ================= */

test('压测：按轮次执行并统计', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/users/42', name: 'ping' });

    const res = await req('POST', `/api/projects/${env.projectId}/stress`, {
      target_id: id,
      concurrency: 2,
      mode: 'rounds',
      rounds: 6,
      run_assertions: true
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.total, 6);
    assert.equal(res.data.success, 6);
    assert.equal(res.data.failed, 0);
    assert.equal(res.data.success_rate, 100);
    assert.ok(res.data.latency.p50 >= 0);
    assert.ok(res.data.latency.p99 >= 0);
    assert.ok(res.data.qps >= 0);
    assert.equal(res.data.concurrency, 2);
    assert.equal(res.data.mode, 'rounds');
    assert.equal(res.data.rounds, 6);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('压测：按持续时长执行', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/users/42' });

    const res = await req('POST', `/api/projects/${env.projectId}/stress`, {
      target_id: id,
      concurrency: 1,
      mode: 'duration',
      duration_ms: 1200,
      run_assertions: false
    });

    assert.equal(res.data.ok, true);
    assert.ok(res.data.total >= 1, '至少跑一次');
    assert.equal(res.data.mode, 'duration');
    assert.ok(res.data.elapsed_ms >= 1000);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('压测：失败请求计入 failed', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/nope', name: '404接口' });

    const res = await req('POST', `/api/projects/${env.projectId}/stress`, {
      target_id: id,
      concurrency: 1,
      mode: 'rounds',
      rounds: 3,
      run_assertions: true
    });

    assert.equal(res.data.total, 3);
    assert.equal(res.data.failed, 3);
    assert.equal(res.data.success_rate, 0);
    assert.equal(res.data.status_codes['404'], 3);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('压测：非 HTTP 接口被拒绝', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const folder = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '目录',
      target_type: 'folder'
    });
    const res = await req('POST', `/api/projects/${env.projectId}/stress`, {
      target_id: folder.data.target_id,
      concurrency: 1,
      rounds: 1
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /压测仅支持 HTTP 接口/);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

/* ================= Mock ================= */

test('Mock：配置读写', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: 'https://api.test/mockme', name: 'mock接口' });

    const empty = await req('GET', `/api/projects/${env.projectId}/apis/${id}/mock`);
    assert.equal(empty.status, 200);
    assert.equal(empty.data.mock, null);

    const put = await req('PUT', `/api/projects/${env.projectId}/apis/${id}/mock`, {
      enabled: true,
      status: '201',
      delay_ms: 50,
      schema: {
        type: 'object',
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
        APIPOST_ORDERS: ['id', 'name']
      }
    });
    assert.equal(put.status, 200);
    assert.equal(put.data.mock.enabled, 1);
    assert.equal(put.data.mock.status, '201');
    assert.equal(put.data.mock.delay_ms, 50);

    const got = await req('GET', `/api/projects/${env.projectId}/apis/${id}/mock`);
    assert.equal(got.data.mock.enabled, 1);
    assert.equal(got.data.mock.schema.properties.id.type, 'integer');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('Mock：schema 生成样例数据', async () => {
  const { generateFromSchema } = await import('../src/server/mock.js');
  const sample = generateFromSchema({
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string', description: 'userName' },
      tags: { type: 'array', items: { type: 'string' } },
      nested: { type: 'object', properties: { ok: { type: 'boolean' } } }
    },
    APIPOST_ORDERS: ['id', 'name', 'tags', 'nested']
  });

  assert.equal(typeof sample.id, 'number');
  assert.equal(typeof sample.name, 'string');
  assert.ok(Array.isArray(sample.tags));
  assert.equal(typeof sample.nested.ok, 'boolean');
});

test('Mock：本地服务真实响应', async () => {
  const { env, instance, req, base } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: '/mock/demo', name: 'demo' });

    await req('PUT', `/api/projects/${env.projectId}/apis/${id}/mock`, {
      enabled: true,
      status: '200',
      schema: {
        type: 'object',
        properties: { code: { type: 'integer' }, msg: { type: 'string' } },
        APIPOST_ORDERS: ['code', 'msg']
      }
    });

    const port = await instance.startMock(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mock/demo`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.code, 'number');
      assert.equal(typeof body.msg, 'string');
      assert.equal(res.headers.get('x-mock-from'), 'api-mcp');
    } finally {
      await instance.stopMock();
    }
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('Mock：未启用的接口不响应', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: '/mock/disabled' });
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}/mock`, { enabled: false });

    const port = await instance.startMock(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mock/disabled`);
      assert.equal(res.status, 404);
    } finally {
      await instance.stopMock();
    }
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('Mock：自定义状态码与延迟生效', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: '/mock/slow' });
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}/mock`, {
      enabled: true,
      status: '503',
      delay_ms: 120,
      schema: { type: 'object', properties: {}, APIPOST_ORDERS: [] }
    });

    const port = await instance.startMock(0);
    try {
      const start = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/mock/slow`);
      const elapsed = Date.now() - start;
      assert.equal(res.status, 503);
      assert.ok(elapsed >= 100, `延迟应生效，实际 ${elapsed}ms`);
    } finally {
      await instance.stopMock();
    }
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('Mock：路径参数匹配', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: '/mock/users/{id}' });
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}/mock`, {
      enabled: true,
      schema: { type: 'object', properties: { id: { type: 'integer' } }, APIPOST_ORDERS: ['id'] }
    });

    const port = await instance.startMock(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mock/users/42`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.id, 'number');
    } finally {
      await instance.stopMock();
    }
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('Mock：服务管理端点', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {

    // 先确保是停止状态
    await req('POST', '/api/mock-server/stop', {});

    const before = await req('GET', '/api/mock-server');
    assert.equal(before.status, 200);
    assert.equal(Boolean(before.data.running), false, `初始应为停止，实际 ${JSON.stringify(before.data)}`);

    const started = await req('POST', '/api/mock-server/start', { port: 0 });
    assert.equal(started.status, 200);
    assert.equal(started.data.ok, true);
    assert.ok(started.data.port > 0);

    const after = await req('GET', '/api/mock-server');
    assert.equal(Boolean(after.data.running), true);
    assert.equal(after.data.port, started.data.port);

    await req('POST', '/api/mock-server/stop', {});
    const stopped = await req('GET', '/api/mock-server');
    assert.equal(Boolean(stopped.data.running), false);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

/* ================= 数据域隔离与展示补齐 ================= */

test('PUT /apis/:id 支持 preserve_aux：保护 cases 与 mock', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: 'https://api.test/keep' });

    // 先写用例与 Mock
    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, {
      name: '保护用例',
      expect_status: '200'
    });
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}/mock`, {
      enabled: true,
      status: '201',
      content_type: 'text/plain',
      body: 'hello',
      headers: { 'X-Trace': 'abc' }
    });

    // 模拟设计页签保存：只带设计字段，并要求保护附属数据
    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    // 故意用过期快照覆盖：把 cases / mock 清空
    data.cases = [];
    data.mock = null;
    data.name = '设计改名';
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data, preserve_aux: true });

    const after = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    assert.equal(after.data.data.name, '设计改名', '设计字段应已更新');
    assert.equal(after.data.data.cases.length, 1, '用例不应被旧快照覆盖');
    assert.equal(after.data.data.mock.status, '201', 'Mock 不应被旧快照覆盖');
    assert.equal(after.data.data.mock.headers['X-Trace'], 'abc');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('PUT /apis/:id 不带 preserve_aux 时仍可覆盖附属数据', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: 'https://api.test/overwrite' });
    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, { name: '会被覆盖' });

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    data.cases = [];
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

    const after = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    assert.equal(after.data.data.cases.length, 0);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('用例：expect_content_type 校验', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/users/42' });

    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, {
      name: '类型命中',
      expect_content_type: 'application/json'
    });
    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, {
      name: '类型不符',
      expect_content_type: 'text/xml'
    });

    const run = await req('POST', `/api/projects/${env.projectId}/cases/run`, { target_id: id });
    const ok = run.data.results.find((r) => r.name === '类型命中');
    const bad = run.data.results.find((r) => r.name === '类型不符');
    assert.equal(ok.passed, true);
    assert.equal(bad.passed, false);
    assert.match(bad.message || '', /Content-Type/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('用例：expect_headers 校验（命中 / 缺失 / 值不符）', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/users/42' });

    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, {
      name: '头命中',
      expect_headers: { 'Content-Type': 'json' }
    });
    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, {
      name: '头缺失',
      expect_headers: { 'X-Not-Exist': 'x' }
    });
    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, {
      name: '头值不符',
      expect_headers: { 'Content-Type': 'xml' }
    });

    const run = await req('POST', `/api/projects/${env.projectId}/cases/run`, { target_id: id });
    const ok = run.data.results.find((r) => r.name === '头命中');
    const missing = run.data.results.find((r) => r.name === '头缺失');
    const mismatch = run.data.results.find((r) => r.name === '头值不符');

    assert.equal(ok.passed, true);
    assert.equal(missing.passed, false);
    assert.match(missing.message || '', /缺少响应头/);
    assert.equal(mismatch.passed, false);
    assert.match(mismatch.message || '', /期望包含 xml/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('用例：执行结果带 request / response，响应体截断到 20KB', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/bigtext', name: 'big' });

    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, { name: '大响应' });

    const run = await req('POST', `/api/projects/${env.projectId}/cases/run`, { target_id: id });
    const result = run.data.results[0];
    assert.ok(result.request, '应带请求详情');
    assert.ok(result.request.url, '请求应带实际 URL');
    assert.ok(result.response, '应带响应详情');
    assert.ok(result.response.headers, '响应应带响应头');
    assert.equal(result.response.truncated, true, '超过 20KB 应标记截断');
    assert.ok(result.response.body.length <= 20 * 1024);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('压测：返回 progress_timeline', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/users/42' });

    const res = await req('POST', `/api/projects/${env.projectId}/stress`, {
      target_id: id,
      concurrency: 1,
      mode: 'rounds',
      rounds: 5,
      run_assertions: false
    });
    assert.ok(Array.isArray(res.data.progress_timeline), '应返回 progress_timeline');
    assert.ok(res.data.progress_timeline.length >= 1);
    const last = res.data.progress_timeline[res.data.progress_timeline.length - 1];
    assert.equal(last.done, res.data.total);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('Mock：自定义 headers / body / content_type 生效', async () => {
  const { env, instance, req } = await boot({ withFake: false });
  try {
    const id = await makeApi(req, env, { url: '/mock/custom', name: 'custom' });

    const saved = await req('PUT', `/api/projects/${env.projectId}/apis/${id}/mock`, {
      enabled: true,
      status: '202',
      content_type: 'text/plain; charset=utf-8',
      body: 'plain-body',
      headers: { 'X-Custom': 'yes' }
    });
    assert.equal(saved.data.mock.content_type, 'text/plain; charset=utf-8');
    assert.equal(saved.data.mock.body, 'plain-body');
    assert.equal(saved.data.mock.headers['X-Custom'], 'yes');

    const port = await instance.startMock(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mock/custom`);
      assert.equal(res.status, 202);
      assert.equal(res.headers.get('x-custom'), 'yes');
      assert.match(String(res.headers.get('content-type')), /text\/plain/);
      assert.equal(await res.text(), 'plain-body');
    } finally {
      await instance.stopMock();
    }
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('设计-响应：expect.headers 与 content_type 在执行时生效', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/users/42' });

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    data.response.is_check_result = 1;
    data.response.example = [
      {
        example_id: 'e1',
        expect: {
          code: '200',
          name: '成功',
          is_default: 1,
          verify_type: 'schema',
          content_type: 'json',
          headers: { 'Content-Type': 'json' },
          schema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }, required: ['id'] }
        },
        raw: '{}',
        raw_parameter: []
      }
    ];
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.status, 200);
    const names = (res.data.assertions || []).map((a) => a.name).join(' | ');
    assert.match(names, /响应结构校验/, `应有结构校验，实际：${names}`);
    assert.match(names, /状态码校验/, `应有状态码校验，实际：${names}`);
    assert.match(names, /响应头校验（Content-Type）/, `应有响应头校验，实际：${names}`);
    assert.match(names, /Content-Type 校验/, `应有 Content-Type 校验，实际：${names}`);
    assert.ok((res.data.assertions || []).every((a) => a.passed !== false), '全部断言应通过');
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('设计-响应：verify_type=code 时不跑结构校验', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnv(req, env, fake);
    const id = await makeApi(req, env, { url: '{{base}}/users/42' });

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    data.response.is_check_result = 1;
    data.response.example = [
      {
        example_id: 'e1',
        expect: {
          code: '200',
          name: '仅状态码',
          is_default: 1,
          verify_type: 'code',
          // 故意给一个不可能通过的 schema
          schema: { type: 'object', properties: { nonexistent: { type: 'string' } }, required: ['nonexistent'] }
        },
        raw: '{}',
        raw_parameter: []
      }
    ];
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    const names = (res.data.assertions || []).map((a) => a.name).join(' | ');
    assert.equal(names.includes('响应结构校验'), false, 'verify_type=code 不应做结构校验');
    assert.match(names, /状态码校验/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});
