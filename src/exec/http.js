import fs from 'node:fs';
import path from 'node:path';
import { applyAuth, mergeAuthInto } from './auth.js';
import { renderTemplate, createVariableScope } from './template.js';
import { collectScripts, runScript } from './script.js';
import { validateSchema, parseJsonSafe } from './assert.js';
import { redact } from '../store/runs.js';
import { transmitHttp2 } from './http2.js';

const RAW_MODES = new Set(['raw', 'json', 'xml', 'html', 'javascript', 'plain', 'text', 'msgpack']);

const CONTENT_TYPE = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  plain: 'text/plain',
  text: 'text/plain',
  raw: 'text/plain',
  msgpack: 'application/msgpack',
  graphql: 'application/json',
  'form-data': 'multipart/form-data',
  urlencoded: 'application/x-www-form-urlencoded'
};

/* ---------------- Cookie jar（跨步骤共享） ---------------- */

export function createCookieJar(initial = []) {
  const store = new Map();
  const keyOf = (c) => `${c.domain || ''}|${c.path || '/'}|${c.name}`;
  for (const c of initial) store.set(keyOf(c), { ...c });

  return {
    absorb(setCookieHeaders = [], url = '') {
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {}
      for (const raw of setCookieHeaders) {
        const parts = String(raw).split(';').map((s) => s.trim());
        const [pair, ...attrs] = parts;
        const idx = pair.indexOf('=');
        if (idx <= 0) continue;
        const cookie = {
          name: pair.slice(0, idx),
          value: pair.slice(idx + 1),
          domain: host,
          path: '/',
          expires: null,
          secure: false,
          httpOnly: false
        };
        for (const attr of attrs) {
          const [k, ...v] = attr.split('=');
          const key = String(k).trim().toLowerCase();
          const val = v.join('=').trim();
          if (key === 'domain') cookie.domain = val;
          else if (key === 'path') cookie.path = val;
          else if (key === 'expires') cookie.expires = val;
          else if (key === 'secure') cookie.secure = true;
          else if (key === 'httponly') cookie.httpOnly = true;
        }
        store.set(keyOf(cookie), cookie);
      }
    },
    header() {
      return [...store.values()].map((c) => `${c.name}=${c.value}`).join('; ');
    },
    jar() {
      return [...store.values()].map((c) => ({ ...c }));
    },
    toObject() {
      const out = {};
      for (const c of store.values()) out[c.name] = c.value;
      return out;
    },
    setCookie(cookie) {
      store.set(keyOf(cookie), { ...cookie });
    },
    clear() {
      store.clear();
    }
  };
}

/* ---------------- 参数表工具 ---------------- */

function activeParams(paramList) {
  return (paramList || []).filter((p) => p && p.key && Number(p.is_checked) !== 0 && Number(p.is_checked) !== -1);
}

function paramsToObject(paramList) {
  const out = {};
  for (const p of activeParams(paramList)) out[p.key] = renderValue(p.value);
  return out;
}

function renderValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * 把 input 覆盖值合并进参数表：只更新已存在的 key，不新增（对齐官方语义）。
 * 返回 { applied, ignored }
 */
function mergeOverrides(paramList, overrides) {
  const applied = [];
  const ignored = [];
  if (!overrides || typeof overrides !== 'object') return { applied, ignored };
  for (const [key, value] of Object.entries(overrides)) {
    const item = (paramList || []).find((p) => p.key === key);
    if (!item) {
      ignored.push(key);
      continue;
    }
    item.value = renderValue(value);
    item.is_checked = 1;
    applied.push(key);
  }
  return { applied, ignored };
}

/* ---------------- URL 构造 ---------------- */

