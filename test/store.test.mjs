import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, cleanup, makeContext } from './helpers.mjs';
import { openProject } from '../src/store/target.js';
import {
  listApis,
  createApiOrFolder,
  readApiFile,
  makeParameter,
  buildEmptyAuth,
  buildBlankBody,
  deleteApis,
  TARGET_TYPE
} from '../src/store/apis.js';
import {
  listEnvironments,
  createEnvironment,
  getEnvironmentVariables,
  upsertEnvVariable,
  sharedServers,
  createEnvironmentServer,
  listEnvironmentServers,
  getGlobalVariables,
  upsertGlobalVariable,
  readGlobalVarsHistory
} from '../src/store/envs.js';
import { listProjects, createProject } from '../src/store/projects.js';
import { createFlow, getFlow, listFlows } from '../src/store/flows.js';
import { listRuns, saveRun, getRun } from '../src/store/runs.js';

test('存储：读写直连官方目录，不再经过工作区', () => {
  const env = makeTempRoot();
  try {
    const target = openProject({ dataRoot: env.root, projectId: env.projectId });

    // project 区 -> offline-data；local 区 -> offline-data-local
    assert.equal(target.abs('project/project.json'), path.join(env.root, 'offline-data', env.projectId, 'project.json'));
    assert.equal(
      target.abs('local/env_vars_history.json'),
      path.join(env.root, 'offline-data-local', 'projects', env.projectId, 'env_vars_history.json')
    );

    const api = createApiOrFolder(target, { name: '直连接口', method: 'GET', url: 'https://api.test/direct' });
    const officialFile = path.join(env.root, 'offline-data', env.projectId, 'apis', `${api.target_id}.json`);
    assert.ok(fs.existsSync(officialFile), '写入应直接落在官方目录');

    const official = JSON.parse(fs.readFileSync(officialFile, 'utf8'));
    assert.equal(official.data.name, '直连接口');

    // 越界路径一律拒绝
    assert.throws(() => target.abs('project/../../escape.json'), /路径越界/);
    assert.throws(() => target.abs('unknown-area/x.json'), /路径越界/);
  } finally {
    cleanup(env.base);
  }
});

test('存储：项目列表与新建项目骨架', () => {
  const env = makeTempRoot();
  try {
    const projects = listProjects(env.root);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, '测试项目');

    const created = createProject(env.root, { name: '新项目A' });
    assert.match(created.project_id, /^[0-9a-f]{14}$/);

    const after = listProjects(env.root);
    assert.equal(after.length, 2);
    assert.ok(fs.existsSync(path.join(created.path, 'apis', 'index.json')));
    assert.ok(fs.existsSync(path.join(created.path, 'envs', '1.json')));
    assert.ok(fs.existsSync(path.join(created.path, 'executions', 'flows', 'index.json')));
  } finally {
    cleanup(env.base);
  }
});

test('存储：建接口、读详情、删除级联', () => {
  const env = makeTempRoot();
  try {
    const target = openProject({ dataRoot: env.root, projectId: env.projectId });

    const folder = createApiOrFolder(target, { name: '用户模块', targetType: TARGET_TYPE.FOLDER });
    assert.equal(folder.target_type, 'folder');

    const api = createApiOrFolder(target, {
      name: '创建用户',
      parentId: folder.target_id,
      method: 'POST',
      url: 'https://api.test/users'
    });

    const file = readApiFile(target, api.target_id);
    assert.equal(file.data.method, 'POST');
    assert.equal(file.data.url, 'https://api.test/users');
    assert.equal(file.data.parent_id, folder.target_id);

    const list = listApis(target, {});
    assert.equal(list.length, 2);

    const filtered = listApis(target, { parentId: folder.target_id });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].target_id, api.target_id);

    const kw = listApis(target, { keyword: '创建' });
    assert.equal(kw.length, 1);

    const deleted = deleteApis(target, [folder.target_id]);
    assert.equal(deleted.deleted_ids.length, 2);
    assert.equal(listApis(target, {}).length, 0);
  } finally {
    cleanup(env.base);
  }
});

