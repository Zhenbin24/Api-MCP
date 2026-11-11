import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeTempRoot, cleanup, makeContext, startFakeServer } from './helpers.mjs';
import { openProject } from '../src/store/target.js';
import { createApiOrFolder, readApiFile, writeApiFile, findApiItem } from '../src/store/apis.js';
import { upsertEnvVariable, createEnvironment } from '../src/store/envs.js';
import { callTool } from '../src/mcp/tools.js';
import { handleMessage } from '../src/mcp/protocol.js';
import { TOOLS } from '../src/mcp/schemas.js';

async function setup({ withServer = true } = {}) {
  const env = makeTempRoot();
  const server = withServer ? await startFakeServer() : { url: '', calls: [], close: async () => {} };
  const target = openProject({ officialRoot: env.root, projectId: env.projectId });

  // 让测试环境的默认服务地址与 base 变量指向假服务
  const envFile = target.readJson('project/envs/2503d4840ac010.json');
  envFile.server_list = [{ name: 'default', server_id: '1', sort: 1000, uri: server.url }];
  if (withServer) {
    envFile.env_var_list = { ...(envFile.env_var_list || {}), base: { value: server.url, description: '被测服务' } };
  }
  target.writeJson('project/envs/2503d4840ac010.json', envFile);

  return { env, server, target, ctx: await makeContext(env) };
}

/** 建一个接口并把它指向假服务 */
function addApi(target, { name, method, uriPath, body, auth, preScripts, postScripts, response }) {
  const api = createApiOrFolder(target, {
    name,
    method,
    url: `{{base}}${uriPath}`,
    detail: { request: { body: body || undefined } }
  });
  const file = readApiFile(target, api.target_id);
  const data = { ...file.data };
  if (auth) data.request.auth = auth;
  if (preScripts) data.request.pre_tasks = preScripts;
  if (postScripts) data.request.post_tasks = postScripts;
  if (response) data.response = response;
  writeApiFile(target, api.target_id, data, { ...findApiItem(target, api.target_id), name, method, url: `{{base}}${uriPath}` });
  return api.target_id;
}

