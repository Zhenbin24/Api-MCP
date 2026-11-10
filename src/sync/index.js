import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  exists,
  isDir,
  listDir,
  listFilesRecursive,
  readJson,
  removeDir,
  removeFile,
  sha256File,
  writeJsonAtomic,
  writeFileAtomic
} from '../util/fsx.js';
import {
  localProjectDir,
  projectDir,
  shadowManifestPath,
  shadowProjectDir
} from '../store/paths.js';

/**
 * 影子工作区目录结构（每个项目一份）：
 *   workspace/{pid}/project/**          <- 对应官方 offline-data/{pid}/**
 *   workspace/{pid}/local/**            <- 对应官方 offline-data-local/projects/{pid}/**
 *   workspace/{pid}.manifest.json       <- 三方比对基线
 */

const AREA_PROJECT = 'project';
const AREA_LOCAL = 'local';

export const SYNC_STATE = {
  NOT_PULLED: 'not_pulled',
  SYNCED: 'synced',
  AHEAD: 'ahead',
  BEHIND: 'behind',
  DIVERGED: 'diverged'
};

function areaRoots(officialRoot, shadowRoot, projectId) {
  return {
    [AREA_PROJECT]: {
      official: projectDir(officialRoot, projectId),
      shadow: path.join(shadowProjectDir(shadowRoot, projectId), AREA_PROJECT)
    },
    [AREA_LOCAL]: {
      official: localProjectDir(officialRoot, projectId),
      shadow: path.join(shadowProjectDir(shadowRoot, projectId), AREA_LOCAL)
    }
  };
}

/** 收集两侧所有相对路径（`area/rel` 形式），附带 sha256。 */
function snapshotSide(roots, side) {
  const out = new Map();
  for (const [area, dirs] of Object.entries(roots)) {
    const base = dirs[side];
    if (!isDir(base)) continue;
    for (const rel of listFilesRecursive(base)) {
      const abs = path.join(base, rel.split('/').join(path.sep));
      const hash = sha256File(abs);
      if (hash) out.set(`${area}/${rel}`, { hash, abs });
    }
  }
  return out;
}

export function readManifest(shadowRoot, projectId) {
  return readJson(shadowManifestPath(shadowRoot, projectId), null);
}

function writeManifest(shadowRoot, projectId, manifest) {
  writeJsonAtomic(shadowManifestPath(shadowRoot, projectId), manifest);
  return manifest;
}

export function isPulled(shadowRoot, projectId) {
  const manifest = readManifest(shadowRoot, projectId);
  return Boolean(manifest && manifest.files);
}

/**
 * 计算三方比对结果。
 * base: 上次 pull/push 时的文件哈希
 * official: 官方现况
 * shadow: 影子现况
 */