export function resolveUrl({ apiUrl, baseUrl, restfulParams, pathOverrides }) {
  let url = String(apiUrl || '').trim();
  if (!url) throw new Error('接口未定义 URL');

  // 路径参数替换
  const paramMap = { ...paramsToObject(restfulParams), ...(pathOverrides || {}) };
  url = url.replace(/\{([^{}]+)\}/g, (whole, name) => {
    const value = paramMap[name];
    return value === undefined ? whole : encodeURIComponent(String(value));
  });

  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  if (isAbsolute) return url;

  const base = String(baseUrl || '').trim();
  if (!base) {
    throw new Error(`接口 URL 是相对路径（${url}），但当前环境未配置默认服务地址（server_id=1 的 uri）`);
  }
  return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/** 拆分 URL 已有的 query 串（用于与参数表合并，避免出现两个 ?） */
export function splitUrlQuery(url) {
  const text = String(url || '');
  const idx = text.indexOf('?');
  if (idx < 0) return { base: text, params: {} };
  const base = text.slice(0, idx);
  const params = {};
  for (const pair of text.slice(idx + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      params[decodeURIComponent(key)] = decodeURIComponent(value);
    } catch {
      params[key] = value;
    }
  }
  return { base, params };
}

function buildQueryString(query, addEqual = true) {
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    const val = v === null ? '' : String(v);
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
  }
  if (parts.length === 0) return '';
  return `?${parts.join('&')}`;
}

/* ---------------- Body 构造 ---------------- */

function buildBody(apiBody, overrideBody, contentTypeHeader, scope = null) {
  const body = apiBody || {};
  const mode = String(body.mode || 'none');
  const sub = (value) => (scope ? renderTemplate(renderValue(value), scope) : renderValue(value));

  if (overrideBody !== undefined) {
    if (mode === 'none') {
      throw new Error('该接口未定义可覆盖的请求体');
    }
    if (mode === 'json' || RAW_MODES.has(mode)) {
      const text = typeof overrideBody === 'string' ? overrideBody : JSON.stringify(overrideBody, null, 2);
      return { mode, text, contentType: contentTypeHeader || CONTENT_TYPE[mode] || 'application/json' };
    }
    if (mode === 'form-data' || mode === 'urlencoded') {
      if (!overrideBody || typeof overrideBody !== 'object') {
        throw new Error(`请求体覆盖值需为对象（mode=${mode}）`);
      }
      const merged = [...(body.parameter || [])];
      const { applied, ignored } = mergeOverrides(merged, overrideBody);
      return { ...buildBodyFromParams(merged, mode, sub), applied, ignored };
    }
    throw new Error(`请求体覆盖值与接口已定义的 Body 类型不匹配（mode=${mode}）`);
  }

  if (mode === 'none') return { mode, text: '', contentType: null };
  if (RAW_MODES.has(mode)) {
    return {
      mode,
      text: sub(body.raw ?? ''),
      contentType: contentTypeHeader || CONTENT_TYPE[mode] || 'text/plain'
    };
  }
  if (mode === 'graphql') {
    const raw = String(sub(body.raw ?? '')).trim();
    let payload;
    if (!raw) payload = JSON.stringify({ query: '' });
    else if (raw.startsWith('{')) payload = raw;
    else payload = JSON.stringify({ query: raw });
    return { mode, text: payload, contentType: 'application/json' };
  }
  if (mode === 'form-data' || mode === 'urlencoded') {
    return buildBodyFromParams(body.parameter || [], mode, sub);
  }
  if (mode === 'binary') {
    const bin = body.binary || {};
    const filePath = bin.file_path || bin.filePath;
    if (!filePath) throw new Error('binary 模式缺少文件路径');
    if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);
    return {
      mode,
      buffer: fs.readFileSync(filePath),
      contentType: bin.file_type || 'application/octet-stream',
      fileName: bin.file_name || path.basename(filePath)
    };
  }

  // 未知模式按 raw 处理
  return { mode, text: String(body.raw || ''), contentType: contentTypeHeader || 'text/plain' };
}

