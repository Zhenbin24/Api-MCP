/**
 * 可视化断言：把「数据源 + 表达式 + 条件 + 比较值」翻译成一条断言结果。
 *
 * 任务存在 request.post_tasks 里，结构见 newAssertTask()（前端 workspace.js 创建）：
 *   { id, type: 'assert', name, enabled: 1, data: { source, expression, condition, value, description } }
 *
 * 脚本执行器（script.js 的 collectScripts）只认 type === 'customScript'，
 * 所以这里的任务不会被误当脚本执行；反之脚本断言也照旧走 apt.test。
 *
 * 断言对象与既有 assertions[] 同构，多带 source / expression / expected / actual
 * 四个字段，供响应区做「期望值 → 实际值」对比。
 */
import { validateSchema, parseJsonSafe } from './assert.js';

/** 不需要比较值的条件 */
const NO_VALUE_CONDITIONS = new Set(['exists', 'empty', 'schema_match', 'schema_not_match']);

export const ASSERT_SOURCES = {
  status_code: '响应码',
  elapsed_time: '响应时间',
  content_type: 'Content-Type',
  response_header: 'Response Header',
  response_cookie: 'Response Cookie',
  response_json: 'Response JSON',
  response_text: 'Response Text',
  response_xml: 'Response XML',
  response_schema: 'Response Schema',
  var: '临时变量',
  env_var: '环境变量',
  global_var: '全局变量'
};

export const ASSERT_CONDITIONS = {
  equal: '等于',
  not_equal: '不等于',
  include: '包含',
  not_include: '不包含',
  regex: '正则匹配',
  gt: '大于',
  lt: '小于',
  gte: '大于等于',
  lte: '小于等于',
  length_equal: '长度等于',
  exists: '存在',
  empty: '为空',
  type_is: '类型为',
  schema_match: '结构匹配',
  schema_not_match: '结构不匹配'
};

const CONDITION_LABEL = ASSERT_CONDITIONS;
const SOURCE_LABEL = ASSERT_SOURCES;

/* ---------------- 轻量 JSONPath ---------------- */

/**
 * 解析极简 JSONPath。支持：
 *   $           根
 *   $.a.b       属性
 *   $['a']     带引号的属性
 *   $[0]        下标
 *   $[*]        通配（返回数组）
 *
 * 不支持过滤器、递归下降、切片——够覆盖断言里的常见写法，
 * 复杂场景请用后置脚本的 apt.expect。
 *
 * @returns {{ok: boolean, value?: any, error?: string}}
 */