export function diffProject(officialRoot, shadowRoot, projectId) {
  const manifest = readManifest(shadowRoot, projectId);
  if (!manifest) {
    return { state: SYNC_STATE.NOT_PULLED, entries: [], manifest: null };
  }
  const roots = areaRoots(officialRoot, shadowRoot, projectId);
  const baseFiles = manifest.files || {};
  const official = snapshotSide(roots, 'official');
  const shadow = snapshotSide(roots, 'shadow');

  const keys = new Set([
    ...Object.keys(baseFiles),
    ...official.keys(),
    ...shadow.keys()
  ]);

  const entries = [];
  for (const key of [...keys].sort()) {
    const baseHash = baseFiles[key]?.sha256 || null;
    const officialHash = official.get(key)?.hash || null;
    const shadowHash = shadow.get(key)?.hash || null;
    if (baseHash === officialHash && baseHash === shadowHash) continue;

    const officialChanged = officialHash !== baseHash;
    const shadowChanged = shadowHash !== baseHash;

    let kind;
    if (!baseHash && officialHash && !shadowHash) kind = 'official_added';
    else if (!baseHash && !officialHash && shadowHash) kind = 'shadow_added';
    else if (baseHash && !officialHash && shadowHash) kind = 'official_deleted';
    else if (baseHash && officialHash && !shadowHash) kind = 'shadow_deleted';
    else if (officialChanged && shadowChanged) kind = 'conflict';
    else if (officialChanged) kind = 'behind';
    else kind = 'ahead';

    entries.push({
      path: key,
      kind,
      base: baseHash,
      official: officialHash,
      shadow: shadowHash,
      official_changed: officialChanged,
      shadow_changed: shadowChanged
    });
  }

  const ahead = entries.some((e) => e.kind === 'ahead' || e.kind === 'shadow_added' || e.kind === 'shadow_deleted');
  const behind = entries.some((e) => e.kind === 'behind' || e.kind === 'official_added' || e.kind === 'official_deleted');
  let state = SYNC_STATE.SYNCED;
  if (entries.some((e) => e.kind === 'conflict')) state = SYNC_STATE.DIVERGED;
  else if (ahead && behind) state = SYNC_STATE.DIVERGED;
  else if (ahead) state = SYNC_STATE.AHEAD;
  else if (behind) state = SYNC_STATE.BEHIND;

  return { state, entries, manifest };
}

/** 把官方目录整树复制到影子（含 local 区），并写入基线。 */
export function pullProject(officialRoot, shadowRoot, projectId, { force = false } = {}) {
  const roots = areaRoots(officialRoot, shadowRoot, projectId);
  const shadowBase = shadowProjectDir(shadowRoot, projectId);
  const manifest = readManifest(shadowRoot, projectId);

  if (manifest && !force) {
    const { entries } = diffProject(officialRoot, shadowRoot, projectId);
    const blocking = entries.filter(
      (e) => e.kind === 'conflict' || e.kind === 'ahead' || e.kind === 'shadow_added' || e.kind === 'shadow_deleted'
    );
    if (blocking.length > 0) {
      const err = new Error(
        `影子工作区存在 ${blocking.length} 处未推送的本地改动，pull 会丢弃它们。请先 push，或用 force 覆盖。`
      );
      err.code = 'SHADOW_DIRTY';
      err.entries = blocking;
      throw err;
    }
  }

  ensureDir(shadowBase);
  const files = {};

  for (const [area, dirs] of Object.entries(roots)) {
    const shadowArea = dirs.shadow;
    removeDir(shadowArea);
    ensureDir(shadowArea);
    if (!isDir(dirs.official)) continue;
    for (const rel of listFilesRecursive(dirs.official)) {
      const src = path.join(dirs.official, rel.split('/').join(path.sep));
      const dest = path.join(shadowArea, rel.split('/').join(path.sep));
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      const hash = sha256File(dest);
      if (hash) files[`${area}/${rel}`] = { sha256: hash };
    }
  }

  const now = new Date().toISOString();
  return writeManifest(shadowRoot, projectId, {
    project_id: projectId,
    official_root: officialRoot,
    shadow_root: shadowBase,
    pulled_at: now,
    updated_at: now,
    files
  });
}

/**
 * 把影子改动推回官方。
 * selections: { [relPath]: 'shadow' | 'official' } 用于解决冲突；未指定冲突则整体失败。
 */
