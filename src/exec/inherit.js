/**
 * 参数继承：把「全局参数 → 祖先目录 → 接口自身」合并成一次请求实际使用的配置。
 *
 * 规则（与官方语义一致）：
 * - header / query / cookie：按 key 求并集，内层覆盖外层；内层 is_checked === -1 表示禁用该 key
 * - body：取最内层 mode !== 'none' 的一层；内层为 form-data / urlencoded 且外层同模式时按 key 并集
 * - auth：从内往外找第一个 type !== 'inherit'；都没有则 noauth
 * - pre_tasks：外 → 内拼接；post_tasks：内 → 外拼接
 * - 目录的 server_id 指向环境里的某个共享服务，用于替换默认前置 URL
 */
import { readGlobalParams } from '../store/globals.js';
import { findApiItem, readApiFile } from '../store/apis.js';
import { TARGET_TYPE } from '../store/apis.js';

const SECTION_KEYS = ['header', 'query', 'cookie'];
const FORM_BODY_MODES = new Set(['form-data', 'urlencoded']);

function paramList(section) {
  if (!section) return [];
  if (Array.isArray(section)) return section;
  return Array.isArray(section.parameter) ? section.parameter : [];
}

function activeList(section) {
  return paramList(section).filter((p) => p && String(p.key ?? '').trim() !== '');
}

/** 沿 parent_id 往上收集目录祖先，返回由外到内 */
function folderChain(target, parentId) {
  const chain = [];
  const seen = new Set();
  let current = String(parentId || '0');
  while (current && current !== '0' && !seen.has(current)) {
    seen.add(current);
    const item = findApiItem(target, current);
    if (!item) break;
    const file = readApiFile(target, current);
    if (file?.data) chain.unshift({ targetId: current, name: item.name || '', data: file.data });
    current = String(item.parent_id || '0');
  }
  return chain;
}

/**
 * 构建继承链路（外 → 内）：全局参数 → 目录祖先 → 接口自身
 * @returns {Array<{level: string, name: string, targetId?: string, request: object, serverId?: string}>}
 */
export function resolveChain(target, apiDetail) {
  const chain = [];

  const globalParams = readGlobalParams(target);
  if (hasContent(globalParams)) {
    chain.push({ level: 'global', name: '全局参数', request: globalParams, serverId: '0' });
  }

  for (const folder of folderChain(target, apiDetail?.parent_id)) {
    const request = folder.data.request || {};
    if (hasContent(request) || String(folder.data.server_id || '0') !== '0') {
      chain.push({
        level: 'folder',
        name: folder.name || '目录',
        targetId: folder.targetId,
        request,
        serverId: String(folder.data.server_id || '0')
      });
    }
  }

  chain.push({
    level: 'api',
    name: apiDetail?.name || '接口',
    targetId: apiDetail?.target_id || '',
    request: apiDetail?.request || {},
    serverId: '0'
  });

  return chain;
}

function hasContent(request) {
  if (!request || typeof request !== 'object') return false;
  for (const key of SECTION_KEYS) {
    if (activeList(request[key]).length > 0) return true;
  }
  const body = request.body;
  if (body && (String(body.mode || 'none') !== 'none' || activeList(body).length > 0)) return true;
  if (request.auth && String(request.auth.type || 'noauth') !== 'noauth') return true;
  if ((request.pre_tasks || []).length > 0) return true;
  if ((request.post_tasks || []).length > 0) return true;
  return false;
}

/**
 * 合并参数表：外 → 内逐层覆盖；内层 is_checked === -1 表示从结果中删除该 key。
 */
function mergeSections(chain, name) {
  const merged = new Map();
  for (const layer of chain) {
    for (const raw of paramList(layer.request?.[name])) {
      const key = String(raw?.key ?? '').trim();
      if (!key) continue;
      const disabled = Number(raw?.is_checked) === -1;
      const checked = Number(raw?.is_checked) === 0 ? 1 : Number(raw?.is_checked ?? 1);
      if (disabled) {
        merged.delete(key);
        continue;
      }
      const prev = merged.get(key);
      merged.set(key, {
        ...(prev || {}),
        ...raw,
        key,
        is_checked: Number.isFinite(checked) && checked !== -1 ? 1 : 1,
        source: layer.level
      });
    }
  }
  return [...merged.values()];
}

