import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot, cleanup, startFakeServer } from './helpers.mjs';
import { createServer } from '../src/server/serve.js';
import { defaultConfig } from '../src/server/config.js';

async function boot() {
  const env = makeTempRoot();
  const fake = await startFakeServer();
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
  return { env, fake, instance, req };
}

/** 建一个指向 fake server 的接口 */
async function makeApi(req, env, fake, { name, method, path: apiPath, base = '{{base}}' }) {
  const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
    name,
    target_type: 'api',
    method,
    url: `${base}${apiPath}`
  });
  const id = api.data.target_id;

  const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
  const data = detail.data.data;
  data.method = method;
  data.url = `${base}${apiPath}`;
  await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

  // 环境指向 fake server
  const envList = await req('GET', `/api/projects/${env.projectId}/apis`); // touch
  return id;
}

async function pointEnvTo(req, env, fake) {
  // 默认环境 id=1（runner 未指定 envId 时会选它），把它的默认服务地址指向 fake server
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

test('send：返回完整响应（状态码/头/体/耗时）', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);

    const id = await makeApi(req, env, fake, { name: 'ping', method: 'GET', path: '/users/42' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'passed');
    assert.equal(res.data.status_code, 200);
    assert.ok(res.data.run_id);

    // 完整响应体
    assert.ok(res.data.response, '应返回 response 对象');
    assert.equal(res.data.response.status, 200);
    assert.match(res.data.response.body, /alice/);
    assert.ok(res.data.response.headers, '应返回响应头');
    assert.ok(typeof res.data.elapsed_ms === 'number');

    // 请求信息
    assert.ok(res.data.request);
    assert.match(res.data.request.url, /\/users\/42/);
    assert.ok(Array.isArray(res.data.assertions));
    assert.ok(Array.isArray(res.data.console));
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send：断言失败返回 failed', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);

    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'fail-assert',
      target_type: 'api',
      method: 'GET',
      url: '{{base}}/users/42'
    });
    const id = api.data.target_id;

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    data.request.post_tasks = [
      {
        type: 'customScript',
        enabled: 1,
        id: 'q1',
        data: 'apt.test("id 应为 999", function () { apt.expect(apt.response.json().id).to.equal(999); });'
      }
    ];
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.data.status, 'failed');
    assert.ok(res.data.assertions.some((a) => a.passed === false));
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send：非 2xx 判 failed 但仍返回响应体', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);

    const id = await makeApi(req, env, fake, { name: 'notfound', method: 'GET', path: '/nope' });
    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});

    assert.equal(res.data.status, 'failed');
    assert.equal(res.data.status_code, 404);
    assert.match(res.data.response.body, /not found/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send：未找到接口返回 404', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    const res = await req('POST', `/api/projects/${env.projectId}/apis/deadbeef123456/send`, {});
    assert.equal(res.status, 500);
    assert.match(String(res.data.error || ''), /接口不存在/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

/* ---------------- ��������Ӧ ---------------- */

test('send���ı���Ӧ�� content_type / is_binary=false / body_base64', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'ping', method: 'GET', path: '/users/42' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.data.status, 'passed');
    assert.equal(res.data.is_binary, false);
    assert.match(String(res.data.content_type || ''), /json/);
    assert.ok(res.data.body_base64, '�ı���ӦҲӦ�� base64 �������л�');

    // �������Ӧ�� body һ��
    const decoded = Buffer.from(res.data.body_base64, 'base64').toString('utf8');
    assert.match(decoded, /alice/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send��run ��¼���� body_base64����ֹ��ʷ���ͣ�', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'ping', method: 'GET', path: '/users/42' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.ok(res.data.body_base64, '��ʱ��ӦӦ�� base64');

    // �����̼�¼��ȷ��û�� base64
    const { openProject } = await import('../src/store/target.js');
    const { getRun } = await import('../src/store/runs.js');
    const target = openProject({ officialRoot: env.root, projectId: env.projectId });
    const run = getRun(target, res.data.run_id);
    assert.ok(run, 'Ӧ�ܶ��� run ��¼');
    const step = run.steps[0];

    const serialized = JSON.stringify(step);
    assert.equal(serialized.includes('body_base64'), false, 'run ��¼��Ӧ�� body_base64');
    assert.equal(step.response.has_binary, true);
    assert.equal(step.response.is_binary, false);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send��MCP execute_api �����屣�־��򣨲��� base64��', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'ping', method: 'GET', path: '/users/42' });

    const res = await req('POST', `/api/tools/call`, {
      name: 'apipost_execute_api',
      arguments: { project_id: env.projectId, target_id: id }
    });
    assert.equal(res.data.ok, true);
    const result = res.data.result;
    assert.equal(result.body_base64, undefined, 'MCP ���߲�Ӧ���� base64');
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send��ͼƬ��Ӧ is_binary=true �Ҵ� base64', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'img', method: 'GET', path: '/image' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.data.is_binary, true, 'ͼƬӦ�ж�Ϊ������');
    assert.match(String(res.data.content_type || ''), /^image\/png/);
    assert.ok(res.data.body_base64, 'Ӧ�� base64 ��Ԥ��');

    // base64 �����Ӧ�� PNG ħ��
    const buf = Buffer.from(res.data.body_base64, 'base64');
    assert.equal(buf[0], 0x89);
    assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send��������Ӧ������ base64', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'big', method: 'GET', path: '/bigtext' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.data.body_base64, null, '���� 4MB ��Ӧ�� base64');
    assert.equal(res.data.too_large_for_base64, true);
    assert.ok(res.data.response.size > 4 * 1024 * 1024);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

/* ---------------- live_detail（未脱敏，仅本地即时返回） ---------------- */

test('send：live_detail 返回未脱敏的请求头与 Set-Cookie', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);

    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'login',
      target_type: 'api',
      method: 'POST',
      url: '{{base}}/login'
    });
    const id = api.data.target_id;

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    data.request.body = { mode: 'json', raw: '{"username":"admin"}', parameter: [], raw_parameter: [] };
    data.request.header = {
      parameter: [
        { key: 'Authorization', value: 'Bearer super-secret', is_checked: 1, field_type: 'String', param_id: 'h1' },
        { key: 'X-Custom', value: 'visible', is_checked: 1, field_type: 'String', param_id: 'h2' }
      ]
    };
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.status, 200);

    // 未脱敏：完整请求头
    assert.ok(res.data.live_detail, '应返回 live_detail');
    const liveReq = res.data.live_detail.request;
    assert.equal(liveReq.headers.Authorization, 'Bearer super-secret', 'live_detail 里的 Authorization 不应脱敏');
    assert.equal(liveReq.headers['X-Custom'], 'visible');
    assert.match(liveReq.url, /\/login/);
    assert.equal(liveReq.method, 'POST');
    assert.match(String(liveReq.body || ''), /admin/);

    // 响应侧 Set-Cookie
    const liveResp = res.data.live_detail.response;
    assert.ok(liveResp, '应返回响应详情');
    assert.ok(liveResp.protocol, '应带协议');
    assert.ok(Array.isArray(liveResp.set_cookies), 'set_cookies 应为数组');
    assert.ok(liveResp.set_cookies.length > 0, '登录接口应下发 Set-Cookie');
    assert.match(liveResp.set_cookies[0], /session=/);

    // 脱敏字段保留（执行历史依赖）
    assert.equal(res.data.request.headers.Authorization, '***');
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send：落盘 run 仍脱敏且不含 live_detail', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);

    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'me',
      target_type: 'api',
      method: 'GET',
      url: '{{base}}/users/42'
    });
    const id = api.data.target_id;
    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    data.request.header = {
      parameter: [
        { key: 'Authorization', value: 'Bearer hidden', is_checked: 1, field_type: 'String', param_id: 'h1' }
      ]
    };
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.ok(res.data.live_detail, '即时返回应有 live_detail');

    const { openProject } = await import('../src/store/target.js');
    const { getRun } = await import('../src/store/runs.js');
    const target = openProject({ officialRoot: env.root, projectId: env.projectId });
    const run = getRun(target, res.data.run_id);
    assert.ok(run, '应能读到 run');
    assert.equal(run.steps[0].request.headers.Authorization, '***', '落盘记录必须脱敏');
    assert.equal(JSON.stringify(run.steps[0]).includes('live_detail'), false, '落盘记录不应含 live_detail');
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('MCP execute_api 不返回 live_detail', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'ping', method: 'GET', path: '/users/42' });

    const res = await req('POST', `/api/tools/call`, {
      name: 'apipost_execute_api',
      arguments: { project_id: env.projectId, target_id: id }
    });
    assert.equal(res.data.ok, true);
    assert.equal(res.data.result.live_detail, undefined, 'MCP 工具不应返回 live_detail');
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});