function buildBodyFromParams(paramList, mode, sub = (v) => renderValue(v)) {
  if (mode === 'urlencoded') {
    const params = new URLSearchParams();
    for (const p of activeParams(paramList)) {
      params.append(p.key, sub(p.value));
    }
    return { mode, text: params.toString(), contentType: CONTENT_TYPE[mode] };
  }

  // form-data
  const boundary = `----APIFormBoundary${Math.random().toString(16).slice(2)}`;
  const chunks = [];
  for (const p of activeParams(paramList)) {
    const type = String(p.field_type || p.type || '').toLowerCase();
    if (type === 'file') {
      const filePath = p.value;
      if (filePath && fs.existsSync(String(filePath))) {
        const name = path.basename(String(filePath));
        chunks.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${p.key}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
          ),
          fs.readFileSync(String(filePath)),
          Buffer.from('\r\n')
        );
      }
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.key}"\r\n\r\n${sub(p.value)}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    mode,
    buffer: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

/* ---------------- 主执行 ---------------- */

/**
 * 执行一次接口请求。
 * @param {object} opts
 * @param {object} opts.apiDetail 接口完整定义（data 部分）
 * @param {object} opts.input     参数覆盖 {query, path, headers, cookies, body, auth}
 * @param {object} opts.env       当前环境（含 env_var_list / server_list）
 * @param {object} opts.envRuntime 环境运行时变量 {key:{value}}
 * @param {object} opts.globalVars 全局变量默认值
 * @param {object} opts.globalRuntime 全局变量运行时值
 * @param {object} opts.globalParams 项目默认请求参数（auth 继承用）
 * @param {boolean} opts.runBuiltinScripts 是否执行接口自带脚本（单接口执行为 true，流程执行为 false）
 * @param {string} opts.extraPreScript 流程步骤自带的前置脚本
 * @param {string} opts.extraPostScript 流程步骤自带的后置脚本
 * @param {object} opts.cookieJar
 * @param {number} opts.timeoutMs
 * @returns {Promise<object>} 步骤结果
 */
