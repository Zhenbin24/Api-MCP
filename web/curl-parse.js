/**
 * curl 命令解析器
 * 支持三种方言：bash/zsh（Linux、macOS、Git Bash）、Windows CMD、PowerShell
 * 既可在浏览器（<script type="module">）使用，也可被 Node 直接 import 做单测。
 */

/* ---------------- 方言识别 ---------------- */

/**
 * 判断 curl 文本来自哪种 shell。
 * - CMD：行尾 ^ 续行、^" 包裹、^\^ 二次转义
 * - PowerShell：反引号续行、curl.exe、--%
 * - 其余：bash
 */
export function detectDialect(text) {
  const src = String(text || '');
  if (!src.trim()) return 'bash';

  // CMD：行尾 ^ 续行，或 ^" 开头，或 ^\^ 二次转义
  if (/(\^[ \t]*\r?\n)/.test(src)) return 'cmd';
  if (/\^"/.test(src)) return 'cmd';
  if (/\^\\\^/.test(src)) return 'cmd';

  // PowerShell：反引号续行，或 curl.exe，或 --%
  if (/`[ \t]*\r?\n/.test(src)) return 'powershell';
  if (/\bcurl\.exe\b/i.test(src)) return 'powershell';
  if (/--%/.test(src)) return 'powershell';

  return 'bash';
}

/* ---------------- 预处理 ---------------- */

/** 统一换行、去 BOM、去首尾空白 */
function normalize(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/** 合并续行（按方言选续行符） */
function joinContinuations(text, dialect) {
  const marker = dialect === 'cmd' ? '\\^' : dialect === 'powershell' ? '`' : '\\';
  if (dialect === 'cmd') {
    // CMD 的续行符是 ^，但可能是 "内容 ^" 或行尾单独一个 ^
    return text
      .split('\n')
      .map((line) => line.replace(/\^[ \t]*$/, '\u0000CONT\u0000'))
      .join('\n')
      .replace(/\u0000CONT\u0000\n[ \t]*/g, ' ')
      .replace(/\u0000CONT\u0000/g, '');
  }
  return text
    .split('\n')
    .map((line) => line.replace(new RegExp(`${marker}[ \\t]*$`), '\u0000CONT\u0000'))
    .join('\n')
    .replace(/\u0000CONT\u0000\n[ \t]*/g, ' ')
    .replace(/\u0000CONT\u0000/g, '');
}

/**
 * CMD 反转义：^X -> X。
 * 处理 ^^ 时只吃掉一个 ^，所以二次转义的 ^\^" 会先变成 \"，
 * 再交给分词器还原成 "。
 */
function unescapeCmd(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '^' && i + 1 < text.length) {
      out += text[i + 1];
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** PowerShell 反转义（主要处理单引号串内的 '' 与双引号内的 ` 转义） */
function unescapePowershell(text) {
  return text.replace(/``/g, '`').replace(/''/g, "'");
}

/* ---------------- 分词 ---------------- */

/**
 * 把命令行切成 token 数组。
 * 支持 '...'（字面）、"..."（含 \ 转义）、无引号时的 \ 转义。
 */
export function tokenize(line) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;

  const push = () => {
    if (inToken) {
      tokens.push(current);
      current = '';
      inToken = false;
    }
  };

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === '\\' && i + 1 < line.length) {
        const next = line[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i += 1;
          continue;
        }
        current += ch;
        continue;
      }
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }

    // 未在引号内
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      push();
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      // 无引号时的转义：\ 后面跟空白或引号时代表字面字符
      const next = line[i + 1];
      if (next === ' ' || next === '\t' || next === '\\' || next === '"' || next === "'") {
        current += next;
        inToken = true;
        i += 1;
        continue;
      }
      current += ch;
      inToken = true;
      continue;
    }

    current += ch;
    inToken = true;
  }

  push();
  return tokens;
}

/* ---------------- 分块 ---------------- */

