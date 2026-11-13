/**
 * 导入统一入口：识别格式 -> 解析成扁平接口列表 -> 落库。
 *
 * 支持格式：openapi（3.x）/ swagger（2.0）/ postman（Collection v2.1）/ har / curl
 */

import { parseOpenApi } from '../openapi/convert.js';
import { parseJsonOrYaml } from '../util/yaml.js';
import { applyImportItems, countFolders, normalizeCoverMode, assertFolderId } from './apply.js';
import { swagger2ToOpenApi } from './swagger2.js';
import { parsePostmanCollection } from './postman.js';
import { parseHar } from './har.js';
import { curlToItems } from './curl.js';

/** 导入格式标识 */
export const IMPORT_FORMATS = ['auto', 'openapi', 'swagger', 'postman', 'har', 'curl'];

const FORMAT_LABEL = {
  openapi: 'OpenAPI 3.x',
  swagger: 'Swagger 2.0',
  postman: 'Postman Collection',
  har: 'HAR',
  curl: 'cURL'
};

/**
 * 判断文本/对象属于哪种格式。
 * @param {string|object} payload
 * @returns {string} openapi|swagger|postman|har|curl
 */
export function detectFormat(payload) {
  if (payload && typeof payload === 'object') {
    if (payload.swagger && String(payload.swagger).startsWith('2')) return 'swagger';
    if (payload.openapi) return 'openapi';
    if (payload.info?.schema && /collection/i.test(String(payload.info.schema))) return 'postman';
    if (payload.log && Array.isArray(payload.log.entries)) return 'har';
    if (payload.item && payload.info) return 'postman';
    throw new Error('无法识别的数据结构：既不是 OpenAPI/Swagger，也不是 Postman Collection 或 HAR');
  }

  const text = String(payload ?? '').trim();
  if (text === '') throw new Error('内容为空');

  // cURL：以 curl 开头
  if (/^(?:\s*#.*\n)*\s*curl(\.exe)?\b/i.test(text)) return 'curl';

  const data = parseJsonOrYaml(text);

  if (data && typeof data === 'object') {
    if (data.swagger && String(data.swagger).startsWith('2')) return 'swagger';
    if (data.openapi) return 'openapi';
    if (data.log && Array.isArray(data.log.entries)) return 'har';
    if (data.info?.schema && /collection/i.test(String(data.info.schema))) return 'postman';
    if (Array.isArray(data.item)) return 'postman';
  }

  throw new Error('无法识别的格式。支持 OpenAPI 3.x / Swagger 2.0 / Postman Collection v2.1 / HAR / cURL');
}

/**
 * 解析成统一结构
 * @param {object} options
 * @param {string} [options.format='auto']
 * @param {string|object} options.payload
 * @param {boolean} [options.basePath=false]
 * @returns {{ format: string, items: Array, warnings: string[], models: string[], title: string }}
 */
export function parseImportPayload({ format = 'auto', payload, basePath = false } = {}) {
  const warnings = [];

  const resolved = !format || format === 'auto' ? detectFormat(payload) : format;
  if (!FORMAT_LABEL[resolved]) {
    throw new Error(`不支持的导入格式：${resolved}，可选 ${IMPORT_FORMATS.join('/')}`);
  }

  if (resolved === 'curl') {
    const { items, warnings: w } = curlToItems(typeof payload === 'string' ? payload : String(payload ?? ''));
    return { format: resolved, items, warnings: [...warnings, ...w], models: [], title: 'cURL 导入' };
  }

  // 其余格式都先拿到 JS 对象
  const data = typeof payload === 'string' ? parseJsonOrYaml(payload) : payload;
  if (!data || typeof data !== 'object') throw new Error('内容不是合法的 JSON / YAML 对象');

  if (resolved === 'postman') {
    const { items, collectionName, variables } = parsePostmanCollection(data);
    const varCount = Object.keys(variables || {}).length;
    if (varCount > 0) {
      warnings.push(`集合内有 ${varCount} 个变量（${Object.keys(variables).join(', ')}），导入后按原样保留 {{变量名}}，需在「环境与变量」里补上定义`);
    }
    return { format: resolved, items, warnings, models: [], title: collectionName };
  }

  if (resolved === 'har') {
    const { items, collectionName, warnings: w } = parseHar(data);
    return { format: resolved, items, warnings: [...warnings, ...w], models: [], title: collectionName };
  }

  if (resolved === 'swagger') {
    const openapi = swagger2ToOpenApi(data);
    const parsed = parseOpenApi(openapi, { basePath });
    return {
      format: resolved,
      items: parsed.items,
      warnings,
      models: Object.keys(parsed.schemas || {}),
      title: String(openapi.info?.title || 'Swagger 导入')
    };
  }

  // openapi
  const parsed = parseOpenApi(data, { basePath });
  return {
    format: resolved,
    items: parsed.items,
    warnings,
    models: Object.keys(parsed.schemas || {}),
    title: String(data.info?.title || 'OpenAPI 导入')
  };
}

/**
 * 预览：只解析不落库
 * @param {object} options
 * @returns {object}
 */
export function previewImport({ format = 'auto', payload, basePath = false, sampleLimit = 50 } = {}) {
  const parsed = parseImportPayload({ format, payload, basePath });
  const items = parsed.items || [];

  if (items.length === 0) throw new Error('没有解析出任何可导入的接口');

  return {
    format: parsed.format,
    format_label: FORMAT_LABEL[parsed.format] || parsed.format,
    title: parsed.title,
    api_count: items.length,
    folder_count: countFolders(items),
    models: parsed.models,
    warnings: parsed.warnings,
    sample: items.slice(0, sampleLimit).map((item) => ({
      method: item.method,
      url: item.url,
      name: item.name,
      folder: (item.folderPath || []).join('/')
    })),
    truncated: items.length > sampleLimit
  };
}

/**
 * 导入：解析 + 落库
 * @param {object} target ProjectTarget
 * @param {object} options
 * @returns {object}
 */
export function importIntoProject(target, { projectId, format = 'auto', payload, folderId = '0', coverMode = 'url_and_folder', basePath = false } = {}) {
  const mode = normalizeCoverMode(coverMode);
  const rootFolderId = assertFolderId(target, folderId);

  const parsed = parseImportPayload({ format, payload, basePath });
  if (parsed.items.length === 0) throw new Error('没有解析出任何可导入的接口');

  const results = applyImportItems(target, {
    projectId,
    items: parsed.items,
    folderId: rootFolderId,
    coverMode: mode
  });

  return {
    project_id: projectId,
    format: parsed.format,
    cover_mode: mode,
    folder_id: rootFolderId,
    summary: {
      created: results.created.length,
      updated: results.updated.length,
      skipped: results.skipped.length,
      deleted: results.deleted.length
    },
    created: results.created,
    updated: results.updated,
    skipped: results.skipped,
    warnings: parsed.warnings,
    models: parsed.models
  };
}

export { FORMAT_LABEL };
