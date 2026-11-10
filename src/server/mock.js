/**
 * 本地 Mock 服务：独立端口（默认 39101），按接口配置的数据结构生成响应。
 * Mock 配置存在接口文件的 data.mock 里：{ enabled, status, delay_ms, schema, priority }
 */
import http from 'node:http';
import { openShadow } from '../store/shadow.js';
import { readApiIndex, readApiFile, findApiItem } from '../store/apis.js';
import { listProjects } from '../store/projects.js';

const DEFAULT_PORT = 39101;

/* ---------------- 按 schema 生成样例数据 ---------------- */

/** 从 Apipost schema 生成一份示例值 */
export function generateFromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return null;

  const type = String(schema.type || 'object');

  if (schema.example !== undefined) return schema.example;
  if (schema.mock !== undefined && schema.mock !== '') return schema.mock;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  if (type === 'object' || schema.properties) {
    const out = {};
    const props = schema.properties || {};
    const orders = Array.isArray(schema.APIPOST_ORDERS) ? schema.APIPOST_ORDERS : Object.keys(props);
    for (const key of orders) {
      const sub = props[key];
      if (!sub) continue;
      const value = generateFromSchema(sub, depth + 1);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  if (type === 'array') {
    return [generateFromSchema(schema.items || { type: 'string' }, depth + 1)];
  }
  if (type === 'integer') return Math.floor(Math.random() * 1000);
  if (type === 'number') return Number((Math.random() * 1000).toFixed(2));
  if (type === 'boolean') return Math.random() > 0.5;
  if (type === 'null') return null;

  // string：按字段名猜一个像样的值
  const name = String(schema.description || '').toLowerCase();
  if (/mail/.test(name)) return 'mock@example.com';
  if (/name/.test(name)) return 'mock_name';
  if (/phone|tel|mobile/.test(name)) return '13800138000';
  if (/url|link/.test(name)) return 'https://example.com';
  if (/date|time/.test(name)) return new Date().toISOString();
  return 'mock_string';
}

/* ---------------- Mock 路由匹配 ---------------- */

function stripQuery(url) {
  const idx = url.indexOf('?');
  return idx < 0 ? url : url.slice(0, idx);
}

/** 把接口 URL 转成路径部分（保留 {param} / :param 占位符，不做 URL 编码） */
function urlToPathOnly(rawUrl) {
  const text = stripQuery(String(rawUrl || '').trim());
  if (!text) return '/';
  if (/^https?:\/\//i.test(text)) {
    // 只取 path，手工切分避免 new URL() 把 {id} 编码成 %7Bid%7D
    const afterScheme = text.replace(/^https?:\/\//i, '');
    const slash = afterScheme.indexOf('/');
    return slash < 0 ? '/' : afterScheme.slice(slash);
  }
  return text.startsWith('/') ? text : `/${text}`;
}

/** 把接口 URL 里的 {param} 或 :param 变成可匹配的正则 */
function urlToPattern(rawUrl) {
  const path = urlToPathOnly(rawUrl);
  const escaped = path
    // 先保护占位符，避免被转义规则处理
    .replace(/\{[^}]+\}/g, '\u0000P\u0000')
    .replace(/:[A-Za-z_][\w]*/g, '\u0000P\u0000')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\u0000P\u0000/g, '[^/]+');
  return new RegExp(`^${escaped}/?$`);
}

/** 找到匹配请求的 mock 接口 */
function matchMock(ctx, method, pathname) {
  for (const project of ctx.projects()) {
    const target = openShadow({ shadowRoot: ctx.shadowRoot, projectId: project.project_id });
    let index;
    try {
      index = readApiIndex(target);
    } catch {
      continue;
    }
    for (const item of index.items || []) {
      if (item.target_type !== 'api') continue;
      if (String(item.method || '').toUpperCase() !== method) continue;
      const pattern = urlToPattern(item.url);
      if (!pattern.test(pathname)) continue;
      const file = readApiFile(target, item.target_id);
      const mock = file?.data?.mock;
      if (!mock || Number(mock.enabled) !== 1) continue;
      return { project, target, item, mock, data: file.data };
    }
  }
  return null;
}