/** 按「以 curl 开头的行」切分成多个命令块 */
export function splitCurlBlocks(text) {
  const src = normalize(text);
  if (!src) return [];

  const lines = src.split('\n');
  const blocks = [];
  let current = [];
  let started = false;

  const isCurlStart = (line) => /^\s*curl(\.exe)?\b/i.test(line);
  // 续行的判定要覆盖三种方言
  const continuesPrev = (line) => /(\^|\\|`)[ \t]*$/.test(line);

  for (const line of lines) {
    if (isCurlStart(line)) {
      if (started && current.length) blocks.push(current.join('\n'));
      current = [line];
      started = true;
      continue;
    }
    if (!started) {
      // 第一个 curl 之前的说明文字忽略
      continue;
    }
    current.push(line);
    // 不是续行且已是空行，则视为块结束
    if (!continuesPrev(line) && line.trim() === '') {
      blocks.push(current.join('\n'));
      current = [];
      started = false;
    }
  }

  if (started && current.length) blocks.push(current.join('\n'));

  const cleaned = blocks.map((b) => b.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : [src];
}

/* ---------------- 参数识别 ---------------- */

const IGNORE_FLAGS = new Set([
  '--compressed',
  '-k',
  '--insecure',
  '-L',
  '--location',
  '-i',
  '--include',
  '-s',
  '--silent',
  '-v',
  '--verbose',
  '--no-buffer',
  '-N',
  '--globoff',
  '-g',
  '--http1.1',
  '--http2',
  '--tlsv1.2',
  '--tlsv1.3',
  '-4',
  '-6',
  '--fail',
  '-f',
  '--show-error',
  '-S',
  '--no-keepalive',
  '--raw',
  '--path-as-is'
]);

const IGNORE_WITH_VALUE = new Set([
  '-o',
  '--output',
  '-w',
  '--write-out',
  '--max-time',
  '-m',
  '--connect-timeout',
  '--retry',
  '--retry-delay',
  '--limit-rate',
  '--cacert',
  '--cert',
  '--key',
  '--proxy',
  '-x',
  '--resolve',
  '--interface',
  '--dns-servers'
]);

function looksLikeUrl(value) {
  return /^(https?|wss?|ftp):\/\//i.test(String(value || ''));
}

/**
 * 解析单条 curl。
 * @returns {{
 *   ok: boolean, dialect: string, url: string, method: string,
 *   headers: Array<{key,value}>, query: Array<{key,value}>,
 *   cookies: Array<{key,value}>, restful: Array<{key,value}>,
 *   body: {mode, raw, form}, auth: object|null,
 *   warnings: string[], raw_command: string
 * }}
 */
export function parseCurl(text, { dialect = 'auto' } = {}) {
  const rawCommand = String(text || '').trim();
  const warnings = [];
  const headers = [];
  const query = [];
  const cookies = [];
  const restful = [];

  const detected = dialect === 'auto' ? detectDialect(rawCommand) : dialect;

  if (!rawCommand) {
    return {
      ok: false,
      dialect: detected,
      url: '',
      method: '',
      headers,
      query,
      cookies,
      restful,
      body: { mode: 'none', raw: '', form: [] },
      auth: null,
      warnings: ['内容为空'],
      raw_command: ''
    };
  }

  // 预处理
  let prepared = joinContinuations(normalize(rawCommand), detected === 'auto' ? detectDialect(rawCommand) : detected);
  if (detected === 'cmd') prepared = unescapeCmd(prepared);
  else if (detected === 'powershell') prepared = unescapePowershell(prepared);

  const tokens = tokenize(prepared);

  // 丢掉开头的 curl / curl.exe
  let startIndex = 0;
  if (tokens.length > 0 && /^curl(\.exe)?$/i.test(tokens[0])) startIndex = 1;
  else if (tokens.length > 0 && /^curl(\.exe)?$/i.test(tokens[0].split(/[ ]+/)[0])) startIndex = 1;

  let url = '';
  let method = '';
  let explicitMethod = '';
  let bodyRaw = '';
  let bodyKind = '';
  const formFields = [];
  let basicAuth = null;

  const headerMap = new Map();
  const pushHeader = (key, value) => {
    const k = String(key || '').trim();
    if (!k) return;
    const v = String(value ?? '').replace(/^\s+/, '');
    // 同名头累加（curl 允许多次 -H 同一 key）
    if (headerMap.has(k.toLowerCase())) {
      const prev = headerMap.get(k.toLowerCase());
      prev.value = `${prev.value}, ${v}`;
    } else {
      headerMap.set(k.toLowerCase(), { key: k, value: v });
    }
  };

  for (let i = startIndex; i < tokens.length; i += 1) {
    let token = tokens[i];

    // 处理 --flag=value 形式
    let inlineValue = null;
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 2) {
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }

    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      const next = tokens[i + 1];
      if (next === undefined) return '';
      i += 1;
      return next;
    };

    const lower = token.toLowerCase();

    // URL：--url 或裸参数
    if (lower === '--url' || lower === '-url') {
      const value = takeValue();
      if (value) url = value;
      continue;
    }

    // 方法
    if (lower === '-x' || lower === '--request') {
      explicitMethod = String(takeValue() || '').toUpperCase();
      continue;
    }

    // 头
    if (lower === '-h' || lower === '--header') {
      const value = takeValue();
      if (value) {
        const idx = value.indexOf(':');
        if (idx > 0) {
          const key = value.slice(0, idx).trim();
          const val = value.slice(idx + 1).trim();
          if (key.toLowerCase() === 'cookie') {
            parseCookieString(val).forEach((c) => cookies.push(c));
          } else {
            pushHeader(key, val);
          }
        } else {
          warnings.push(`无法解析的 header：${value}`);
        }
      }
      continue;
    }

    // UA / Referer
    if (lower === '-a' || lower === '--user-agent') {
      pushHeader('User-Agent', takeValue());
      continue;
    }
    if (lower === '-e' || lower === '--referer') {
      pushHeader('Referer', takeValue());
      continue;
    }

    // Cookie
    if (lower === '-b' || lower === '--cookie') {
      const value = takeValue();
      if (value) {
        if (value.includes('=') && !value.startsWith('@')) {
          parseCookieString(value).forEach((c) => cookies.push(c));
        } else if (value.startsWith('@')) {
          warnings.push(`cookie 文件引用未展开：${value}`);
        }
      }
      continue;
    }

    // body
    if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii'].includes(lower)) {
      bodyRaw = takeValue();
      if (!bodyKind) bodyKind = 'raw';
      continue;
    }
    if (lower === '--data-urlencode') {
      bodyRaw = takeValue();
      bodyKind = 'urlencoded';
      continue;
    }
    if (lower === '--json') {
      bodyRaw = takeValue();
      bodyKind = 'json';
      if (!headerMap.has('content-type')) pushHeader('Content-Type', 'application/json');
      continue;
    }

    // form
    if (lower === '-f' || lower === '--form' || lower === '--form-string') {
      const value = takeValue();
      if (value) formFields.push(value);
      bodyKind = 'form-data';
      continue;
    }

    // basic auth
    if (lower === '-u' || lower === '--user') {
      const value = takeValue();
      if (value && value.includes(':')) {
        const idx = value.indexOf(':');
        basicAuth = { username: value.slice(0, idx), password: value.slice(idx + 1) };
      }
      continue;
    }

    // -G：把 data 挪到 query
    if (lower === '-g' || lower === '--get') {
      bodyKind = bodyKind || 'get';
      continue;
    }

    // HEAD
    if (lower === '-i' || lower === '--head') {
      explicitMethod = 'HEAD';
      continue;
    }

    // 带值但忽略的
    if (IGNORE_WITH_VALUE.has(lower)) {
      takeValue();
      continue;
    }

    // 纯忽略
    if (IGNORE_FLAGS.has(lower)) continue;

    // 其它以 - 开头的未知开关：如果有下一个 token 且不像 URL，则跳过该值
    if (lower.startsWith('-')) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-') && !looksLikeUrl(next)) {
        // 多数未知开关带一个值，消费掉避免被当成 URL
        i += 1;
      }
      continue;
    }

    // 裸 URL
    if (!url && looksLikeUrl(token)) {
      url = token;
      continue;
    }
  }

  if (!url) {
    warnings.push('未识别到 URL（需要 http:// 或 https:// 开头）');
  }

  // ---- URL 拆分 query ----
  let baseUrl = url;
  if (url) {
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      baseUrl = url.slice(0, qIdx);
      const qs = url.slice(qIdx + 1);
      for (const pair of qs.split('&')) {
        if (!pair) continue;
        const eq2 = pair.indexOf('=');
        const key = eq2 < 0 ? pair : pair.slice(0, eq2);
        const value = eq2 < 0 ? '' : pair.slice(eq2 + 1);
        query.push({ key: safeDecode(key), value: safeDecode(value) });
      }
    }
    // path 参数 {name}
    for (const m of baseUrl.matchAll(/\{([^{}]+)\}/g)) {
      restful.push({ key: m[1], value: '' });
    }
  }

  // ---- 方法推断 ----
  const hasBody = Boolean(bodyRaw) || formFields.length > 0;
  if (explicitMethod) method = explicitMethod;
  else if (bodyKind === 'get') method = 'GET';
  else if (hasBody) method = 'POST';
  else method = 'GET';

  // -G 时 data 转 query
  if (bodyKind === 'get' && bodyRaw) {
    const parsed = new URLSearchParams(bodyRaw);
    for (const [k, v] of parsed.entries()) query.push({ key: k, value: v });
    bodyRaw = '';
  }

  // ---- body 判定 ----
  const contentType = headerMap.get('content-type')?.value || '';
  const body = buildBody({ bodyRaw, bodyKind, formFields, contentType });

  return {
    ok: Boolean(url),
    dialect: detected,
    url: baseUrl,
    method,
    headers: [...headerMap.values()],
    query,
    cookies,
    restful,
    body,
    auth: basicAuth ? { type: 'basic', ...basicAuth } : null,
    warnings,
    raw_command: rawCommand
  };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch {
    return String(value);
  }
}

function parseCookieString(value) {
  const out = [];
  for (const part of String(value || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    out.push({ key: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() });
  }
  return out;
}

/* ---------------- Body 构建 ---------------- */

function buildBody({ bodyRaw, bodyKind, formFields, contentType }) {
  // form-data
  if (formFields.length > 0) {
    return {
      mode: 'form-data',
      raw: '',
      form: formFields.map((field) => {
        const idx = field.indexOf('=');
        if (idx < 0) return { key: field, value: '', isFile: false };
        const key = field.slice(0, idx).trim();
        const value = field.slice(idx + 1);
        const isFile = /^@|^</.test(value);
        return {
          key,
          value: isFile ? value.replace(/^[@<]/, '') : value,
          isFile
        };
      })
    };
  }

  if (!bodyRaw) return { mode: 'none', raw: '', form: [] };

  const ct = String(contentType || '').toLowerCase();

  // urlencoded
  if (bodyKind === 'urlencoded' || ct.includes('x-www-form-urlencoded')) {
    const params = [];
    for (const pair of String(bodyRaw).split('&')) {
      if (!pair) continue;
      const idx = pair.indexOf('=');
      params.push({
        key: safeDecode(idx < 0 ? pair : pair.slice(0, idx)),
        value: safeDecode(idx < 0 ? '' : pair.slice(idx + 1))
      });
    }
    return { mode: 'urlencoded', raw: String(bodyRaw), form: params };
  }

  // JSON：显式声明或内容像 JSON 且能解析
  const looksJson =
    bodyKind === 'json' || ct.includes('json') || /^\s*[[{]/.test(String(bodyRaw));

  if (looksJson) {
    try {
      const parsed = JSON.parse(bodyRaw);
      return {
        mode: 'json',
        raw: JSON.stringify(parsed, null, 2),
        json: parsed,
        form: []
      };
    } catch {
      // 声明是 json 但解析失败：保留原文
      return { mode: 'json', raw: String(bodyRaw), parseError: true, form: [] };
    }
  }

  return { mode: 'raw', raw: String(bodyRaw), form: [] };
}

/* ---------------- JSON -> Apipost schema ---------------- */

/** 推断值的类型名 */
function typeOfValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'string';
}

/** JSON 值 -> Apipost raw_schema */
export function jsonToSchema(value, depth = 0) {
  if (depth > 20) return { type: 'object' };
  const type = typeOfValue(value);

  if (type === 'array') {
    const first = Array.isArray(value) && value.length > 0 ? value[0] : { type: 'string' };
    const sample = value.length > 0 ? value[0] : '';
    return { type: 'array', items: jsonToSchema(sample, depth + 1), example: [] };
  }

  if (type === 'object') {
    const keys = Object.keys(value || {});
    const properties = {};
    for (const key of keys) properties[key] = jsonToSchema(value[key], depth + 1);
    return {
      type: 'object',
      properties,
      required: [],
      APIPOST_ORDERS: keys,
      APIPOST_REFS: {}
    };
  }

  return { type };
}

/** 把 schema 摊成官方的 raw_parameter 表单 */
export function schemaToParameters(schema, prefix = '') {
  const out = [];
  const props = schema?.properties || {};
  const orders = Array.isArray(schema?.APIPOST_ORDERS) ? schema.APIPOST_ORDERS : Object.keys(props);

  for (const key of orders) {
    const sub = props[key];
    if (!sub) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    out.push({
      description: '',
      field_type: capitalizeType(sub.type),
      is_checked: 1,
      key: fullKey,
      not_null: (schema.required || []).includes(key) ? 1 : -1,
      param_id: makeParamId(),
      value: ''
    });
    if (sub.type === 'object' && sub.properties) {
      out.push(...schemaToParameters(sub, fullKey));
    }
  }
  return out;
}

function capitalizeType(type) {
  const map = {
    string: 'String',
    integer: 'Integer',
    number: 'Number',
    boolean: 'Boolean',
    array: 'Array',
    object: 'Object',
    null: 'String',
    any: 'String'
  };
  return map[String(type || 'string')] || 'String';
}

let paramCounter = 0;
function makeParamId() {
  paramCounter += 1;
  return `${Date.now().toString(16)}${paramCounter.toString(16).padStart(2, '0')}`;
}

/* ---------------- 应用到接口数据 ---------------- */

/** 把解析结果写进 Apipost 接口 data 对象（就地修改） */
export function applyParsedToApiData(data, parsed) {
  if (!data || !parsed) return data;

  data.method = String(parsed.method || 'GET').toUpperCase();
  data.url = parsed.url || '';

  data.request = data.request || {};
  const req = data.request;

  // headers
  req.header = req.header || { parameter: [] };
  req.header.parameter = (parsed.headers || []).map((h) => makeParam(h.key, h.value));

  // query
  req.query = req.query || { parameter: [], query_add_equal: 1 };
  req.query.parameter = (parsed.query || []).map((q) => makeParam(q.key, q.value));
  req.query.query_add_equal = 1;

  // cookies
  req.cookie = req.cookie || { parameter: [] };
  req.cookie.parameter = (parsed.cookies || []).map((c) => makeParam(c.key, c.value));

  // path 参数
  req.restful = req.restful || { parameter: [] };
  req.restful.parameter = (parsed.restful || []).map((r) => makeParam(r.key, r.value));

  // body
  const body = parsed.body || { mode: 'none', raw: '', form: [] };
  const nextBody = {
    binary: null,
    mode: body.mode || 'none',
    parameter: [],
    raw: '',
    raw_parameter: [],
    raw_schema: { type: 'object' }
  };

  if (body.mode === 'json' || body.mode === 'raw') {
    nextBody.raw = body.raw || '';
    if (body.mode === 'json' && body.json !== undefined) {
      const schema = jsonToSchema(body.json);
      nextBody.raw_schema = schema;
      nextBody.raw_parameter = schemaToParameters(schema);
    }
  } else if (body.mode === 'form-data' || body.mode === 'urlencoded') {
    nextBody.parameter = (body.form || []).map((item) =>
      makeParam(item.key, item.value, item.isFile ? 'File' : 'String')
    );
  }
  req.body = nextBody;

  // 鉴权
  if (parsed.auth && parsed.auth.type === 'basic') {
    req.auth = {
      ...(req.auth || {}),
      type: 'basic',
      basic: { username: parsed.auth.username || '', password: parsed.auth.password || '' }
    };
  }

  return data;
}

function makeParam(key, value, fieldType = 'String') {
  return {
    description: '',
    field_type: fieldType,
    is_checked: 1,
    key: String(key ?? ''),
    not_null: -1,
    param_id: makeParamId(),
    value: String(value ?? '')
  };
}

/* ---------------- 批量解析 ---------------- */

/** 解析文本里所有 curl 块 */
export function parseAll(text, { dialect = 'auto' } = {}) {
  const blocks = splitCurlBlocks(text);
  return blocks.map((block) => parseCurl(block, { dialect }));
}

/** 从 URL 推断一个可读的接口名（跳过 {id} 这类占位段） */
export function suggestName(parsed) {
  const raw = String(parsed?.url || '').trim();
  if (!raw) return '新接口';
  try {
    const u = new URL(raw.replace(/\{[^}]*\}/g, 'placeholder'));
    const segments = u.pathname
      .split('/')
      .filter(Boolean)
      .filter((seg) => seg !== 'placeholder');
    const last = segments[segments.length - 1] || u.hostname;
    return last.length > 48 ? last.slice(0, 48) : last;
  } catch {
    const tail = raw.split('/').filter(Boolean).pop() || raw;
    return tail.length > 48 ? tail.slice(0, 48) : tail;
  }
}

/* ---------------- 浏览器挂载 ---------------- */

if (typeof window !== 'undefined') {
  window.CurlParse = {
    detectDialect,
    splitCurlBlocks,
    parseCurl,
    parseAll,
    tokenize,
    jsonToSchema,
    schemaToParameters,
    applyParsedToApiData,
    suggestName
  };
}
