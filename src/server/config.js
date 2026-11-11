import { readJson, writeJsonAtomic, ensureDir } from '../util/fsx.js';
import { configPath, ownRoot, detectOfficialRoot, defaultOfficialRoot, migrateLegacyOwnRoot } from '../store/paths.js';
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

export function resolveRoots(config, { dataRoot } = {}) {
  // 显式参数 > 环境变量 > 配置文件 > 默认探测
  const officialRoot = detectOfficialRoot({ explicit: dataRoot, config });
  return { officialRoot };
}

export function publicConfig(config) {
  const { token, ui_token, ...rest } = config;
  return {
    ...rest,
    has_token: Boolean(token),
    has_ui_token: Boolean(ui_token),
    config_path: configPath(),
    default_data_root: defaultOfficialRoot()
  };
}

export function regenerateToken(config) {
  config.token = makeToken(24);
  return saveConfig(config);
}
