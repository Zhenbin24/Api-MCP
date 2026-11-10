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
    token: 'test-token',
    ui_token: 'test-ui',
    port: 0,
    data_root: env.root,
    shadow_root: env.shadow,
    allowed_project_ids: []
  };
  const instance = createServer({ config, officialRoot: env.root, shadowRoot: env.shadow });
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
  const { openShadow } = await import('../src/store/shadow.js');
  const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    const id = await makeApi(req, env, { url: 'https://api.test/y' });

    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, { name: 'A' });
    await req('POST', `/api/projects/${env.projectId}/apis/${id}/cases`, { name: 'B' });

    // 直接读影子文件确认存在 data.cases
    const { openShadow } = await import('../src/store/shadow.js');
    const { readApiFile } = await import('../src/store/apis.js');
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
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
    await req('POST', `/api/projects/${env.projectId}/pull`, {});

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
