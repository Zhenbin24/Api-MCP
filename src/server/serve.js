import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WEB_ASSETS } from './web-assets.generated.js';
import { ToolContext } from '../mcp/tools.js';
import { handleMessage } from '../mcp/protocol.js';
import { TOOLS } from '../mcp/schemas.js';
import { saveConfig, publicConfig, regenerateToken, DEFAULT_PORT } from './config.js';
import { buildClientConfigs } from './client-config.js';
import { listProjects } from '../store/projects.js';
import { openProject } from '../store/target.js';
import {
  buildApiTree,
  countApis,
  createApiOrFolder,
  ensureApiFile,
  readApiFile,
  writeApiFile,
  deleteApis,
  findApiItem,
  readApiIndex,
  writeApiIndex,
  updateApiIndexItem,
  TARGET_TYPE
} from '../store/apis.js';
import {
  listEnvironments,
  shapeEnv,
  createEnvironment,
  updateEnvironment,
  deleteEnvironment,
  createEnvironmentServer,
  updateEnvironmentServer,
  deleteEnvironmentServer,
  listEnvironmentServers,
  sharedServers,
  getEnvironmentVariables,
  replaceEnvVariables,
  upsertEnvVariable,
  deleteEnvVariable,
  getGlobalVariables,
  upsertGlobalVariable,
  deleteGlobalVariable,
  readCurrentEnvId,
  writeCurrentEnvId
} from '../store/envs.js';
import { readGlobalParams, writeGlobalParams } from '../store/globals.js';
import { listFlows } from '../store/flows.js';
import { listRuns, getRun } from '../store/runs.js';
import { checkExpectedHeaders } from '../exec/http.js';
import { listRecentlySaved, listRecentRuns } from '../store/recent.js';
import { detectOfficialRoot, isOfficialRoot } from '../store/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(here, '../../web');

/** 设计域之外的附属数据，保存设计时按 preserve_aux 保护 */
const AUX_KEYS = ['cases', 'mock'];

/** 打包后 web 资源以字符串内联，避免依赖外部文件 */
let INLINE_ASSETS = null;

function loadInlineAssets() {
  if (INLINE_ASSETS !== null) return INLINE_ASSETS;
  try {
    // 打包时会静态内联，开发时文件可能不存在
    INLINE_ASSETS = WEB_ASSETS || null;
  } catch {
    INLINE_ASSETS = null;
  }
  return INLINE_ASSETS;
}

function readWebAsset(name) {
  const inline = loadInlineAssets();
  if (inline && inline[name]) return inline[name];
  return fs.readFileSync(path.join(WEB_DIR, name), 'utf8');
}