test('存储：环境 CRUD、共享服务、变量双写', () => {
  const env = makeTempRoot();
  try {
    const target = openProject({ dataRoot: env.root, projectId: env.projectId });

    const envs = listEnvironments(target);
    assert.equal(envs.length, 2);

    const created = createEnvironment(target, { name: '预发环境', baseUrl: 'https://pre.example.com' });
    assert.equal(created.name, '预发环境');
    assert.equal(created.server_list[0].uri, 'https://pre.example.com');

    const servers = sharedServers(target);
    assert.ok(servers.some((s) => s.server_id === '1'));

    const newServer = createEnvironmentServer(target, { name: 'auth', envId: created.env_id, baseUrl: 'https://auth.example.com' });
    const listed = listEnvironmentServers(target, created.env_id);
    const authServer = listed.servers.find((s) => s.server_id === newServer.server_id);
    assert.equal(authServer.base_url, 'https://auth.example.com');

    // 变量：默认值写 env 文件，运行时值写 local history
    upsertEnvVariable(target, { envId: created.env_id, key: 'token', value: 'default-token', currentValue: 'runtime-token' });
    const vars = getEnvironmentVariables(target, created.env_id);
    const tokenVar = vars.variables.find((v) => v.key === 'token');
    assert.equal(tokenVar.value, 'default-token');
    assert.equal(tokenVar.current_value, 'runtime-token');

    const history = target.readJson('local/env_vars_history.json');
    assert.equal(history[created.env_id].token.value, 'runtime-token');
  } finally {
    cleanup(env.base);
  }
});

test('存储：当前值留空时回落到默认值，不把默认值压成空', () => {
  const env = makeTempRoot();
  try {
    const target = openProject({ dataRoot: env.root, projectId: env.projectId });

    // 环境变量：控制台整表保存时，空的当前值会以 '' 传进来
    upsertEnvVariable(target, { envId: '1', key: 'token', value: 'jwt-abc', currentValue: '' });
    let vars = getEnvironmentVariables(target, '1').variables;
    assert.equal(vars.find((v) => v.key === 'token').current_value, 'jwt-abc');
    assert.equal(target.readJson('local/env_vars_history.json')['1'].token.value, 'jwt-abc');

    // 全局变量：走 upsert 单条保存，同样是空串
    upsertGlobalVariable(target, { key: 'token', value: 'jwt-abc', currentValue: '' });
    vars = getGlobalVariables(target).variables;
    assert.equal(vars.find((v) => v.key === 'token').current_value, 'jwt-abc');
    assert.equal(readGlobalVarsHistory(target).token.value, 'jwt-abc');

    // 历史里已经存在空串脏数据时，读取要自动丢弃，执行侧拿到的仍是默认值
    target.writeJson('local/global_vars_history.json', { token: { value: '' } });
    target.writeJson('local/env_vars_history.json', { 1: { token: { value: '' } } });
    assert.equal(readGlobalVarsHistory(target).token, undefined);
    assert.equal(getGlobalVariables(target).variables.find((v) => v.key === 'token').current_value, 'jwt-abc');

    // 显式写了非空当前值，仍以当前值为准
    upsertGlobalVariable(target, { key: 'token', value: 'jwt-abc', currentValue: 'jwt-runtime' });
    assert.equal(getGlobalVariables(target).variables.find((v) => v.key === 'token').current_value, 'jwt-runtime');
    assert.equal(readGlobalVarsHistory(target).token.value, 'jwt-runtime');
  } finally {
    cleanup(env.base);
  }
});

