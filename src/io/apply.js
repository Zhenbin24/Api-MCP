/**
 * 导入落库核心：把「扁平的接口列表」写进项目。
 *
 * 三条导入路径（MCP 的 apimcp_sync_openapi、MCP 的 apimcp_import_project、
 * 控制台的 POST /api/projects/:id/import）都走这里，保证判定规则只有一份。
 */

import {
  listApiItems,
  readApiFile,
  createApiOrFolder,
  deleteApis,
  findApiItem,
  readApiIndex,
  writeApiFile,
  collectDescendantApiIds,
  buildEmptyAuth,
  buildBlankBody,
  TARGET_TYPE
} from '../store/apis.js';

/** 允许的覆盖方式 */
export const COVER_MODES = ['url_and_folder', 'url', 'ignore', 'both', 'clear'];

/**
 * 校验并归一化覆盖方式
 * @param {string} [mode]
 * @returns {string}
 */
export function normalizeCoverMode(mode) {
  const coverMode = mode || 'url_and_folder';
  if (!COVER_MODES.includes(coverMode)) {
    throw new Error(`api_cover_mode 无效：${coverMode}，可选 ${COVER_MODES.join('/')}`);
  }
  return coverMode;
}

/**
 * 校验目标目录：必须是本项目里的 folder，或 '0' 表示根
 * @param {object} target ProjectTarget
 * @param {string} folderId
 * @returns {string}
 */
export function assertFolderId(target, folderId) {
  const id = String(folderId || '0');
  if (id === '0') return id;
  const folder = findApiItem(target, id);
  if (!folder || folder.target_type !== TARGET_TYPE.FOLDER) {
    throw new Error('未找到指定的导入目录，请检查 folder_id 是否为项目内目录的 target_id');
  }
  return id;
}

/** 把 api_scripts 数组转成 method+url -> scripts 的 Map */
export function buildScriptMap(apiScripts) {
  const scriptMap = new Map();
  for (const item of apiScripts || []) {
    if (!item || typeof item !== 'object') continue;
    const method = String(item.method || '').toUpperCase();
    const url = String(item.url || '');
    if (!method || !url) continue;
    scriptMap.set(`${method}_${url}`, item);
  }
  return scriptMap;
}

/**
 * 把一批接口写进项目。
 *
 * @param {object} target ProjectTarget
 * @param {object} options
 * @param {string} options.projectId
 * @param {Array} options.items  形如 [{ name, method, url, folderPath, description, tags, request, response }]
 * @param {string} [options.folderId='0']
 * @param {string} [options.coverMode='url_and_folder']
 * @param {Map<string, object>} [options.scriptMap]
 * @returns {{ created: Array, updated: Array, skipped: Array, deleted: Array }}
 */