/** 读二进制资源（图标）：内联时是 { base64 }，否则读 web/ 目录 */
function readWebBinary(name) {
  const inline = loadInlineAssets();
  const entry = inline && inline[name];
  if (entry && typeof entry === 'object' && entry.base64) return Buffer.from(entry.base64, 'base64');
  if (typeof entry === 'string') return Buffer.from(entry, 'base64');
  return fs.readFileSync(path.join(WEB_DIR, name));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readBody(req, limit = 40 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function tokenFrom(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-mcp-token'] || req.headers['x-api-token'] || '');
}

function uiTokenFrom(req) {
  return String(req.headers['x-ui-token'] || req.headers['x-api-token'] || '');
}

/**
 * 启动本地 HTTP 服务。
 * @param {object} opts
 * @param {object} opts.config  已加载配置（可变，保存时写盘）
 * @param {string} opts.officialRoot
 */
export function createServer({ config, officialRoot, log = () => {} }) {
  const ctx = new ToolContext({ officialRoot, config });
  const startedAt = Date.now();
  let requestCount = 0;
  let lastMcpCallAt = '';
  let mockService = null;

  const requireUi = (req, res) => {
    const token = uiTokenFrom(req);
    const url = new URL(req.url, 'http://127.0.0.1');
    const queryToken = url.searchParams.get('ui');
    if (token === config.ui_token || queryToken === config.ui_token) return true;
    sendJson(res, 401, { error: 'UI token 无效。请使用启动时打印的地址打开控制台。' });
    return false;
  };

  const requireMcp = (req, res) => {
    if (!config.enabled) {
      sendJson(res, 503, { error: 'MCP 服务未启用' });
      return false;
    }
    if (tokenFrom(req) !== config.token) {
      sendJson(res, 401, { error: 'MCP token 无效' });
      return false;
    }
    return true;
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`[http] error: ${err?.message || err}`);
      if (!res.headersSent) sendJson(res, 500, { error: err?.message || String(err) });
      else res.end();
    });
  });

  async function handle(req, res) {
    requestCount += 1;
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);

    // CORS（仅本机）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-UI-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- MCP over HTTP ----
    if (pathname === '/mcp' || pathname === '/mcp/') {
      if (!requireMcp(req, res)) return;
      if (req.method === 'GET') {
        // SSE 长连接不支持，返回 405 提示用 POST
        sendJson(res, 405, { error: '请使用 POST 提交 JSON-RPC 消息' });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      const body = await readBody(req);
      const messages = Array.isArray(body) ? body : [body];
      const responses = [];
      for (const message of messages) {
        if (!message) continue;
        const response = await handleMessage(message, ctx);
        if (response) responses.push(response);
      }
      lastMcpCallAt = new Date().toISOString();
      // 仅更新内存态，避免每次调用都落盘（stdio 模式与控制台共用同一配置文件）
      config.last_connected_at = lastMcpCallAt;
      if (responses.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }
      sendJson(res, 200, Array.isArray(body) ? responses : responses[0]);
      return;
    }

    // ---- 静态资源 ----
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(readWebAsset('index.html'));
      return;
    }
    if (req.method === 'GET' && /^\/(app|design|envvars|extra|recent|curl-parse|curl-build|theme|style)\.(js|css)$/.test(pathname)) {
      const name = pathname.slice(1);
      try {
        const content = readWebAsset(name);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'text/plain', 'Cache-Control': 'no-store' });
        res.end(content);
        return;
      } catch {
        sendText(res, 404, `asset not found: ${name}`);
        return;
      }
    }
    if (req.method === 'GET' && (pathname === '/favicon.ico' || pathname === '/favicon.png' || pathname === '/icon.png')) {
      // 优先内联资源，其次读 web/ 目录；都没有则返回 204
      try {
        const png = readWebBinary('icon.png');
        res.writeHead(200, { 'Content-Type': MIME['.png'], 'Cache-Control': 'max-age=86400' });
        res.end(png);
        return;
      } catch {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // ---- REST API ----
    if (!pathname.startsWith('/api/')) {
      sendText(res, 404, 'Not Found');
      return;
    }
    if (!requireUi(req, res)) return;

    const api = pathname.replace(/^\/api\/?/, '');

    if (api === 'status' && req.method === 'GET') {
      return sendJson(res, 200, {
        enabled: config.enabled,
        allow_write: config.allow_write !== false,
        allow_execute: config.allow_execute !== false,
        port: config.port,
        host: config.host,
        uptime_ms: Date.now() - startedAt,
        requests: requestCount,
        last_mcp_call_at: lastMcpCallAt,
        official_root: officialRoot,
        official_root_ok: isOfficialRoot(officialRoot),
        detected_root: detectOfficialRoot({ config }),
        tool_count: TOOLS.length,
        version: '1.0.0'
      });
    }

    if (api === 'config' && req.method === 'GET') {
      return sendJson(res, 200, publicConfig(config));
    }

    if (api === 'config' && req.method === 'PUT') {
      const body = (await readBody(req)) || {};
      const allowedKeys = [
        'enabled',
        'allow_write',
        'allow_execute',
        'allowed_project_ids',
        'data_root',
        'theme',
        'theme_custom_bg',
        'follow_system_theme',
        'font_scale',
        'nav_order',
        'preferred_env'
      ];
      for (const key of allowedKeys) {
        if (!(key in body)) continue;
        // nav_order 需是字符串数组，避免脏数据
        if (key === 'nav_order') {
          config.nav_order = Array.isArray(body.nav_order) ? body.nav_order.map(String) : [];
          continue;
        }
        config[key] = body[key];
      }
      saveConfig(config);
      ctx.config = config;
      return sendJson(res, 200, publicConfig(config));
    }

    if (api === 'token' && req.method === 'POST') {
      regenerateToken(config);
      ctx.config = config;
      return sendJson(res, 200, { token: config.token, message: 'Token 已重置，请更新客户端配置' });
    }

    if (api === 'client-config' && req.method === 'GET') {
      const exe = process.execPath;
      // 打包版（SEA）：execPath 就是 apimcp.exe，直接传 --stdio
      // 开发版：execPath 是 node，需要把入口脚本路径补上
      const isSea = !/^node(\.exe)?$/i.test(path.basename(exe));
      const command = exe;
      const args = isSea ? ['--stdio'] : [path.resolve(here, '../main.js'), '--stdio'];
      return sendJson(res, 200, {
        command,
        args,
        configs: buildClientConfigs({ command, args })
      });
    }

    if (api === 'projects' && req.method === 'GET') {
      const allowed = config.allowed_project_ids || [];
      const projects = listProjects(officialRoot).map((p) => ({
        ...p,
        authorized: allowed.length === 0 || allowed.includes(p.project_id)
      }));
      return sendJson(res, 200, { projects, official_root: officialRoot });
    }

    const projectMatch = api.match(/^projects\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
      const action = projectMatch[2] || '';
      const projectExists = listProjects(officialRoot).some((p) => p.project_id === projectId);
      if (!projectExists) return sendJson(res, 404, { error: `项目不存在：${projectId}` });

      if (action === 'tree' && req.method === 'GET') {
        const target = openProject({ officialRoot, projectId });
        return sendJson(res, 200, {
          project_id: projectId,
          tree: buildApiTree(target),
          counts: countApis(target)
        });
      }

      if (action === 'flows' && req.method === 'GET') {
        const target = openProject({ officialRoot, projectId });
        return sendJson(res, 200, { project_id: projectId, flows: listFlows(target) });
      }

      if (action === 'runs' && req.method === 'GET') {
        const target = openProject({ officialRoot, projectId });
        return sendJson(res, 200, { project_id: projectId, ...listRuns(target, { limit: url.searchParams.get('limit') || 20 }) });
      }

      // ---------- 最近：最近保存 / 历史发送记录 ----------
      if (action === 'recent' && req.method === 'GET') {
        const target = openProject({ officialRoot, projectId });
        const kind = url.searchParams.get('kind') || 'saved';
        const keyword = url.searchParams.get('keyword') || '';
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));

        if (kind === 'runs') {
          return sendJson(res, 200, {
            project_id: projectId,
            kind,
            items: listRecentRuns(target, { limit, keyword })
          });
        }
        return sendJson(res, 200, {
          project_id: projectId,
          kind: 'saved',
          items: listRecentlySaved(target, { limit, keyword })
        });
      }

      if (action === 'recent/runs' && req.method === 'GET') {
        const target = openProject({ officialRoot, projectId });
        const runId = url.searchParams.get('run_id');
        if (!runId) return sendJson(res, 400, { error: '缺少 run_id' });
        const run = getRun(target, runId);
        if (!run) return sendJson(res, 404, { error: `执行记录不存在：${runId}` });
        return sendJson(res, 200, { project_id: projectId, run });
      }

      if (action === 'run' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        const { callTool } = await import('../mcp/tools.js');
        const result = await callTool(
          'apipost_execute_api',
          { project_id: projectId, target_id: body.target_id, environment_id: body.environment_id, input: body.input || {} },
          ctx
        );
        return sendJson(res, 200, result);
      }

      // ---------- 接口编辑器：CRUD ----------
      const projectTarget = () => openProject({ officialRoot, projectId });

      if (action === 'apis/reorder' && req.method === 'POST') {
        const target = projectTarget();
        const body = (await readBody(req)) || {};
        const items = Array.isArray(body.items) ? body.items : [];
        const applied = [];
        for (const item of items) {
          if (!item?.target_id) continue;
          const patch = {};
          if (item.parent_id !== undefined) patch.parent_id = String(item.parent_id || '0');
          if (item.sort !== undefined) patch.sort = Number(item.sort) || 0;
          const updated = updateApiIndexItem(target, item.target_id, patch);
          if (updated) {
            // 同步实体文件里的 name/parent_id/sort
            const file = readApiFile(target, item.target_id);
            if (file?.data) {
              const data = { ...file.data };
              if (patch.parent_id !== undefined) data.parent_id = patch.parent_id;
              if (patch.sort !== undefined) data.sort = patch.sort;
              writeApiFile(target, item.target_id, data, updated);
            }
            applied.push(item.target_id);
          }
        }
        return sendJson(res, 200, { ok: true, applied });
      }

      if (action === 'apis' && req.method === 'GET') {
        const target = projectTarget();
        const flat = readApiIndex(target).items.map((i) => ({
          target_id: i.target_id,
          target_type: i.target_type,
          name: i.name || '',
          method: String(i.method || '').toUpperCase(),
          url: i.url || '',
          parent_id: i.parent_id || '0',
          sort: i.sort ?? 0
        }));
        return sendJson(res, 200, { project_id: projectId, items: flat });
      }

      if (action === 'apis' && req.method === 'POST') {
        const target = projectTarget();
        const body = (await readBody(req)) || {};
        const targetType = String(body.target_type || TARGET_TYPE.API);
        if (!Object.values(TARGET_TYPE).includes(targetType)) {
          return sendJson(res, 400, { error: `target_type 无效：${targetType}` });
        }
        const name = String(body.name || '').trim();
        if (!name) return sendJson(res, 400, { error: '缺少接口名称 name' });

        const created = createApiOrFolder(target, {
          name,
          parentId: String(body.parent_id || '0'),
          targetType,
          method: body.method || 'GET',
          url: body.url || '',
          detail: {
            description: body.description || '',
            content: body.content || '',
            request: body.request,
            response: body.response
          }
        });
        return sendJson(res, 200, { ok: true, ...created });
      }

      // ---------- 接口用例 ----------
      const casesMatch = action.match(/^apis\/([^/]+)\/cases(?:\/([^/]+))?$/);
      if (casesMatch) {
        const targetId = casesMatch[1];
        const caseId = casesMatch[2] || null;
        const target = projectTarget();
        const { listCases, upsertCase, deleteCase } = await import('../store/cases.js');

        if (req.method === 'GET') {
          return sendJson(res, 200, { project_id: projectId, target_id: targetId, cases: listCases(target, targetId) });
        }
        if (req.method === 'POST') {
          const body = (await readBody(req)) || {};
          return sendJson(res, 200, { ok: true, ...upsertCase(target, targetId, body) });
        }
        if (req.method === 'PUT' && caseId) {
          const body = (await readBody(req)) || {};
          return sendJson(res, 200, { ok: true, ...upsertCase(target, targetId, { ...body, case_id: caseId }) });
        }
        if (req.method === 'DELETE' && caseId) {
          return sendJson(res, 200, { ok: true, ...deleteCase(target, targetId, caseId) });
        }
      }

      // 项目级用例汇总
      if (action === 'cases' && req.method === 'GET') {
        const target = projectTarget();
        const { collectProjectCases } = await import('../store/cases.js');
        return sendJson(res, 200, { project_id: projectId, cases: collectProjectCases(target) });
      }

      // 批量执行用例
      if (action === 'cases/run' && req.method === 'POST') {
        projectTarget();
        const body = (await readBody(req)) || {};
        const targetId = String(body.target_id || '');
        if (!targetId) return sendJson(res, 400, { error: '缺少 target_id' });

        const target = openProject({ officialRoot, projectId });
        const { listCases } = await import('../store/cases.js');
        const { runApi } = await import('../exec/runner.js');
        const { getRun } = await import('../store/runs.js');

        let allCases;
        try {
          allCases = listCases(target, targetId);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }

        const wanted = Array.isArray(body.case_ids) && body.case_ids.length > 0
          ? allCases.filter((c) => body.case_ids.includes(c.case_id))
          : allCases.filter((c) => Number(c.enabled) === 1);

        if (wanted.length === 0) return sendJson(res, 400, { error: '没有可执行的用例' });

        const results = [];
        const CASE_BODY_LIMIT = 20 * 1024;
        for (const c of wanted) {
          try {
            const summary = await runApi({
              officialRoot,
              projectId,
              targetId,
              input: c.input || {},
              source: 'manual',
              includeLiveDetail: true
            });
            const run = getRun(target, summary.run_id);
            const step = run?.steps?.[0] || null;
            const statusCode = step?.response?.status;
            const live = summary.live_detail || null;
            const liveResp = live?.response || null;
            const respHeaders = liveResp?.headers || step?.response?.headers || {};

            let passed = summary.status === 'passed';
            const messages = [];

            // 期望状态码
            if (c.expect_status && String(c.expect_status).trim()) {
              const expected = String(c.expect_status).trim();
              const okCode = String(statusCode) === expected;
              if (!okCode) {
                passed = false;
                messages.push(`期望状态码 ${expected}，实际 ${statusCode}`);
              }
            }
            // 期望响应包含
            if (c.expect_body_contains && String(c.expect_body_contains).trim()) {
              const needle = String(c.expect_body_contains);
              const bodyText = step?.response?.body || '';
              if (!bodyText.includes(needle)) {
                passed = false;
                messages.push(`响应不包含「${needle}」`);
              }
            }
            // 期望 Content-Type 包含
            if (c.expect_content_type && String(c.expect_content_type).trim()) {
              const wantedType = String(c.expect_content_type).trim().toLowerCase();
              const actualType = String(respHeaders['content-type'] || '').toLowerCase();
              if (!actualType.includes(wantedType)) {
                passed = false;
                messages.push(`Content-Type 期望包含 ${wantedType}，实际 ${actualType || '(空)'}`);
              }
            }
            // 期望响应头
            if (c.expect_headers && typeof c.expect_headers === 'object') {
              const checks = checkExpectedHeaders(c.expect_headers, respHeaders);
              for (const check of checks) {
                if (check.passed) continue;
                passed = false;
                messages.push(check.message || check.name);
              }
            }

            // 结果里带上请求 / 响应详情，供前端内联展开；响应体截断到 20KB
            const rawBody = step?.response?.body || liveResp?.body || '';
            const truncated = rawBody.length > CASE_BODY_LIMIT;
            results.push({
              case_id: c.case_id,
              name: c.name || '未命名',
              passed,
              status_code: statusCode,
              elapsed_ms: summary.elapsed_ms,
              run_id: summary.run_id,
              message: messages.length > 0 ? messages.join('; ') : summary.error || undefined,
              request: live?.request || step?.request || null,
              response: {
                status: liveResp?.status ?? statusCode,
                status_text: liveResp?.status_text ?? step?.response?.status_text ?? '',
                headers: respHeaders,
                body: truncated ? rawBody.slice(0, CASE_BODY_LIMIT) : rawBody,
                truncated
              }
            });
          } catch (err) {
            results.push({
              case_id: c.case_id,
              name: c.name || '未命名',
              passed: false,
              status_code: undefined,
              elapsed_ms: 0,
              message: err.message
            });
          }
        }

        const passed = results.filter((r) => r.passed).length;
        return sendJson(res, 200, {
          ok: true,
          target_id: targetId,
          total: results.length,
          passed,
          failed: results.length - passed,
          results
        });
      }

      // ---------- 压测 ----------
      if (action === 'stress' && req.method === 'POST') {
        projectTarget();
        const body = (await readBody(req)) || {};
        if (!body.target_id) return sendJson(res, 400, { error: '缺少 target_id' });
        const { runStress } = await import('../exec/stress.js');
        try {
          // 节流收集进度快照（每 250ms 一次），跑完随结果返回给前端画曲线
          const progressTimeline = [];
          let lastSample = 0;
          const onProgress = (done, total) => {
            const now = Date.now();
            if (now - lastSample < 250 && done !== total) return;
            lastSample = now;
            progressTimeline.push({ done, total: total || 0, at_ms: now });
          };
          const result = await runStress({
            officialRoot,
            projectId,
            targetId: body.target_id,
            concurrency: body.concurrency,
            mode: body.mode,
            rounds: body.rounds,
            durationMs: body.duration_ms,
            runAssertions: body.run_assertions !== false,
            envId: body.environment_id,
            onProgress
          });
          const startedMs = progressTimeline.length > 0 ? progressTimeline[0].at_ms : 0;
          const timeline = progressTimeline.map((p) => ({
            done: p.done,
            total: p.total,
            t_ms: startedMs ? p.at_ms - startedMs : 0
          }));
          return sendJson(res, 200, { ok: true, ...result, progress_timeline: timeline });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      // ---------- Mock 配置 ----------
      const mockMatch = action.match(/^apis\/([^/]+)\/mock$/);
      if (mockMatch) {
        const targetId = mockMatch[1];
        const target = projectTarget();
        const { readApiFile: readFile, writeApiFile: writeFile, findApiItem: findItem } = await import('../store/apis.js');

        if (req.method === 'GET') {
          const file = readFile(target, targetId);
          const mock = file?.data?.mock || null;
          return sendJson(res, 200, { project_id: projectId, target_id: targetId, mock });
        }

        if (req.method === 'PUT') {
          const body = (await readBody(req)) || {};
          const item = findItem(target, targetId);
          if (!item) return sendJson(res, 404, { error: `接口不存在：${targetId}` });
          const file = readFile(target, targetId);
          if (!file?.data) return sendJson(res, 404, { error: `接口定义缺失：${targetId}` });

          const data = file.data;
          const prev = data.mock || {};
          data.mock = {
            enabled: body.enabled === undefined ? Number(prev.enabled) === 1 ? 1 : 0 : body.enabled ? 1 : 0,
            status: String(body.status ?? prev.status ?? '200'),
            delay_ms: Math.max(0, Math.min(60000, Number(body.delay_ms ?? prev.delay_ms ?? 0) || 0)),
            content_type: String(body.content_type ?? prev.content_type ?? 'application/json; charset=utf-8'),
            body: String(body.body ?? prev.body ?? ''),
            headers: body.headers && typeof body.headers === 'object' ? body.headers : prev.headers || {},
            schema: body.schema !== undefined ? body.schema : prev.schema || null,
            updated_at: new Date().toISOString()
          };
          writeFile(target, targetId, data, item);
          return sendJson(res, 200, { ok: true, mock: data.mock });
        }
      }

      if (action === 'mocks' && req.method === 'GET') {
        const { listMocks } = await import('../server/mock.js');
        const mocks = listMocks({
          officialRoot,
          projects: () => listProjects(officialRoot)
        });
        return sendJson(res, 200, {
          project_id: projectId,
          mocks: mocks.filter((m) => m.project_id === projectId),
          mock_port: mockService?.port || null,
          mock_running: Boolean(mockService)
        });
      }

      // ---------- 环境与变量（控制台「环境与变量」页） ----------
      if (action === 'environments' && req.method === 'GET') {
        const target = projectTarget();
        const envs = listEnvironments(target);
        const currentId = readCurrentEnvId(target) || envs[0]?.env_id || '';
        return sendJson(res, 200, {
          project_id: projectId,
          current_env_id: currentId,
          environments: envs.map((env) => ({
            ...shapeEnv(env, currentId),
            is_private: Number(env.is_private) === 1 ? 1 : -1,
            variables: getEnvironmentVariables(target, env.env_id).variables,
            servers: (env.server_list || []).map((s) => ({
              server_id: String(s.server_id),
              name: s.name || 'default',
              sort: s.sort ?? 1000,
              base_url: s.uri || ''
            }))
          })),
          shared_servers: sharedServers(target),
          global_vars: getGlobalVariables(target).variables
        });
      }

      if (action === 'environments' && req.method === 'POST') {
        const target = projectTarget();
        const body = (await readBody(req)) || {};
        const env = createEnvironment(target, { name: body.name, baseUrl: body.base_url });
        return sendJson(res, 200, { ok: true, environment: shapeEnv(env, readCurrentEnvId(target)) });
      }

      // 切换当前环境（必须在 /environments/:id 之前匹配）
      if (action === 'environments/current' && req.method === 'POST') {
        const target = projectTarget();
        const body = (await readBody(req)) || {};
        const envId = writeCurrentEnvId(target, body.environment_id);
        // 同时记进配置，供 stdio 端（没有项目数据上下文时）参考
        config.preferred_env = { ...(config.preferred_env || {}), [projectId]: envId };
        saveConfig(config);
        ctx.config = config;
        return sendJson(res, 200, { ok: true, project_id: projectId, current_env_id: envId });
      }

      const envMatch = action.match(/^environments\/([^/]+)(?:\/(variables))?(?:\/([^/]+))?$/);
      if (envMatch) {
        const envId = envMatch[1];
        const sub = envMatch[2] || '';
        const key = envMatch[3] ? decodeURIComponent(envMatch[3]) : '';
        const target = projectTarget();

        if (sub === 'variables') {
          if (req.method === 'GET') {
            return sendJson(res, 200, { project_id: projectId, ...getEnvironmentVariables(target, envId) });
          }
          if (req.method === 'PUT') {
            // 整表保存
            const body = (await readBody(req)) || {};
            const list = Array.isArray(body.variables) ? body.variables : [];
            return sendJson(res, 200, { ok: true, ...replaceEnvVariables(target, envId, list) });
          }
          if (req.method === 'POST') {
            const body = (await readBody(req)) || {};
            return sendJson(res, 200, {
              ok: true,
              ...upsertEnvVariable(target, {
                envId,
                key: body.key,
                value: body.value,
                currentValue: body.current_value,
                description: body.description
              })
            });
          }
          if (req.method === 'DELETE' && key) {
            return sendJson(res, 200, { ok: true, ...deleteEnvVariable(target, { envId, key }) });
          }
        }

        if (req.method === 'PUT') {
          const body = (await readBody(req)) || {};
          const env = updateEnvironment(target, envId, { name: body.name, baseUrl: body.base_url });
          return sendJson(res, 200, { ok: true, environment: shapeEnv(env, readCurrentEnvId(target)) });
        }
        if (req.method === 'DELETE') {
          deleteEnvironment(target, envId);
          return sendJson(res, 200, { ok: true, deleted: true, env_id: envId });
        }
      }

      // ---------- 共享服务（多 host） ----------
      if (action === 'servers' && req.method === 'GET') {
        const target = projectTarget();
        const envId = url.searchParams.get('environment_id') || '';
        return sendJson(res, 200, { project_id: projectId, ...listEnvironmentServers(target, envId) });
      }

      if (action === 'servers' && req.method === 'POST') {
        const target = projectTarget();
        const body = (await readBody(req)) || {};
        const created = createEnvironmentServer(target, {
          name: body.name,
          envId: body.environment_id,
          baseUrl: body.base_url
        });
        return sendJson(res, 200, { ok: true, server: created });
      }

      const serverMatch = action.match(/^servers\/([^/]+)$/);
      if (serverMatch) {
        const target = projectTarget();
        const serverId = serverMatch[1];
        if (req.method === 'PUT') {
          const body = (await readBody(req)) || {};
          const updated = updateEnvironmentServer(target, {
            serverId,
            name: body.name,
            envId: body.environment_id,
            baseUrl: body.base_url
          });
          return sendJson(res, 200, { ok: true, server: updated });
        }
        if (req.method === 'DELETE') {
          return sendJson(res, 200, { ok: true, ...deleteEnvironmentServer(target, serverId) });
        }
      }

      // ---------- 全局参数 ----------
      if (action === 'global-params' && req.method === 'GET') {
        const target = projectTarget();
        return sendJson(res, 200, { project_id: projectId, params: readGlobalParams(target) });
      }

      if (action === 'global-params' && req.method === 'PUT') {
        const target = projectTarget();
        const body = (await readBody(req)) || {};
        const saved = writeGlobalParams(target, body.params || body);
        return sendJson(res, 200, { ok: true, params: saved });
      }

      // ---------- 全局变量 ----------
      if (action === 'global-vars' && req.method === 'GET') {
        const target = projectTarget();
        return sendJson(res, 200, { project_id: projectId, ...getGlobalVariables(target) });
      }

      if (action === 'global-vars' && req.method === 'POST') {
        const target = projectTarget();
        const body = (await readBody(req)) || {};
        return sendJson(res, 200, {
          ok: true,
          ...upsertGlobalVariable(target, {
            key: body.key,
            value: body.value,
            currentValue: body.current_value,
            description: body.description
          })
        });
      }

      const globalVarMatch = action.match(/^global-vars\/([^/]+)$/);
      if (globalVarMatch && req.method === 'DELETE') {
        const target = projectTarget();
        return sendJson(res, 200, { ok: true, ...deleteGlobalVariable(target, { key: decodeURIComponent(globalVarMatch[1]) }) });
      }

      // ---------- 接口状态（marks） ----------
      if (action === 'marks' && req.method === 'GET') {        const target = projectTarget();
        const marks = target.readJson('project/settings/marks.json', null) || [];
        return sendJson(res, 200, { project_id: projectId, marks: Array.isArray(marks) ? marks : [] });
      }

      if (action === 'marks' && req.method === 'PUT') {
        const target = projectTarget();
        const body = (await readBody(req)) || {};
        const marks = Array.isArray(body.marks) ? body.marks : null;
        if (!marks) return sendJson(res, 400, { error: 'marks 必须是数组' });
        const normalized = marks
          .filter((m) => m && m.mark_id)
          .map((m) => ({
            color: String(m.color || '#2857FF'),
            is_default_mark: Number(m.is_default_mark) === 1 ? 1 : -1,
            is_sys_default: m.is_sys_default === undefined ? -1 : Number(m.is_sys_default),
            mark_id: String(m.mark_id),
            name: String(m.name || m.mark_id),
            project_id: projectId
          }));
        if (!normalized.some((m) => m.is_default_mark === 1) && normalized.length > 0) {
          normalized[0].is_default_mark = 1;
        }
        target.writeJson('project/settings/marks.json', normalized);
        return sendJson(res, 200, { ok: true, marks: normalized });
      }

      // ---------- 编辑器内发送：返回完整响应 ----------
      const sendMatch = action.match(/^apis\/([^/]+)\/send$/);
      if (sendMatch && req.method === 'POST') {
        const targetId = sendMatch[1];
        projectTarget();
        const body = (await readBody(req)) || {};
        const { runApi } = await import('../exec/runner.js');
        const { getRun } = await import('../store/runs.js');

        const summary = await runApi({
          officialRoot,
          projectId,
          targetId,
          input: body.input || {},
          envId: body.environment_id,
          preferredEnvId: config.preferred_env?.[projectId],
          source: 'manual',
          includeBinary: true,
          includeLiveDetail: true
        });

        const runTarget = openProject({ officialRoot, projectId });
        const run = getRun(runTarget, summary.run_id);
        const step = run?.steps?.[0] || null;

        return sendJson(res, 200, {
          ...summary,
          protocol: step?.response?.protocol || 'HTTP/1.1',
          request: step?.request || null,
          response: step?.response || null,
          // 二进制原始字节只在即时响应里给，不落盘
          content_type: summary.content_type || step?.response?.content_type || '',
          is_binary: Boolean(summary.is_binary ?? step?.response?.is_binary),
          body_base64: summary.body_base64 || null,
          too_large_for_base64: Boolean(summary.too_large_for_base64),
          console: step?.console || [],
          variables: step?.variables || {},
          assertions: step?.assertions || summary.assertions || []
        });
      }

      const apiItemMatch = action.match(/^apis\/([^/]+)$/);
      if (apiItemMatch) {
        const targetId = apiItemMatch[1];
        const target = projectTarget();

        if (req.method === 'GET') {
          const item = findApiItem(target, targetId);
          if (!item) return sendJson(res, 404, { error: `接口不存在：${targetId}` });
          const file = ensureApiFile(target, targetId);
          return sendJson(res, 200, {
            project_id: projectId,
            target_id: targetId,
            target_type: item.target_type,
            index: {
              name: item.name,
              method: item.method,
              url: item.url,
              parent_id: item.parent_id,
              sort: item.sort,
              mark_id: item.mark_id
            },
            data: file?.data || null
          });
        }

        if (req.method === 'PUT') {
          const item = findApiItem(target, targetId);
          if (!item) return sendJson(res, 404, { error: `接口不存在：${targetId}` });
          const body = (await readBody(req)) || {};
          const incoming = body.data || body;

          const existingFile = readApiFile(target, targetId);
          const merged = { ...(existingFile?.data || {}), ...incoming };
          // preserve_aux：设计页签保存时保护用例 / Mock，避免用旧快照覆盖
          if (body.preserve_aux) {
            for (const key of AUX_KEYS) {
              if (existingFile?.data && key in existingFile.data) merged[key] = existingFile.data[key];
              else delete merged[key];
            }
          }
          // 只允许这些索引字段被改名
          const name = String(merged.name ?? item.name ?? '').trim();
          if (!name) return sendJson(res, 400, { error: '接口名称不能为空' });
          const method = String(merged.method ?? item.method ?? 'GET').toUpperCase();
          const apiUrl = String(merged.url ?? item.url ?? '');
          const parentId = String(merged.parent_id ?? item.parent_id ?? '0');

          merged.name = name;
          merged.method = method;
          merged.url = apiUrl;
          merged.parent_id = parentId;
          merged.project_id = projectId;
          merged.target_id = targetId;
          merged.target_type = merged.target_type || item.target_type;

          const nextIndexItem = {
            ...item,
            name,
            method: item.target_type === TARGET_TYPE.API ? method : '',
            url: item.target_type === TARGET_TYPE.API ? apiUrl : '',
            parent_id: parentId
          };

          const saved = writeApiFile(target, targetId, merged, nextIndexItem);
          updateApiIndexItem(target, targetId, {
            name,
            method: item.target_type === TARGET_TYPE.API ? method : '',
            url: item.target_type === TARGET_TYPE.API ? apiUrl : '',
            parent_id: parentId
          });

          return sendJson(res, 200, { ok: true, target_id: targetId, version: saved.version, updated_at: saved.updated_at });
        }

        if (req.method === 'DELETE') {
          const item = findApiItem(target, targetId);
          if (!item) return sendJson(res, 404, { error: `接口不存在：${targetId}` });
          const result = deleteApis(target, [targetId]);
          return sendJson(res, 200, { ok: true, ...result, deleted_count: result.deleted_ids.length });
        }
      }
    }

    if (api === 'tools' && req.method === 'GET') {
      return sendJson(res, 200, { tools: TOOLS });
    }

    // Mock 服务管理
    if (api === 'mock-server' && req.method === 'GET') {
      return sendJson(res, 200, {
        running: Boolean(instance.mockPort),
        port: instance.mockPort,
        stats: instance.mockStats
      });
    }

    if (api === 'mock-server/start' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      try {
        // 显式区分「未传」与「传 0（自动分配）」
        const requested = body.port === undefined || body.port === null ? 39101 : Number(body.port);
        const port = await instance.startMock(Number.isFinite(requested) ? requested : 39101);
        return sendJson(res, 200, { ok: true, port });
      } catch (err) {
        return sendJson(res, 400, { error: `启动 Mock 服务失败：${err.message}` });
      }
    }

    if (api === 'mock-server/stop' && req.method === 'POST') {
      const ok = await instance.stopMock();
      return sendJson(res, 200, { ok, running: Boolean(instance.mockPort) });
    }

    if (api === 'tools/call' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const { callTool } = await import('../mcp/tools.js');
      try {
        const result = await callTool(body.name, body.arguments || {}, ctx);
        return sendJson(res, 200, { ok: true, result });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: err.message, entries: err.entries });
      }
    }

    sendJson(res, 404, { error: `未知接口：${pathname}` });
  }

  const instance = {
    server,
    ctx,
    listen(port = config.port || DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          resolve(address);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, config.host || '127.0.0.1');
      });
    },
    /** 启动/重启本地 Mock 服务（独立端口，默认 39101） */
    async startMock(mockPort = 39101) {
      const { createMockServer } = await import('./mock.js');
      if (mockService) {
        try {
          await mockService.close();
        } catch {}
        mockService = null;
      }
      const instance = createMockServer({ officialRoot, config, log });
      const address = await instance.listen(mockPort);
      mockService = instance;
      const actualPort = typeof address === 'object' && address ? address.port : mockPort;
      log(`[mock] 本地 Mock 服务已启动：http://127.0.0.1:${actualPort}`);
      return actualPort;
    },
    async stopMock() {
      if (!mockService) return false;
      try {
        await mockService.close();
      } catch {}
      mockService = null;
      return true;
    },
    get mockPort() {
      return mockService?.port || null;
    },
    get mockStats() {
      return mockService ? mockService.stats() : null;
    },
    close() {
      const closeMock = mockService
        ? mockService.close().catch(() => {})
        : Promise.resolve();
      return Promise.all([new Promise((resolve) => server.close(resolve)), closeMock]).then(() => {});
    },
    get port() {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : null;
    }
  };

  return instance;
}