export async function executeRequest(opts) {
  const {
    apiDetail,
    input = {},
    env = null,
    envRuntime = {},
    globalVars = {},
    globalRuntime = {},
    globalParams = null,
    /** 已合并「全局参数 → 目录 → 接口」的请求配置；不传则退化为接口自身定义 */
    requestConfig = null,
    /** 已解析好的前置 URL（含目录指定服务）；不传则用环境默认服务 */
    baseUrlOverride = '',
    runBuiltinScripts = true,
    extraPreScript = '',
    extraPostScript = '',
    cookieJar = createCookieJar(),
    timeoutMs = 60000,
    fetchImpl = globalThis.fetch
  } = opts;

  const startedAt = Date.now();
  const now = new Date().toISOString();

  const scope = createVariableScope({
    envVars: env?.env_var_list || {},
    envRuntime,
    globalVars,
    globalRuntime
  });

  const method = String(apiDetail.method || 'GET').toUpperCase();
  const apiUrl = apiDetail.url || '';
  const conf = requestConfig || apiDetail.request || {};
  const baseUrl =
    baseUrlOverride || (env?.server_list || []).find((s) => String(s.server_id) === '1')?.uri || '';

  // ---- 参数表（先做模板替换） ----
  const queryParams = (conf.query?.parameter || []).map((p) => ({
    ...p,
    value: renderTemplate(renderValue(p.value), scope)
  }));
  const restfulParams = (conf.restful?.parameter || []).map((p) => ({
    ...p,
    value: renderTemplate(renderValue(p.value), scope)
  }));
  const headerParams = (conf.header?.parameter || []).map((p) => ({
    ...p,
    value: renderTemplate(renderValue(p.value), scope)
  }));
  const cookieParams = (conf.cookie?.parameter || []).map((p) => ({
    ...p,
    value: renderTemplate(renderValue(p.value), scope)
  }));

  const appliedOverrides = {};
  appliedOverrides.query = mergeOverrides(queryParams, input.query);
  appliedOverrides.path = mergeOverrides(restfulParams, input.path);
  appliedOverrides.headers = mergeOverrides(headerParams, input.headers);
  appliedOverrides.cookies = mergeOverrides(cookieParams, input.cookies);

  const request = {
    method,
    url: '',
    headers: paramsToObject(headerParams),
    query: paramsToObject(queryParams),
    cookies: paramsToObject(cookieParams),
    body: undefined,
    bodyText: '',
    bodyMode: 'none'
  };

  // ---- 鉴权（配置里的值也要做模板替换，以便引用脚本写入的变量） ----
  const authConf = input.auth
    ? { ...(conf.auth || {}), ...structuredClone(input.auth) }
    : conf.auth;
  const renderedAuth = renderTemplate(authConf || { type: 'noauth' }, scope);
  // 合并链路已把 inherit 解析成具体类型，globalParams.auth 仅作为旧调用方的兜底
  const renderedFallbackAuth = globalParams?.auth ? renderTemplate(globalParams.auth, scope) : null;
  const authResult = applyAuth(renderedAuth, renderedFallbackAuth);
  mergeAuthInto({ headers: request.headers, query: request.query }, authResult);

  // ---- Body ----
  const builtBody = buildBody(conf.body, input.body, request.headers['Content-Type'] || request.headers['content-type'], scope);
  request.bodyMode = builtBody.mode;
  if (builtBody.buffer) {
    request.bodyBuffer = builtBody.buffer;
    request.bodyText = `<binary ${builtBody.buffer.length} bytes>`;
    if (!Object.keys(request.headers).some((k) => k.toLowerCase() === 'content-type') && builtBody.contentType) {
      request.headers['Content-Type'] = builtBody.contentType;
    }
  } else {
    request.bodyText = builtBody.text || '';
    if (builtBody.text && !Object.keys(request.headers).some((k) => k.toLowerCase() === 'content-type')) {
      if (builtBody.contentType) request.headers['Content-Type'] = builtBody.contentType;
    }
  }
  if (builtBody.applied) appliedOverrides.body = { applied: builtBody.applied, ignored: builtBody.ignored };

  // ---- 前置脚本 ----
  const assertions = [];
  const logs = [];
  const scriptErrors = [];
  const variableWrites = { environment: {}, globals: {} };

  const persist = (area, key, value) => {
    if (!variableWrites[area]) variableWrites[area] = {};
    variableWrites[area][key] = value;
  };

  const envInfo = { envName: env?.name || '', baseUrl };

  const preSources = [];
  for (const s of collectScripts(conf.pre_tasks)) {
    // 流程执行时忽略接口自带脚本，但全局/目录脚本仍然执行
    if (!runBuiltinScripts && (!s.origin || s.origin === 'api')) continue;
    preSources.push(s.source);
  }
  if (extraPreScript && String(extraPreScript).trim()) preSources.push(String(extraPreScript));

  for (const source of preSources) {
    const result = await runScript(source, {
      variables: scope,
      request,
      response: null,
      envInfo,
      cookieJar,
      persist
    }, { phase: 'pre' });
    assertions.push(...result.assertions);
    logs.push(...result.console);
    if (result.error) {
      scriptErrors.push({ phase: 'pre', message: result.error });
      return finalize({
        apiDetail,
        request,
        response: null,
        assertions,
        logs,
        scriptErrors,
        variableWrites,
        variableScope: scope,
        startedAt,
        now,
        appliedOverrides,
        error: `前置脚本失败：${result.error}`
      });
    }
  }

  // ---- 组装最终 URL（脚本可能改了 query/header/body） ----
  let finalUrl;
  try {
    const renderedUrl = renderTemplate(apiUrl, scope);
    const resolved = resolveUrl({
      apiUrl: renderedUrl,
      baseUrl: renderTemplate(baseUrl, scope),
      restfulParams
    });
    // URL 自带 query 与参数表合并（参数表优先覆盖同名键）
    const split = splitUrlQuery(resolved);
    const mergedQuery = { ...split.params, ...request.query };
    finalUrl = split.base + buildQueryString(mergedQuery, conf.query?.query_add_equal !== 0);
    request.query = mergedQuery;
  } catch (err) {
    return finalize({
      apiDetail,
      request,
      response: null,
      assertions,
      logs,
      scriptErrors,
      variableWrites,
      variableScope: scope,
      startedAt,
      now,
      appliedOverrides,
      error: err.message
    });
  }

  request.url = finalUrl;

  // Cookie 头
  const jarHeader = cookieJar.header();
  const cookieHeader = [
    paramsToObject(cookieParams) &&
      Object.entries(request.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    jarHeader
  ]
    .filter(Boolean)
    .join('; ');
  if (cookieHeader && !Object.keys(request.headers).some((k) => k.toLowerCase() === 'cookie')) {
    request.headers.Cookie = cookieHeader;
  }

  // ---- 发送 ----
  const fetchOptions = {
    method,
    headers: { ...request.headers },
    redirect: 'follow',
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  };
  if (request.bodyBuffer) fetchOptions.body = request.bodyBuffer;
  else if (request.bodyText && !['GET', 'HEAD'].includes(method)) fetchOptions.body = request.bodyText;

  // 协议选择：接口定义的 protocol 字段
  const wantHttp2 = String(apiDetail.protocol || '').toLowerCase() === 'http/2';

  let response;
  let usedProtocol = 'HTTP/1.1';
  let protocolWarning = null;
  const netStart = Date.now();
  try {
    if (wantHttp2) {
      const h2 = await transmitHttp2({
        url: finalUrl,
        method,
        headers: request.headers,
        body: fetchOptions.body,
        timeoutMs
      });
      if (h2.fallback) {
        // http: 不能走 h2，回退到 fetch
        protocolWarning = h2.reason;
        response = await fetchImpl(finalUrl, fetchOptions);
      } else {
        usedProtocol = 'HTTP/2';
        response = {
          status: h2.status,
          statusText: h2.statusText,
          headers: {
            forEach: (cb) => {
              for (const [k, v] of Object.entries(h2.headers || {})) cb(v, k);
            },
            get: (name) => h2.headers?.[String(name).toLowerCase()] ?? null,
            getSetCookie: () => h2.setCookies || []
          },
          arrayBuffer: async () => Buffer.from(h2.bodyText, 'utf8'),
          __h2: h2
        };
      }
    } else {
      response = await fetchImpl(finalUrl, fetchOptions);
    }
  } catch (err) {
    const cause = err?.cause;
    const detail = cause
      ? ` (${cause.code || cause.errno || ''}${cause.code || cause.errno ? ': ' : ''}${cause.message || String(cause)})`
      : '';
    return finalize({
      apiDetail,
      request,
      response: null,
      assertions,
      logs,
      scriptErrors,
      variableWrites,
      variableScope: scope,
      startedAt,
      now,
      appliedOverrides,
      error: `请求失败：${err.message}${detail} — ${finalUrl}`
    });
  }
  const networkElapsed = Date.now() - netStart;

  if (protocolWarning) {
    logs.push({ level: 'warn', message: protocolWarning });
  }

  let bodyText = '';
  let bodyBuffer = null;
  try {
    bodyBuffer = Buffer.from(await response.arrayBuffer());
    bodyText = bodyBuffer.toString('utf8');
  } catch {
    bodyText = '';
  }

  const responseHeaders = {};
  try {
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
  } catch {}

  const setCookies = collectSetCookie(response);
  if (setCookies.length) cookieJar.absorb(setCookies, finalUrl);

  const bodyJson = parseJsonSafe(bodyText);

  // 响应体类型判定：文本类走 utf8 解码，二进制额外留一份原始字节（供前端预览/换编码/下载）
  const contentTypeHeader = responseHeaders['content-type'] || '';
  const loweredType = String(contentTypeHeader).toLowerCase();
  const isTextLike =
    /^text\//.test(loweredType) ||
    /^application\/(json|xml|javascript|x-www-form-urlencoded|graphql)/.test(loweredType) ||
    /\+json|\+xml/.test(loweredType);
  const isBinary = Boolean(loweredType) && !isTextLike;

  // 限制 4MB，避免把大文件塞进 HTTP 响应体；二进制与文本都带，供编码切换与下载
  const MAX_BASE64_BYTES = 4 * 1024 * 1024;
  const bodyBase64 =
    bodyBuffer && bodyBuffer.length > 0 && bodyBuffer.length <= MAX_BASE64_BYTES
      ? bodyBuffer.toString('base64')
      : null;

  const responseInfo = {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    bodyText,
    bodyJson,
    content_type: contentTypeHeader,
    is_binary: isBinary,
    body_base64: bodyBase64,
    too_large_for_base64: Boolean(bodyBuffer && bodyBuffer.length > MAX_BASE64_BYTES),
    size: bodyBuffer?.length || 0,
    setCookies,
    protocol: usedProtocol
  };

  // ---- 后置脚本 ----
  const postSources = [];
  if (extraPostScript && String(extraPostScript).trim()) postSources.push(String(extraPostScript));
  for (const s of collectScripts(conf.post_tasks)) {
    // 同上：流程里只跳过接口自带的脚本
    if (!runBuiltinScripts && (!s.origin || s.origin === 'api')) continue;
    postSources.push(s.source);
  }

  for (const source of postSources) {
    const result = await runScript(source, {
      variables: scope,
      request,
      response: responseInfo,
      envInfo,
      cookieJar,
      persist
    }, { phase: 'post' });
    assertions.push(...result.assertions);
    logs.push(...result.console);
    if (result.error) scriptErrors.push({ phase: 'post', message: result.error });
  }

  // ---- 结构校验（response.is_check_result + example[].expect） ----
  if (Number(apiDetail.response?.is_check_result) === 1) {
    const expect = pickExpect(apiDetail.response?.example);
    const verifyType = String(expect?.verify_type || 'schema');
    if (expect?.schema && verifyType === 'schema') {
      const errors = validateSchema(expect.schema, bodyJson ?? {});
      assertions.push({
        name: `响应结构校验（${expect.name || '成功'}）`,
        passed: errors.length === 0,
        phase: 'schema',
        message: errors.length ? errors.map((e) => `${e.path}: ${e.message}`).join('; ') : undefined
      });
    }
    if (expect?.code && verifyType !== 'none') {
      const codes = String(expect.code)
        .split(/[,\s|]+/)
        .filter(Boolean);
      if (codes.length) {
        const passed = codes.includes(String(response.status));
        assertions.push({
          name: `状态码校验（期望 ${codes.join('/')}）`,
          passed,
          phase: 'schema',
          message: passed ? undefined : `实际 ${response.status}`
        });
      }
    }
    // 响应头校验：expect.headers 里配置的每一条都要命中（值按包含比对）
    if (expect?.headers && typeof expect.headers === 'object') {
      const headerChecks = checkExpectedHeaders(expect.headers, responseHeaders);
      assertions.push(...headerChecks);
    }
    // Content-Type 校验
    if (expect?.content_type && String(expect.content_type).trim()) {
      const wanted = String(expect.content_type).trim().toLowerCase();
      const actual = String(responseHeaders['content-type'] || '').toLowerCase();
      const passed = actual.includes(wanted);
      assertions.push({
        name: `Content-Type 校验（期望包含 ${wanted}）`,
        passed,
        phase: 'schema',
        message: passed ? undefined : `实际 ${actual || '(空)'}`
      });
    }
  }

  return finalize({
    apiDetail,
    request,
    response: responseInfo,
    assertions,
    logs,
    scriptErrors,
    variableWrites,
    variableScope: scope,
    startedAt,
    now,
    appliedOverrides,
    networkElapsed,
    error: null
  });
}

function collectSetCookie(response) {
  const out = [];
  try {
    if (typeof response.headers.getSetCookie === 'function') {
      out.push(...response.headers.getSetCookie());
    } else if (typeof response.headers.raw === 'function') {
      out.push(...(response.headers.raw()['set-cookie'] || []));
    } else {
      const single = response.headers.get('set-cookie');
      if (single) out.push(...single.split(/,(?=[^;]+=)/));
    }
  } catch {}
  return out;
}

/** 按 expect.headers 逐条校验响应头（值按包含比对，键不区分大小写） */
export function checkExpectedHeaders(expected, actualHeaders) {
  const out = [];
  const actualLower = {};
  for (const [k, v] of Object.entries(actualHeaders || {})) actualLower[String(k).toLowerCase()] = String(v);

  for (const [rawKey, rawValue] of Object.entries(expected || {})) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const wanted = String(rawValue ?? '');
    const actual = actualLower[key.toLowerCase()];
    if (actual === undefined) {
      out.push({
        name: `响应头校验（${key}）`,
        passed: false,
        phase: 'header',
        message: `缺少响应头 ${key}`
      });
      continue;
    }
    const passed = wanted === '' || actual.includes(wanted);
    out.push({
      name: `响应头校验（${key}）`,
      passed,
      phase: 'header',
      message: passed ? undefined : `期望包含 ${wanted}，实际 ${actual}`
    });
  }
  return out;
}

