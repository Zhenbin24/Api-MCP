/**
 * Swagger 2.0 -> OpenAPI 3.0 最小升级。
 *
 * 只做「够 parseOpenApi 用」的转换，不追求完整语义：
 * - host + basePath + schemes -> servers[0].url
 * - definitions -> components.schemas，并把 #/definitions/X 引用改写
 * - parameters 里 in:body -> requestBody（按 consumes 选类型）
 * - parameters 里 in:formData -> requestBody（form-data / urlencoded）
 * - responses[].schema -> responses[].content
 * - produces -> 响应 content 类型
 */

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace'];

/** 递归替换 $ref 前缀 */
function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      out[key] = value.startsWith('#/definitions/')
        ? `#/components/schemas/${value.slice('#/definitions/'.length)}`
        : value;
      continue;
    }
    out[key] = rewriteRefs(value);
  }
  return out;
}

/** swagger 2 的 schema（无 nullable / 无 oneOf 差异）基本兼容，只补 type: file -> string */
function normalizeSchema(schema) {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && value === 'file') {
      out[key] = 'string';
      out.format = 'binary';
      continue;
    }
    out[key] = normalizeSchema(value);
  }
  return out;
}

function buildServerUrl(swagger) {
  const schemes = Array.isArray(swagger.schemes) && swagger.schemes.length > 0 ? swagger.schemes : ['https'];
  const scheme = String(schemes[0] || 'https').replace(/:.*$/, '');
  const host = String(swagger.host || '').trim();
  const basePath = String(swagger.basePath || '').replace(/\/+$/, '');
  if (!host) return basePath || '';
  return `${scheme}://${host}${basePath}`;
}

