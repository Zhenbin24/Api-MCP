import { readJson, writeJsonAtomic, ensureDir, exists } from '../util/fsx.js';
import {
  configPath,
  ownRoot,
  resolveDataRoot,
  ensureDataRoot,
  defaultDataRoot,
  migrateLegacyOwnRoot,
  projectsIndexPath
} from '../store/paths.js';
import { ensureDefaultProject } from '../store/projects.js';
import { token as makeToken } from '../util/ids.js';

export const DEFAULT_PORT = 39100;

export function defaultConfig() {
  return {
    // MCP 服务默认关闭，需在控制台「总览」手动启用后才对外提供能力
    enabled: false,
    host: '127.0.0.1',
    port: DEFAULT_PORT,
    token: makeToken(24),
    ui_token: makeToken(18),
    data_root: null,
    allowed_project_ids: [],
    allow_write: true,
    allow_execute: true,
    preferred_env: {},
    theme: 'golden',
    theme_custom_bg: '',
    follow_system_theme: false,
    font_scale: 100,
    nav_order: [],
    // AI 辅助：OpenAI 兼容接口，Key 明文存本机 config.json（服务只监听 127.0.0.1 且需 ui_token）
    ai: {
      enabled: false,
      base_url: 'https://api.openai.com/v1',
      api_key: '',
      model: 'gpt-4o-mini',
      timeout_ms: 60000
    },
    last_connected_at: '',
    updated_at: new Date().toISOString(),
    version: 1
  };
}

export function loadConfig() {
  // 老版本配置目录（ApiPostMCP）→ 新目录（ApiMCP），只在首次启动时迁移一次
  migrateLegacyOwnRoot();
  const stored = readJson(configPath(), null);
  const base = defaultConfig();
  if (!stored || typeof stored !== 'object') return base;
  return {
    ...base,
    ...stored,
    token: stored.token || base.token,
    ui_token: stored.ui_token || base.ui_token,
    preferred_env: stored.preferred_env && typeof stored.preferred_env === 'object' ? stored.preferred_env : {},
    allowed_project_ids: Array.isArray(stored.allowed_project_ids) ? stored.allowed_project_ids.map(String) : []
  };
}

export function saveConfig(config) {
  ensureDir(ownRoot());
  const next = { ...config, updated_at: new Date().toISOString() };
  writeJsonAtomic(configPath(), next);
  return next;
}

/**
 * 解析并初始化数据根：显式参数 > 环境变量 > 配置文件 > 默认目录。
 *
 * 首次启动会自动建出骨架（offline-projects.json / offline-data / offline-data-local），
 * 并播种一个默认项目，因此不再依赖本机是否装过 Apipost 单机版，也不会一进来就是空列表。
 *
 * @returns {{dataRoot: string, created: boolean}}
 */
export function resolveRoots(config, { dataRoot } = {}) {
  const resolved = resolveDataRoot({ explicit: dataRoot, config });
  // 首次初始化：项目索引还不存在。比「目录是否存在」更准——
  // 目录可能被手动建过，或上次异常退出只建出目录却没建索引。
  const firstInit = !exists(projectsIndexPath(resolved));
  const root = ensureDataRoot(resolved);
  // 必须在 ensureDataRoot 之后：createProject 依赖 meta.json 里的 default_team_id
  if (firstInit) ensureDefaultProject(root);
  return { dataRoot: root, created: firstInit };
}

export function publicConfig(config) {
  const { token, ui_token, ...rest } = config;
  // 绝不下发 api_key：只告诉前端「有没有配」，前端据此决定是否提示去配置
  const ai = { ...(config.ai || {}) };
  const hasAiKey = Boolean(ai.api_key);
  delete ai.api_key;
  return {
    ...rest,
    ai: { ...ai, has_api_key: hasAiKey },
    has_token: Boolean(token),
    has_ui_token: Boolean(ui_token),
    config_path: configPath(),
    default_data_root: defaultDataRoot()
  };
}

/**
 * 写入 AI 配置。
 * api_key 语义：undefined 表示不修改，空字符串表示清空，其它值表示替换。
 */
export function updateAiConfig(config, patch = {}) {
  const current = config.ai || {};
  const next = { ...current };

  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.base_url !== undefined) next.base_url = String(patch.base_url || '').trim();
  if (patch.model !== undefined) next.model = String(patch.model || '').trim();
  if (patch.timeout_ms !== undefined) {
    next.timeout_ms = Math.max(5000, Math.min(300000, Number(patch.timeout_ms) || 60000));
  }
  if (patch.api_key !== undefined) {
    const key = String(patch.api_key == null ? '' : patch.api_key);
    // 传空字符串 = 清空；传 undefined 由外面挡住（不改）
    next.api_key = key;
  }

  config.ai = next;
  return saveConfig(config);
}

export function regenerateToken(config) {
  config.token = makeToken(24);
  return saveConfig(config);
}