test('执行：最简 GET，状态码与 run 记录', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const targetId = addApi(target, { name: 'ping', method: 'GET', uriPath: '/users/42' });
    const res = await callTool('apipost_execute_api', { project_id: env.projectId, target_id: targetId, environment_id: '2503d4840ac010' }, ctx);

    assert.equal(res.status, 'passed');
    assert.equal(res.status_code, 200);
    assert.ok(res.run_id);

    const runs = await callTool('apipost_list_execution_runs', { project_id: env.projectId }, ctx);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].status, 'passed');

    const detail = await callTool('apipost_get_execution_result', { project_id: env.projectId, run_id: res.run_id }, ctx);
    assert.equal(detail.run.steps.length, 1);
    assert.match(detail.run.steps[0].response.body, /alice/);
    assert.equal(server.calls.at(-1).path, '/users/42');
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('执行：POST JSON body + 参数覆盖', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const targetId = addApi(target, {
      name: 'echo',
      method: 'POST',
      uriPath: '/echo',
      body: { mode: 'json', raw: '{"a":1}', parameter: [] }
    });
    const file = readApiFile(target, targetId);
    const data = structuredClone(file.data);
    data.request.body = { mode: 'json', raw: '{"a":1,"b":2}', parameter: [], raw_parameter: [], raw_schema: { type: 'object' } };
    writeApiFile(target, targetId, data, findApiItem(target, targetId));

    const res = await callTool(
      'apipost_execute_api',
      {
        project_id: env.projectId,
        target_id: targetId,
        environment_id: '2503d4840ac010',
        input: { body: { hello: 'world' } }
      },
      ctx
    );
    assert.equal(res.status, 'passed');
    const call = server.calls.at(-1);
    assert.match(call.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(call.body), { hello: 'world' });
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('执行：query 与 header 参数、模板替换', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const api = createApiOrFolder(target, {
      name: 'query',
      method: 'GET',
      url: '{{base}}/query?page={{page}}',
      detail: {
        request: {
          header: {
            parameter: [
              { description: '', field_type: 'String', is_checked: 1, key: 'X-Test', not_null: -1, param_id: 'p1', value: '{{hval}}' }
            ]
          },
          query: {
            parameter: [
              { description: '', field_type: 'String', is_checked: 1, key: 'page', not_null: -1, param_id: 'p2', value: '1' }
            ],
            query_add_equal: 1
          }
        }
      }
    });
    upsertEnvVariable(target, { envId: '2503d4840ac010', key: 'hval', value: 'hdr-1', currentValue: 'hdr-1' });

    const res = await callTool(
      'apipost_execute_api',
      {
        project_id: env.projectId,
        target_id: api.target_id,
        environment_id: '2503d4840ac010',
        input: { query: { page: '9' } }
      },
      ctx
    );
    assert.equal(res.status, 'passed');
    const call = server.calls.at(-1);
    assert.equal(call.query.page, '9');
    assert.equal(call.headers['x-test'], 'hdr-1');
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('执行：Bearer 鉴权注入', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const targetId = addApi(target, {
      name: 'me',
      method: 'GET',
      uriPath: '/me',
      auth: { type: 'bearer', bearer: { key: 'tok-123' } }
    });
    const res = await callTool('apipost_execute_api', { project_id: env.projectId, target_id: targetId, environment_id: '2503d4840ac010' }, ctx);
    assert.equal(res.status, 'passed');
    assert.equal(server.calls.at(-1).headers.authorization, 'Bearer tok-123');
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('执行：状态码非 2xx 判 failed', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const targetId = addApi(target, { name: 'nf', method: 'GET', uriPath: '/nope' });
    const res = await callTool('apipost_execute_api', { project_id: env.projectId, target_id: targetId, environment_id: '2503d4840ac010' }, ctx);
    assert.equal(res.status, 'failed');
    assert.equal(res.status_code, 404);
    assert.match(res.error, /状态码 404/);
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('执行：前置脚本改写请求 + 后置脚本断言', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const api = createApiOrFolder(target, {
      name: 'scripted',
      method: 'POST',
      url: '{{base}}/echo',
      detail: {
        request: {
          pre_tasks: [
            {
              type: 'customScript',
              enabled: 1,
              id: 'p1',
              data: `
                apt.setRequestHeader('X-From-Pre', 'yes');
                apt.environment.set('preVar', 'from-pre');
                console.log('pre done', apt.environment.get('preVar'));
              `
            }
          ],
          post_tasks: [
            {
              type: 'customScript',
              enabled: 1,
              id: 'q1',
              data: `
                apt.test('响应 ok 字段为 true', function () {
                  apt.expect(apt.response.json().ok).to.be.true();
                });
                apt.environment.set('echoed', apt.response.json().ok);
              `
            }
          ]
        }
      }
    });

    const res = await callTool('apipost_execute_api', { project_id: env.projectId, target_id: api.target_id, environment_id: '2503d4840ac010' }, ctx);
    assert.equal(res.status, 'passed', res.error);
    assert.equal(server.calls.at(-1).headers['x-from-pre'], 'yes');

    const detail = await callTool('apipost_get_execution_result', { project_id: env.projectId, run_id: res.run_id }, ctx);
    const step = detail.run.steps[0];
    assert.ok(step.console.some((c) => /pre done/.test(c.message)));
    const scriptAssertions = step.assertions.filter((a) => a.phase === 'post');
    assert.equal(scriptAssertions.length, 1);
    assert.equal(scriptAssertions[0].passed, true);

    // 脚本写入的运行时变量应持久化
    const history = target.readJson('local/env_vars_history.json');
    assert.equal(history['2503d4840ac010'].echoed.value, true);
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('执行：脚本断言失败 -> failed', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const api = createApiOrFolder(target, {
      name: 'failing',
      method: 'GET',
      url: '{{base}}/users/42',
      detail: {
        request: {
          post_tasks: [
            {
              type: 'customScript',
              enabled: 1,
              id: 'q1',
              data: `
                apt.test('id 应为 999', function () {
                  apt.expect(apt.response.json().id).to.equal(999);
                });
              `
            }
          ]
        }
      }
    });
    const res = await callTool('apipost_execute_api', { project_id: env.projectId, target_id: api.target_id, environment_id: '2503d4840ac010' }, ctx);
    assert.equal(res.status, 'failed');
    assert.ok(res.assertions.some((a) => a.passed === false));
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('执行：执行计划两步传递 token（跨步骤变量）', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const loginId = addApi(target, {
      name: '登录',
      method: 'POST',
      uriPath: '/login',
      body: { mode: 'json', raw: '{"username":"admin"}', parameter: [], raw_parameter: [], raw_schema: { type: 'object' } }
    });
    const meId = addApi(target, {
      name: '我的信息',
      method: 'GET',
      uriPath: '/me',
      auth: { type: 'bearer', bearer: { key: '{{token}}' } }
    });

    const flow = await callTool(
      'apipost_create_execution_flow',
      {
        project_id: env.projectId,
        name: '登录后查询',
        environment_id: '2503d4840ac010',
        steps: [
          {
            target_id: loginId,
            input: { body: { username: 'admin' } },
            post_script: 'apt.environment.set("token", apt.response.json().token);'
          },
          { target_id: meId, input: {} }
        ]
      },
      ctx
    );
    assert.equal(flow.step_count, 2);

    const run = await callTool(
      'apipost_execute_flow',
      { project_id: env.projectId, flow_id: flow.flow_id },
      ctx
    );
    assert.equal(run.status, 'passed', JSON.stringify(run.failed_steps));
    assert.equal(run.passed, 2);

    // 第二步应带上第一步提取的 token
    const meCall = server.calls.find((c) => c.path === '/me');
    assert.equal(meCall.headers.authorization, 'Bearer tok-123');
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('执行：执行计划忽略接口自带脚本', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const api = createApiOrFolder(target, {
      name: '自带脚本',
      method: 'GET',
      url: '{{base}}/users/42',
      detail: {
        request: {
          pre_tasks: [
            {
              type: 'customScript',
              enabled: 1,
              id: 'p1',
              data: "apt.setRequestHeader('X-Builtin', 'leaked');"
            }
          ]
        }
      }
    });

    const flow = await callTool(
      'apipost_create_execution_flow',
      {
        project_id: env.projectId,
        name: '忽略内置脚本',
        environment_id: '2503d4840ac010',
        steps: [{ target_id: api.target_id, input: {} }]
      },
      ctx
    );
    const run = await callTool('apipost_execute_flow', { project_id: env.projectId, flow_id: flow.flow_id }, ctx);
    assert.equal(run.status, 'passed');
    const call = server.calls.at(-1);
    assert.equal(call.headers['x-builtin'], undefined);
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('执行：步骤快照固化（改接口不影响已建计划）', async () => {
  const { env, server, target, ctx } = await setup();
  try {
    const api = createApiOrFolder(target, { name: 'v1', method: 'GET', url: '{{base}}/users/42' });
    const flow = await callTool(
      'apipost_create_execution_flow',
      { project_id: env.projectId, name: '快照测试', environment_id: '2503d4840ac010', steps: [{ target_id: api.target_id }] },
      ctx
    );

    // 把接口 URL 改成一个 404 路径
    const file = readApiFile(target, api.target_id);
    writeApiFile(target, api.target_id, { ...file.data, url: '{{base}}/nope' }, findApiItem(target, api.target_id));

    const run = await callTool('apipost_execute_flow', { project_id: env.projectId, flow_id: flow.flow_id }, ctx);
    assert.equal(run.status, 'passed', '应使用快照里的旧 URL');
    assert.equal(server.calls.at(-1).path, '/users/42');
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('工具：未知工具与参数缺失的错误处理', async () => {
  const { env, target, ctx } = await setup({ withServer: false });
  try {
    await assert.rejects(() => callTool('nope_tool', {}, ctx), /未知工具/);
    await assert.rejects(() => callTool('apipost_list_apis', {}, ctx), /缺少 project_id/);
    await assert.rejects(
      () => callTool('apipost_delete_apis', { project_id: env.projectId, target_ids: ['x'], confirm: false }, ctx),
      /confirm: true/
    );
    await assert.rejects(
      () => callTool('apipost_list_apis', { project_id: 'ffffffffffffff' }, ctx),
      /项目不存在/
    );
  } finally {
    cleanup(env.base);
  }
});

test('工具：未授权项目被拒绝', async () => {
  const { env, ctx } = await setup({ withServer: false });
  try {
    ctx.config.allowed_project_ids = ['other_project'];
    await assert.rejects(
      () => callTool('apipost_list_apis', { project_id: env.projectId }, ctx),
      /项目未授权访问/
    );
  } finally {
    cleanup(env.base);
  }
});

test('协议：initialize / tools/list / tools/call 结构', async () => {
  const { env, ctx } = await setup({ withServer: false });
  try {
    const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'apimcp');

    const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
    assert.equal(list.result.tools.length, 32);
    assert.ok(list.result.tools.every((t) => t.name.startsWith('apipost_')));
    assert.ok(list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));

    const call = await handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'apipost_list_projects', arguments: {} } },
      ctx
    );
    assert.ok(call.result.content[0].text.includes('测试项目'));
    assert.equal(call.result.isError, undefined);

    const bad = await handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'apipost_list_apis', arguments: {} } },
      ctx
    );
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /缺少 project_id/);

    const notif = await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx);
    assert.equal(notif, null);

    const unknown = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'bogus/method' }, ctx);
    assert.equal(unknown.error.code, -32601);
  } finally {
    cleanup(env.base);
  }
});

test('工具：32 个工具名称（官方 30 + 全局参数 2）', () => {
  const expected = [
    'apipost_list_projects',
    'apipost_create_project',
    'apipost_list_apis',
    'apipost_get_api_detail',
    'apipost_sync_openapi',
    'apipost_delete_apis',
    'apipost_execute_api',
    'apipost_list_environments',
    'apipost_switch_environment',
    'apipost_create_environment',
    'apipost_update_environment',
    'apipost_delete_environment',
    'apipost_list_environment_servers',
    'apipost_create_environment_server',
    'apipost_update_environment_server',
    'apipost_delete_environment_server',
    'apipost_get_environment_variables',
    'apipost_upsert_environment_variable',
    'apipost_delete_environment_variable',
    'apipost_get_global_variables',
    'apipost_upsert_global_variable',
    'apipost_delete_global_variable',
    'apipost_get_global_params',
    'apipost_update_global_params',
    'apipost_create_execution_flow',
    'apipost_update_execution_flow',
    'apipost_list_execution_flows',
    'apipost_get_execution_flow',
    'apipost_delete_execution_flow',
    'apipost_execute_flow',
    'apipost_list_execution_runs',
    'apipost_get_execution_result'
  ];
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), expected.sort());
});
