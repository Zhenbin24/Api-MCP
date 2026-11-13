/**
 * HAR 1.2 解析：log.entries[] -> 扁平接口列表。
 *
 * 与 Postman 解析器输出同一结构，落库走 apply.js。
 */

import { makeParameter, buildBlankBody, buildEmptyAuth } from '../store/apis.js';
import { jsonToSchema } from '../../web/curl-parse.js';

/** 从 URL 推断一个可读名字：取最后一个路径段 */
function nameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const tail = segments[segments.length - 1] || parsed.hostname || '接口';
    return tail.length > 48 ? tail.slice(0, 48) : tail;
  } catch {
    const tail = String(url || '').split('?')[0].split('/').filter(Boolean).pop();
    return tail || '接口';
  }
}

/** 请求头转参数表，跳过伪头与 HTTP/2 冒号头 */
function headersFromHar(headers) {
  const out = [];
  for (const h of headers || []) {
    if (!h || h.name === undefined) continue;
    const name = String(h.name);
    if (name.startsWith(':')) continue;
    // HAR 里这两个是协议层产生的，不该落进接口定义
    if (/^(host|content-length|connection)$/i.test(name)) continue;
    out.push(makeParameter({ key: name, value: h.value === undefined ? '' : String(h.value), description: h.comment || '' }));
  }
  return out;
}

function queryFromHar(queryString) {
  return (queryString || [])
    .filter((q) => q && q.name !== undefined)
    .map((q) => makeParameter({ key: String(q.name), value: q.value === undefined ? '' : String(q.value), description: q.comment || '' }));
}

/** postData -> 接口 request.body */
function bodyFromHar(postData) {
  const blank = buildBlankBody();
  if (!postData || typeof postData !== 'object') return blank;

  const mime = String(postData.mimeType || '').toLowerCase();
  const text = postData.text;

  // 结构化 params（HAR 对 form 请求会给出）
  if (Array.isArray(postData.params) && postData.params.length > 0) {
    const isMultipart = mime.includes('multipart');
    return {
      ...blank,
      mode: isMultipart ? 'form-data' : 'urlencoded',
      parameter: postData.params
        .filter((p) => p && p.name !== undefined)
        .map((p) =>
          makeParameter({
            key: String(p.name),
            value: p.value === undefined || p.value === null ? (p.fileName ? p.fileName : '') : String(p.value),
            fieldType: p.fileName || p.value === undefined ? 'File' : 'String',
            description: p.comment || ''
          })
        )
    };
  }

  if (text === undefined || text === null) return blank;
  const raw = String(text);

  if (mime.includes('json') || (!mime && /^\s*[{[]/.test(raw))) {
    let schema = { type: 'object' };
    try {
      schema = jsonToSchema(JSON.parse(raw));
    } catch {
      // 非法 JSON：原文保留，schema 留空对象
    }
    return { ...blank, mode: 'json', raw, raw_schema: schema, raw_parameter: [] };
  }

  if (mime.includes('x-www-form-urlencoded')) {
    const params = [];
    for (const pair of raw.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      params.push(makeParameter({ key: decodeURIComponent(key), value: decodeURIComponent(value) }));
    }
    return { ...blank, mode: 'urlencoded', parameter: params };
  }

  if (mime.includes('xml')) return { ...blank, mode: 'xml', raw, raw_schema: { type: 'string' } };
  if (mime.includes('html')) return { ...blank, mode: 'html', raw, raw_schema: { type: 'string' } };

  return { ...blank, mode: 'raw', raw, raw_schema: { type: 'string' } };
}

/** 从 Set-Cookie 之类的响应头推断不了 Cookie，直接留空 */

/**
 * 解析 HAR
 * @param {object} har
 * @returns {{ items: Array, collectionName: string, warnings: string[] }}
 */
export function parseHar(har) {
  const log = har?.log;
  if (!log || !Array.isArray(log.entries)) {
    throw new Error('不是 HAR 文件：缺少 log.entries 数组');
  }

  const items = [];
  const warnings = [];

  for (const entry of log.entries) {
    if (!entry || !entry.request) continue;
    const req = entry.request;
    const url = String(req.url || '');
    if (!url) {
      warnings.push('跳过一条没有 URL 的请求');
      continue;
    }

    const method = String(req.method || 'GET').toUpperCase();
    const request = {
      auth: buildEmptyAuth(),
      body: bodyFromHar(req.postData),
      cookie: { parameter: [] },
      header: { parameter: headersFromHar(req.headers) },
      post_tasks: [],
      pre_tasks: [],
      query: { parameter: queryFromHar(req.queryString), query_add_equal: 1 },
      restful: { parameter: [] }
    };

    // HAR 里 URL 常带 query，落库时 URL 保留原样即可；
    // 但为避免和 query 参数表重复，这里把 query 从 URL 上剥掉
    let cleanUrl = url;
    const qIndex = cleanUrl.indexOf('?');
    if (qIndex !== -1 && request.query.parameter.length > 0) cleanUrl = cleanUrl.slice(0, qIndex);

    items.push({
      name: nameFromUrl(url),
      method,
      url: cleanUrl,
      summary: '',
      description: String(entry.comment || ''),
      folderPath: [],
      tags: [],
      request,
      response: null
    });
  }

  return {
    items,
    collectionName: String(log.creator?.name || 'HAR 导入'),
    warnings
  };
}
