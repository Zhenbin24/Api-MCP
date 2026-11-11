/**
 * 窗口尺寸/位置持久化（纯 Node，不依赖 Electron）。
 *
 * 文件：%APPDATA%/ApiMCP/desktop-window.json
 * 结构：{ x, y, width, height, maximized }
 */
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../util/fsx.js';
import { ownRoot } from '../store/paths.js';

export const DEFAULT_WINDOW = {
  width: 1280,
  height: 840,
  minWidth: 960,
  minHeight: 600
};

export function windowStatePath() {
  return path.join(ownRoot(), 'desktop-window.json');
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * 校验状态是否落在某块可见屏幕内；不可信则丢弃位置（只保留尺寸）。
 *
 * @param {object} state
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas 屏幕可用区域
 */
export function sanitizeWindowState(state, workAreas = []) {
  if (!state || typeof state !== 'object') return null;

  const width = Number(state.width);
  const height = Number(state.height);
  const out = {
    width: Number.isFinite(width) ? clamp(Math.round(width), DEFAULT_WINDOW.minWidth, 10000) : DEFAULT_WINDOW.width,
    height: Number.isFinite(height) ? clamp(Math.round(height), DEFAULT_WINDOW.minHeight, 10000) : DEFAULT_WINDOW.height,
    maximized: Boolean(state.maximized)
  };

  const x = Number(state.x);
  const y = Number(state.y);
  if (Number.isFinite(x) && Number.isFinite(y) && workAreas.length > 0) {
    // 至少要有 80x40 的标题栏区域落在某块屏幕里，否则视为离线屏幕（拔掉副屏）
    const visible = workAreas.some(
      (area) =>
        x + 80 > area.x &&
        x < area.x + area.width &&
        y + 40 > area.y &&
        y < area.y + area.height
    );
    if (visible) {
      out.x = Math.round(x);
      out.y = Math.round(y);
    }
  }

  return out;
}

export function loadWindowState({ workAreas = [] } = {}) {
  const raw = readJson(windowStatePath(), null);
  return sanitizeWindowState(raw, workAreas);
}

export function saveWindowState(state, { workAreas = [] } = {}) {
  const safe = sanitizeWindowState(state, workAreas);
  if (!safe) return null;
  try {
    writeJsonAtomic(windowStatePath(), safe);
  } catch {
    // 持久化失败不应影响窗口使用
  }
  return safe;
}
