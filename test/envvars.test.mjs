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
  const instance = createServer({ config, dataRoot: env.root });
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
  const close = async () => {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  };
  return { env, fake, instance, req, close };
}

test('环境端点：列表 / 新建 / 改名 / 切换当前 / 删除', async () => {
  const { env, req, close } = await boot();
  try {
    const base = `/api/projects/${env.projectId}`;

    // 列表：两个环境，current 默认是 env_id=1
    let list = await req('GET', `${base}/environments`);
    assert.equal(list.status, 200);
    assert.equal(list.data.environments.length, 2);
    assert.equal(list.data.current_env_id, '1');
    assert.ok(Array.isArray(list.data.environments[0].variables));
    assert.ok(Array.isArray(list.data.environments[0].servers));
    assert.ok(Array.isArray(list.data.global_vars));

    // 新建
    const created = await req('POST', `${base}/environments`, { name: '预发', base_url: 'https://pre.example.com' });
    assert.equal(created.status, 200);
    const newId = created.data.environment.env_id;
    assert.equal(created.data.environment.base_url, 'https://pre.example.com');

    // 改名 + 改地址
    const updated = await req('PUT', `${base}/environments/${newId}`, { name: '预发2', base_url: 'https://pre2.example.com' });
    assert.equal(updated.data.environment.name, '预发2');
    assert.equal(updated.data.environment.base_url, 'https://pre2.example.com');

    // 切换当前环境
    const switched = await req('POST', `${base}/environments/current`, { environment_id: newId });
    assert.equal(switched.data.current_env_id, newId);
    list = await req('GET', `${base}/environments`);
    assert.equal(list.data.current_env_id, newId);
    assert.equal(list.data.environments.find((e) => e.env_id === newId).is_current, true);

    // 删除
    const removed = await req('DELETE', `${base}/environments/${newId}`);
    assert.equal(removed.data.deleted, true);
    list = await req('GET', `${base}/environments`);
    assert.ok(!list.data.environments.some((e) => e.env_id === newId));
  } finally {
    await close();
  }
});