export function evalJsonPath(root, expr) {
  const text = String(expr ?? '').trim();
  if (!text || text === '$') return { ok: true, value: root };

  if (!text.startsWith('$')) {
    return { ok: false, error: `JSONPath 必须以 $ 开头：${text}` };
  }

  let current = root;
  let i = 1;
  let wildcard = false;

  const fail = (message) => ({ ok: false, error: message });

  while (i < text.length) {
    const ch = text[i];

    if (ch === '.') {
      i += 1;
      if (text[i] === '.') return fail('不支持递归下降（..），请用具体路径');
      let name = '';
      while (i < text.length && /[^.[\]]/.test(text[i])) {
        name += text[i];
        i += 1;
      }
      if (name === '*') {
        wildcard = true;
        if (current == null || typeof current !== 'object') return { ok: true, value: [] };
        current = Object.values(current);
        continue;
      }
      if (!name) return fail(`路径在 ${i} 处缺少属性名`);
      if (current == null || typeof current !== 'object' || !(name in current)) {
        return { ok: true, value: undefined };
      }
      current = current[name];
      continue;
    }

    if (ch === '[') {
      const close = text.indexOf(']', i);
      if (close < 0) return fail('方括号未闭合');
      const inner = text.slice(i + 1, close).trim();
      i = close + 1;

      if (inner === '*') {
        wildcard = true;
        if (current == null || typeof current !== 'object') return { ok: true, value: [] };
        current = Array.isArray(current) ? current.slice() : Object.values(current);
        continue;
      }

      const quoted = /^['"](.*)['"]$/.exec(inner);
      if (quoted) {
        const key = quoted[1];
        if (current == null || typeof current !== 'object' || !(key in current)) {
          return { ok: true, value: undefined };
        }
        current = current[key];
        continue;
      }

      const index = Number(inner);
      if (!Number.isInteger(index)) return fail(`下标不是整数：${inner}`);
      if (!Array.isArray(current)) return { ok: true, value: undefined };
      const at = index < 0 ? current.length + index : index;
      if (at < 0 || at >= current.length) return { ok: true, value: undefined };
      current = current[at];
      continue;
    }

    return fail(`路径在第 ${i} 个字符处无法解析：${text}`);
  }

  return { ok: true, value: current, wildcard };
}

/* ---------------- 极简 XML 取值 ---------------- */

/**
 * 按 /root/child 取标签文本。用正则做保守实现：
 * 不支持命名空间、属性筛选、同名标签嵌套——只服务常见的结构断言。
 */
export function evalXmlPath(xmlText, expr) {
  const text = String(xmlText ?? '');
  const path = String(expr ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!path) return { ok: true, value: text };

  const parts = path.split('/').filter(Boolean);
  let scope = text;

  for (let index = 0; index < parts.length; index += 1) {
    const tag = parts[index];
    if (!/^[A-Za-z_][\w.:-]*$/.test(tag)) {
      return { ok: false, error: `XML 路径里的标签名不合法：${tag}` };
    }
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
    const m = re.exec(scope);
    if (!m) return { ok: true, value: undefined };
    scope = m[1];
    // 最后一段取文本，中间段继续往里找
    if (index === parts.length - 1) {
      const textMatch = /^([\s\S]*?)(?:<|$)/.exec(scope);
      const value = (textMatch ? textMatch[1] : scope).trim();
      return { ok: true, value };
    }
  }

  return { ok: true, value: scope };
}

/* ---------------- 取值 ---------------- */

function headerValue(headers, name) {
  const wanted = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

function cookieValue(setCookies, name) {
  const wanted = String(name || '').trim();
  for (const raw of setCookies || []) {
    const pair = String(raw).split(';')[0] || '';
    const eq = pair.indexOf('=');
    const key = (eq < 0 ? pair : pair.slice(0, eq)).trim();
    if (key === wanted) return eq < 0 ? '' : pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** 从期望的 JSON Schema 里挑出要校验的那份 */
function pickSchema(apiDetail, expression) {
  const examples = apiDetail?.response?.example;
  if (!Array.isArray(examples) || examples.length === 0) return null;

  const wanted = String(expression || 'default').trim();
  if (!wanted || wanted === 'default') {
    const def = examples.find((e) => Number(e?.expect?.is_default) === 1) || examples[0];
    return def?.expect?.schema || null;
  }
  const hit = examples.find((e) => String(e?.example_id) === wanted);
  return hit?.expect?.schema || null;
}

function parseMaybeJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  if (!/^[[{]/.test(trimmed)) return undefined;
  const parsed = parseJsonSafe(trimmed);
  return parsed;
}

/**
 * 按数据源取值。
 * @returns {{ok: boolean, value?: any, error?: string}}
 */
export function resolveSource(source, expression, ctx) {
  const response = ctx.response || {};
  const expr = String(expression ?? '').trim();

  switch (String(source)) {
    case 'status_code':
      return { ok: true, value: response.status };

    case 'elapsed_time':
      return { ok: true, value: ctx.elapsedMs };

    case 'content_type':
      return { ok: true, value: headerValue(response.headers, 'content-type') };

    case 'response_header':
      if (!expr) return { ok: false, error: '缺少 Header 名' };
      return { ok: true, value: headerValue(response.headers, expr) };

    case 'response_cookie':
      if (!expr) return { ok: false, error: '缺少 Cookie 名' };
      return { ok: true, value: cookieValue(response.setCookies, expr) };

    case 'response_text':
      return { ok: true, value: response.bodyText ?? '' };

    case 'response_json': {
      const json = response.bodyJson !== undefined ? response.bodyJson : parseMaybeJson(response.bodyText);
      if (json === undefined) return { ok: false, error: '响应不是合法 JSON' };
      return evalJsonPath(json, expr);
    }

    case 'response_xml': {
      if (!expr) return { ok: true, value: response.bodyText ?? '' };
      return evalXmlPath(response.bodyText, expr);
    }

    case 'response_schema': {
      const schema = pickSchema(ctx.apiDetail, expr);
      if (!schema) return { ok: false, error: '没有可用的响应结构（JSON Schema）' };
      return { ok: true, value: schema };
    }

    case 'var': {
      if (!expr) return { ok: false, error: '缺少变量名' };
      const value = ctx.variables?.get?.(expr);
      return { ok: true, value };
    }

    case 'env_var': {
      if (!expr) return { ok: false, error: '缺少变量名' };
      const raw = (ctx.envVars || {})[expr];
      const value = raw && typeof raw === 'object' ? (raw.current_value ?? raw.value) : raw;
      return { ok: true, value };
    }

    case 'global_var': {
      if (!expr) return { ok: false, error: '缺少变量名' };
      const raw = (ctx.globalVars || {})[expr];
      const value = raw && typeof raw === 'object' ? (raw.current_value ?? raw.value) : raw;
      return { ok: true, value };
    }

    default:
      return { ok: false, error: `未知数据源：${source}` };
  }
}

/* ---------------- 条件判定 ---------------- */

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeValue(value) {
  if (value === undefined) return '(不存在)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 宽松相等：数字与数字字符串视为相等，对象与 JSON 字符串按解析后比较 */
function looseEqual(actual, expected) {
  if (actual === expected) return true;
  if (actual === undefined || actual === null) return actual === expected;
  if (typeof actual === 'number' || typeof expected === 'number') {
    const a = Number(actual);
    const b = Number(expected);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  // 实际值是对象/数组、比较框里填的是 JSON 文本：解析后再比
  if (typeof actual === 'object' && typeof expected === 'string') {
    const parsed = parseJsonSafe(expected.trim());
    if (parsed !== undefined) {
      try {
        return JSON.stringify(actual) === JSON.stringify(parsed);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (typeof actual === 'object' || typeof expected === 'object') {
    try {
      return JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      return false;
    }
  }
  return String(actual) === String(expected);
}

/**
 * 判定单个条件。
 * @returns {{passed: boolean, message?: string}}
 */
export function checkCondition(condition, actual, rawExpected, ctx) {
  const expectedText = String(rawExpected ?? '');
  const label = CONDITION_LABEL[condition] || condition;
  const fail = (detail) => ({ passed: false, message: `${label}失败：${detail}` });

  switch (String(condition)) {
    case 'equal':
      return looseEqual(actual, expectedText)
        ? { passed: true }
        : fail(`期望等于 ${describeValue(expectedText)}，实际 ${describeValue(actual)}`);

    case 'not_equal':
      return !looseEqual(actual, expectedText)
        ? { passed: true }
        : fail(`期望不等于 ${describeValue(expectedText)}`);

    case 'include': {
      const needle = expectedText;
      const value = actual;
      let ok = false;
      if (typeof value === 'string') ok = value.includes(needle);
      else if (Array.isArray(value)) ok = value.some((v) => looseEqual(v, needle));
      else if (value && typeof value === 'object') ok = needle in value;
      return ok ? { passed: true } : fail(`期望包含 ${describeValue(needle)}，实际 ${describeValue(value)}`);
    }

    case 'not_include': {
      const needle = expectedText;
      const value = actual;
      let has = false;
      if (typeof value === 'string') has = value.includes(needle);
      else if (Array.isArray(value)) has = value.some((v) => looseEqual(v, needle));
      else if (value && typeof value === 'object') has = needle in value;
      return !has ? { passed: true } : fail(`期望不包含 ${describeValue(needle)}`);
    }

    case 'regex': {
      let re;
      try {
        re = new RegExp(expectedText);
      } catch (err) {
        return { passed: false, message: `正则表达式不合法：${err.message}` };
      }
      return re.test(String(actual ?? ''))
        ? { passed: true }
        : fail(`${describeValue(actual)} 未匹配 ${expectedText}`);
    }

    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const a = Number(actual);
      const b = Number(expectedText);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return fail(`无法按数值比较：实际 ${describeValue(actual)}，期望 ${describeValue(expectedText)}`);
      }
      const ok =
        condition === 'gt' ? a > b : condition === 'lt' ? a < b : condition === 'gte' ? a >= b : a <= b;
      return ok ? { passed: true } : fail(`期望 ${label} ${b}，实际 ${a}`);
    }

    case 'length_equal': {
      const len = actual == null ? 0 : typeof actual === 'object' ? Object.keys(actual).length || actual.length || 0 : String(actual).length;
      const want = Number(expectedText);
      if (!Number.isFinite(want)) return fail(`期望长度不是数字：${expectedText}`);
      return Number(len) === want ? { passed: true } : fail(`期望长度 ${want}，实际 ${len}`);
    }

    case 'exists':
      return actual !== undefined && actual !== null
        ? { passed: true }
        : fail('取值不存在或为 null');

    case 'empty': {
      const isEmpty =
        actual === undefined ||
        actual === null ||
        (typeof actual === 'string' && actual === '') ||
        (Array.isArray(actual) && actual.length === 0) ||
        (typeof actual === 'object' && !Array.isArray(actual) && Object.keys(actual).length === 0);
      return isEmpty ? { passed: true } : fail(`期望为空，实际 ${describeValue(actual)}`);
    }

    case 'type_is': {
      const want = expectedText.toLowerCase().trim();
      const got = typeOf(actual);
      const ok = want === got || (want === 'integer' && got === 'number' && Number.isInteger(actual));
      return ok ? { passed: true } : fail(`期望类型 ${want}，实际 ${got}`);
    }

    case 'schema_match':
    case 'schema_not_match': {
      // 数据源为 response_schema 时，actual 是 schema 本身，校验对象是响应 JSON
      const schema = actual;
      if (!schema || typeof schema !== 'object') {
        return fail('没有可用的 JSON Schema，无法做结构校验');
      }
      const bodyJson =
        ctx?.response?.bodyJson !== undefined ? ctx.response.bodyJson : parseMaybeJson(ctx?.response?.bodyText);
      const errors = validateSchema(schema, bodyJson ?? {});
      if (condition === 'schema_match') {
        return errors.length === 0
          ? { passed: true }
          : { passed: false, message: errors.map((e) => `${e.path}: ${e.message}`).join('; ') };
      }
      return errors.length > 0
        ? { passed: true }
        : { passed: false, message: '响应结构与 Schema 完全匹配（期望不匹配）' };
    }

    default:
      return { passed: false, message: `未知条件：${condition}` };
  }
}

/* ---------------- 主入口 ---------------- */

function assertName(task) {
  const data = task?.data || {};
  const explicit = String(task?.name || '').trim();
  const source = SOURCE_LABEL[data.source] || data.source || '断言';
  const expr = String(data.expression || '').trim();
  const cond = CONDITION_LABEL[data.condition] || data.condition || '';
  const base = `${source}${expr ? ` ${expr}` : ''} ${cond}`.trim();
  // 前端给的默认名（如「断言1」）不如自动拼出来的信息量大
  if (explicit && !/^断言\d*$/.test(explicit)) return explicit;
  return base || explicit || '断言';
}

/**
 * 执行 post_tasks 里的可视化断言任务。
 *
 * @param {Array} postTasks request.post_tasks（inherit.js 已按内→外合并）
 * @param {object} ctx { response, request, elapsedMs, variables, envVars, globalVars, apiDetail }
 * @returns {Array<object>} 与既有 assertions[] 同构的断言结果
 */
export function runVisualAssertions(postTasks, ctx = {}) {
  const tasks = (Array.isArray(postTasks) ? postTasks : []).filter(
    (t) => t && t.type === 'assert' && Number(t.enabled) !== -1
  );
  if (tasks.length === 0) return [];

  const out = [];
  for (const task of tasks) {
    const data = task.data && typeof task.data === 'object' ? task.data : {};
    const name = assertName(task);
    const source = String(data.source || 'status_code');
    const condition = String(data.condition || 'equal');

    const resolved = resolveSource(source, data.expression, ctx);

    if (!resolved.ok) {
      out.push({
        name,
        passed: false,
        phase: 'assert',
        source,
        expression: String(data.expression || ''),
        expected: NO_VALUE_CONDITIONS.has(condition) ? undefined : data.value,
        actual: undefined,
        message: resolved.error
      });
      continue;
    }

    const verdict = checkCondition(condition, resolved.value, data.value, ctx);
    out.push({
      name,
      passed: Boolean(verdict.passed),
      phase: 'assert',
      source,
      expression: String(data.expression || ''),
      expected: NO_VALUE_CONDITIONS.has(condition) ? undefined : data.value,
      actual: resolved.value,
      message: verdict.passed ? undefined : verdict.message,
      description: String(data.description || '')
    });
  }

  return out;
}
