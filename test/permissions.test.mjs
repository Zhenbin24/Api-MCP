import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot, cleanup, makeContext, startFakeServer } from './helpers.mjs';
import { pullProject } from '../src/sync/index.js';
import { openShadow } from '../src/store/shadow.js';
import { createApiOrFolder, readApiFile, writeApiFile, findApiItem } from '../src/store/apis.js';
import { callTool, ToolContext } from '../src/mcp/tools.js';
import { handleMessage } from '../src/mcp/protocol.js';

async function setup(overrides = {}, { withServer = false } = {}) {
  const env = makeTempRoot();
  const server = withServer ? await startFakeServer() : { url: '', calls: [], close: async () => {} };
  pullProject(env.root, env.shadow, env.projectId);
  const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });

  if (server.url) {
    const envFile = target.readJson('project/envs/2503d4840ac010.json');
    envFile.server_list = [{ name: 'default', server_id: '1', sort: 1000, uri: server.url }];
    envFile.env_var_list = { base: { value: server.url } };
    target.writeJson('project/envs/2503d4840ac010.json', envFile);
  }

  const ctx = await makeContext(env, overrides);
  return { env, server, target, ctx };
}

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'rbac', version: '1' },
  servers: [{ url: 'https://api.test' }],
  paths: { '/rbac': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } } } } }
};

/* ---------------- 服务总开关 ---------------- */

test('权限：enabled=false 时所有工具都被拒绝', async () => {
  const { env, ctx } = await setup({ enabled: false });
  try {
    await assert.rejects(() => callTool('apipost_list_projects', {}, ctx), /服务已停用/);
    await assert.rejects(() => callTool('apipost_list_apis', { project_id: env.projectId }, ctx), /服务已停用/);
    await assert.rejects(
      () => callTool('apipost_execute_api', { project_id: env.projectId, target_id: 'x' }, ctx),
      /服务已停用/
    );
    await assert.rejects(
      () => callTool('apipost_create_project', { name: 'x' }, ctx),
      /服务已停用/
    );
  } finally {
    cleanup(env.base);
  }
});

test('权限：enabled=true 时正常放行', async () => {
  const { env, ctx } = await setup({ enabled: true });
  try {
    const res = await callTool('apipost_list_projects', {}, ctx);
    assert.ok(Array.isArray(res.projects));
  } finally {
    cleanup(env.base);
  }
});

/* ---------------- 写入权限 ---------------- */

test('权限：只读模式下写工具全部被拒绝', async () => {
  const { env, target, ctx } = await setup({ allow_write: false });
  try {
    const api = createApiOrFolder(target, { name: 'x', method: 'GET', url: 'https://api.test/x' });

    await assert.rejects(
      () => callTool('apipost_sync_openapi', { project_id: env.projectId, openapi: SPEC }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_delete_apis', { project_id: env.projectId, target_ids: [api.target_id], confirm: true }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_create_project', { name: '新项目' }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_create_environment', { project_id: env.projectId, name: 'e' }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_update_environment', { project_id: env.projectId, environment_id: '1', name: 'e2' }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_delete_environment', { project_id: env.projectId, environment_id: '2503d4840ac010', confirm: true }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_create_environment_server', { project_id: env.projectId, name: 's' }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_update_environment_server', { project_id: env.projectId, server_id: '1', name: 's2' }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_delete_environment_server', { project_id: env.projectId, server_id: '9', confirm: true }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_upsert_environment_variable', { project_id: env.projectId, environment_id: '1', key: 'k' }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_delete_environment_variable', { project_id: env.projectId, environment_id: '1', key: 'k', confirm: true }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_upsert_global_variable', { project_id: env.projectId, key: 'g' }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_delete_global_variable', { project_id: env.projectId, key: 'g', confirm: true }, ctx),
      /只读模式/
    );
    await assert.rejects(
      () => callTool('apipost_create_execution_flow', { project_id: env.projectId, name: 'f', steps: [{ target_id: api.target_id }] }, ctx),
      /只读模式/
    );
  } finally {
    cleanup(env.base);
  }
});

test('权限：只读模式下读工具与执行仍可用', async () => {
  const { env, server, target, ctx } = await setup({ allow_write: false, allow_execute: true }, { withServer: true });
  try {
    const api = createApiOrFolder(target, { name: 'ping', method: 'GET', url: '{{base}}/users/42' });
    const file = readApiFile(target, api.target_id);
    writeApiFile(target, api.target_id, { ...file.data }, findApiItem(target, api.target_id));

    // 读工具放行
    const list = await callTool('apipost_list_apis', { project_id: env.projectId }, ctx);
    assert.ok(list.items.length >= 1);

    const detail = await callTool('apipost_get_api_detail', { project_id: env.projectId, target_id: api.target_id }, ctx);
    assert.equal(detail.index.name, 'ping');

    const envs = await callTool('apipost_list_environments', { project_id: env.projectId }, ctx);
    assert.ok(envs.environments.length >= 1);

    // 执行也放行（allow_execute 未被关闭）
    const run = await callTool(
      'apipost_execute_api',
      { project_id: env.projectId, target_id: api.target_id, environment_id: '2503d4840ac010' },
      ctx
    );
    assert.equal(run.status, 'passed');
    assert.equal(server.calls.at(-1).path, '/users/42');
  } finally {
    await server.close();
    cleanup(env.base);
  }
});