/** 把一个 swagger 参数转成 OpenAPI 参数（schema 化） */
function parameterToV3(param) {
  if (!param || typeof param !== 'object') return null;
  if (param.$ref) return { $ref: param.$ref.replace('#/parameters/', '#/components/parameters/') };

  const out = { name: param.name, in: param.in };
  if (param.description) out.description = param.description;
  if (param.required !== undefined) out.required = Boolean(param.required);

  // swagger 2 把类型直接摊在参数上，OpenAPI 3 要收进 schema
  const schema = { type: param.type || 'string' };
  for (const key of ['format', 'enum', 'default', 'items', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern']) {
    if (param[key] !== undefined) schema[key] = normalizeSchema(param[key]);
  }
  out.schema = schema;
  if (param.example !== undefined) out.example = param.example;
  return out;
}

/** in:body 参数 -> requestBody */
function bodyToRequestBody(param, consumes) {
  const jsonFirst = Array.isArray(consumes) && consumes.some((c) => String(c).includes('json'));
  const type = jsonFirst || !Array.isArray(consumes) || consumes.length === 0 ? 'application/json' : String(consumes[0]);
  const schema = normalizeSchema(param.schema || { type: 'object' });
  return {
    description: param.description || '',
    required: Boolean(param.required),
    content: { [type]: { schema } }
  };
}

/** in:formData 参数集合 -> requestBody */
function formToRequestBody(params, consumes) {
  const isMultipart = (Array.isArray(consumes) ? consumes : []).some((c) => String(c).includes('multipart'));
  const hasFile = params.some((p) => p.type === 'file');
  const type = isMultipart || hasFile ? 'multipart/form-data' : 'application/x-www-form-urlencoded';

  const properties = {};
  const required = [];
  for (const p of params) {
    const schema = { type: p.type === 'file' ? 'string' : p.type || 'string' };
    if (p.type === 'file') schema.format = 'binary';
    if (p.format) schema.format = p.format;
    if (p.description) schema.description = p.description;
    if (p.enum) schema.enum = p.enum;
    if (p.default !== undefined) schema.default = p.default;
    properties[p.name] = schema;
    if (p.required) required.push(p.name);
  }

  return {
    required: required.length > 0,
    content: {
      [type]: {
        schema: { type: 'object', properties, ...(required.length ? { required } : {}) }
      }
    }
  };
}

/**
 * Swagger 2.0 -> OpenAPI 3.0
 * @param {object} swagger
 * @returns {object} OpenAPI 3.0 文档
 */
export function swagger2ToOpenApi(swagger) {
  if (!swagger || typeof swagger !== 'object') throw new Error('Swagger 数据无效');
  if (String(swagger.swagger || '') !== '2.0') {
    throw new Error(`仅支持 Swagger 2.0，当前为 ${swagger.swagger || '未知'}`);
  }

  const globalConsumes = Array.isArray(swagger.consumes) ? swagger.consumes : [];
  const globalProduces = Array.isArray(swagger.produces) ? swagger.produces : [];

  const paths = {};
  for (const [pathKey, pathItem] of Object.entries(swagger.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const next = {};

    // path 级参数先转
    if (Array.isArray(pathItem.parameters)) {
      const bodyParam = pathItem.parameters.find((p) => p && p.in === 'body');
      const formParams = pathItem.parameters.filter((p) => p && p.in === 'formData');
      const rest = pathItem.parameters.filter((p) => p && p.in !== 'body' && p.in !== 'formData');
      const converted = rest.map(parameterToV3).filter(Boolean);
      if (converted.length > 0) next.parameters = converted;

      for (const method of METHODS) {
        const operation = pathItem[method];
        if (!operation || typeof operation !== 'object') continue;
        const merged = buildOperation(operation, { bodyParam, formParams, globalConsumes, globalProduces });
        next[method] = merged;
      }
      continue;
    }

    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;
      next[method] = buildOperation(operation, { globalConsumes, globalProduces });
    }
    if (Object.keys(next).length > 0) paths[pathKey] = next;
  }

  const components = {};
  if (swagger.definitions && typeof swagger.definitions === 'object') {
    components.schemas = normalizeSchema(swagger.definitions);
  }
  if (swagger.parameters && typeof swagger.parameters === 'object') {
    const params = {};
    for (const [name, p] of Object.entries(swagger.parameters)) {
      params[name] = parameterToV3(p);
    }
    components.parameters = params;
  }
  if (swagger.responses && typeof swagger.responses === 'object') {
    components.responses = rewriteRefs(swagger.responses);
  }
  if (swagger.securityDefinitions && typeof swagger.securityDefinitions === 'object') {
    components.securitySchemes = rewriteRefs(swagger.securityDefinitions);
  }

  const serverUrl = buildServerUrl(swagger);
  const info = rewriteRefs(swagger.info || { title: 'Imported API', version: '1.0.0' });

  const openapi = {
    openapi: '3.0.3',
    info: { version: '1.0.0', ...info },
    paths: rewriteRefs(paths)
  };
  if (serverUrl) openapi.servers = [{ url: serverUrl }];
  if (Object.keys(components).length > 0) openapi.components = components;
  if (Array.isArray(swagger.tags)) openapi.tags = rewriteRefs(swagger.tags);

  return openapi;
}

/** 单个 operation 的转换 */
function buildOperation(operation, { bodyParam, formParams, globalConsumes, globalProduces }) {
  const out = {};
  for (const key of ['tags', 'summary', 'description', 'operationId', 'deprecated']) {
    if (operation[key] !== undefined) out[key] = rewriteRefs(operation[key]);
  }

  const consumes = Array.isArray(operation.consumes) ? operation.consumes : globalConsumes;
  const produces = Array.isArray(operation.produces) ? operation.produces : globalProduces;

  const rawParams = Array.isArray(operation.parameters) ? operation.parameters : [];
  const body = bodyParam || rawParams.find((p) => p && p.in === 'body');
  const forms = formParams || rawParams.filter((p) => p && p.in === 'formData');
  const rest = rawParams.filter((p) => p && p.in !== 'body' && p.in !== 'formData');

  const params = rest.map(parameterToV3).filter(Boolean);
  if (params.length > 0) out.parameters = params;

  if (body) out.requestBody = bodyToRequestBody(body, consumes);
  else if (forms.length > 0) out.requestBody = formToRequestBody(forms, consumes);

  // responses
  const responses = {};
  const rawResponses = operation.responses || {};
  for (const [code, res] of Object.entries(rawResponses)) {
    if (!res || typeof res !== 'object') continue;
    const entry = {};
    if (res.description !== undefined) entry.description = res.description;
    if (res.headers) entry.headers = rewriteRefs(res.headers);
    if (res.schema) {
      const schema = normalizeSchema(res.schema);
      const types = produces.length > 0 ? produces : ['application/json'];
      entry.content = {};
      for (const t of types) entry.content[t] = { schema };
    }
    if (res.examples) {
      const types = produces.length > 0 ? produces : ['application/json'];
      for (const t of types) {
        if (entry.content) entry.content[t].example = res.examples[t];
      }
    }
    responses[code] = entry;
  }
  if (Object.keys(responses).length === 0) responses['200'] = { description: 'OK' };
  out.responses = responses;

  return out;
}
