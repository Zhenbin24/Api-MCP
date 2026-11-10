import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, cleanup, makeContext } from './helpers.mjs';
import { pullProject, pushProject, diffProject, isPulled, SYNC_STATE } from '../src/sync/index.js';
import { openShadow } from '../src/store/shadow.js';
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
  listEnvironmentServers
} from '../src/store/envs.js';
import { listProjects, createProject } from '../src/store/projects.js';
import { createFlow, getFlow, listFlows } from '../src/store/flows.js';
import { listRuns, saveRun, getRun } from '../src/store/runs.js';

test('同步：pull 建立基线，官方只读', () => {
  const env = makeTempRoot();
  try {
    const manifest = pullProject(env.root, env.shadow, env.projectId);
    assert.equal(manifest.project_id, env.projectId);
    assert.ok(Object.keys(manifest.files).length > 5);
    assert.equal(isPulled(env.shadow, env.projectId), true);

    const diff = diffProject(env.root, env.shadow, env.projectId);
    assert.equal(diff.state, SYNC_STATE.SYNCED);
    assert.equal(diff.entries.length, 0);

    // 影子目录里应有 project/ 与 local/ 两个区
    const shadowBase = path.join(env.shadow, env.projectId);
    assert.ok(fs.existsSync(path.join(shadowBase, 'project', 'project.json')));
    assert.ok(fs.existsSync(path.join(shadowBase, 'local', 'env_vars_history.json')));
  } finally {
    cleanup(env.base);
  }
});

test('同步：影子改动 -> ahead -> push 写回官方', () => {
  const env = makeTempRoot();
  try {
    pullProject(env.root, env.shadow, env.projectId);
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });
    const project = target.readJson('project/project.json');
    target.writeJson('project/project.json', { ...project, name: '改过的名字' });

    const diff = diffProject(env.root, env.shadow, env.projectId);
    assert.equal(diff.state, SYNC_STATE.AHEAD);
    assert.equal(diff.entries.length, 1);
    assert.equal(diff.entries[0].kind, 'ahead');

    const result = pushProject(env.root, env.shadow, env.projectId);
    assert.equal(result.applied.length, 1);

    const official = JSON.parse(fs.readFileSync(path.join(env.root, 'offline-data', env.projectId, 'project.json'), 'utf8'));
    assert.equal(official.name, '改过的名字');
    assert.equal(diffProject(env.root, env.shadow, env.projectId).state, SYNC_STATE.SYNCED);
  } finally {
    cleanup(env.base);
  }
});

test('同步：官方改动 -> behind', () => {
  const env = makeTempRoot();
  try {
    pullProject(env.root, env.shadow, env.projectId);
    const officialPath = path.join(env.root, 'offline-data', env.projectId, 'project.json');
    const official = JSON.parse(fs.readFileSync(officialPath, 'utf8'));
    fs.writeFileSync(officialPath, JSON.stringify({ ...official, name: '官方改的' }, null, 2));

    const diff = diffProject(env.root, env.shadow, env.projectId);
    assert.equal(diff.state, SYNC_STATE.BEHIND);
    assert.equal(diff.entries[0].kind, 'behind');
  } finally {
    cleanup(env.base);
  }
});

test('同步：两侧都改 -> 冲突，未选择时拒绝推送', () => {
  const env = makeTempRoot();
  try {
    pullProject(env.root, env.shadow, env.projectId);
    const rel = 'project/project.json';
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });
    const shadowDoc = target.readJson(rel);
    target.writeJson(rel, { ...shadowDoc, name: '影子版' });

    const officialPath = path.join(env.root, 'offline-data', env.projectId, 'project.json');
    const official = JSON.parse(fs.readFileSync(officialPath, 'utf8'));
    fs.writeFileSync(officialPath, JSON.stringify({ ...official, name: '官方版' }, null, 2));

    const diff = diffProject(env.root, env.shadow, env.projectId);
    assert.equal(diff.state, SYNC_STATE.DIVERGED);
    assert.equal(diff.entries[0].kind, 'conflict');

    assert.throws(() => pushProject(env.root, env.shadow, env.projectId), /冲突文件未选择保留侧/);

    // 选择保留官方：不写入
    const keepOfficial = pushProject(env.root, env.shadow, env.projectId, { selections: { [rel]: 'official' } });
    assert.equal(keepOfficial.applied.length, 0);
    const afterOfficial = JSON.parse(fs.readFileSync(officialPath, 'utf8'));
    assert.equal(afterOfficial.name, '官方版');

    // 再选影子覆盖
    pullProject(env.root, env.shadow, env.projectId, { force: true });
    const t2 = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });
    t2.writeJson(rel, { ...t2.readJson(rel), name: '影子版' });
    const official2 = JSON.parse(fs.readFileSync(officialPath, 'utf8'));
    fs.writeFileSync(officialPath, JSON.stringify({ ...official2, name: '官方版2' }, null, 2));
    const pushShadow = pushProject(env.root, env.shadow, env.projectId, { selections: { [rel]: 'shadow' } });
    assert.equal(pushShadow.applied.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(officialPath, 'utf8')).name, '影子版');
  } finally {
    cleanup(env.base);
  }
});

test('同步：pull 拒绝丢弃未推送改动', () => {
  const env = makeTempRoot();
  try {
    pullProject(env.root, env.shadow, env.projectId);
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });
    target.writeJson('project/project.json', { ...target.readJson('project/project.json'), name: 'x' });
    assert.throws(() => pullProject(env.root, env.shadow, env.projectId), /未推送的本地改动/);
    // force 可以
    assert.ok(pullProject(env.root, env.shadow, env.projectId, { force: true }));
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
    pullProject(env.root, env.shadow, env.projectId);
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });

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
    pullProject(env.root, env.shadow, env.projectId);
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });

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

test('存储：执行计划 CRUD 保留 step_id 快照', () => {
  const env = makeTempRoot();
  try {
    pullProject(env.root, env.shadow, env.projectId);
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });

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
    pullProject(env.root, env.shadow, env.projectId);
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });

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