export function pushProject(officialRoot, shadowRoot, projectId, { selections = {}, dryRun = false } = {}) {
  const diff = diffProject(officialRoot, shadowRoot, projectId);
  if (diff.state === SYNC_STATE.NOT_PULLED) {
    throw new Error('影子工作区尚未拉取，请先执行 pull。');
  }

  const roots = areaRoots(officialRoot, shadowRoot, projectId);
  const plan = [];
  const unresolved = [];

  for (const entry of diff.entries) {
    if (entry.kind === 'behind' || entry.kind === 'official_added' || entry.kind === 'official_deleted') {
      continue; // 官方更新，push 不处理
    }
    if (entry.kind === 'conflict') {
      const pick = selections[entry.path];
      if (!pick) {
        unresolved.push(entry);
        continue;
      }
      if (pick === 'official') continue;
      plan.push({ ...entry, action: entry.shadow ? 'write' : 'delete' });
      continue;
    }
    // ahead / shadow_added / shadow_deleted
    plan.push({ ...entry, action: entry.shadow ? 'write' : 'delete' });
  }

  if (unresolved.length > 0) {
    const err = new Error(`存在 ${unresolved.length} 个冲突文件未选择保留侧`);
    err.code = 'SYNC_CONFLICT';
    err.entries = unresolved;
    throw err;
  }

  const applied = [];
  if (!dryRun) {
    for (const item of plan) {
      const [area, ...rest] = item.path.split('/');
      const rel = rest.join('/');
      const dirs = roots[area];
      if (!dirs) continue;
      const target = path.join(dirs.official, rel.split('/').join(path.sep));
      if (item.action === 'delete') {
        removeFile(target);
        applied.push({ path: item.path, action: 'delete' });
      } else {
        const src = path.join(dirs.shadow, rel.split('/').join(path.sep));
        ensureDir(path.dirname(target));
        fs.copyFileSync(src, target);
        applied.push({ path: item.path, action: 'write' });
      }
    }
  }

  // 重建基线（dryRun 不动基线）
  let manifest = readManifest(shadowRoot, projectId);
  if (!dryRun) {
    const files = { ...(manifest?.files || {}) };
    for (const item of plan) {
      if (item.action === 'delete') delete files[item.path];
      else files[item.path] = { sha256: item.shadow };
    }
    // 官方侧仍有、影子已删且基线已不存在的，清理基线
    manifest = writeManifest(shadowRoot, projectId, {
      ...(manifest || {}),
      project_id: projectId,
      official_root: officialRoot,
      shadow_root: shadowProjectDir(shadowRoot, projectId),
      updated_at: new Date().toISOString(),
      files
    });
  }

  return {
    applied,
    planned: plan.map((p) => ({ path: p.path, action: p.action })),
    dry_run: Boolean(dryRun),
    remaining: dryRun ? null : diffProject(officialRoot, shadowRoot, projectId).state,
    manifest_updated_at: manifest?.updated_at || null
  };
}

/** 丢弃影子本地改动，重新从官方拉取。 */
export function discardShadowChanges(officialRoot, shadowRoot, projectId) {
  return pullProject(officialRoot, shadowRoot, projectId, { force: true });
}

/** 读取影子中的文件内容（不存在则返回 fallback）。 */
export function readShadowText(shadowRoot, projectId, relPath, fallback = null) {
  const abs = path.join(shadowProjectDir(shadowRoot, projectId), relPath.split('/').join(path.sep));
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return fallback;
  }
}

export function readShadowJson(shadowRoot, projectId, relPath, fallback = null) {
  const text = readShadowText(shadowRoot, projectId, relPath);
  if (text == null || text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function writeShadowText(shadowRoot, projectId, relPath, content) {
  const abs = path.join(shadowProjectDir(shadowRoot, projectId), relPath.split('/').join(path.sep));
  writeFileAtomic(abs, content);
  return abs;
}

export function writeShadowJson(shadowRoot, projectId, relPath, data) {
  return writeShadowText(shadowRoot, projectId, relPath, `${JSON.stringify(data, null, 2)}\n`);
}

export function shadowFileExists(shadowRoot, projectId, relPath) {
  const abs = path.join(shadowProjectDir(shadowRoot, projectId), relPath.split('/').join(path.sep));
  return exists(abs);
}

export function listShadowDir(shadowRoot, projectId, relPath = '') {
  const abs = path.join(shadowProjectDir(shadowRoot, projectId), relPath.split('/').join(path.sep));
  return listDir(abs);
}

export { AREA_PROJECT, AREA_LOCAL };