test('权限：写入权限开启时写工具正常', async () => {
  const { env, ctx } = await setup({ allow_write: true });
  try {
    const res = await callTool('apipost_sync_openapi', { project_id: env.projectId, openapi: SPEC }, ctx);
    assert.equal(res.summary.created, 1);

    const created = await callTool('apipost_create_environment', { project_id: env.projectId, name: '可写环境' }, ctx);
    assert.equal(created.environment.name, '可写环境');
  } finally {
    cleanup(env.base);
  }
});

/* ---------------- 执行权限 ---------------- */

test('权限：关闭执行权限后 execute_api / execute_flow 被拒绝', async () => {
  const { env, target, ctx } = await setup({ allow_execute: false });
  try {
    const api = createApiOrFolder(target, { name: 'ping', method: 'GET', url: '{{base}}/users/42' });

    await assert.rejects(
      () => callTool('apipost_execute_api', { project_id: env.projectId, target_id: api.target_id }, ctx),
      /执行已关闭/
    );

    // 建计划（写权限开启，允许）
    const flow = await callTool(
      'apipost_create_execution_flow',
      { project_id: env.projectId, name: 'f', steps: [{ target_id: api.target_id }] },
      ctx
    );
    await assert.rejects(
      () => callTool('apipost_execute_flow', { project_id: env.projectId, flow_id: flow.flow_id }, ctx),
      /执行已关闭/
    );
  } finally {
    cleanup(env.base);
  }
});

test('权限：关闭执行不影响只读查询', async () => {
  const { env, ctx } = await setup({ allow_execute: false, allow_write: true });
  try {
    const res = await callTool('apipost_list_apis', { project_id: env.projectId }, ctx);
    assert.ok(Array.isArray(res.items));
  } finally {
    cleanup(env.base);
  }
});

/* ---------------- 组合：只读 + 禁执行 ---------------- */

test('权限：只读且禁执行时只有查询能用', async () => {
  const { env, target, ctx } = await setup({ allow_write: false, allow_execute: false });
  try {
    const api = createApiOrFolder(target, { name: 'ping', method: 'GET', url: '{{base}}/users/42' });

    await assert.rejects(
      () => callTool('apipost_execute_api', { project_id: env.projectId, target_id: api.target_id }, ctx),
      /执行已关闭/
    );
    await assert.rejects(
      () => callTool('apipost_delete_apis', { project_id: env.projectId, target_ids: [api.target_id], confirm: true }, ctx),
      /只读模式/
    );

    const list = await callTool('apipost_list_apis', { project_id: env.projectId }, ctx);
    assert.ok(list.items.length >= 1);
  } finally {
    cleanup(env.base);
  }
});

/* ---------------- 协议层错误透出 ---------------- */

test('权限：tools/call 返回 isError 与可读提示', async () => {
  const { env, ctx } = await setup({ allow_write: false });
  try {
    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'apipost_sync_openapi', arguments: { project_id: env.projectId, openapi: SPEC } }
      },
      ctx
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /只读模式/);
    assert.match(res.result.content[0].text, /允许写入项目/);
  } finally {
    cleanup(env.base);
  }
});

test('权限：disabled 时 tools/call 也是 isError', async () => {
  const { env, ctx } = await setup({ enabled: false });
  try {
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apipost_list_projects', arguments: {} } },
      ctx
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /服务已停用/);
  } finally {
    cleanup(env.base);
  }
});

/* ---------------- 配置读写 ---------------- */

test('权限：配置文件可持久化 allow_write / allow_execute / enabled', async () => {
  const { loadConfig, saveConfig, defaultConfig } = await import('../src/server/config.js');
  const before = loadConfig();
  try {
    const next = { ...defaultConfig(), allow_write: false, allow_execute: false, enabled: false };
    saveConfig(next);
    const loaded = loadConfig();
    assert.equal(loaded.allow_write, false);
    assert.equal(loaded.allow_execute, false);
    assert.equal(loaded.enabled, false);
  } finally {
    saveConfig(before);
  }
});

test('权限：WorkBuddy 客户端配置已生成', async () => {
  const { buildClientConfigs } = await import('../src/server/client-config.js');
  const configs = buildClientConfigs({ command: 'C:\\x\\apipost-mcp.exe', args: ['--stdio'] });
  assert.ok(configs.workbuddy, '应包含 workbuddy');
  const parsed = JSON.parse(configs.workbuddy);
  assert.ok(parsed.mcpServers['apipost-offline']);
  assert.equal(parsed.mcpServers['apipost-offline'].command, 'C:\\x\\apipost-mcp.exe');
  assert.deepEqual(parsed.mcpServers['apipost-offline'].args, ['--stdio']);

  for (const key of ['cursor', 'codex', 'claude_code', 'vscode', 'trae', 'workbuddy', 'http']) {
    assert.ok(configs[key], `应包含 ${key}`);
  }
});