test('存储：控制台读回再保存不会把运行时值固化成脏数据', () => {
  const env = makeTempRoot();
  try {
    const target = openProject({ dataRoot: env.root, projectId: env.projectId });

    // 默认值有值、当前值留空：history 里不应该出现空串
    upsertGlobalVariable(target, { key: 'token', value: 'jwt-abc', currentValue: '' });
    assert.deepEqual(readGlobalVarsHistory(target), { token: { value: 'jwt-abc' } });

    // 前端是 GET 后整表 POST 回来：current_value 是回落的生效值，不应改变语义
    const readBack = () => getGlobalVariables(target).variables.find((v) => v.key === 'token');
    const first = readBack();
    upsertGlobalVariable(target, { key: first.key, value: first.value, currentValue: first.current_value });
    assert.deepEqual(readGlobalVarsHistory(target), { token: { value: 'jwt-abc' } });

    // 用户改默认值、前端仍把旧的当前值一起回传：未动过当前值，要跟着新默认值走
    const second = readBack();
    upsertGlobalVariable(target, { key: 'token', value: 'jwt-NEW', currentValue: second.current_value });
    assert.deepEqual(readGlobalVarsHistory(target), { token: { value: 'jwt-NEW' } });
    assert.equal(readBack().current_value, 'jwt-NEW');

    // 用户明确把当前值改成别的值，改默认值不能覆盖它
    upsertGlobalVariable(target, { key: 'token', value: 'jwt-NEW', currentValue: 'runtime-manual' });
    upsertGlobalVariable(target, { key: 'token', value: 'jwt-NEW2', currentValue: 'runtime-manual' });
    assert.equal(readBack().current_value, 'runtime-manual');
    assert.equal(readBack().value, 'jwt-NEW2');
  } finally {
    cleanup(env.base);
  }
});

test('存储：执行计划 CRUD 保留 step_id 快照', () => {
  const env = makeTempRoot();
  try {
    const target = openProject({ dataRoot: env.root, projectId: env.projectId });

    const api = createApiOrFolder(target, { name: 'ping', method: 'GET', url: 'https://api.test/ping' });
    const snapshot = readApiFile(target, api.target_id).data;

    const flow = createFlow(target, {
      name: '冒烟流程',
      steps: [{ step_id: 'step_a', target_id: api.target_id, api_snapshot: snapshot, input: {} }]
    });
    assert.equal(flow.steps.length, 1);

    const loaded = getFlow(target, flow.flow_id);
    assert.equal(loaded.name, '冒烟流程');
    assert.equal(loaded.steps[0].api_snapshot.name, 'ping');

    assert.equal(listFlows(target).length, 1);
  } finally {
    cleanup(env.base);
  }
});

test('存储：执行记录裁剪到 50 条', () => {
  const env = makeTempRoot();
  try {
    const target = openProject({ dataRoot: env.root, projectId: env.projectId });

    for (let i = 0; i < 55; i += 1) {
      saveRun(target, {
        run_id: `run_${1000 + i}`,
        project_id: env.projectId,
        source: 'mcp',
        scope: 'api',
        environment_id: '1',
        status: 'passed',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        elapsed_ms: 5,
        steps: []
      });
    }
    const { runs, total } = listRuns(target, { limit: 50 });
    assert.equal(total, 50);
    assert.equal(runs.length, 50);
    assert.equal(runs[0].run_id, 'run_1054');
    // 被淘汰的详情文件应被删除
    assert.equal(target.exists('project/executions/runs/run_1000.json'), false);
  } finally {
    cleanup(env.base);
  }
});

test('存储：敏感字段打码', async () => {
  const { redact } = await import('../src/store/runs.js');
  const masked = redact({ headers: { Authorization: 'Bearer secret', 'X-Normal': 'ok' }, token: 'abc', nested: { password: 'p' } });
  assert.equal(masked.headers.Authorization, '***');
  assert.equal(masked.headers['X-Normal'], 'ok');
  assert.equal(masked.token, '***');
  assert.equal(masked.nested.password, '***');
});
