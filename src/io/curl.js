/**
 * cURL 导入：复用 web/curl-parse.js 的解析器（同一份代码，浏览器与 Node 共用）。
 *
 * 该模块本身是纯 ESM，只在文件末尾有 `typeof window !== 'undefined'` 的挂载，
 * 所以 Node 里可以直接 import，不需要维护第二份实现。
 */

import {
  parseAll,
  parseCurl,
  splitCurlBlocks,
  applyParsedToApiData,
  suggestName
} from '../../web/curl-parse.js';
import { buildEmptyAuth, buildBlankBody } from '../store/apis.js';

/** 给 applyParsedToApiData 准备一个最小可用的接口 data 骨架 */
function blankApiData() {
  return {
    method: 'GET',
    url: '',
    request: {
      auth: buildEmptyAuth(),
      body: buildBlankBody(),
      cookie: { parameter: [] },
      header: { parameter: [] },
      post_tasks: [],
      pre_tasks: [],
      query: { parameter: [], query_add_equal: 1 },
      restful: { parameter: [] }
    },
    response: null
  };
}

/** curl-parse 的 makeParam 产物补上 description / not_null 等字段 */
function normalizeParams(list) {
  return (list || []).map((p) => ({
    description: p.description || '',
    field_type: p.field_type || 'String',
    is_checked: p.is_checked === undefined ? 1 : p.is_checked,
    key: String(p.key ?? ''),
    not_null: p.not_null === undefined ? -1 : p.not_null,
    param_id: p.param_id,
    value: p.value === undefined || p.value === null ? '' : String(p.value)
  }));
}

/**
 * 把一条解析结果转成落库用的 item
 * @param {object} parsed parseCurl 的返回值
 * @returns {object|null}
 */
export function parsedToItem(parsed) {
  if (!parsed || !parsed.ok || !parsed.url) return null;

  const data = blankApiData();
  applyParsedToApiData(data, parsed);

  const req = data.request;
  req.header.parameter = normalizeParams(req.header.parameter);
  req.query.parameter = normalizeParams(req.query.parameter);
  req.restful.parameter = normalizeParams(req.restful.parameter);
  req.cookie.parameter = normalizeParams(req.cookie.parameter);
  if (Array.isArray(req.body?.parameter)) req.body.parameter = normalizeParams(req.body.parameter);

  return {
    name: suggestName(parsed),
    method: String(data.method || 'GET').toUpperCase(),
    url: data.url,
    summary: '',
    description: '',
    folderPath: [],
    tags: [],
    request: req,
    response: null
  };
}

/**
 * 解析一段可能包含多条 curl 的文本
 * @param {string} text
 * @returns {{ items: Array, warnings: string[] }}
 */
export function curlToItems(text) {
  const src = String(text || '');
  if (!src.trim()) throw new Error('cURL 内容为空');

  // 没有 curl 关键字时，可能是用户只粘贴了 URL
  if (!/\bcurl(\.exe)?\b/i.test(src)) {
    throw new Error('没有找到 curl 命令，请确认粘贴内容以 curl 开头');
  }

  const parsedList = parseAll(src);
  const items = [];
  const warnings = [];

  parsedList.forEach((parsed, index) => {
    const item = parsedToItem(parsed);
    if (item) {
      items.push(item);
    } else {
      warnings.push(`第 ${index + 1} 条 curl 无法解析（缺少 URL）`);
    }
    for (const w of parsed.warnings || []) warnings.push(`第 ${index + 1} 条：${w}`);
  });

  if (items.length === 0) throw new Error('没有解析出任何可导入的接口');
  return { items, warnings };
}

export { parseCurl, parseAll, splitCurlBlocks };
