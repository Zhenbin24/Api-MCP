import { hexId } from '../util/ids.js';

const ENV_INDEX_REL = 'project/envs/index.json';

function envRelPath(envId) {
  return `project/envs/${envId}.json`;
}

export function readEnvIndex(target) {
  const index = target.readJson(ENV_INDEX_REL, null);
  if (!index || !Array.isArray(index.items)) return { project_id: target.projectId, items: [] };
  return index;
}

function writeEnvIndex(target, index) {
  target.writeJson(ENV_INDEX_REL, { project_id: target.projectId, items: index.items || [] });
  return index;
}

export function readEnv(target, envId) {
  return target.readJson(envRelPath(envId), null);
}

function writeEnv(target, env) {
  target.writeJson(envRelPath(env.env_id), env);
  return env;
}

export function listEnvironments(target) {
  const index = readEnvIndex(target);
  const envs = [];
  for (const item of index.items) {
    const detail = readEnv(target, item.env_id);
    if (detail) envs.push(detail);
  }
  envs.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  return envs;
}

export function assertEnv(target, envId) {
  if (!envId) throw new Error('缺少 environment_id');
  const env = readEnv(target, envId);
  if (!env) {
    throw new Error(`环境不存在：${envId}，请先用 apipost_list_environments 查询可选环境`);
  }
  return env;
}

export function envBaseUrl(env) {
  const server = (env?.server_list || []).find((s) => String(s.server_id) === '1');
  return server?.uri || '';
}

export function shapeEnv(env, currentEnvId) {
  return {
    env_id: env.env_id,
    name: env.name || env.env_id,
    is_current: env.env_id === currentEnvId,
    base_url: envBaseUrl(env)
  };
}

export function createEnvironment(target, { name, baseUrl } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('缺少环境名称 name');
  const index = readEnvIndex(target);
  const ids = new Set(index.items.map((i) => i.env_id));
  const envId = hexId(ids);
  const now = target.now();

  // 共享服务沿用项目已有服务定义
  const shared = sharedServers(target);
  const serverList = shared.length
    ? shared.map((s) => ({
        name: s.name,
        server_id: s.server_id,
        sort: s.sort ?? 1000,
        uri: String(s.server_id) === '1' && baseUrl !== undefined ? String(baseUrl || '') : ''
      }))
    : [{ name: 'default', server_id: '1', sort: 1000, uri: String(baseUrl || '') }];

  const detail = {
    created_at: now,
    env_id: envId,
    env_var_list: {},
    is_private: -1,
    name: trimmed,
    project_id: target.projectId,
    server_list: serverList,
    sort: (index.items.length + 1) * 1000,
    updated_at: now
  };
  writeEnv(target, detail);
  index.items.push({ env_id: envId, name: trimmed, sort: detail.sort, updated_at: now });
  writeEnvIndex(target, index);
  return detail;
}

export function updateEnvironment(target, envId, { name, baseUrl } = {}) {
  const env = assertEnv(target, envId);
  if (name !== undefined) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('环境名称不能为空');
    env.name = trimmed;
  }
  if (baseUrl !== undefined) {
    const list = env.server_list || [];
    const target1 = list.find((s) => String(s.server_id) === '1');
    if (target1) target1.uri = String(baseUrl || '');
    else list.unshift({ name: 'default', server_id: '1', sort: 1000, uri: String(baseUrl || '') });
    env.server_list = list;
  }
  env.updated_at = target.now();
  writeEnv(target, env);

  const index = readEnvIndex(target);
  const item = index.items.find((i) => i.env_id === envId);
  if (item) {
    if (name !== undefined) item.name = env.name;
    item.updated_at = env.updated_at;
    writeEnvIndex(target, index);
  }
  return env;
}

export function deleteEnvironment(target, envId) {
  const env = assertEnv(target, envId);
  if (String(envId) === '1') throw new Error('默认环境不可删除');
  target.remove(envRelPath(envId));
  const index = readEnvIndex(target);
  index.items = index.items.filter((i) => i.env_id !== envId);
  writeEnvIndex(target, index);

  // 清理运行时变量
  const history = readEnvVarsHistory(target);
  if (history[envId]) {
    delete history[envId];
    writeEnvVarsHistory(target, history);
  }
  return { deleted: true, env_id: envId };
}

