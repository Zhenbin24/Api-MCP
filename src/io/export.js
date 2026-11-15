/**
 * 导出：项目 -> OpenAPI 3.0（JSON / YAML）或 Postman Collection v2.1。
 *
 * 与导入对称：导出的结构能再被 import.js 读回来（往返一致性由 test/io.test.mjs 覆盖）。
 */

import { listApiItems, readApiFile, TARGET_TYPE } from '../store/apis.js';
import { listEnvironments, readCurrentEnvId, envBaseUrl } from '../store/envs.js';
import { readProjectMeta } from '../store/projects.js';
import { jsonToYaml } from '../util/yaml.js';

/** 支持导出的格式 */
export const EXPORT_FORMATS = ['openapi', 'openapi_yaml', 'postman', 'markdown', 'html', 'word'];

export const EXPORT_LABEL = {
  openapi: 'OpenAPI 3.0 (JSON)',
  openapi_yaml: 'OpenAPI 3.0 (YAML)',
  postman: 'Postman Collection v2.1',
  markdown: 'Markdown 文档',
  html: 'HTML 文档（可打印为 PDF）',
  // 采用 HTML 包装的 .doc：Word / WPS 可直接打开，无需手写 OOXML
  word: 'Word 文档 (.doc)'
};

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']);

/** 文件名里去掉非法字符 */
function safeFilename(name) {
  return String(name || 'project')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 64) || 'project';
}

/** 目标类型 -> 目录层级（父在前） */
function folderChain(items, parentId) {
  const byId = new Map(items.map((i) => [i.target_id, i]));
  const chain = [];
  let cursor = parentId;
  let guard = 0;
  while (cursor && cursor !== '0' && guard < 64) {
    const node = byId.get(cursor);
    if (!node) break;
    chain.unshift(node.name || '未命名目录');
    cursor = node.parent_id || '0';
    guard += 1;
  }
  return chain;
}

/** 参数列表 -> OpenAPI parameters（只处理 query / header / path） */
function parametersFromRequest(request, chain) {
  const out = [];

  for (const p of request?.query?.parameter || []) {
    if (!p || !p.key) continue;
    out.push({
      name: String(p.key),
      in: 'query',
      required: false,
      ...(p.description ? { description: String(p.description) } : {}),
      schema: { type: 'string' },
      ...(p.value !== undefined && p.value !== '' ? { example: String(p.value) } : {})
    });
  }

  for (const p of request?.header?.parameter || []) {
    if (!p || !p.key) continue;
    // Cookie 在导出时按普通 header 处理，这与「Cookie 统一写 Header」的产品口径一致
    out.push({
      name: String(p.key),
      in: 'header',
      required: false,
      ...(p.description ? { description: String(p.description) } : {}),
      schema: { type: 'string' },
      ...(p.value !== undefined && p.value !== '' ? { example: String(p.value) } : {})
    });
  }

  for (const p of request?.restful?.parameter || []) {
    if (!p || !p.key) continue;
    out.push({
      name: String(p.key),
      in: 'path',
      required: true,
      ...(p.description ? { description: String(p.description) } : {}),
      schema: { type: 'string' }
    });
  }

  return out;
}

