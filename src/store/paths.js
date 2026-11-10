import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { exists, isDir, ensureDir, readJson, writeJsonAtomic } from '../util/fsx.js';

/** 官方单机版 userData 目录名 */
const OFFICIAL_APP_DIR = 'Apipost单机版';
/** 本软件自身配置目录 */
const OWN_APP_DIR = 'ApiPostMCP';

export function appDataRoot() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

export function defaultOfficialRoot() {
  return path.join(appDataRoot(), OFFICIAL_APP_DIR);
}

export function ownRoot() {
  return process.env.APIPOST_MCP_HOME || path.join(appDataRoot(), OWN_APP_DIR);
}

export function defaultShadowRoot() {
  return path.join(ownRoot(), 'workspace');
}

export function configPath() {
  return process.env.APIPOST_MCP_CONFIG || path.join(ownRoot(), 'config.json');
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

/** 影子目录下某个项目的根 */
export function shadowProjectDir(shadowRoot, projectId) {
  return path.join(shadowRoot, projectId);
}

export function shadowManifestPath(shadowRoot, projectId) {
  return path.join(shadowRoot, `${projectId}.manifest.json`);
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
