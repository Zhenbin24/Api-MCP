import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot, cleanup, makeContext } from './helpers.mjs';
import { openProject } from '../src/store/target.js';
import { listApis, createApiOrFolder, readApiFile, TARGET_TYPE } from '../src/store/apis.js';
import { callTool } from '../src/mcp/tools.js';

async function setup() {
  const env = makeTempRoot();
  const target = openProject({ officialRoot: env.root, projectId: env.projectId });
  return { env, target, ctx: await makeContext(env) };
}

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'petstore', version: '1.0.0' },
  servers: [{ url: 'https://petstore.example.com/v1' }],
  paths: {
    '/pets': {
      get: {
        summary: '列出宠物',
        tags: ['宠物'],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' }, description: '数量' }],
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } }
              }
            }
          }
        }
      },
      post: {
        summary: '新建宠物',
        tags: ['宠物'],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' }, tag: { type: 'string' } },
                required: ['name']
              }
            }
          }
        },
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } }
      }
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        summary: '查宠物',
        tags: ['宠物'],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } }
      }
    },
    '/health': {
      get: {
        summary: '健康检查',
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } }
      }
    }
  }
};

test('OpenAPI 同步：创建接口与目录', async () => {
  const { env, target, ctx } = await setup();
  try {
    const res = await callTool('apipost_sync_openapi', { project_id: env.projectId, openapi: SPEC }, ctx);
    assert.equal(res.summary.created, 4);
    assert.equal(res.summary.updated, 0);

    const items = listApis(target, {});
    assert.equal(items.length, 5); // 4 接口 + 1 目录「宠物」

    const folder = items.find((i) => i.target_type === TARGET_TYPE.FOLDER);
    assert.equal(folder.name, '宠物');

    const pets = items.filter((i) => i.parent_id === folder.target_id);
    assert.equal(pets.length, 3);

    const health = items.find((i) => i.name === '健康检查');
    assert.equal(health.parent_id, '0');

    const post = items.find((i) => i.method === 'POST');
    const file = readApiFile(target, post.target_id);
    assert.equal(file.data.request.body.mode, 'json');
    assert.equal(file.data.request.body.raw_schema.properties.name.type, 'string');
    assert.deepEqual(file.data.request.body.raw_schema.required, ['name']);

    const getPets = items.find((i) => i.method === 'GET' && i.parent_id === folder.target_id && i.url === '/pets');
    const getFile = readApiFile(target, getPets.target_id);
    assert.equal(getFile.data.request.query.parameter[0].key, 'limit');
    assert.equal(getFile.data.request.query.parameter[0].field_type, 'Integer');
  } finally {
    cleanup(env.base);
  }
});

test('OpenAPI 同步：url_and_folder 覆盖、ignore 跳过', async () => {
  const { env, target, ctx } = await setup();
  try {
    await callTool('apipost_sync_openapi', { project_id: env.projectId, openapi: SPEC }, ctx);

    const first = await callTool('apipost_sync_openapi', { project_id: env.projectId, openapi: SPEC }, ctx);
    assert.equal(first.summary.created, 0);
    assert.equal(first.summary.updated, 4);

    const ignore = await callTool(
      'apipost_sync_openapi',
      { project_id: env.projectId, openapi: SPEC, api_cover_mode: 'ignore' },
      ctx
    );
    assert.equal(ignore.summary.created, 0);
    assert.equal(ignore.summary.skipped, 4);
  } finally {
    cleanup(env.base);
  }
});

test('OpenAPI 同步：both 保留重复', async () => {
  const { env, target, ctx } = await setup();
  try {
    await callTool('apipost_sync_openapi', { project_id: env.projectId, openapi: SPEC }, ctx);
    const both = await callTool(
      'apipost_sync_openapi',
      { project_id: env.projectId, openapi: SPEC, api_cover_mode: 'both' },
      ctx
    );
    assert.equal(both.summary.created, 4);
    const items = listApis(target, {});
    assert.equal(items.filter((i) => i.target_type === TARGET_TYPE.API).length, 8);
  } finally {
    cleanup(env.base);
  }
});

test('OpenAPI 同步：folder_id 导入到指定目录 + api_scripts', async () => {
  const { env, target, ctx } = await setup();
  try {
    const folder = createApiOrFolder(target, { name: '手工目录', targetType: TARGET_TYPE.FOLDER });

    const res = await callTool(
      'apipost_sync_openapi',
      {
        project_id: env.projectId,
        openapi: SPEC,
        folder_id: folder.target_id,
        api_scripts: [{ method: 'GET', url: '/health', pre_script: 'console.log("hi")', post_script: 'console.log("bye")' }]
      },
      ctx
    );
    assert.equal(res.summary.created, 4);

    const direct = listApis(target, { parentId: folder.target_id });
    // 直接子项：1 个 API（健康检查） + 1 个子目录（宠物）
    assert.equal(direct.length, 2);
    assert.ok(direct.some((i) => i.name === '健康检查'));
    const subFolder = direct.find((i) => i.target_type === TARGET_TYPE.FOLDER);
    assert.equal(subFolder.name, '宠物');
    assert.equal(listApis(target, { parentId: subFolder.target_id }).length, 3);

    const health = direct.find((i) => i.name === '健康检查');
    const file = readApiFile(target, health.target_id);
    assert.equal(file.data.request.pre_tasks.length, 1);
    assert.equal(file.data.request.post_tasks.length, 1);
    assert.match(file.data.request.pre_tasks[0].data, /hi/);
    assert.match(file.data.request.post_tasks[0].data, /bye/);
  } finally {
    cleanup(env.base);
  }
});

