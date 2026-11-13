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
export const EXPORT_FORMATS = ['openapi', 'openapi_yaml', 'postman'];

export const EXPORT_LABEL = {
  openapi: 'OpenAPI 3.0 (JSON)',
  openapi_yaml: 'OpenAPI 3.0 (YAML)',
  postman: 'Postman Collection v2.1'
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
