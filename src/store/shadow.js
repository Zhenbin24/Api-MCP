import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  exists,
  isDir,
  listDir,
  readJson,
  removeFile,
  writeFileAtomic,
  writeJsonAtomic
} from '../util/fsx.js';
import { shadowProjectDir } from './paths.js';
import { AREA_PROJECT, AREA_LOCAL } from '../sync/index.js';

/**
 * 影子项目访问器。
 * 相对路径约定：`project/apis/index.json`、`local/env_vars_history.json`
 * 所有写操作只落在影子目录，官方目录保持只读。
 */
export class ShadowProject {
  constructor({ shadowRoot, projectId }) {
    if (!shadowRoot) throw new Error('缺少 shadowRoot');
    if (!projectId) throw new Error('缺少 project_id');
    this.shadowRoot = shadowRoot;
    this.projectId = projectId;
    this.base = shadowProjectDir(shadowRoot, projectId);
  }

  abs(relPath) {
    const rel = String(relPath || '').replace(/^\/+/, '');
    const abs = path.resolve(this.base, rel.split('/').join(path.sep));
    const root = path.resolve(this.base);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`路径越界: ${relPath}`);
    }
    return abs;
  }

  exists(relPath) {
    return exists(this.abs(relPath));
  }

  readText(relPath, fallback = null) {
    try {
      return fs.readFileSync(this.abs(relPath), 'utf8');
    } catch {
      return fallback;
    }
  }

  readJson(relPath, fallback = null) {
    const text = this.readText(relPath);
    if (text == null || text.trim() === '') return fallback;
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  }

  writeText(relPath, content) {
    const abs = this.abs(relPath);
    writeFileAtomic(abs, content);
    return abs;
  }

  writeJson(relPath, data) {
    return this.writeText(relPath, `${JSON.stringify(data, null, 2)}\n`);
  }

  remove(relPath) {
    return removeFile(this.abs(relPath));
  }

  list(relPath = '') {
    return listDir(this.abs(relPath));
  }

  isDir(relPath) {
    return isDir(this.abs(relPath));
  }

  ensureDir(relPath = '') {
    const abs = this.abs(relPath);
    ensureDir(abs);
    return abs;
  }

  /** project 区相对路径糖 */
  p(relPath) {
    return `${AREA_PROJECT}/${relPath}`;
  }

  /** local 区相对路径糖 */
  l(relPath) {
    return `${AREA_LOCAL}/${relPath}`;
  }

  now() {
    return new Date().toISOString();
  }
}

export function openShadow({ shadowRoot, projectId }) {
  return new ShadowProject({ shadowRoot, projectId });
}
