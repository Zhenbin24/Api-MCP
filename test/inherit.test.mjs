import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot, cleanup, startFakeServer } from './helpers.mjs';
import { openProject } from '../src/store/target.js';
import { createApiOrFolder, readApiFile, writeApiFile, updateApiIndexItem } from '../src/store/apis.js';
import { writeCurrentEnvId } from '../src/store/envs.js';
import { readGlobalParams, writeGlobalParams } from '../src/store/globals.js';
import { buildEffectiveRequest, resolveChain, mergeChain } from '../src/exec/inherit.js';
import { upsertEnvVariable } from '../src/store/envs.js';

function boot(root, projectId) {
  return openProject({ officialRoot: root, projectId });
}

/** 把环境的默认服务地址指向 fake server */
function pointEnvTo(target, envId, url) {
  const env = target.readJson(`project/envs/${envId}.json`);
  env.server_list = [{ name: 'default', server_id: '1', sort: 1000, uri: url }];
  env.env_var_list = { ...(env.env_var_list || {}), base: { value: url } };
  target.writeJson(`project/envs/${envId}.json`, env);
}

function makeApi(target, { name = '接口', url = '{{base}}/echo', method = 'POST', parentId = '0', request = null } = {}) {
  const created = createApiOrFolder(target, { name, url, method, parentId, targetType: 'api' });
  const file = readApiFile(target, created.target_id);
  const data = file.data;
  if (request) {
    data.request = { ...data.request, ...request };
    writeApiFile(target, created.target_id, data, file);
  }
  return { id: created.target_id, data };
}

function makeFolder(target, { name = '目录', parentId = '0', serverId = '0', request = null } = {}) {
  const created = createApiOrFolder(target, { name, parentId, targetType: 'folder' });
  const file = readApiFile(target, created.target_id);
  const data = file.data;
  data.server_id = serverId;
  if (request) data.request = { ...data.request, ...request };
  writeApiFile(target, created.target_id, data, file);
  return created.target_id;
}

function param(key, value, extra = {}) {
  return {
    description: '',
    field_type: 'String',
    is_checked: 1,
    key,
    not_null: -1,
    param_id: `p_${key}_${Math.random().toString(16).slice(2, 8)}`,
    value,
    ...extra
  };
}

test('继承：全局 header → 目录 header → 接口 header 逐层覆盖', () => {
  const env = makeTempRoot();
  try {
    const target = boot(env.root, env.projectId);

    writeGlobalParams(target, {
      header: [param('X-Tenant', 'global'), param('X-Only-Global', 'g')],
      query: [param('lang', 'zh')]
    });
    const folderId = makeFolder(target, {
      request: { header: { parameter: [param('X-Tenant', 'folder'), param('X-Only-Folder', 'f')] } }
    });
    const api = makeApi(target, {
      parentId: folderId,
      request: { header: { parameter: [param('X-Tenant', 'api')] } }
    });

    const effective = buildEffectiveRequest(target, api.data, { server_list: [] });
    const headers = effective.request.header.parameter;
    const byKey = Object.fromEntries(headers.map((h) => [h.key, h.value]));

    assert.equal(byKey['X-Tenant'], 'api', '接口层应覆盖目录与全局');
    assert.equal(byKey['X-Only-Folder'], 'f');
    assert.equal(byKey['X-Only-Global'], 'g');
    assert.equal(effective.request.query.parameter[0].key, 'lang');
    // 来源标记
    assert.deepEqual([...new Set(effective.sources.header)].sort(), ['api', 'folder', 'global']);
  } finally {
    cleanup(env.base);
  }
});

test('继承：内层 is_checked = -1 表示禁用外层同名参数', () => {
  const env = makeTempRoot();
  try {
    const target = boot(env.root, env.projectId);
    writeGlobalParams(target, { header: [param('X-Debug', '1'), param('X-Keep', 'k')] });
    const api = makeApi(target, {
      request: { header: { parameter: [param('X-Debug', '1', { is_checked: -1 })] } }
    });

    const effective = buildEffectiveRequest(target, api.data, { server_list: [] });
    const keys = effective.request.header.parameter.map((h) => h.key);
    assert.ok(!keys.includes('X-Debug'), '被禁用后不应出现');
    assert.ok(keys.includes('X-Keep'));
  } finally {
    cleanup(env.base);
  }
});

test('继承：form-data Body 按 key 并集，raw 由最内层接管', () => {
  const env = makeTempRoot();
  try {
    const target = boot(env.root, env.projectId);
    writeGlobalParams(target, {
      body: { mode: 'form-data', parameter: [param('g1', '1'), param('shared', 'global')] }
    });
    const api = makeApi(target, {
      request: { body: { mode: 'form-data', parameter: [param('shared', 'api'), param('a1', '2')] } }
    });

    const effective = buildEffectiveRequest(target, api.data, { server_list: [] });
    assert.equal(effective.request.body.mode, 'form-data');
    const byKey = Object.fromEntries(effective.request.body.parameter.map((p) => [p.key, p.value]));
    assert.deepEqual(byKey, { g1: '1', shared: 'api', a1: '2' });

    // raw 模式：内层直接胜出，不与全局 form 合并
    const rawApi = makeApi(target, { name: 'raw接口', request: { body: { mode: 'json', raw: '{"a":1}', parameter: [] } } });
    const rawEffective = buildEffectiveRequest(target, rawApi.data, { server_list: [] });
    assert.equal(rawEffective.request.body.mode, 'json');
    assert.equal(rawEffective.request.body.raw, '{"a":1}');
    assert.equal(rawEffective.request.body.parameter.length, 0);
  } finally {
    cleanup(env.base);
  }
});

