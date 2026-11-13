import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { exists, isDir, ensureDir, readJson, writeJsonAtomic } from '../util/fsx.js';
import { hexId } from '../util/ids.js';

/** 本软件自身配置目录 */
const OWN_APP_DIR = 'ApiMCP';
/** 旧版配置目录，首次启动时把配置迁移过来 */
const LEGACY_OWN_APP_DIR = 'ApiPostMCP';
/** 数据目录名（挂在 ownRoot 下，与 config.json 同级） */
const DATA_DIR = 'data';

export function appDataRoot() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/**
 * 本软件自身的数据根。
 * 默认 %APPDATA%\ApiMCP\data；设了 APIMCP_HOME 则跟着配置目录走，便于做成绿色版。
 */
export function defaultDataRoot() {
  return path.join(ownRoot(), DATA_DIR);
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
 * 解析数据根：只做路径解析，不创建目录也不校验内容。
 *
 * 顺序：显式参数 > APIMCP_DATA_ROOT > 旧环境变量 APIPOST_DATA_ROOT > 配置文件 > 默认目录。
 */
export function resolveDataRoot({ explicit, config } = {}) {
  const pick =
    explicit ||
    process.env.APIMCP_DATA_ROOT ||
    process.env.APIPOST_DATA_ROOT ||
    config?.data_root ||
    defaultDataRoot();
  return path.resolve(String(pick));
}

/**
 * 幂等初始化数据根：缺什么补什么，已存在的内容一律不动。
 *
 * 骨架结构（沿用原有序列化格式，只是换了根目录）：
 *   offline-projects.json          项目索引（数组）
 *   offline-data/                  各项目数据
 *   offline-data-local/meta.json   默认团队等本地元信息
 *   offline-data-local/teams.json  团队列表
 *
 * @returns {string} 解析后的绝对路径
 */
export function ensureDataRoot(dir = defaultDataRoot()) {
  const root = path.resolve(String(dir));
  ensureDir(root);
  ensureDir(dataDir(root));
  ensureDir(localDir(root));

  if (!exists(projectsIndexPath(root))) writeJsonAtomic(projectsIndexPath(root), []);

  // team_id 必须先算出来，再分别写两个文件，否则 meta 与 teams 会对不上
  const teamsFile = localTeamsPath(root);
  const metaFile = localMetaPath(root);
  let teamId = '';
  if (!exists(teamsFile)) {
    teamId = hexId(new Set());
    writeJsonAtomic(teamsFile, [{ created_at: new Date().toISOString(), name: '默认团队', team_id: teamId }]);
  }
  if (!exists(metaFile)) {
    const teams = teamId ? [{ team_id: teamId }] : readJson(teamsFile, []);
    writeJsonAtomic(metaFile, {
      default_team_id: teamId || teams?.[0]?.team_id || hexId(new Set())
    });
  }
  return root;
}

/** 目录是否可写（状态接口用来区分「没权限」与「有权限但还空」） */
export function canWriteDir(dir) {
  if (!dir) return false;
  const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
  try {
    ensureDir(dir);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    try {
      if (exists(probe)) fs.unlinkSync(probe);
    } catch {}
    return false;
  }
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

export function projectsIndexMtime(root) {
  try {
    return fs.statSync(projectsIndexPath(root)).mtimeMs;
  } catch {
    return 0;
  }
}
