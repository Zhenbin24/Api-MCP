/** 轻量 JSON Schema 校验 + 断言收集（用于 response.example[].expect.schema 与脚本断言） */

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected, actual) {
  const e = String(expected || '').toLowerCase();
  if (!e) return true;
  if (e === 'integer') return actual === 'integer' || actual === 'number';
  if (e === 'number') return actual === 'number' || actual === 'integer';
  if (e === 'array') return actual === 'array';
  if (e === 'object') return actual === 'object';
  if (e === 'any') return true;
  return e === actual;
}

/**
 * 校验结构（官方 schema 形如 { type, properties, required, APIPOST_ORDERS, items }）
 * @returns {Array<{path,message}>} 错误列表，空数组表示通过
 */
export function validateSchema(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  const declared = schema.type;
  const actual = typeOf(value);

  if (declared && !typeMatches(declared, actual)) {
    errors.push({ path, message: `期望 ${declared}，实际 ${actual}` });
    return errors;
  }

  if (declared === 'object' || schema.properties) {
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in (value || {}))) errors.push({ path: `${path}.${key}`, message: '缺失必填字段' });
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value && typeof value === 'object' && key in value) {
        validateSchema(sub, value[key], `${path}.${key}`, errors);
      }
    }
  }

  if (declared === 'array' && schema.items) {
    if (Array.isArray(value)) {
      value.forEach((item, i) => validateSchema(schema.items, item, `${path}[${i}]`, errors));
    }
  }

  return errors;
}

export function parseJsonSafe(text) {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 把 schema 转成示例值（OpenAPI 转换时用） */
export function schemaToSample(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const t = String(schema.type || 'object');
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length) return schema.enum[0];
  if (t === 'object' || schema.properties) {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties || {})) out[k] = schemaToSample(v);
    return out;
  }
  if (t === 'array') return [schemaToSample(schema.items || { type: 'string' })];
  if (t === 'integer') return 0;
  if (t === 'number') return 0;
  if (t === 'boolean') return false;
  if (t === 'null') return null;
  return '';
}
