/**
 * OpenAPI 3.0 / 3.1 -> Apipost 接口文档结构
 */
import { schemaToSample } from '../exec/assert.js';

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];

/** schema -> Apipost raw_schema（{type,properties,required,APIPOST_ORDERS,APIPOST_REFS}） */
export function toApipostSchema(schema, { resolveRef, depth = 0 } = {}) {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  if (depth > 20) return { type: 'object' };

  let node = schema;
  if (node.$ref && resolveRef) {
    const resolved = resolveRef(node.$ref);
    if (resolved) node = resolved;
  }

  if (node.allOf && Array.isArray(node.allOf)) {
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of node.allOf) {
      const sub = toApipostSchema(part, { resolveRef, depth: depth + 1 });
      Object.assign(merged.properties, sub.properties || {});
      merged.required.push(...(sub.required || []));
    }
    if (node.description) merged.description = node.description;
    return merged;
  }

  if (node.oneOf || node.anyOf) {
    const list = node.oneOf || node.anyOf;
    const first = toApipostSchema(list[0], { resolveRef, depth: depth + 1 });
    return first;
  }

  const type = normalizeType(node);
  const out = { type };

  if (node.description) out.description = node.description;
  if (node.example !== undefined) out.example = node.example;
  if (node.default !== undefined) out.default = node.default;
  if (node.enum) out.enum = node.enum;
  if (node.format) out.format = node.format;
  if (node.nullable) out.nullable = true;

  if (type === 'object') {
    const props = node.properties || {};
    const keys = Object.keys(props);
    out.properties = {};
    for (const key of keys) {
      out.properties[key] = toApipostSchema(props[key], { resolveRef, depth: depth + 1 });
    }
    out.required = Array.isArray(node.required) ? [...node.required] : [];
    out.APIPOST_ORDERS = keys;
    out.APIPOST_REFS = {};
  } else if (type === 'array') {
    out.items = toApipostSchema(node.items || { type: 'string' }, { resolveRef, depth: depth + 1 });
  }

  return out;
}

function normalizeType(node) {
  if (Array.isArray(node.type)) {
    const first = node.type.find((t) => t !== 'null') || node.type[0];
    return String(first || 'string');
  }
  if (node.type) {
    const t = String(node.type);
    if (t === 'file') return 'string';
    return t;
  }
  if (node.properties) return 'object';
  if (node.items) return 'array';
  return 'string';
}

function refResolver(openapi) {
  const components = openapi?.components || {};
  const resolveRef = (ref) => {
    if (!String(ref).startsWith('#/')) return null;
    const parts = String(ref).slice(2).split('/');
    let node = openapi;
    for (const part of parts) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (node == null) return null;
      node = node[key];
    }
    return node || null;
  };
  return { resolveRef, components };
}

function schemaNameFromRef(ref) {
  return String(ref || '').split('/').pop();
}

