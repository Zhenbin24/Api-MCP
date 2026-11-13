/**
 * Postman Collection v2.0 / v2.1 解析。
 *
 * 只做「collection -> 扁平接口列表」的映射，落库交给 apply.js。
 * 输出结构与 src/openapi/convert.js 的 parseOpenApi 保持一致，
 * 这样三条导入路径能共用同一份落库逻辑。
 */

import { makeParameter, buildBlankBody, buildEmptyAuth } from '../store/apis.js';
import { jsonToSchema } from '../../web/curl-parse.js';

/** Postman 变量占位符 {{var}} 原样保留（模板引擎会在发送时替换） */

function emptyRequest() {
  return {
    auth: buildEmptyAuth(),
    body: buildBlankBody(),
    cookie: { parameter: [] },
    header: { parameter: [] },
    post_tasks: [],
    pre_tasks: [],
    query: { parameter: [], query_add_equal: 1 },
    restful: { parameter: [] }
  };
}

/** Postman header 的 disabled 字段决定是否勾选 */
function headersFromList(list) {
  const out = [];
  for (const h of list || []) {
    if (!h || h.key === undefined) continue;
    if (h.disabled) continue;
    out.push(
      makeParameter({
        key: String(h.key),
        value: h.value === undefined || h.value === null ? '' : String(h.value),
        description: h.description || ''
      })
    );
  }
  return out;
}

/** url 可能是字符串，也可能是对象（raw / host / path / query / variable） */
function parsePostmanUrl(url) {
  const result = { raw: '', query: [], pathVars: [] };
  if (!url) return result;

  if (typeof url === 'string') {
    result.raw = url;
    return result;
  }

  if (typeof url.raw === 'string' && url.raw) {
    result.raw = url.raw;
  } else {
    const host = Array.isArray(url.host) ? url.host.join('.') : String(url.host || '');
    const pathSeg = Array.isArray(url.path) ? url.path.join('/') : String(url.path || '');
    const protocol = url.protocol ? `${url.protocol}://` : '';
    const port = url.port ? `:${url.port}` : '';
    result.raw = `${protocol}${host}${port}/${pathSeg}`.replace(/\/+$/, (m) => (pathSeg ? m : ''));
  }

  for (const q of url.query || []) {
    if (!q || q.key === undefined) continue;
    result.query.push({
      key: String(q.key),
      value: q.value === undefined || q.value === null ? '' : String(q.value),
      description: q.description || '',
      disabled: Boolean(q.disabled)
    });
  }

  for (const v of url.variable || []) {
    if (!v || v.key === undefined) continue;
    result.pathVars.push({ key: String(v.key), value: v.value ?? '', description: v.description || '' });
  }

  return result;
}

/** 从 raw URL 里拆出 query（Postman 有时只给 raw） */
function splitRawQuery(raw) {
  const out = [];
  const text = String(raw || '');
  const qIndex = text.indexOf('?');
  if (qIndex === -1) return { url: text, query: out };
  const url = text.slice(0, qIndex);
  const search = text.slice(qIndex + 1).split('#')[0];
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    out.push({ key: decodeURIComponent(key), value: decodeURIComponent(value) });
  }
  return { url, query: out };
}

/** Postman auth -> 接口 request.auth */
function authFromPostman(auth, variables) {
  const result = buildEmptyAuth();
  if (!auth || typeof auth !== 'object') return result;

  const type = String(auth.type || '').toLowerCase();
  const params = Array.isArray(auth[type]) ? auth[type] : [];
  const get = (key) => {
    const hit = params.find((p) => String(p?.key || '').toLowerCase() === key);
    return hit ? String(hit.value ?? '') : '';
  };

  if (type === 'bearer') {
    result.type = 'bearer';
    result.bearer.key = get('token');
    return result;
  }
  if (type === 'basic') {
    result.type = 'basic';
    result.basic.username = get('username');
    result.basic.password = get('password');
    return result;
  }
  if (type === 'apikey') {
    result.type = 'apikey';
    result.kv.key = get('key');
    result.kv.value = get('value');
    result.kv.in = String(get('in') || 'header').toLowerCase() === 'query' ? 'query' : 'header';
    return result;
  }
  if (type === 'oauth2') {
    result.type = 'oauth2';
    result.oauth2.access_token = get('accessToken') || get('token');
    result.oauth2.headerPrefix = get('headerPrefix') || 'Bearer';
    return result;
  }
  return result;
}

