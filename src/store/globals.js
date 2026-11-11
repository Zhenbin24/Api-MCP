/**
 * 项目级「全局参数」（global_params.json）：对项目下所有接口生效。
 * 只存在工作区 project 区，随推送写回官方目录，与全局变量同一层级。
 */

const GLOBAL_PARAMS_REL = 'project/global_params.json';

export const GLOBAL_PARAM_SECTIONS = ['header', 'query', 'cookie', 'body', 'auth', 'pre_tasks', 'post_tasks'];

/** 全局参数 Body 仅支持这三种模式（对齐官方：全部 body 只支持 form-data / urlencoded） */
export const GLOBAL_BODY_MODES = ['none', 'form-data', 'urlencoded'];

export function defaultGlobalParams() {
  return {
    auth: { type: 'noauth' },
    body: { mode: 'none', parameter: [], raw: '' },
    cookie: { parameter: [] },
    header: { parameter: [] },
    post_tasks: [],
    pre_tasks: [],
    query: { parameter: [] }
  };
}

export function readGlobalParams(target) {
  const stored = target.readJson(GLOBAL_PARAMS_REL, null);
  const base = defaultGlobalParams();
  if (!stored || typeof stored !== 'object') return base;
  return {
    ...base,
    ...stored,
    auth: stored.auth && typeof stored.auth === 'object' ? stored.auth : base.auth,
    body: normalizeBody(stored.body),
    cookie: normalizeSection(stored.cookie),
    header: normalizeSection(stored.header),
    query: normalizeSection(stored.query),
    post_tasks: Array.isArray(stored.post_tasks) ? stored.post_tasks : [],
    pre_tasks: Array.isArray(stored.pre_tasks) ? stored.pre_tasks : []
  };
}

function normalizeSection(section) {
  if (!section || typeof section !== 'object') return { parameter: [] };
  return { ...section, parameter: Array.isArray(section.parameter) ? section.parameter : [] };
}

function normalizeBody(body) {
  if (!body || typeof body !== 'object') return { mode: 'none', parameter: [], raw: '' };
  const mode = GLOBAL_BODY_MODES.includes(String(body.mode)) ? String(body.mode) : 'none';
  return {
    ...body,
    mode,
    parameter: Array.isArray(body.parameter) ? body.parameter : [],
    raw: String(body.raw ?? '')
  };
}

/** 归一化一个参数项，保证前端/导入来的脏数据不会破坏结构 */
function normalizeParam(item, fallbackType = 'String') {
  return {
    ...item,
    description: String(item.description ?? ''),
    field_type: String(item.field_type || fallbackType),
    is_checked: Number(item.is_checked) === -1 ? -1 : 1,
    key: String(item.key ?? ''),
    not_null: Number(item.not_null) === 1 ? 1 : -1,
    param_id: String(item.param_id || `p_${Math.random().toString(16).slice(2, 10)}`),
    value: item.value ?? ''
  };
}

/**
 * 局部更新全局参数：只覆盖传入的 section。
 * - header / query / cookie：传数组即整体替换该 section 的参数表（传 null 表示清空）
 * - body：mode 与 parameter 支持单独传
 * - auth：浅合并
 * - pre_tasks / post_tasks：数组整体替换
 */
export function writeGlobalParams(target, patch = {}) {
  const current = readGlobalParams(target);
  const next = { ...current };

  for (const name of ['header', 'query', 'cookie']) {
    if (!(name in patch)) continue;
    const incoming = patch[name];
    const list = Array.isArray(incoming) ? incoming : incoming?.parameter;
    next[name] = { parameter: Array.isArray(list) ? list.filter(Boolean).map((p) => normalizeParam(p)) : [] };
  }

  if ('body' in patch && patch.body && typeof patch.body === 'object') {
    const merged = { ...current.body, ...patch.body };
    next.body = normalizeBody(merged);
    next.body.parameter = (next.body.parameter || []).filter(Boolean).map((p) => normalizeParam(p));
  }

  if ('auth' in patch && patch.auth && typeof patch.auth === 'object') {
    next.auth = { ...current.auth, ...patch.auth };
  }

  for (const name of ['pre_tasks', 'post_tasks']) {
    if (!(name in patch)) continue;
    const list = Array.isArray(patch[name]) ? patch[name] : [];
    next[name] = list.filter((t) => t && typeof t === 'object').map((t) => ({ ...t }));
  }

  target.writeJson(GLOBAL_PARAMS_REL, next);
  return next;
}