/** 列出所有已启用 Mock 的接口 */
export function listMocks(ctx) {
  const out = [];
  for (const project of ctx.projects()) {
    const target = openShadow({ shadowRoot: ctx.shadowRoot, projectId: project.project_id });
    let index;
    try {
      index = readApiIndex(target);
    } catch {
      continue;
    }
    for (const item of index.items || []) {
      if (item.target_type !== 'api') continue;
      const file = readApiFile(target, item.target_id);
      const mock = file?.data?.mock;
      if (!mock) continue;
      out.push({
        project_id: project.project_id,
        project_name: project.name,
        target_id: item.target_id,
        name: item.name || '',
        method: String(item.method || '').toUpperCase(),
        url: item.url || '',
        mock_path: urlToPattern(item.url) ? mockPathOf(item.url) : '',
        enabled: Number(mock.enabled) === 1,
        status: mock.status || '200',
        delay_ms: mock.delay_ms || 0,
        schema: mock.schema || null
      });
    }
  }
  return out;
}

function mockPathOf(rawUrl) {
  return urlToPathOnly(rawUrl);
}

/* ---------------- 服务 ---------------- */

export function createMockServer({ shadowRoot, officialRoot, config, log = () => {} }) {
  const ctx = {
    shadowRoot,
    officialRoot,
    projects: () => listProjects(officialRoot)
  };

  const startedAt = Date.now();
  let hits = 0;

  const server = http.createServer(async (req, res) => {
    hits += 1;
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);

    // 管理端点：列出所有 mock
    if (pathname === '/__mocks') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ mocks: listMocks(ctx), hits, uptime_ms: Date.now() - startedAt }, null, 2));
      return;
    }

    const method = String(req.method || 'GET').toUpperCase();

    // CORS 放行，方便前端直接调用
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let matched;
    try {
      matched = matchMock(ctx, method, pathname);
    } catch (err) {
      log(`[mock] 匹配失败：${err.message}`);
      matched = null;
    }

    if (!matched) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          {
            error: '没有匹配的 Mock 接口',
            method,
            path: pathname,
            hint: '请在接口的 Mock 页签中启用 Mock，并确保方法、路径匹配'
          },
          null,
          2
        )
      );
      return;
    }

    const { mock, item } = matched;
    const delay = Math.max(0, Math.min(60000, Number(mock.delay_ms) || 0));
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    // 优先用 schema 生成，其次用 mock.body 原文
    let bodyText = '';
    let contentType = 'application/json; charset=utf-8';
    if (mock.schema && Object.keys(mock.schema).length > 0) {
      try {
        bodyText = JSON.stringify(generateFromSchema(mock.schema), null, 2);
      } catch {
        bodyText = '{}';
      }
    } else if (typeof mock.body === 'string' && mock.body.trim()) {
      bodyText = mock.body;
      const lowered = String(mock.content_type || '').toLowerCase();
      if (lowered) contentType = mock.content_type;
    } else {
      bodyText = JSON.stringify({ ok: true, mock: item.name || item.target_id }, null, 2);
    }

    const headers = {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(bodyText),
      'X-Mock-From': 'api-mcp',
      'X-Mock-Api': encodeURIComponent(item.name || item.target_id)
    };
    for (const [k, v] of Object.entries(mock.headers || {})) {
      headers[k] = String(v);
    }

    res.writeHead(Number(mock.status) || 200, headers);
    res.end(bodyText);
  });

  return {
    server,
    ctx,
    listen(port = DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
    get port() {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : null;
    },
    stats() {
      return { hits, uptime_ms: Date.now() - startedAt, mock_count: listMocks(ctx).length };
    }
  };
}

export { DEFAULT_PORT as MOCK_DEFAULT_PORT };