test('环境端点：默认环境不可删除；整表保存变量与单条增删', async () => {
  const { env, req, close } = await boot();
  try {
    const base = `/api/projects/${env.projectId}`;
    const envId = '2503d4840ac010';

    const deny = await req('DELETE', `${base}/environments/1`);
    assert.equal(deny.status, 500);
    assert.match(String(deny.data.error), /默认环境不可删除/);

    // 整表保存
    const saved = await req('PUT', `${base}/environments/${envId}/variables`, {
      variables: [
        { key: 'host', value: 'http://a.example', description: '主机' },
        { key: 'token', value: 'abc' }
      ]
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.variables.length, 2);

    // 整表替换：旧的被清掉
    const replaced = await req('PUT', `${base}/environments/${envId}/variables`, {
      variables: [{ key: 'only', value: '1' }]
    });
    assert.deepEqual(replaced.data.variables.map((v) => v.key), ['only']);

    // 单条 upsert
    const upsert = await req('POST', `${base}/environments/${envId}/variables`, { key: 'token', value: 'xyz', current_value: 'xyz' });
    assert.equal(upsert.data.variable.value, 'xyz');

    // 单条删除
    const del = await req('DELETE', `${base}/environments/${envId}/variables/token`);
    assert.equal(del.data.deleted, true);
    const after = await req('GET', `${base}/environments/${envId}/variables`);
    assert.ok(!after.data.variables.some((v) => v.key === 'token'));
  } finally {
    await close();
  }
});

test('共享服务端点：新增 / 改环境地址 / 改名 / 删除', async () => {
  const { env, req, close } = await boot();
  try {
    const base = `/api/projects/${env.projectId}`;
    const envId = '2503d4840ac010';

    const created = await req('POST', `${base}/servers`, {
      name: '用户服务',
      environment_id: envId,
      base_url: 'http://user.example'
    });
    assert.equal(created.status, 200);
    const serverId = created.data.server.server_id;
    assert.ok(serverId !== '1');

    // 列表带该环境地址
    const listed = await req('GET', `${base}/servers?environment_id=${envId}`);
    const row = listed.data.servers.find((s) => s.server_id === serverId);
    assert.equal(row.base_url, 'http://user.example');
    assert.equal(row.name, '用户服务');

    // 改该环境地址
    const updated = await req('PUT', `${base}/servers/${serverId}`, {
      environment_id: envId,
      base_url: 'http://user2.example'
    });
    assert.equal(updated.status, 200);

    // 改名
    await req('PUT', `${base}/servers/${serverId}`, { name: '用户中心' });
    const listed2 = await req('GET', `${base}/servers`);
    assert.equal(listed2.data.servers.find((s) => s.server_id === serverId).name, '用户中心');

    // 删除
    const removed = await req('DELETE', `${base}/servers/${serverId}`);
    assert.equal(removed.data.deleted, true);
    const listed3 = await req('GET', `${base}/servers`);
    assert.ok(!listed3.data.servers.some((s) => s.server_id === serverId));
  } finally {
    await close();
  }
});

test('全局参数端点：GET 默认结构 / PUT 局部更新 / 参数项归一', async () => {
  const { env, req, close } = await boot();
  try {
    const base = `/api/projects/${env.projectId}`;

    const initial = await req('GET', `${base}/global-params`);
    assert.equal(initial.status, 200);
    assert.equal(initial.data.params.auth.type, 'noauth');
    assert.deepEqual(initial.data.params.header.parameter, []);

    // 只改 header，不动其他 section
    const put = await req('PUT', `${base}/global-params`, {
      params: { header: [{ key: 'X-Tenant', value: 'acme' }] }
    });
    assert.equal(put.status, 200);
    const params = put.data.params;
    assert.equal(params.header.parameter.length, 1);
    assert.equal(params.header.parameter[0].key, 'X-Tenant');
    // 归一化补齐字段
    assert.equal(params.header.parameter[0].is_checked, 1);
    assert.equal(params.header.parameter[0].field_type, 'String');
    assert.ok(params.header.parameter[0].param_id);

    // body 模式限制
    const bodyPut = await req('PUT', `${base}/global-params`, {
      params: { body: { mode: 'raw', parameter: [{ key: 'a', value: '1' }] } }
    });
    assert.equal(bodyPut.data.params.body.mode, 'none', 'raw 不允许作为全局 body');

    const formPut = await req('PUT', `${base}/global-params`, {
      params: { body: { mode: 'urlencoded', parameter: [{ key: 'a', value: '1' }] } }
    });
    assert.equal(formPut.data.params.body.mode, 'urlencoded');
    assert.equal(formPut.data.params.body.parameter[0].key, 'a');
    // header 仍然保留
    assert.equal(formPut.data.params.header.parameter.length, 1);

    // query 清空
    await req('PUT', `${base}/global-params`, { params: { query: [{ key: 'q', value: '1' }] } });
    const cleared = await req('PUT', `${base}/global-params`, { params: { query: [] } });
    assert.equal(cleared.data.params.query.parameter.length, 0);
  } finally {
    await close();
  }
});

test('全局变量端点：列表 / upsert / 删除', async () => {
  const { env, req, close } = await boot();
  try {
    const base = `/api/projects/${env.projectId}`;

    const before = await req('GET', `${base}/global-vars`);
    const beforeKeys = before.data.variables.map((v) => v.key);
    assert.ok(beforeKeys.includes('shared'));

    const up = await req('POST', `${base}/global-vars`, { key: 'num', value: '1000', description: '编号' });
    assert.equal(up.data.variable.value, '1000');

    const after = await req('GET', `${base}/global-vars`);
    const row = after.data.variables.find((v) => v.key === 'num');
    assert.equal(row.value, '1000');
    assert.equal(row.current_value, '1000');
    assert.equal(row.description, '编号');

    const del = await req('DELETE', `${base}/global-vars/num`);
    assert.equal(del.data.deleted, true);
    const final = await req('GET', `${base}/global-vars`);
    assert.ok(!final.data.variables.some((v) => v.key === 'num'));
  } finally {
    await close();
  }
});

test('环境与变量：写全局 header 后发送请求真的带上，且环境切换生效', async () => {
  const { env, fake, req, close } = await boot();
  try {
    const base = `/api/projects/${env.projectId}`;

    // 环境指向 fake server
    await req('PUT', `${base}/environments/2503d4840ac010`, { base_url: fake.url });
    await req('POST', `${base}/environments/current`, { environment_id: '2503d4840ac010' });
    // base 变量也要指过去（接口 URL 用 {{base}}）
    await req('POST', `${base}/environments/2503d4840ac010/variables`, { key: 'base', value: fake.url });

    // 全局 header + 全局变量
    await req('PUT', `${base}/global-params`, {
      params: { header: [{ key: 'X-Tenant', value: '{{tenant}}' }] }
    });
    await req('POST', `${base}/global-vars`, { key: 'tenant', value: 'acme' });

    // 建一个 GET /query 接口
    const created = await req('POST', `${base}/apis`, {
      name: '查询',
      target_type: 'api',
      method: 'GET',
      url: '{{base}}/query'
    });
    const targetId = created.data.target_id;

    const sent = await req('POST', `${base}/apis/${targetId}/send`, {});
    assert.equal(sent.status, 200, JSON.stringify(sent.data).slice(0, 300));
    assert.equal(sent.data.status, 'passed', sent.data.error);

    const call = fake.calls.find((c) => c.path === '/query');
    assert.ok(call, '应真的发出请求');
    assert.equal(call.headers['x-tenant'], 'acme', '全局 header 的变量应被替换');
  } finally {
    await close();
  }
});

test('环境切换：MCP 工具后 list_environments 的 current_env_id 跟随', async () => {
  const { env, req, close } = await boot();
  try {
    const call = async (name, args) => {
      const res = await req('POST', '/api/tools/call', { name, arguments: args });
      assert.equal(res.status, 200);
      if (!res.data.ok) throw new Error(res.data.error);
      return res.data.result;
    };

    await call('apimcp_switch_environment', {
      project_id: env.projectId,
      environment_id: '2503d4840ac010'
    });
    const listed = await call('apimcp_list_environments', { project_id: env.projectId });
    assert.equal(listed.current_env_id, '2503d4840ac010');

    // 持久化：控制台读到同一个当前环境
    const consoleList = await req('GET', `/api/projects/${env.projectId}/environments`);
    assert.equal(consoleList.data.current_env_id, '2503d4840ac010');
  } finally {
    await close();
  }
});

test('全局参数 MCP 工具：get / update', async () => {
  const { env, req, close } = await boot();
  try {
    const call = async (name, args) => {
      const res = await req('POST', '/api/tools/call', { name, arguments: args });
      if (!res.data.ok) throw new Error(res.data.error);
      return res.data.result;
    };

    const got = await call('apimcp_get_global_params', { project_id: env.projectId });
    assert.equal(got.params.auth.type, 'noauth');

    const updated = await call('apimcp_update_global_params', {
      project_id: env.projectId,
      header: [{ key: 'X-From-AI', value: 'yes' }],
      pre_tasks: [{ type: 'customScript', data: 'console.log("hi")', enabled: 1 }]
    });
    assert.deepEqual(updated.updated_sections.sort(), ['header', 'pre_tasks']);
    assert.equal(updated.params.header.parameter[0].key, 'X-From-AI');
    assert.equal(updated.params.pre_tasks.length, 1);

    // 空 patch 报错
    const res = await req('POST', '/api/tools/call', {
      name: 'apimcp_update_global_params',
      arguments: { project_id: env.projectId }
    });
    assert.equal(res.data.ok, false);
    assert.match(String(res.data.error), /没有可更新的内容/);
  } finally {
    await close();
  }
});