test('OpenAPI 同步：clear 清空目录后导入', async () => {
  const { env, target, ctx } = await setup();
  try {
    await callTool('apipost_sync_openapi', { project_id: env.projectId, openapi: SPEC }, ctx);
    const before = listApis(target, {});
    assert.equal(before.length, 5);

    const cleared = await callTool(
      'apipost_sync_openapi',
      { project_id: env.projectId, openapi: SPEC, api_cover_mode: 'clear' },
      ctx
    );
    assert.equal(cleared.summary.created, 4);
    assert.equal(listApis(target, {}).length, 5);
  } finally {
    cleanup(env.base);
  }
});

test('OpenAPI 同步：folder_id 不存在时报错', async () => {
  const { env, ctx } = await setup();
  try {
    await assert.rejects(
      () => callTool('apipost_sync_openapi', { project_id: env.projectId, openapi: SPEC, folder_id: 'deadbeef000001' }, ctx),
      /未找到指定的导入目录/
    );
  } finally {
    cleanup(env.base);
  }
});

test('OpenAPI 同步：非法版本报错', async () => {
  const { env, ctx } = await setup();
  try {
    await assert.rejects(
      () => callTool('apipost_sync_openapi', { project_id: env.projectId, openapi: { swagger: '2.0', paths: {} } }, ctx),
      /仅支持 OpenAPI 3.0 或 3.1/
    );
  } finally {
    cleanup(env.base);
  }
});

test('环境工具：列表 / 切换 / 增删改 / 服务', async () => {
  const { env, target, ctx } = await setup();
  try {
    const list = await callTool('apipost_list_environments', { project_id: env.projectId }, ctx);
    assert.equal(list.environments.length, 2);
    assert.equal(list.current_env_id, '1');

    const created = await callTool(
      'apipost_create_environment',
      { project_id: env.projectId, name: '生产', base_url: 'https://prod.example.com' },
      ctx
    );
    assert.equal(created.environment.name, '生产');
    assert.equal(created.environment.base_url, 'https://prod.example.com');

    const updated = await callTool(
      'apipost_update_environment',
      { project_id: env.projectId, environment_id: created.env_id, name: '生产环境' },
      ctx
    );
    assert.equal(updated.environment.name, '生产环境');

    const server = await callTool(
      'apipost_create_environment_server',
      { project_id: env.projectId, name: '支付服务', environment_id: created.env_id, base_url: 'https://pay.example.com' },
      ctx
    );
    assert.ok(server.server.server_id);

    const servers = await callTool(
      'apipost_list_environment_servers',
      { project_id: env.projectId, environment_id: created.env_id },
      ctx
    );
    assert.ok(servers.servers.some((s) => s.name === '支付服务' && s.base_url === 'https://pay.example.com'));

    await assert.rejects(
      () => callTool('apipost_delete_environment', { project_id: env.projectId, environment_id: created.env_id, confirm: false }, ctx),
      /confirm: true/
    );

    const del = await callTool(
      'apipost_delete_environment',
      { project_id: env.projectId, environment_id: created.env_id, confirm: true },
      ctx
    );
    assert.equal(del.deleted, true);

    // 默认环境不可删
    await assert.rejects(
      () => callTool('apipost_delete_environment', { project_id: env.projectId, environment_id: '1', confirm: true }, ctx),
      /默认环境不可删除/
    );
  } finally {
    cleanup(env.base);
  }
});

test('变量工具：upsert / get / delete（环境与全局）', async () => {
  const { env, ctx } = await setup();
  try {
    const up = await callTool(
      'apipost_upsert_environment_variable',
      { project_id: env.projectId, environment_id: '1', key: 'API_KEY', value: 'default', current_value: 'runtime' },
      ctx
    );
    assert.equal(up.variable.value, 'default');
    assert.equal(up.variable.current_value, 'runtime');

    const got = await callTool('apipost_get_environment_variables', { project_id: env.projectId, environment_id: '1' }, ctx);
    const found = got.variables.find((v) => v.key === 'API_KEY');
    assert.equal(found.current_value, 'runtime');

    await callTool(
      'apipost_upsert_global_variable',
      { project_id: env.projectId, key: 'TENANT', value: 'acme' },
      ctx
    );
    const globals = await callTool('apipost_get_global_variables', { project_id: env.projectId }, ctx);
    assert.ok(globals.variables.some((v) => v.key === 'TENANT' && v.value === 'acme'));

    await assert.rejects(
      () => callTool('apipost_delete_global_variable', { project_id: env.projectId, key: 'TENANT', confirm: false }, ctx),
      /confirm: true/
    );
    const del = await callTool('apipost_delete_global_variable', { project_id: env.projectId, key: 'TENANT', confirm: true }, ctx);
    assert.equal(del.deleted, true);
  } finally {
    cleanup(env.base);
  }
});

