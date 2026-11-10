import fs from 'node:fs';
import { readApiIndex } from './apis.js';
import { readRunsIndex } from './runs.js';

/**
 * 最近保存：按影子工作区里 apis/*.json 的文件 mtime 倒序。
 * 与 API 索引合并，拿到名称/方法/URL。
 */
export function listRecentlySaved(target, { limit = 50, keyword = '' } = {}) {
  const dirRel = 'project/apis';
  if (!target.isDir(dirRel)) return [];

  const index = readApiIndex(target);
  const byId = new Map((index.items || []).map((i) => [i.target_id, i]));
  const kw = String(keyword || '').trim().toLowerCase();
  const out = [];

  for (const name of target.list(dirRel)) {
    if (!name.endsWith('.json') || name === 'index.json') continue;
    const targetId = name.slice(0, -5);
    const abs = target.abs(`${dirRel}/${name}`);

    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }

    const item = byId.get(targetId);
    const entry = {
      target_id: targetId,
      target_type: item?.target_type || 'api',
      name: item?.name || targetId,
      method: String(item?.method || '').toUpperCase(),
      url: item?.url || '',
      parent_id: item?.parent_id || '0',
      saved_at: new Date(stat.mtimeMs).toISOString(),
      size: stat.size
    };

    if (kw) {
      const hay = `${entry.name} ${entry.url} ${entry.method}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    out.push(entry);
  }

  out.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
  return out.slice(0, limit);
}

/** 历史发送记录：执行历史摘要（最新优先） */
export function listRecentRuns(target, { limit = 50, keyword = '' } = {}) {
  const index = readRunsIndex(target);
  const kw = String(keyword || '').trim().toLowerCase();

  const records = (index.records || []).filter((r) => {
    if (!kw) return true;
    const hay = `${r.flow_name || ''} ${r.run_id || ''} ${r.status || ''} ${r.scope || ''}`.toLowerCase();
    return hay.includes(kw);
  });

  return records.slice(0, limit).map((r) => ({ ...r }));
}