/** 接口 body -> OpenAPI requestBody */
function requestBodyFromApi(request) {
  const body = request?.body;
  if (!body || !body.mode || body.mode === 'none') return null;

  const mode = String(body.mode);

  if (['json', 'raw', 'xml', 'html', 'javascript', 'plain', 'text'].includes(mode)) {
    const schema =
      body.raw_schema && typeof body.raw_schema === 'object' && Object.keys(body.raw_schema).length > 0
        ? apipostSchemaToOpenApi(body.raw_schema)
        : { type: 'string' };
    const type =
      mode === 'json'
        ? 'application/json'
        : mode === 'xml'
          ? 'application/xml'
          : mode === 'html'
            ? 'text/html'
            : 'text/plain';
    const entry = { schema };
    if (body.raw !== undefined && body.raw !== '') {
      if (mode === 'json') {
        try {
          entry.example = JSON.parse(body.raw);
        } catch {
          entry.example = String(body.raw);
        }
      } else {
        entry.example = String(body.raw);
      }
    }
    return { required: false, content: { [type]: entry } };
  }

  if (mode === 'urlencoded' || mode === 'form-data') {
    const properties = {};
    const required = [];
    for (const p of body.parameter || []) {
      if (!p || !p.key) continue;
      const type = String(p.field_type || 'String').toLowerCase();
      properties[String(p.key)] = {
        type: type === 'file' ? 'string' : type === 'integer' ? 'integer' : type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : 'string',
        ...(type === 'file' ? { format: 'binary' } : {}),
        ...(p.description ? { description: String(p.description) } : {})
      };
      if (p.not_null === 1) required.push(String(p.key));
    }
    const type = mode === 'form-data' ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
    return {
      required: false,
      content: {
        [type]: {
          schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
        }
      }
    };
  }

  if (mode === 'binary') {
    return {
      required: false,
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
    };
  }

  return null;
}

/** Apipost 内部 schema -> 标准 JSON Schema（保留属性顺序） */
function apipostSchemaToOpenApi(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 20) return { type: 'object' };

  const type = String(schema.type || 'object');
  const out = { type };
  if (schema.description) out.description = String(schema.description);
  if (schema.example !== undefined) out.example = schema.example;
  if (schema.default !== undefined) out.default = schema.default;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;

  if (type === 'object' || schema.properties) {
    const props = schema.properties || {};
    const orders = Array.isArray(schema.APIPOST_ORDERS) && schema.APIPOST_ORDERS.length > 0
      ? schema.APIPOST_ORDERS.filter((k) => k in props)
      : Object.keys(props);
    const properties = {};
    for (const key of orders) {
      properties[key] = apipostSchemaToOpenApi(props[key], depth + 1);
    }
    out.type = 'object';
    out.properties = properties;
    if (Array.isArray(schema.required) && schema.required.length > 0) out.required = [...schema.required];
  } else if (type === 'array') {
    out.items = apipostSchemaToOpenApi(schema.items || { type: 'string' }, depth + 1);
  } else if (schema.format) {
    out.format = String(schema.format);
  }

  return out;
}

/** 响应示例 -> OpenAPI responses */
function responsesFromApi(response) {
  const examples = Array.isArray(response?.example) ? response.example : [];
  if (examples.length === 0) {
    return { '200': { description: 'OK' } };
  }

  const out = {};
  for (const ex of examples) {
    const code = String(ex?.expect?.code || '200');
    const contentType = String(ex?.expect?.content_type || 'json');
    const entry = { description: String(ex?.expect?.name || `响应 ${code}`) };

    const schema =
      ex?.expect?.schema && typeof ex.expect.schema === 'object' && Object.keys(ex.expect.schema).length > 0
        ? apipostSchemaToOpenApi(ex.expect.schema)
        : { type: 'string' };

    const mediaType =
      contentType === 'json'
        ? 'application/json'
        : contentType === 'xml'
          ? 'application/xml'
          : contentType === 'html'
            ? 'text/html'
            : 'text/plain';

    entry.content = { [mediaType]: { schema } };
    if (ex?.raw) {
      if (contentType === 'json') {
        try {
          entry.content[mediaType].example = JSON.parse(ex.raw);
        } catch {
          entry.content[mediaType].example = String(ex.raw);
        }
      } else {
        entry.content[mediaType].example = String(ex.raw);
      }
    }

    // 同一状态码出现多次时保留第一个，避免覆盖
    if (!out[code]) out[code] = entry;
  }

  return Object.keys(out).length > 0 ? out : { '200': { description: 'OK' } };
}