function pickExpect(examples) {
  if (!Array.isArray(examples) || examples.length === 0) return null;
  return examples.find((e) => Number(e?.expect?.is_default) === 1)?.expect || examples[0]?.expect || null;
}

function finalize({
  apiDetail,
  request,
  response,
  assertions,
  logs,
  scriptErrors,
  variableWrites,
  variableScope,
  startedAt,
  now,
  appliedOverrides,
  networkElapsed,
  error
}) {
  const failedAssertion = assertions.find((a) => a.passed === false);

  let status = 'passed';
  let errorMessage = null;
  if (error) {
    status = 'failed';
    errorMessage = error;
  } else if (scriptErrors.length) {
    status = 'failed';
    errorMessage = scriptErrors.map((e) => `${e.phase}: ${e.message}`).join('; ');
  } else if (response && !(response.status >= 200 && response.status < 400)) {
    // 状态码优先，避免被结构校验的失败信息盖住
    status = 'failed';
    errorMessage = [`接口返回状态码 ${response.status}，期望 200`];
    const schemaFail = assertions.filter((a) => a.passed === false);
    if (schemaFail.length) errorMessage.push(...schemaFail.map((a) => a.message || a.name));
    errorMessage = errorMessage.join('; ');
  } else if (failedAssertion) {
    status = 'failed';
    errorMessage = failedAssertion.message || `断言失败：${failedAssertion.name}`;
  }

  return {
    status,
    error: errorMessage,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
    network_elapsed_ms: networkElapsed,
    method: request.method,
    url: request.url,
    input: appliedOverrides,
    request: redact({
      method: request.method,
      url: request.url,
      headers: request.headers,
      query: request.query,
      cookies: request.cookies,
      body_mode: request.bodyMode,
      body: request.bodyText
    }),
    response: response
      ? redact({
          status: response.status,
          status_text: response.statusText,
          headers: response.headers,
          body: truncate(response.bodyText, 200000),
          size: response.size,
          content_type: response.content_type || '',
          is_binary: Boolean(response.is_binary),
          // 落盘记录只留标记，不存 base64（避免 50 条历史膨胀）
          has_binary: Boolean(response.body_base64)
        })
      : null,
    assertions,
    console: logs,
    script_errors: scriptErrors,
    variable_writes: variableWrites,
    variables: variableScope?.toObject?.() || {},
    api_name: apiDetail.name || '',
    api_target_id: apiDetail.target_id || '',
    // 仅即时返回用，不参与落盘
    live_binary: {
      body_base64: response?.body_base64 || null,
      too_large: Boolean(response?.too_large_for_base64)
    },
    // 仅即时返回用：未脱敏的完整请求 / 响应详情（不落盘，只给本地控制台）
    live_detail: {
      request: {
        method: request.method,
        url: request.url,
        headers: request.headers,
        query: request.query,
        cookies: request.cookies,
        body_mode: request.bodyMode,
        body: truncate(request.bodyText, 200000)
      },
      response: response
        ? {
            status: response.status,
            status_text: response.statusText,
            protocol: response.protocol,
            headers: response.headers,
            set_cookies: response.setCookies || [],
            size: response.size,
            content_type: response.content_type || ''
          }
        : null
    }
  };
}

function truncate(text, max) {
  if (typeof text !== 'string') return text;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated, total ${text.length} chars)`;
}

export { buildQueryString, paramsToObject, mergeOverrides, buildBody };