function mergeBody(chain) {
  let mode = 'none';
  let parameter = [];
  let raw = '';
  let binary = null;
  let source = '';

  for (const layer of chain) {
    const body = layer.request?.body;
    if (!body || typeof body !== 'object') continue;
    const layerMode = String(body.mode || 'none');
    if (layerMode === 'none') continue;

    if (FORM_BODY_MODES.has(layerMode)) {
      if (mode === layerMode) {
        // 同模式：按 key 并集，内层覆盖
        const merged = new Map(parameter.map((p) => [String(p.key ?? ''), p]));
        for (const p of paramList(body)) {
          const key = String(p?.key ?? '').trim();
          if (!key) continue;
          if (Number(p?.is_checked) === -1) {
            merged.delete(key);
            continue;
          }
          merged.set(key, { ...(merged.get(key) || {}), ...p, key, is_checked: 1, source: layer.level });
        }
        parameter = [...merged.values()];
      } else {
        // 模式不同：内层整体接管
        mode = layerMode;
        parameter = paramList(body)
          .filter((p) => p && String(p.key ?? '').trim() && Number(p.is_checked) !== -1)
          .map((p) => ({ ...p, is_checked: 1, source: layer.level }));
      }
      source = layer.level;
      raw = '';
      binary = null;
      continue;
    }

    // raw / binary / graphql：内层直接胜出，不做合并
    mode = layerMode;
    parameter = [];
    raw = String(body.raw ?? '');
    binary = body.binary ? { ...body.binary } : null;
    source = layer.level;
  }

  const out = { mode, parameter, raw, source };
  if (binary) out.binary = binary;
  return out;
}

function mergeAuth(chain) {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const auth = chain[i].request?.auth;
    if (!auth || typeof auth !== 'object') continue;
    const type = String(auth.type || 'noauth');
    if (type === 'inherit') continue;
    if (type === 'noauth') return { auth: { ...auth, type: 'noauth' }, source: chain[i].level };
    return { auth: { ...auth }, source: chain[i].level };
  }
  return { auth: { type: 'noauth' }, source: '' };
}

function collectTasks(chain, name) {
  const out = [];
  for (const layer of chain) {
    for (const task of layer.request?.[name] || []) {
      if (!task || typeof task !== 'object') continue;
      out.push({ ...task, __source: layer.level });
    }
  }
  return out;
}

/**
 * 合并整条链路。
 * @returns {{request: object, sources: object}}
 */
export function mergeChain(chain) {
  const header = mergeSections(chain, 'header');
  const query = mergeSections(chain, 'query');
  const cookie = mergeSections(chain, 'cookie');
  const body = mergeBody(chain);
  const { auth, source: authSource } = mergeAuth(chain);
  // 前置脚本外 → 内；后置脚本内 → 外
  const preTasks = collectTasks(chain, 'pre_tasks');
  const postTasks = collectTasks([...chain].reverse(), 'post_tasks');

  const request = {
    auth,
    body,
    cookie: { parameter: cookie },
    header: { parameter: header },
    post_tasks: postTasks,
    pre_tasks: preTasks,
    query: { parameter: query, query_add_equal: 1 }
  };

  return {
    request,
    sources: {
      header: uniqSources(header),
      query: uniqSources(query),
      cookie: uniqSources(cookie),
      body: body.source ? [body.source] : [],
      auth: authSource ? [authSource] : [],
      pre_tasks: uniqSources(preTasks),
      post_tasks: uniqSources(postTasks)
    }
  };
}

function uniqSources(list) {
  return [...new Set((list || []).map((item) => item.source || item.__source).filter(Boolean))];
}

/** 目录指定的服务 → 该环境下的前置 URL；未指定则用默认服务（server_id = 1） */
export function resolveBaseUrl(target, apiDetail, env) {
  const servers = env?.server_list || [];
  const pickDefault = () => servers.find((s) => String(s.server_id) === '1')?.uri || '';

  // 从内往外找第一个设了服务的目录
  for (const folder of folderChain(target, apiDetail?.parent_id).reverse()) {
    const serverId = String(folder.data.server_id || '0');
    if (serverId === '0' || !serverId) continue;
    const server = servers.find((s) => String(s.server_id) === serverId);
    if (server && String(server.uri || '').trim()) return String(server.uri);
  }
  return pickDefault();
}

/**
 * 一次性算出「实际要发的请求配置 + 前置 URL」。
 * @returns {{request: object, sources: object, baseUrl: string}}
 */
export function buildEffectiveRequest(target, apiDetail, env) {
  const chain = resolveChain(target, apiDetail);
  const { request, sources } = mergeChain(chain);
  return {
    request,
    sources,
    baseUrl: resolveBaseUrl(target, apiDetail, env)
  };
}

export { TARGET_TYPE };