/** 项目共享服务 = 各环境 server_list 按 server_id 去重合并 */
export function sharedServers(target) {
  const envs = listEnvironments(target);
  const map = new Map();
  for (const env of envs) {
    for (const server of env.server_list || []) {
      if (!map.has(server.server_id)) {
        map.set(server.server_id, {
          server_id: server.server_id,
          name: server.name || 'default',
          sort: server.sort ?? 1000
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
}

export function listEnvironmentServers(target, envId) {
  const shared = sharedServers(target);
  if (!envId) return { servers: shared.map((s) => ({ ...s, base_url: '' })) };
  const env = assertEnv(target, envId);
  const list = env.server_list || [];
  return {
    environment_id: envId,
    servers: list.map((s) => ({
      server_id: s.server_id,
      name: s.name || 'default',
      sort: s.sort ?? 1000,
      base_url: s.uri || ''
    }))
  };
}

export function createEnvironmentServer(target, { name, envId, baseUrl } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('缺少服务名称 name');
  const envs = listEnvironments(target);
  if (envs.length === 0) throw new Error('项目还没有环境，请先创建环境');

  const existingIds = new Set();
  for (const env of envs) for (const s of env.server_list || []) existingIds.add(s.server_id);
  const serverId = hexId(existingIds);
  const sort = Math.max(0, ...sharedServers(target).map((s) => Number(s.sort) || 0)) + 1000;

  for (const env of envs) {
    const list = env.server_list || [];
    list.push({
      name: trimmed,
      server_id: serverId,
      sort,
      uri: envId && env.env_id === envId ? String(baseUrl || '') : ''
    });
    env.server_list = list;
    env.updated_at = target.now();
    writeEnv(target, env);
  }
  return { server_id: serverId, name: trimmed, sort, base_url: envId ? String(baseUrl || '') : '' };
}

export function updateEnvironmentServer(target, { serverId, name, envId, baseUrl } = {}) {
  const envs = listEnvironments(target);
  const found = envs.some((env) => (env.server_list || []).some((s) => s.server_id === serverId));
  if (!found) throw new Error(`服务不存在：${serverId}`);

  for (const env of envs) {
    const list = env.server_list || [];
    const server = list.find((s) => s.server_id === serverId);
    if (!server) continue;
    if (name !== undefined) {
      const trimmed = String(name || '').trim();
      if (!trimmed) throw new Error('服务名称不能为空');
      server.name = trimmed;
    }
    if (baseUrl !== undefined) {
      if (!envId) throw new Error('修改 base_url 时必须同时传入 environment_id');
      if (env.env_id === envId) server.uri = String(baseUrl || '');
    }
    env.server_list = list;
    env.updated_at = target.now();
    writeEnv(target, env);
  }
  return { server_id: serverId, name, base_url: baseUrl };
}

export function deleteEnvironmentServer(target, serverId) {
  const envs = listEnvironments(target);
  const exists = envs.some((env) => (env.server_list || []).some((s) => s.server_id === serverId));
  if (!exists) throw new Error(`服务不存在：${serverId}`);
  if (String(serverId) === '1') throw new Error('默认服务 (server_id=1) 不可删除');

  for (const env of envs) {
    env.server_list = (env.server_list || []).filter((s) => s.server_id !== serverId);
    env.updated_at = target.now();
    writeEnv(target, env);
  }
  return { deleted: true, server_id: serverId };
}

/** 运行时变量历史（current_value），存在 local 区 */
export function readEnvVarsHistory(target) {
  return target.readJson(target.l('env_vars_history.json'), {}) || {};
}

export function writeEnvVarsHistory(target, data) {
  target.writeJson(target.l('env_vars_history.json'), data);
  return data;
}

export function readGlobalVarsHistory(target) {
  return target.readJson(target.l('global_vars_history.json'), {}) || {};
}

export function writeGlobalVarsHistory(target, data) {
  target.writeJson(target.l('global_vars_history.json'), data);
  return data;
}

export function readGlobalVars(target) {
  return target.readJson(target.p('global_vars.json'), {}) || {};
}

export function writeGlobalVars(target, data) {
  target.writeJson(target.p('global_vars.json'), data);
  return data;
}

/** 合并默认值与运行时值，输出 {key, value, current_value, description} */
export function mergeVariables(defaults = {}, runtime = {}) {
  const keys = new Set([...Object.keys(defaults || {}), ...Object.keys(runtime || {})]);
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const def = defaults[key] || {};
      const run = runtime[key] || {};
      return {
        key,
        value: def.value ?? '',
        current_value: run.value ?? def.current_value ?? def.value ?? '',
        description: def.description ?? ''
      };
    });
}

export function upsertEnvVariable(target, { envId, key, value, currentValue, description }) {
  const env = assertEnv(target, envId);
  const trimmed = String(key || '').trim();
  if (!trimmed) throw new Error('缺少变量名 key');

  const defaults = { ...(env.env_var_list || {}) };
  const history = readEnvVarsHistory(target);
  const envRuntime = { ...(history[envId] || {}) };
  const prev = defaults[trimmed] || {};

  const nextValue = value === undefined ? (prev.value ?? '') : value;
  const nextCurrent =
    currentValue === undefined ? (envRuntime[trimmed]?.value ?? prev.current_value ?? prev.value ?? '') : currentValue;

  defaults[trimmed] = {
    ...prev,
    value: nextValue,
    current_value: nextCurrent,
    description: description === undefined ? (prev.description ?? '') : String(description || '')
  };
  envRuntime[trimmed] = { value: nextCurrent };

  env.env_var_list = defaults;
  env.updated_at = target.now();
  writeEnv(target, env);
  history[envId] = envRuntime;
  writeEnvVarsHistory(target, history);

  return {
    variable: {
      key: trimmed,
      value: defaults[trimmed].value,
      current_value: nextCurrent,
      description: defaults[trimmed].description
    }
  };
}

export function deleteEnvVariable(target, { envId, key }) {
  const env = assertEnv(target, envId);
  const trimmed = String(key || '').trim();
  const defaults = { ...(env.env_var_list || {}) };
  const history = readEnvVarsHistory(target);
  const envRuntime = { ...(history[envId] || {}) };
  if (!(trimmed in defaults) && !(trimmed in envRuntime)) {
    throw new Error(`环境变量不存在：${trimmed}`);
  }
  delete defaults[trimmed];
  delete envRuntime[trimmed];
  env.env_var_list = defaults;
  env.updated_at = target.now();
  writeEnv(target, env);
  history[envId] = envRuntime;
  writeEnvVarsHistory(target, history);
  return { deleted: true, key: trimmed };
}

export function getEnvironmentVariables(target, envId) {
  const env = assertEnv(target, envId);
  const runtime = readEnvVarsHistory(target)[envId] || {};
  return {
    environment_id: envId,
    variables: mergeVariables(env.env_var_list || {}, runtime)
  };
}

export function getGlobalVariables(target) {
  const defaults = readGlobalVars(target);
  const runtime = readGlobalVarsHistory(target);
  return { variables: mergeVariables(defaults, runtime) };
}

export function upsertGlobalVariable(target, { key, value, currentValue, description }) {
  const trimmed = String(key || '').trim();
  if (!trimmed) throw new Error('缺少变量名 key');
  const defaults = { ...readGlobalVars(target) };
  const runtime = { ...readGlobalVarsHistory(target) };
  const prev = defaults[trimmed] || {};
  const nextValue = value === undefined ? (prev.value ?? '') : value;
  const nextCurrent =
    currentValue === undefined ? (runtime[trimmed]?.value ?? prev.current_value ?? prev.value ?? '') : currentValue;

  defaults[trimmed] = {
    ...prev,
    value: nextValue,
    current_value: nextCurrent,
    description: description === undefined ? (prev.description ?? '') : String(description || '')
  };
  runtime[trimmed] = { value: nextCurrent };

  writeGlobalVars(target, defaults);
  writeGlobalVarsHistory(target, runtime);
  return {
    variable: {
      key: trimmed,
      value: defaults[trimmed].value,
      current_value: nextCurrent,
      description: defaults[trimmed].description
    }
  };
}

export function deleteGlobalVariable(target, { key }) {
  const trimmed = String(key || '').trim();
  const defaults = { ...readGlobalVars(target) };
  const runtime = { ...readGlobalVarsHistory(target) };
  if (!(trimmed in defaults) && !(trimmed in runtime)) {
    throw new Error(`全局变量不存在：${trimmed}`);
  }
  delete defaults[trimmed];
  delete runtime[trimmed];
  writeGlobalVars(target, defaults);
  writeGlobalVarsHistory(target, runtime);
  return { deleted: true, key: trimmed };
}

export function ensureEnvFiles(target) {
  if (!target.exists('project/envs/index.json')) {
    writeEnvIndex(target, { project_id: target.projectId, items: [] });
  }
  return true;
}