/** 收集项目里的 HTTP 接口（目录/文档/SSE 不导出） */
function collectHttpApis(target) {
  const items = listApiItems(target);
  const out = [];
  for (const item of items) {
    if (item.target_type !== TARGET_TYPE.API) continue;
    const method = String(item.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) continue;
    const file = readApiFile(target, item.target_id);
    out.push({
      index: item,
      data: file?.data || {},
      folderPath: folderChain(items, item.parent_id || '0')
    });
  }
  // 按目录层级 + sort 排序，导出结果稳定
  out.sort((a, b) => {
    const pa = a.folderPath.join('/');
    const pb = b.folderPath.join('/');
    if (pa !== pb) return pa.localeCompare(pb);
    return (a.index.sort ?? 0) - (b.index.sort ?? 0);
  });
  return out;
}

/** 项目的默认 base url：优先当前环境的默认服务 */
function projectBaseUrl(target) {
  const envs = listEnvironments(target);
  if (envs.length === 0) return '';
  const currentId = readCurrentEnvId(target);
  const env = envs.find((e) => e.env_id === currentId) || envs[0];
  return envBaseUrl(env) || '';
}

/** 项目 -> OpenAPI 3.0 对象 */
export function projectToOpenApi(target, { projectId, projectName } = {}) {
  const meta = readProjectMeta(target.dataRoot, projectId) || {};
  const apis = collectHttpApis(target);

  const paths = {};
  const tagSet = new Set();

  for (const { index, data, folderPath } of apis) {
    const method = String(index.method || 'GET').toUpperCase();
    const url = String(index.url || '');
    if (!url) continue;

    // 相对 URL 保留原样；绝对 URL 剥掉 base 前缀，落成 path（OpenAPI 的 path 必须以 / 开头）
    let pathKey = url;
    const base = projectBaseUrl(target);
    if (base && pathKey.startsWith(base)) pathKey = pathKey.slice(base.length);
    if (/^https?:\/\//i.test(pathKey)) {
      try {
        pathKey = new URL(pathKey).pathname;
      } catch {
        // 解析失败就保留原样
      }
    }
    if (!pathKey.startsWith('/')) pathKey = `/${pathKey}`;

    // path 里的 {name} 与 Apipost 的 restful 参数对齐；没有花括号就原样
    const operation = {
      ...(folderPath.length > 0 ? { tags: [folderPath.join('/')] } : {}),
      ...(index.name ? { summary: String(index.name) } : {}),
      ...(data.description ? { description: String(data.description) } : {})
    };

    const params = parametersFromRequest(data.request, folderPath);
    if (params.length > 0) operation.parameters = params;

    const body = requestBodyFromApi(data.request);
    if (body) operation.requestBody = body;

    operation.responses = responsesFromApi(data.response);

    if (!paths[pathKey]) paths[pathKey] = {};
    // 同一个 path 上同 method 重复时后者覆盖前者（数据本身应当唯一）
    paths[pathKey][method.toLowerCase()] = operation;
    if (folderPath.length > 0) tagSet.add(folderPath.join('/'));
  }

  const openapi = {
    openapi: '3.0.3',
    info: {
      title: String(projectName || meta.name || 'API MCP 项目'),
      version: '1.0.0',
      ...(meta.intro || meta.description ? { description: String(meta.intro || meta.description) } : {})
    },
    paths
  };

  const base = projectBaseUrl(target);
  if (base) openapi.servers = [{ url: base }];
  if (tagSet.size > 0) openapi.tags = [...tagSet].sort().map((name) => ({ name }));

  return openapi;
}

/** 参数表 -> Postman 的 header/query 数组 */
function toPostmanParams(list) {
  return (list || [])
    .filter((p) => p && p.key)
    .map((p) => ({
      key: String(p.key),
      value: p.value === undefined || p.value === null ? '' : String(p.value),
      ...(p.description ? { description: String(p.description) } : {}),
      ...(p.is_checked === 0 ? { disabled: true } : {})
    }));
}

