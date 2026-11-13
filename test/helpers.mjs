import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 建一个临时的本软件数据根，结构与 ensureDataRoot 初始化出来的一致 */
export function makeTempRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apimcp-test-'));
  const root = path.join(base, 'ApiMCP', 'data');

  // 隔离本软件自身配置，避免测试写到真实 %APPDATA%\ApiMCP
  process.env.APIMCP_HOME = path.join(base, 'mcp-home');
  fs.mkdirSync(process.env.APIMCP_HOME, { recursive: true });

  const projectId = '2503d482bac003';
  const teamId = '2503d483fac004';
  const now = new Date().toISOString();

  const write = (rel, data) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`);
  };

  fs.mkdirSync(root, { recursive: true });

  write('offline-projects.json', [{ project_id: projectId, path: path.join(root, 'offline-data', projectId), created_at: now }]);
  write('offline-data-local/meta.json', {
    current_project_id: projectId,
    default_project_id: projectId,
    default_team_id: teamId
  });
  write('offline-data-local/teams.json', [{ created_at: now, name: '默认团队', team_id: teamId }]);
  write('offline-data-local/projects/' + projectId + '/env_vars_history.json', {});
  write('offline-data-local/projects/' + projectId + '/global_vars_history.json', {});

  const pdir = `offline-data/${projectId}`;
  write(`${pdir}/project.json`, {
    created_at: now,
    intro: '',
    logo: '',
    name: '测试项目',
    project_id: projectId,
    team_id: teamId,
    updated_at: now
  });
  write(`${pdir}/apis/index.json`, { items: [], project_id: projectId });
  write(`${pdir}/envs/index.json`, {
    items: [
      { env_id: '1', name: '默认环境', sort: 1000, updated_at: now },
      { env_id: '2503d4840ac010', name: '测试环境', sort: 2000, updated_at: now }
    ],
    project_id: projectId
  });
  write(`${pdir}/envs/1.json`, {
    created_at: now,
    env_id: '1',
    env_var_list: {},
    is_private: -1,
    name: '默认环境',
    project_id: projectId,
    server_list: [{ name: 'default', server_id: '1', sort: 1000, uri: '' }],
    sort: 1000,
    updated_at: now
  });
  write(`${pdir}/envs/2503d4840ac010.json`, {
    created_at: now,
    env_id: '2503d4840ac010',
    env_var_list: { base: { value: 'http://127.0.0.1:0', description: '被测服务' } },
    is_private: -1,
    name: '测试环境',
    project_id: projectId,
    server_list: [{ name: 'default', server_id: '1', sort: 1000, uri: '' }],
    sort: 2000,
    updated_at: now
  });
  write(`${pdir}/global_vars.json`, { shared: { value: 'global-value' } });
  write(`${pdir}/global_params.json`, {
    auth: { type: 'noauth' },
    body: { parameter: [] },
    cookie: { parameter: [] },
    header: { parameter: [] },
    post_tasks: [],
    pre_tasks: [],
    query: { parameter: [] }
  });
  write(`${pdir}/settings/marks.json`, []);
  write(`${pdir}/executions/flows/index.json`, { version: 2, updated_at: now, records: [] });
  write(`${pdir}/executions/runs/index.json`, { version: 2, updated_at: now, records: [] });

  return { base, root, projectId, teamId };
}

export function cleanup(base) {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {}
}

export async function makeContext({ root }, overrides = {}) {
  const { ToolContext } = await import('../src/mcp/tools.js');
  return new ToolContext({
    dataRoot: root,
    config: {
      enabled: true,
      allowed_project_ids: [],
      allow_write: true,
      allow_execute: true,
      preferred_env: {},
      ...overrides
    }
  });
}

/** 起一个本地假 REST 服务 */
export async function startFakeServer() {
  const http = await import('node:http');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      url = new URL('http://127.0.0.1/');
    }
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/login' && req.method === 'POST') {
      const parsed = body ? JSON.parse(body) : {};
      if (parsed.username === 'admin') {
        return send(200, { token: 'tok-123', userId: 7 }, { 'Set-Cookie': 'session=abc; Path=/' });
      }
      return send(401, { error: 'bad credentials' });
    }

    if (url.pathname === '/me' && req.method === 'GET') {
      if (req.headers.authorization === 'Bearer tok-123') {
        return send(200, { id: 7, username: 'admin' });
      }
      return send(401, { error: 'unauthorized' });
    }

    if (url.pathname === '/echo' && req.method === 'POST') {
      return send(200, { ok: true, body, contentType: req.headers['content-type'] || '' });
    }

    if (url.pathname === '/query' && req.method === 'GET') {
      return send(200, { query: Object.fromEntries(url.searchParams), header: req.headers['x-test'] || '' });
    }

    if (url.pathname === '/image' && req.method === 'GET') {
      // 1x1 透明 PNG
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      res.end(png);
      return;
    }

    if (url.pathname === '/bigtext' && req.method === 'GET') {
      // 用于测试超大响应（> 4MB）不附带 base64
      const big = 'x'.repeat(5 * 1024 * 1024);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(big);
      return;
    }

    if (url.pathname === '/slow') {
      await new Promise((r) => setTimeout(r, 50));
      return send(200, { slow: true });
    }

    if (url.pathname === '/users/42' && req.method === 'GET') {
      return send(200, { id: 42, name: 'alice' });
    }

    return send(404, { error: 'not found', path: url.pathname });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