export function applyImportItems(target, { projectId, items, folderId = '0', coverMode = 'url_and_folder', scriptMap = new Map() } = {}) {
  const mode = normalizeCoverMode(coverMode);
  const rootFolderId = assertFolderId(target, folderId);

  const index = readApiIndex(target);
  const now = new Date().toISOString();
  const results = { created: [], updated: [], skipped: [], deleted: [] };

  // clear：先清空目标范围内的接口（目录本身保留）
  if (mode === 'clear') {
    const toDelete =
      rootFolderId === '0'
        ? index.items.filter((i) => i.target_type === TARGET_TYPE.API).map((i) => i.target_id)
        : collectDescendantApiIds(target, rootFolderId);
    if (toDelete.length > 0) {
      const outcome = deleteApis(target, toDelete);
      results.deleted = outcome.deleted_ids || [];
      // 重新读取索引
      index.items = readApiIndex(target).items;
    }
  }

  const folderCache = new Map();

  /** 按目录名链路建目录，返回最终父目录 id */
  const ensureFolderPath = (names) => {
    if (!names || names.length === 0) return rootFolderId;
    let parentId = rootFolderId;
    for (const name of names) {
      const key = `${parentId}/${name}`;
      if (folderCache.has(key)) {
        parentId = folderCache.get(key);
        continue;
      }
      let existing = index.items.find(
        (i) => i.target_type === TARGET_TYPE.FOLDER && i.parent_id === parentId && i.name === name
      );
      if (!existing) {
        const created = createApiOrFolder(target, { name, parentId, targetType: TARGET_TYPE.FOLDER });
        index.items = readApiIndex(target).items;
        existing = index.items.find((i) => i.target_id === created.target_id);
      }
      folderCache.set(key, existing.target_id);
      parentId = existing.target_id;
    }
    return parentId;
  };

  for (const item of items) {
    const parentId = ensureFolderPath(item.folderPath);
    const method = String(item.method || 'GET').toUpperCase();
    const url = item.url;

    const sameUrlAndFolder = index.items.find(
      (i) =>
        i.target_type === TARGET_TYPE.API &&
        String(i.method || '').toUpperCase() === method &&
        i.url === url &&
        i.parent_id === parentId
    );
    const sameUrl = index.items.find(
      (i) => i.target_type === TARGET_TYPE.API && String(i.method || '').toUpperCase() === method && i.url === url
    );

    const scripts = scriptMap.get(`${method}_${url}`);
    const preTask = scripts?.pre_script
      ? { name: '', type: 'customScript', data: String(scripts.pre_script), enabled: 1, id: `${Date.now()}p` }
      : null;
    const postTask = scripts?.post_script
      ? { name: '', type: 'customScript', data: String(scripts.post_script), enabled: 1, id: `${Date.now()}q` }
      : null;

    const buildDetail = (targetId, existingData) => ({
      ...(existingData || {}),
      attribute_info: existingData?.attribute_info || {},
      description: item.description || existingData?.description || '',
      is_locked: -1,
      mark_id: existingData?.mark_id || '1',
      method,
      name: item.name,
      parent_id: parentId,
      project_id: projectId,
      protocol: 'http/1.1',
      request: {
        auth: existingData?.request?.auth || item.request?.auth || buildEmptyAuth(),
        body: item.request?.body || buildBlankBody(),
        cookie: item.request?.cookie || { parameter: [] },
        header: item.request?.header || { parameter: [] },
        post_tasks: postTask
          ? [...(existingData?.request?.post_tasks || []).filter((t) => t?.id !== postTask.id), postTask]
          : existingData?.request?.post_tasks || [],
        pre_tasks: preTask
          ? [...(existingData?.request?.pre_tasks || []).filter((t) => t?.id !== preTask.id), preTask]
          : existingData?.request?.pre_tasks || [],
        query: item.request?.query || { parameter: [] },
        restful: item.request?.restful || { parameter: [] }
      },
      response: item.response,
      sort: existingData?.sort ?? 1000,
      status: 1,
      tags: item.tags || [],
      target_id: targetId,
      target_type: TARGET_TYPE.API,
      url,
      version: (existingData?.version || 1) + 1
    });

    if (mode === 'ignore') {
      if (sameUrl) {
        results.skipped.push({ method, url, reason: '已存在相同方法和 URL' });
        continue;
      }
    } else if (mode === 'url_and_folder') {
      if (sameUrlAndFolder) {
        const existingFile = readApiFile(target, sameUrlAndFolder.target_id);
        writeApiFile(target, sameUrlAndFolder.target_id, buildDetail(sameUrlAndFolder.target_id, existingFile?.data), {
          ...sameUrlAndFolder,
          name: item.name,
          updated_at: now
        });
        index.items = readApiIndex(target).items;
        results.updated.push({ target_id: sameUrlAndFolder.target_id, method, url });
        continue;
      }
    } else if (mode === 'url') {
      if (sameUrl) {
        const existingFile = readApiFile(target, sameUrl.target_id);
        writeApiFile(target, sameUrl.target_id, buildDetail(sameUrl.target_id, existingFile?.data), {
          ...sameUrl,
          name: item.name,
          updated_at: now
        });
        index.items = readApiIndex(target).items;
        results.updated.push({ target_id: sameUrl.target_id, method, url });
        continue;
      }
    }
    // both / clear / 未命中 -> 新建

    const created = createApiOrFolder(target, {
      name: item.name,
      parentId,
      targetType: TARGET_TYPE.API,
      method,
      url,
      detail: {
        ...item,
        request: {
          ...item.request,
          pre_tasks: preTask ? [preTask] : [],
          post_tasks: postTask ? [postTask] : []
        }
      }
    });
    index.items = readApiIndex(target).items;
    results.created.push({ target_id: created.target_id, method, url });
  }

  return results;
}

/** 数一下一批 items 里有多少个不同的目录链路（预览用） */
export function countFolders(items) {
  const seen = new Set();
  for (const item of items || []) {
    const path = item.folderPath || [];
    let prefix = '';
    for (const name of path) {
      prefix = prefix ? `${prefix}/${name}` : name;
      seen.add(prefix);
    }
  }
  return seen.size;
}

export { listApiItems };
