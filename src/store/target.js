import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  exists,
  isDir,
  listDir,
  removeFile,
  writeFileAtomic
} from '../util/fsx.js';
import { localProjectDir, projectDir } from './paths.js';

/**
 * 项目访问器：直接读写 Apipost 单机版官方目录。
 * 相对路径约定：
 *   `project/**` -> `offline-data/{pid}/**`
 *   `local/**`   -> `offline-data-local/projects/{pid}/**`
 * 例：`project/apis/index.json`、`local/env_vars_history.json`
 */
const AREA_PROJECT = 'project';
const AREA_LOCAL = 'local';

export class ProjectTarget {
  constructor({ dataRoot, projectId }) {
    if (!dataRoot) throw new Error('缺少 dataRoot');
    if (!projectId) throw new Error('缺少 project_id');
    this.dataRoot = dataRoot;
    this.projectId = projectId;
    this.roots = {
      [AREA_PROJECT]: projectDir(dataRoot, projectId),
      [AREA_LOCAL]: localProjectDir(dataRoot, projectId)
    };
  }

  /** 把 `area/rel` 解析成绝对路径（跨区目录，各自独立做越界校验） */
  abs(relPath) {
    const rel = String(relPath || '').replace(/^\/+/, '');
    if (!rel) return path.resolve(this.roots[AREA_PROJECT]);
    const [area, ...rest] = rel.split('/');
    const base = this.roots[area];
    if (!base) throw new Error(`路径越界: ${relPath}`);
    const tail = rest.join('/');
    const abs = path.resolve(base, tail.split('/').join(path.sep));
    const root = path.resolve(base);
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

export function openProject({ dataRoot, projectId }) {
  return new ProjectTarget({ dataRoot, projectId });
}

export { AREA_PROJECT, AREA_LOCAL };
