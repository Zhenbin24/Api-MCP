import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { exists, isDir, ensureDir, readJson, writeJsonAtomic } from '../util/fsx.js';

/** 官方单机版 userData 目录名 */
const OFFICIAL_APP_DIR = 'Apipost单机版';
/** 本软件自身配置目录 */
const OWN_APP_DIR = 'ApiMCP';
/** 旧版配置目录，首次启动时把配置迁移过来 */
const LEGACY_OWN_APP_DIR = 'ApiPostMCP';

export function appDataRoot() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

export function defaultOfficialRoot() {
  return path.join(appDataRoot(), OFFICIAL_APP_DIR);
}

/** 旧版配置目录（不带任何环境变量覆盖） */
export function legacyOwnRoot() {
  return path.join(appDataRoot(), LEGACY_OWN_APP_DIR);
}

export function ownRoot() {
  return (
    process.env.APIMCP_HOME ||
    process.env.APIPOST_MCP_HOME ||
    path.join(appDataRoot(), OWN_APP_DIR)
  );
}

export function configPath() {
  return (
    process.env.APIMCP_CONFIG ||
    process.env.APIPOST_MCP_CONFIG ||
    path.join(ownRoot(), 'config.json')
  );
}

/**
 * 旧配置目录迁移：ApiPostMCP → ApiMCP。
 *
 * 只在「用户没显式指定目录 + 新目录不存在 + 旧目录存在」时执行一次，
 * 复制 config.json 与 desktop-window.json（token 等身份信息因此保留）。
 * 旧目录里的 workspace/ 是已删除的影子同步功能遗留，不迁移。
 *
 * @returns {{migrated: boolean, from: string, to: string}}
 */
export function migrateLegacyOwnRoot() {
  const skipped = { migrated: false, from: legacyOwnRoot(), to: ownRoot() };
  // 显式指定目录时说明用户自己管理，不去动它
  if (process.env.APIMCP_HOME || process.env.APIPOST_MCP_HOME) return skipped;
  if (process.env.APIMCP_CONFIG || process.env.APIPOST_MCP_CONFIG) return skipped;

  const from = legacyOwnRoot();
  const to = ownRoot();
  if (from === to) return skipped;
  if (isDir(to) || !isDir(from)) return skipped;

  try {
    ensureDir(to);
    for (const name of ['config.json', 'desktop-window.json']) {
      const src = path.join(from, name);
      if (!exists(src)) continue;
      fs.copyFileSync(src, path.join(to, name));
    }
    return { migrated: true, from, to };
  } catch {
    // 迁移失败不应阻断启动，回落到「新目录为空 → 新生成配置」
    return { migrated: false, from, to };
  }
}

/**
 * 数据根：包含 offline-data / offline-data-local / offline-projects.json 的目录。
 * 探测顺序：显式参数 > 环境变量 > 配置 > %APPDATA%\Apipost单机版 > 逐个候选探测。
 */
export function detectOfficialRoot({ explicit, config } = {}) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.APIPOST_DATA_ROOT) candidates.push(process.env.APIPOST_DATA_ROOT);
  if (config?.data_root) candidates.push(config.data_root);
  candidates.push(defaultOfficialRoot());

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isOfficialRoot(resolved)) return resolved;
  }
  // 都没命中：返回默认路径（让上层给出可读错误），但若显式传入则原样返回
  return path.resolve(explicit || config?.data_root || process.env.APIPOST_DATA_ROOT || defaultOfficialRoot());
}

export function isOfficialRoot(dir) {
  if (!dir || !isDir(dir)) return false;
  return exists(path.join(dir, 'offline-projects.json')) || isDir(path.join(dir, 'offline-data'));
}

export function projectsIndexPath(root) {
  return path.join(root, 'offline-projects.json');
}

export function localDir(root) {
  return path.join(root, 'offline-data-local');
}

export function localMetaPath(root) {
  return path.join(localDir(root), 'meta.json');
}

export function localTeamsPath(root) {
  return path.join(localDir(root), 'teams.json');
}

export function localSettingsDir(root) {
  return path.join(localDir(root), 'settings');
}

export function localProjectDir(root, projectId = '') {
  return projectId
    ? path.join(localDir(root), 'projects', projectId)
    : path.join(localDir(root), 'projects');
}

export function localEnvVarsHistoryPath(root, projectId) {
  return path.join(localProjectDir(root, projectId), 'env_vars_history.json');
}

export function localGlobalVarsHistoryPath(root, projectId) {
  return path.join(localProjectDir(root, projectId), 'global_vars_history.json');
}

export function dataDir(root) {
  return path.join(root, 'offline-data');
}

export function projectDir(root, projectId) {
  return path.join(dataDir(root), projectId);
}

export function projectMetaPath(root, projectId) {
  return path.join(projectDir(root, projectId), 'project.json');
}

export function apisDir(root, projectId) {
  return path.join(projectDir(root, projectId), 'apis');
}

export function apisIndexPath(root, projectId) {
  return path.join(apisDir(root, projectId), 'index.json');
}

export function apiFilePath(root, projectId, targetId) {
  return path.join(apisDir(root, projectId), `${targetId}.json`);
}

export function envsDir(root, projectId) {
  return path.join(projectDir(root, projectId), 'envs');
}

export function envsIndexPath(root, projectId) {
  return path.join(envsDir(root, projectId), 'index.json');
}

export function envFilePath(root, projectId, envId) {
  return path.join(envsDir(root, projectId), `${envId}.json`);
}

export function globalVarsPath(root, projectId) {
  return path.join(projectDir(root, projectId), 'global_vars.json');
}

export function globalParamsPath(root, projectId) {
  return path.join(projectDir(root, projectId), 'global_params.json');
}

export function settingsDir(root, projectId) {
  return path.join(projectDir(root, projectId), 'settings');
}

export function executionsDir(root, projectId) {
  return path.join(projectDir(root, projectId), 'executions');
}

export function flowsDir(root, projectId) {
  return path.join(executionsDir(root, projectId), 'flows');
}

export function flowsIndexPath(root, projectId) {
  return path.join(flowsDir(root, projectId), 'index.json');
}

export function flowFilePath(root, projectId, flowId) {
  return path.join(flowsDir(root, projectId), `${flowId}.json`);
}

export function runsDir(root, projectId) {
  return path.join(executionsDir(root, projectId), 'runs');
}

export function runsIndexPath(root, projectId) {
  return path.join(runsDir(root, projectId), 'index.json');
}

export function runFilePath(root, projectId, runId) {
  return path.join(runsDir(root, projectId), `${runId}.json`);
}

export function loadConfig() {
  return readJson(configPath(), null);
}

export function saveConfig(config) {
  ensureDir(path.dirname(configPath()));
  writeJsonAtomic(configPath(), config);
  return config;
}

export function officialMtime(root) {
  try {
    return fs.statSync(path.join(root, 'offline-projects.json')).mtimeMs;
  } catch {
    return 0;
  }
}