/** 接口鉴权 -> Postman auth */
function toPostmanAuth(auth) {
  const type = String(auth?.type || 'noauth');
  if (type === 'bearer') {
    return { type: 'bearer', bearer: [{ key: 'token', value: String(auth.bearer?.key || ''), type: 'string' }] };
  }
  if (type === 'basic') {
    return {
      type: 'basic',
      basic: [
        { key: 'username', value: String(auth.basic?.username || ''), type: 'string' },
        { key: 'password', value: String(auth.basic?.password || ''), type: 'string' }
      ]
    };
  }
  if (type === 'apikey' || type === 'kv') {
    return {
      type: 'apikey',
      apikey: [
        { key: 'key', value: String(auth.kv?.key || ''), type: 'string' },
        { key: 'value', value: String(auth.kv?.value || ''), type: 'string' },
        { key: 'in', value: String(auth.kv?.in || 'header'), type: 'string' }
      ]
    };
  }
  if (type === 'oauth2') {
    return {
      type: 'oauth2',
      oauth2: [{ key: 'accessToken', value: String(auth.oauth2?.access_token || ''), type: 'string' }]
    };
  }
  return undefined;
}

/** 接口 body -> Postman body */
function toPostmanBody(request) {
  const body = request?.body;
  if (!body || !body.mode || body.mode === 'none') return undefined;
  const mode = String(body.mode);

  if (['json', 'raw', 'xml', 'html', 'javascript', 'plain', 'text'].includes(mode)) {
    return {
      mode: 'raw',
      raw: body.raw === undefined || body.raw === null ? '' : String(body.raw),
      options: {
        raw: {
          language:
            mode === 'json' ? 'json' : mode === 'xml' ? 'xml' : mode === 'html' ? 'html' : mode === 'javascript' ? 'javascript' : 'text'
        }
      }
    };
  }

  if (mode === 'urlencoded') {
    return {
      mode: 'urlencoded',
      urlencoded: (body.parameter || [])
        .filter((p) => p && p.key)
        .map((p) => ({
          key: String(p.key),
          value: p.value === undefined || p.value === null ? '' : String(p.value),
          ...(p.description ? { description: String(p.description) } : {}),
          ...(p.is_checked === 0 ? { disabled: true } : {})
        }))
    };
  }

  if (mode === 'form-data') {
    return {
      mode: 'formdata',
      formdata: (body.parameter || [])
        .filter((p) => p && p.key)
        .map((p) => ({
          key: String(p.key),
          value: p.value === undefined || p.value === null ? '' : String(p.value),
          type: String(p.field_type || '').toLowerCase() === 'file' ? 'file' : 'text',
          ...(p.description ? { description: String(p.description) } : {}),
          ...(p.is_checked === 0 ? { disabled: true } : {})
        }))
    };
  }

  return undefined;
}

/** 接口 -> Postman item */
function toPostmanItem({ index, data }) {
  const method = String(index.method || 'GET').toUpperCase();
  const url = String(index.url || '');

  const query = toPostmanParams(data.request?.query?.parameter);
  const header = toPostmanParams(data.request?.header?.parameter);

  const urlObj = { raw: url };
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      urlObj.protocol = parsed.protocol.replace(':', '');
      urlObj.host = parsed.hostname.split('.');
      if (parsed.port) urlObj.port = parsed.port;
      urlObj.path = parsed.pathname.split('/').filter(Boolean);
    } catch {
      // 保持只有 raw
    }
  } else if (url.startsWith('/')) {
    urlObj.path = url.split('?')[0].split('/').filter(Boolean);
  }
  if (query.length > 0) urlObj.query = query;

  const item = {
    name: String(index.name || url || '未命名接口'),
    request: {
      method,
      header,
      url: urlObj
    }
  };

  const auth = toPostmanAuth(data.request?.auth);
  if (auth) item.request.auth = auth;

  const body = toPostmanBody(data.request);
  if (body) item.request.body = body;

  if (data.description) item.request.description = String(data.description);

  // 响应示例
  const examples = Array.isArray(data.response?.example) ? data.response.example : [];
  if (examples.length > 0) {
    item.response = examples.map((ex) => {
      const contentType = String(ex?.expect?.content_type || 'json');
      return {
        name: String(ex?.expect?.name || `响应 ${ex?.expect?.code || 200}`),
        originalRequest: { method, url: urlObj, header },
        status: 'OK',
        code: Number(ex?.expect?.code) || 200,
        _postman_previewlanguage: contentType === 'json' ? 'json' : 'text',
        header: [{ key: 'Content-Type', value: contentType === 'json' ? 'application/json' : 'text/plain' }],
        body: ex?.raw === undefined || ex?.raw === null ? '' : String(ex.raw)
      };
    });
  }

  return item;
}