test('继承：auth 从内往外找第一个非 inherit；脚本前后顺序正确', () => {
  const env = makeTempRoot();
  try {
    const target = boot(env.root, env.projectId);
    const script = (text) => ({ type: 'customScript', data: text, enabled: 1, id: `s_${text}` });
    writeGlobalParams(target, {
      auth: { type: 'bearer', bearer: { key: 'global-token' } },
      pre_tasks: [script('global-pre')],
      post_tasks: [script('global-post')]
    });
    const folderId = makeFolder(target, {
      request: {
        auth: { type: 'inherit' },
        pre_tasks: [script('folder-pre')],
        post_tasks: [script('folder-post')]
      }
    });
    const api = makeApi(target, {
      parentId: folderId,
      request: {
        auth: { type: 'inherit' },
        pre_tasks: [script('api-pre')],
        post_tasks: [script('api-post')]
      }
    });

    const effective = buildEffectiveRequest(target, api.data, { server_list: [] });
    assert.equal(effective.request.auth.type, 'bearer');
    assert.equal(effective.request.auth.bearer.key, 'global-token');
    assert.equal(effective.sources.auth[0], 'global');

    const pre = effective.request.pre_tasks.map((t) => t.data);
    assert.deepEqual(pre, ['global-pre', 'folder-pre', 'api-pre'], '前置脚本外 → 内');
    const post = effective.request.post_tasks.map((t) => t.data);
    assert.deepEqual(post, ['api-post', 'folder-post', 'global-post'], '后置脚本内 → 外');
  } finally {
    cleanup(env.base);
  }
});

test('继承：目录 server_id 决定前置 URL，未指定则回落默认服务', () => {
  const env = makeTempRoot();
  try {
    const target = boot(env.root, env.projectId);
    const envId = '2503d4840ac010';
    target.writeJson(`project/envs/${envId}.json`, {
      ...target.readJson(`project/envs/${envId}.json`),
      server_list: [
        { name: 'default', server_id: '1', sort: 1000, uri: 'http://default.example' },
        { name: 'user', server_id: 'svc2', sort: 2000, uri: 'http://user.example' }
      ]
    });
    const folderId = makeFolder(target, { serverId: 'svc2' });
    const api = makeApi(target, { parentId: folderId });
    const envDetail = target.readJson(`project/envs/${envId}.json`);

    const effective = buildEffectiveRequest(target, api.data, envDetail);
    assert.equal(effective.baseUrl, 'http://user.example');

    // 不在该目录下 → 用默认服务
    const plain = makeApi(target, { name: '无目录接口' });
    assert.equal(buildEffectiveRequest(target, plain.data, envDetail).baseUrl, 'http://default.example');
  } finally {
    cleanup(env.base);
  }
});

test('继承：链路由外到内且包含全局参数层', () => {
  const env = makeTempRoot();
  try {
    const target = boot(env.root, env.projectId);
    writeGlobalParams(target, { header: [param('X-G', '1')] });
    const outer = makeFolder(target, { name: '外层' });
    const inner = makeFolder(target, { name: '内层', parentId: outer });
    const api = makeApi(target, { parentId: inner });

    const chain = resolveChain(target, api.data);
    assert.deepEqual(chain.map((c) => c.level), ['global', 'folder', 'folder', 'api']);
    assert.deepEqual(chain.filter((c) => c.level === 'folder').map((c) => c.name), ['外层', '内层']);

    const { request } = mergeChain(chain);
    assert.equal(request.header.parameter.length, 1);
  } finally {
    cleanup(env.base);
  }
});

test('继承：端到端发送时全局 header 与 raw body 变量都生效', async () => {
  const env = makeTempRoot();
  const fake = await startFakeServer();
  try {
    const target = boot(env.root, env.projectId);
    pointEnvTo(target, '2503d4840ac010', fake.url);
    writeCurrentEnvId(target, '2503d4840ac010');
    upsertEnvVariable(target, { envId: '2503d4840ac010', key: 'who', value: 'alice' });

    writeGlobalParams(target, { header: [param('X-Test', 'global-header')] });
    const api = makeApi(target, {
      url: '{{base}}/query',
      method: 'GET',
      request: { header: { parameter: [param('X-Test', 'api-header')] }, body: { mode: 'none', parameter: [] } }
    });

    const { runApi } = await import('../src/exec/runner.js');
    const summary = await runApi({
      officialRoot: env.root,
      projectId: env.projectId,
      targetId: api.id,
      input: {},
      source: 'mcp',
      fetchImpl: globalThis.fetch
    });
    assert.equal(summary.status, 'passed', summary.error);

    const call = fake.calls.find((c) => c.path === '/query');
    assert.equal(call.headers['x-test'], 'api-header', '接口层覆盖全局');
  } finally {
    await fake.close();
    cleanup(env.base);
  }
});