/** 把 schema 展成 raw_parameter 扁平列表（官方用于表格展示） */
function flattenSchemaToParams(schema, prefix = '') {
  const out = [];
  const props = schema?.properties || {};
  const orders = Array.isArray(schema?.APIPOST_ORDERS) ? schema.APIPOST_ORDERS : Object.keys(props);
  for (const key of orders) {
    const sub = props[key];
    if (!sub) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    out.push({
      description: sub.description || '',
      field_type: capitalizeType(sub.type),
      is_checked: 1,
      key: fullKey,
      not_null: (schema.required || []).includes(key) ? 1 : -1,
      param_id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
      value: ''
    });
    if (sub.type === 'object' && sub.properties) {
      out.push(...flattenSchemaToParams(sub, fullKey));
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
    null: 'Null',
    any: 'String'
  };
  return map[String(type || 'string')] || 'String';
}

function paramsFromParameters(parameters, { resolveRef }) {
  const out = { query: [], header: [], path: [], cookie: [] };
  for (const raw of parameters || []) {
    let param = raw;
    if (param.$ref) {
      param = resolveRef(param.$ref);
      if (!param) continue;
    }
    const where =
      param.in === 'query'
        ? 'query'
        : param.in === 'header'
          ? 'header'
          : param.in === 'path'
            ? 'path'
            : param.in === 'cookie'
              ? 'cookie'
              : null;
    if (!where) continue;
    const schema = param.schema ? toApipostSchema(param.schema, { resolveRef }) : { type: 'string' };
    out[where].push({
      description: param.description || '',
      field_type: capitalizeType(schema.type),
      is_checked: param.required ? 1 : 1,
      key: param.name,
      not_null: param.required ? 1 : -1,
      param_id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
      value: param.example !== undefined ? String(param.example) : schemaToSample(schema) !== null ? String(schemaToSample(schema)) : ''
    });
  }
  return out;
}

function bodyFromOperation(operation, { resolveRef }) {
  const rb = operation.requestBody;
  if (!rb) return null;
  let body = rb;
  if (body.$ref) {
    body = resolveRef(body.$ref);
    if (!body) return null;
  }
  const content = body.content || {};
  const types = Object.keys(content);

  const pick = (t) => content[t];

  const jsonType = types.find((t) => t.includes('json'));
  if (jsonType) {
    const media = pick(jsonType);
    const schema = toApipostSchema(media.schema || { type: 'object' }, { resolveRef });
    const sample = media.example !== undefined ? media.example : schemaToSample(schema);
    return {
      binary: null,
      mode: 'json',
      parameter: [],
      raw: JSON.stringify(sample, null, 2),
      raw_parameter: flattenSchemaToParams(schema),
      raw_schema: schema
    };
  }

  if (types.includes('application/x-www-form-urlencoded')) {
    const media = pick('application/x-www-form-urlencoded');
    const schema = toApipostSchema(media.schema || { type: 'object' }, { resolveRef });
    return {
      binary: null,
      mode: 'urlencoded',
      parameter: flattenSchemaToParams(schema).map((p) => ({ ...p, field_type: p.field_type })),
      raw: '',
      raw_parameter: [],
      raw_schema: schema
    };
  }

  if (types.includes('multipart/form-data')) {
    const media = pick('multipart/form-data');
    const schema = toApipostSchema(media.schema || { type: 'object' }, { resolveRef });
    return {
      binary: null,
      mode: 'form-data',
      parameter: flattenSchemaToParams(schema),
      raw: '',
      raw_parameter: [],
      raw_schema: schema
    };
  }

  if (types.includes('application/octet-stream')) {
    return {
      binary: null,
      mode: 'binary',
      parameter: [],
      raw: '',
      raw_parameter: [],
      raw_schema: { type: 'string' }
    };
  }

  const textType = types.find((t) => t.startsWith('text/') || t.includes('xml') || t.includes('html'));
  if (textType) {
    const media = pick(textType);
    const mode = textType.includes('xml')
      ? 'xml'
      : textType.includes('html')
        ? 'html'
        : 'plain';
    const schema = media.schema ? toApipostSchema(media.schema, { resolveRef }) : { type: 'string' };
    return {
      binary: null,
      mode,
      parameter: [],
      raw: media.example !== undefined ? String(media.example) : String(schemaToSample(schema) ?? ''),
      raw_parameter: [],
      raw_schema: schema
    };
  }

  return null;
}

function responseFromOperation(operation, { resolveRef }) {
  const responses = operation.responses || {};
  const codes = Object.keys(responses);
  const firstCode = codes.find((c) => String(c).startsWith('2')) || codes[0] || '200';

  const examples = [];
  for (const code of codes) {
    let res = responses[code];
    if (res?.$ref) res = resolveRef(res.$ref) || res;
    const content = res?.content || {};
    const jsonType = Object.keys(content).find((t) => t.includes('json'));

    if (jsonType) {
      const media = content[jsonType];
      const schema = toApipostSchema(media.schema || { type: 'object' }, { resolveRef });
      const sample = media.example !== undefined ? media.example : schemaToSample(schema);
      examples.push({
        example_id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
        expect: {
          code: String(code),
          content_type: 'json',
          is_default: code === firstCode ? 1 : -1,
          mock: '',
          name: res.description || `响应 ${code}`,
          schema,
          verify_type: 'schema'
        },
        raw: JSON.stringify(sample, null, 2),
        raw_parameter: flattenSchemaToParams(schema)
      });
    } else {
      examples.push({
        example_id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
        expect: {
          code: String(code),
          content_type: 'text',
          is_default: code === firstCode ? 1 : -1,
          mock: '',
          name: res?.description || `响应 ${code}`,
          schema: { type: 'string' },
          verify_type: 'schema'
        },
        raw: '',
        raw_parameter: []
      });
    }
  }

  if (examples.length === 0) {
    examples.push({
      example_id: '1',
      expect: {
        code: '200',
        content_type: 'json',
        is_default: 1,
        mock: '',
        name: '成功',
        schema: { properties: {}, type: 'object' },
        verify_type: 'schema'
      },
      raw: '{\n\t\n}',
      raw_parameter: []
    });
  }

  return { example: examples, is_check_result: 1 };
}

/**
 * 解析 OpenAPI，产出扁平接口列表：
 * [{ name, method, url, folderPath: [names], summary, description, request, response, tags }]
 */
export function parseOpenApi(input, { basePath = false, hostPath = false } = {}) {
  const openapi = typeof input === 'string' ? JSON.parse(input) : input;
  if (!openapi || typeof openapi !== 'object') throw new Error('OpenAPI 数据无效');
  const version = String(openapi.openapi || '');
  if (!version.startsWith('3.')) throw new Error(`仅支持 OpenAPI 3.0 或 3.1 数据，当前为 ${version || '未知'}`);

  const { resolveRef } = refResolver(openapi);
  const servers = Array.isArray(openapi.servers) ? openapi.servers : [];
  const serverUrl = servers[0]?.url || '';
  const apiBasePath = basePath ? serverUrl : '';

  const paths = openapi.paths || {};
  const items = [];

  for (const [rawPath, pathItemRaw] of Object.entries(paths)) {
    let pathItem = pathItemRaw;
    if (pathItem?.$ref) pathItem = resolveRef(pathItem.$ref) || pathItem;
    if (!pathItem) continue;

    const sharedParams = pathItem.parameters || [];

    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      let url = rawPath;
      if (hostPath && serverUrl) url = `${serverUrl.replace(/\/+$/, '')}/${rawPath.replace(/^\/+/, '')}`;
      else if (apiBasePath) url = `${apiBasePath.replace(/\/+$/, '')}/${rawPath.replace(/^\/+/, '')}`;

      const allParams = [...sharedParams, ...(operation.parameters || [])];
      const grouped = paramsFromParameters(allParams, { resolveRef });
      const body = bodyFromOperation(operation, { resolveRef });
      const response = responseFromOperation(operation, { resolveRef });

      const tags = Array.isArray(operation.tags) ? operation.tags : [];
      const folderPath = tags.length > 0 ? [tags[0]] : [];

      items.push({
        name: operation.summary || operation.operationId || rawPath,
        method: method.toUpperCase(),
        url,
        summary: operation.summary || '',
        description: operation.description || '',
        folderPath,
        tags,
        request: {
          auth: undefined,
          query: { parameter: grouped.query, query_add_equal: 1 },
          header: { parameter: grouped.header },
          cookie: { parameter: grouped.cookie },
          restful: { parameter: grouped.path },
          body: body || { binary: null, mode: 'none', parameter: [], raw: '', raw_parameter: [], raw_schema: { type: 'object' } },
          pre_tasks: [],
          post_tasks: []
        },
        response
      });
    }
  }

  const schemas = {};
  for (const [name, schema] of Object.entries(openapi.components?.schemas || {})) {
    schemas[name] = toApipostSchema(schema, { resolveRef });
  }

  return { items, schemas, info: openapi.info || {}, serverUrl };
}