test('执行计划工具：create / list / get / update / delete', async () => {
  const { env, target, ctx } = await setup();
  try {
    const api = createApiOrFolder(target, { name: 'ping', method: 'GET', url: 'https://api.test/ping' });

    const created = await callTool(
      'apipost_create_execution_flow',
      {
        project_id: env.projectId,
        name: '流程A',
        description: '说明',
        steps: [{ target_id: api.target_id, pre_script: 'console.log(1)' }]
      },
      ctx
    );
    assert.equal(created.step_count, 1);

    const list = await callTool('apipost_list_execution_flows', { project_id: env.projectId }, ctx);
    assert.equal(list.flows.length, 1);

    const detail = await callTool('apipost_get_execution_flow', { project_id: env.projectId, flow_id: created.flow_id }, ctx);
    assert.equal(detail.flow.name, '流程A');
    const stepId = detail.flow.steps[0].step_id;

    const updated = await callTool(
      'apipost_update_execution_flow',
      {
        project_id: env.projectId,
        flow_id: created.flow_id,
        name: '流程B',
        steps: [{ step_id: stepId, target_id: api.target_id, post_script: 'console.log(2)' }]
      },
      ctx
    );
    assert.equal(updated.name, '流程B');

    const after = await callTool('apipost_get_execution_flow', { project_id: env.projectId, flow_id: created.flow_id }, ctx);
    assert.equal(after.flow.steps.length, 1);
    assert.equal(after.flow.steps[0].step_id, stepId, 'step_id 应沿用');
    assert.equal(after.flow.steps[0].post_script, 'console.log(2)');

    await assert.rejects(
      () => callTool('apipost_delete_execution_flow', { project_id: env.projectId, flow_id: created.flow_id, confirm: false }, ctx),
      /confirm: true/
    );
    const del = await callTool(
      'apipost_delete_execution_flow',
      { project_id: env.projectId, flow_id: created.flow_id, confirm: true },
      ctx
    );
    assert.equal(del.deleted, true);
    assert.equal((await callTool('apipost_list_execution_flows', { project_id: env.projectId }, ctx)).flows.length, 0);
  } finally {
    cleanup(env.base);
  }
});

test('执行计划工具：非 HTTP 接口被拒绝', async () => {
  const { env, target, ctx } = await setup();
  try {
    const folder = createApiOrFolder(target, { name: '目录', targetType: TARGET_TYPE.FOLDER });
    await assert.rejects(
      () =>
        callTool(
          'apipost_create_execution_flow',
          { project_id: env.projectId, name: 'x', steps: [{ target_id: folder.target_id }] },
          ctx
        ),
      /执行计划仅支持 HTTP 接口/
    );
  } finally {
    cleanup(env.base);
  }
});

test('API 工具：get_api_detail 返回脚本标记、delete 级联', async () => {
  const { env, target, ctx } = await setup();
  try {
    const folder = createApiOrFolder(target, { name: '模块', targetType: TARGET_TYPE.FOLDER });
    const api = createApiOrFolder(target, {
      name: '带脚本',
      parentId: folder.target_id,
      method: 'GET',
      url: 'https://api.test/x'
    });
    const file = readApiFile(target, api.target_id);
    const data = structuredClone(file.data);
    data.request.pre_tasks = [{ type: 'customScript', enabled: 1, id: 'p', data: 'console.log("pre")' }];
    data.request.post_tasks = [{ type: 'customScript', enabled: 1, id: 'q', data: 'console.log("post")' }];
    const { writeApiFile, findApiItem } = await import('../src/store/apis.js');
    writeApiFile(target, api.target_id, data, findApiItem(target, api.target_id));

    const detail = await callTool('apipost_get_api_detail', { project_id: env.projectId, target_id: api.target_id }, ctx);
    assert.equal(detail.builtin_pre_scripts.length, 1);
    assert.match(detail.builtin_pre_scripts[0], /pre/);
    assert.equal(detail.builtin_post_scripts.length, 1);

    const del = await callTool(
      'apipost_delete_apis',
      { project_id: env.projectId, target_ids: [folder.target_id], confirm: true },
      ctx
    );
    assert.equal(del.deleted_count, 2);
    assert.equal(listApis(target, {}).length, 0);
  } finally {
    cleanup(env.base);
  }
});