/** 按目录层级把接口组织成 Postman item 树 */
function buildPostmanTree(apis) {
  const root = { children: [], items: [] };

  const ensureFolder = (pathParts) => {
    let node = root;
    for (const name of pathParts) {
      let child = node.children.find((c) => c.name === name);
      if (!child) {
        child = { name, children: [], items: [] };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };

  for (const api of apis) {
    const node = ensureFolder(api.folderPath);
    node.items.push(toPostmanItem(api));
  }

  const render = (node) => {
    const out = [];
    for (const child of node.children) {
      out.push({ name: child.name, item: render(child) });
    }
    out.push(...node.items);
    return out;
  };

  return render(root);
}

/** 项目 -> Postman Collection v2.1 对象 */
export function projectToPostman(target, { projectId, projectName } = {}) {
  const meta = readProjectMeta(target.dataRoot, projectId) || {};
  const apis = collectHttpApis(target);
  const base = projectBaseUrl(target);

  const collection = {
    info: {
      name: String(projectName || meta.name || 'API MCP 项目'),
      description: String(meta.intro || ''),
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: buildPostmanTree(apis)
  };

  const variables = [];
  if (base) variables.push({ key: 'baseUrl', value: base });
  if (variables.length > 0) collection.variable = variables;

  return collection;
}

/**
 * 导出入口
 * @param {object} target ProjectTarget
 * @param {object} options
 * @returns {{ filename: string, mime: string, content: string, format: string }}
 */
export function exportProject(target, { projectId, projectName, format = 'openapi', includeRuns = false } = {}) {
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Error(`不支持的导出格式：${format}，可选 ${EXPORT_FORMATS.join('/')}`);
  }

  const meta = readProjectMeta(target.dataRoot, projectId) || {};
  const name = projectName || meta.name || 'project';
  const base = safeFilename(name);

  if (format === 'postman') {
    const collection = projectToPostman(target, { projectId, projectName: name });
    return {
      filename: `${base}.postman_collection.json`,
      mime: 'application/json; charset=utf-8',
      content: `${JSON.stringify(collection, null, 2)}\n`,
      format
    };
  }

  // 文档类导出：Markdown / HTML / Word（HTML 包装的 .doc）
  if (format === 'markdown') {
    const doc = projectToMarkdown(target, { projectId, projectName: name });
    return {
      filename: `${base}.md`,
      mime: 'text/markdown; charset=utf-8',
      content: doc.content,
      format
    };
  }

  if (format === 'html') {
    const doc = projectToHtml(target, { projectId, projectName: name });
    return {
      filename: `${base}.html`,
      mime: 'text/html; charset=utf-8',
      content: doc.content,
      format
    };
  }

  if (format === 'word') {
    const doc = projectToWord(target, { projectId, projectName: name });
    return {
      filename: `${base}.doc`,
      // Word 认这个 MIME，用 .doc 扩展名打开不会提示格式错误
      mime: 'application/msword; charset=utf-8',
      content: doc.content,
      format
    };
  }

  const openapi = projectToOpenApi(target, { projectId, projectName: name });

  if (format === 'openapi_yaml') {
    return {
      filename: `${base}.openapi.yaml`,
      mime: 'application/yaml; charset=utf-8',
      content: jsonToYaml(openapi),
      format
    };
  }

  return {
    filename: `${base}.openapi.json`,
    mime: 'application/json; charset=utf-8',
    content: `${JSON.stringify(openapi, null, 2)}\n`,
    format
  };
}

/* ================= 文档导出（Markdown / HTML / Word） ================= */

/** Markdown 表格里需要转义的字符 */
function mdCell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function htmlEscape(text) {
  return String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** 连续空行压成一个，避免各段落拼接后出现大段留白 */
function collapseBlankLines(text) {
  return String(text || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
}

/** 参数表 -> Markdown 表格；没有参数返回空串 */
function paramsTableMd(title, params, { withDescription = true } = {}) {
  const rows = (params || []).filter((p) => p && p.key);
  if (rows.length === 0) return '';

  const lines = [];
  lines.push(`**${title}**`);
  lines.push('');
  if (withDescription) {
    lines.push('| 参数名 | 类型 | 必填 | 说明 | 示例值 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const p of rows) {
      const required = Number(p.not_null) === 1 ? '是' : '否';
      lines.push(
        `| ${mdCell(p.key)} | ${mdCell(p.field_type || 'String')} | ${required} | ${mdCell(p.description)} | ${mdCell(p.value)} |`
      );
    }
  } else {
    lines.push('| 参数名 | 类型 | 说明 |');
    lines.push('| --- | --- | --- |');
    for (const p of rows) {
      lines.push(`| ${mdCell(p.key)} | ${mdCell(p.field_type || 'String')} | ${mdCell(p.description)} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** 请求头 / Query / Path 三段 */
function requestSectionsMd(data) {
  const req = data?.request || {};
  const parts = [];
  const header = paramsTableMd('Header 参数', req.header?.parameter, { withDescription: false });
  if (header) parts.push(header);
  const query = paramsTableMd('Query 参数', req.query?.parameter);
  if (query) parts.push(query);
  const restful = paramsTableMd('Path 参数', req.restful?.parameter);
  if (restful) parts.push(restful);
  return parts.join('\n');
}

/** Body 一段：按模式给出可读文本 */
function bodyMd(data) {
  const body = data?.request?.body;
  if (!body) return '';
  const mode = String(body.mode || 'none');
  if (mode === 'none') return '';

  const lines = [`**Body（${mode}）**`, ''];

  if (mode === 'raw' || mode === 'json' || mode === 'xml' || mode === 'html' || mode === 'javascript' || mode === 'plain') {
    const raw = String(body.raw || '');
    if (!raw.trim()) return '';
    const lang = mode === 'json' ? 'json' : mode === 'xml' ? 'xml' : mode === 'html' ? 'html' : 'js';
    lines.push('```' + lang);
    lines.push(raw);
    lines.push('```');
    lines.push('');
    return lines.join('\n');
  }

  const table = paramsTableMd('form 参数', body.parameter, { withDescription: false });
  if (table) {
    lines.push(table);
    return lines.join('\n');
  }
  return '';
}

/** 判断响应体是否为空壳（默认模板是 `{\n\t\n}`，导出时不该占版面） */
function isBlankBody(raw) {
  const text = String(raw || '').trim();
  if (!text) return true;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed).length === 0;
    }
    if (Array.isArray(parsed)) return parsed.length === 0;
  } catch {
    // 不是 JSON 就按文本判断
  }
  return false;
}

/** 响应示例一段 */
function responseMd(data) {
  const examples = Array.isArray(data?.response?.example) ? data.response.example : [];
  if (examples.length === 0) return '';

  const lines = [];
  for (const ex of examples) {
    const code = String(ex?.expect?.code || 200);
    const name = String(ex?.expect?.name || '');
    const raw = String(ex?.raw || '');

    // 空壳示例只保留标题行，不塞一个假的 {} 代码块
    if (isBlankBody(raw)) continue;

    lines.push(`**${code} ${name}**`.trim());
    lines.push('');
    const ct = String(ex?.expect?.content_type || 'json');
    const lang = ct === 'json' ? 'json' : ct === 'xml' ? 'xml' : ct === 'html' ? 'html' : 'text';
    lines.push('```' + lang);
    lines.push(raw);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 项目 -> Markdown 文档。
 * 结构与控制台里的展示顺序一致：目录分组，每个接口给方法、URL、说明、参数、Body、响应。
 */
export function projectToMarkdown(target, { projectId, projectName } = {}) {
  const meta = readProjectMeta(target.dataRoot, projectId) || {};
  const name = projectName || meta.name || 'API 文档';
  const items = listApiItems(target);
  const apis = collectHttpApis(target);
  const base = projectBaseUrl(target);

  const lines = [];
  lines.push(`# ${name}`);
  lines.push('');
  if (meta.description) {
    lines.push(String(meta.description));
    lines.push('');
  }
  if (base) {
    lines.push(`> 默认服务地址：\`${base}\``);
    lines.push('');
  }
  lines.push(`> 共 ${apis.length} 个接口，导出于 ${new Date().toLocaleString('zh-CN')}`);
  lines.push('');

  if (apis.length === 0) {
    lines.push('_该项目下还没有 HTTP 接口。_');
    lines.push('');
    return { name, content: lines.join('\n') };
  }

  // 目录分组：folderPath 完全相同的归到一起
  let lastPath = null;
  for (const { index, data, folderPath } of apis) {
    const pathKey = folderPath.join('/');
    if (pathKey !== lastPath) {
      lastPath = pathKey;
      const title = folderPath.length === 0 ? '根目录' : folderPath.join(' / ');
      lines.push(`## ${title}`);
      lines.push('');
    }

    const method = String(index.method || 'GET').toUpperCase();
    const url = String(index.url || '');
    const apiName = String(index.name || url || '未命名接口');

    lines.push(`### ${apiName}`);
    lines.push('');
    lines.push(`\`${method}\` \`${url || '-'}\``);
    lines.push('');

    const markMap = new Map((target.readJson('project/settings/marks.json', null) || []).map((m) => [String(m.mark_id), m]));
    const mark = markMap.get(String(index.mark_id || ''));
    if (mark?.name) {
      lines.push(`- 状态：${mark.name}`);
    }
    if (Array.isArray(index.tags) && index.tags.length > 0) {
      lines.push(`- 标签：${index.tags.join('、')}`);
    }
    if (mark?.name || (index.tags || []).length > 0) lines.push('');

    const desc = String(data?.description || '').trim();
    if (desc) {
      lines.push(desc);
      lines.push('');
    }

    const reqParts = requestSectionsMd(data);
    if (reqParts) {
      lines.push('#### 请求参数');
      lines.push('');
      lines.push(reqParts);
      lines.push('');
    }

    const body = bodyMd(data);
    if (body) {
      lines.push('#### 请求体');
      lines.push('');
      lines.push(body);
      lines.push('');
    }

    const resp = responseMd(data);
    if (resp) {
      lines.push('#### 响应示例');
      lines.push('');
      lines.push(resp);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return { name, content: collapseBlankLines(lines.join('\n')) };
}

/** Markdown -> 极简 HTML（只处理文档导出用到的语法） */
function markdownToHtml(markdown) {
  const src = String(markdown || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const inline = (text) =>
    htmlEscape(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<pre class="code"><code>${htmlEscape(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 标题
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*---+\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${buf.map(inline).join('<br />')}</blockquote>`);
      continue;
    }

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const parseRow = (row) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());

      const head = parseRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        body.push(parseRow(lines[i]));
        i += 1;
      }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      );
      continue;
    }

    // 列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${buf.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 段落
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|\||[-*+]\s|>|---)/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    if (buf.length > 0) out.push(`<p>${buf.map(inline).join('<br />')}</p>`);
  }

  return out.join('\n');
}

/** 文档页通用 CSS：自包含，离线可开，打印友好 */
const DOC_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 36px 24px 80px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.75;
    color: #333;
    background: #fff;
  }
  .doc { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 8px; padding-bottom: 10px; border-bottom: 2px solid #8a6b3b; }
  h2 { font-size: 20px; margin: 34px 0 12px; padding-left: 10px; border-left: 4px solid #8a6b3b; }
  h3 { font-size: 16px; margin: 24px 0 8px; }
  h4 { font-size: 14px; margin: 16px 0 6px; color: #555; }
  p { margin: 8px 0; }
  a { color: #8a6b3b; }
  code {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 12.5px;
    background: #f6f1e5;
    padding: 1px 5px;
    border-radius: 3px;
  }
  pre.code {
    background: #f6f1e5;
    padding: 12px 14px;
    border-radius: 6px;
    overflow: auto;
    font-size: 12.5px;
    line-height: 1.6;
  }
  pre.code code { background: none; padding: 0; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #f3ead8; font-weight: 600; }
  blockquote {
    margin: 12px 0;
    padding: 8px 14px;
    background: #faf5ea;
    border-left: 3px solid #dccba8;
    color: #6b5d48;
  }
  hr { border: 0; border-top: 1px solid #e5e5e5; margin: 28px 0; }
  ul { padding-left: 22px; }
  @media print {
    body { padding: 0; }
    h2 { page-break-after: avoid; }
    table, pre.code { page-break-inside: avoid; }
  }
`;

/** 项目 -> 自包含 HTML 文档（可离线打开，也可直接打印为 PDF） */
export function projectToHtml(target, { projectId, projectName } = {}) {
  const { name, content } = projectToMarkdown(target, { projectId, projectName });
  const body = markdownToHtml(content);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${htmlEscape(name)} - API 文档</title>
<style>${DOC_STYLE}</style>
</head>
<body>
<div class="doc">
${body}
</div>
</body>
</html>
`;
  return { name, content: html };
}

/**
 * 项目 -> Word 文档（.doc，HTML 包装）。
 *
 * 选择 .doc 而非 .docx：真正的 docx 需要手写 OOXML 再打 zip，
 * 零依赖实现成本高且难以在本机验证渲染效果；.doc 在 Word / WPS
 * 都能直接打开，排版保真足够满足"发给非开发同学看"的场景。
 */
export function projectToWord(target, { projectId, projectName } = {}) {
  const { name, content } = projectToMarkdown(target, { projectId, projectName });
  const body = markdownToHtml(content);
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${htmlEscape(name)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page { size: A4; margin: 2cm; }
body { font-family: "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.7; color: #333; }
h1 { font-size: 20pt; border-bottom: 2pt solid #8a6b3b; padding-bottom: 6pt; }
h2 { font-size: 15pt; margin-top: 20pt; }
h3 { font-size: 12pt; margin-top: 14pt; }
h4 { font-size: 11pt; color: #555; }
code { font-family: Consolas, monospace; font-size: 9.5pt; background: #f6f1e5; }
pre.code { background: #f6f1e5; padding: 8pt; border: 1pt solid #e5e5e5; font-size: 9.5pt; }
table { border-collapse: collapse; width: 100%; font-size: 10pt; }
th, td { border: 1pt solid #ccc; padding: 5pt 7pt; text-align: left; }
th { background: #f3ead8; }
blockquote { margin: 8pt 0; padding: 6pt 10pt; background: #faf5ea; border-left: 3pt solid #dccba8; }
hr { border: 0; border-top: 1pt solid #ddd; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
  return { name, content: html };
}