/** Postman body -> 接口 request.body */
function bodyFromPostman(body) {
  const blank = buildBlankBody();
  if (!body || typeof body !== 'object') return blank;

  const mode = String(body.mode || '').toLowerCase();

  if (mode === 'raw') {
    const raw = String(body.raw ?? '');
    const lang = String(body.options?.raw?.language || '').toLowerCase();
    let detected = lang;
    if (!detected) {
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) detected = 'json';
      else if (/^<([a-z]+:)?[a-z]/i.test(trimmed) && trimmed.includes('</')) detected = 'xml';
      else detected = 'text';
    }
    if (detected === 'json') {
      let schema = { type: 'object' };
      let rawParameter = [];
      try {
        const parsed = JSON.parse(raw);
        schema = jsonToSchema(parsed);
        rawParameter = [];
      } catch {
        // JSON 写错时保留原文，schema 留空对象
      }
      return { ...blank, mode: 'json', raw, raw_schema: schema, raw_parameter: rawParameter };
    }
    if (detected === 'xml' || detected === 'html') {
      return { ...blank, mode: detected, raw, raw_schema: { type: 'string' } };
    }
    return { ...blank, mode: 'raw', raw, raw_schema: { type: 'string' } };
  }

  if (mode === 'urlencoded') {
    return {
      ...blank,
      mode: 'urlencoded',
      parameter: (body.urlencoded || []).filter((p) => p && !p.disabled).map((p) =>
        makeParameter({ key: String(p.key ?? ''), value: String(p.value ?? ''), description: p.description || '' })
      )
    };
  }

  if (mode === 'formdata') {
    return {
      ...blank,
      mode: 'form-data',
      parameter: (body.formdata || []).filter((p) => p && !p.disabled).map((p) =>
        makeParameter({
          key: String(p.key ?? ''),
          value: p.type === 'file' ? String(p.src ?? '') : String(p.value ?? ''),
          fieldType: p.type === 'file' ? 'File' : 'String',
          description: p.description || ''
        })
      )
    };
  }

  if (mode === 'graphql') {
    const g = body.graphql || {};
    const raw = JSON.stringify({ query: g.query || '', variables: g.variables || '' }, null, 2);
    return { ...blank, mode: 'json', raw, raw_schema: { type: 'object' }, raw_parameter: [] };
  }

  return blank;
}

/** 解析 collection 里的 variables（{{var}} 的默认值） */
function variablesFromCollection(collection) {
  const out = {};
  for (const v of collection?.variable || []) {
    if (!v || v.key === undefined) continue;
    out[String(v.key)] = v.value === undefined || v.value === null ? '' : String(v.value);
  }
  return out;
}

/** 从 URL 和请求推断一个可读名字 */
function suggestName(request, folderPath) {
  const name = String(request?.name || '').trim();
  if (name) return name;
  const raw = String(request?.url || '');
  const pathPart = raw.split('?')[0];
  const tail = pathPart.split('/').filter(Boolean).pop();
  return tail || '未命名接口';
}

/**
 * 递归展开 item（Postman 里 item 既可能是目录，也可能是请求）
 * @param {Array} items
 * @param {string[]} folderPath
 * @param {Array} out
 */
function walkItems(items, folderPath, out) {
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;

    if (item.item) {
      // 目录
      const name = String(item.name || '未命名目录');
      walkItems(item.item, [...folderPath, name], out);
      continue;
    }

    if (!item.request) continue;

    const req = item.request;
    // request 可以是字符串（只有 URL）
    const isStringRequest = typeof req === 'string';
    const method = isStringRequest ? 'GET' : String(req.method || 'GET').toUpperCase();
    const urlPart = isStringRequest ? req : parsePostmanUrl(req.url);

    let url = urlPart.raw || '';
    const query = [...(urlPart.query || [])];

    // raw 里带 query 但没有结构化 query 时补上
    if (query.length === 0 && url.includes('?')) {
      const split = splitRawQuery(url);
      url = split.url;
      query.push(...split.query);
    }

    const request = emptyRequest();
    request.auth = authFromPostman(isStringRequest ? null : req.auth, null);
    request.header.parameter = headersFromList(isStringRequest ? [] : req.header);
    request.body = bodyFromPostman(isStringRequest ? null : req.body);
    request.query.parameter = query.filter((q) => !q.disabled).map((q) =>
      makeParameter({ key: q.key, value: q.value, description: q.description || '' })
    );
    request.restful.parameter = (urlPart.pathVars || []).map((v) =>
      makeParameter({ key: v.key, value: v.value, description: v.description || '' })
    );

    out.push({
      name: suggestName({ name: item.name, url }, folderPath),
      method,
      url,
      summary: String(item.name || ''),
      description: isStringRequest ? '' : String(req.description || ''),
      folderPath: [...folderPath],
      tags: folderPath.length > 0 ? [folderPath[0]] : [],
      request,
      response: null
    });
  }
}

/**
 * 解析 Postman Collection
 * @param {object} collection
 * @returns {{ items: Array, collectionName: string, variables: Record<string,string> }}
 */
export function parsePostmanCollection(collection) {
  if (!collection || typeof collection !== 'object') throw new Error('Postman Collection 数据无效');

  const info = collection.info || {};
  const schema = String(info.schema || '');
  if (schema && !/collection\/v2/i.test(schema)) {
    throw new Error(`仅支持 Postman Collection v2.0 / v2.1，当前 schema 为 ${schema}`);
  }
  if (!collection.item && !schema) {
    throw new Error('不是 Postman Collection：缺少 info.schema 与 item');
  }

  const items = [];
  walkItems(collection.item, [], items);

  return {
    items,
    collectionName: String(info.name || 'Postman 导入'),
    variables: variablesFromCollection(collection)
  };
}

/**
 * 解析 Postman 环境文件（Environment / Globals）
 * @param {object} env
 * @returns {{ name: string, values: Array<{key,value}> }}
 */
export function parsePostmanEnvironment(env) {
  if (!env || typeof env !== 'object') throw new Error('Postman 环境数据无效');
  if (!Array.isArray(env.values)) throw new Error('不是 Postman 环境文件：缺少 values 数组');
  return {
    name: String(env.name || '导入的环境'),
    values: env.values
      .filter((v) => v && v.key !== undefined && !v.enabled === false)
      .map((v) => ({ key: String(v.key), value: v.value === undefined || v.value === null ? '' : String(v.value) }))
  };
}
