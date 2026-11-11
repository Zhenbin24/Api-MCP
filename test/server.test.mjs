import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, cleanup } from './helpers.mjs';
import { createServer } from '../src/server/serve.js';
import { defaultConfig } from '../src/server/config.js';

async function boot() {
  const env = makeTempRoot();
  const config = {
    ...defaultConfig(),
    enabled: true,
    token: 'test-token',
    ui_token: 'test-ui',
    port: 0,
    data_root: env.root,
    allowed_project_ids: []
  };
  const instance = createServer({ config, officialRoot: env.root });
  const address = await instance.listen(0);
  const port = address.port;
  const base = `http://127.0.0.1:${port}`;
  return { env, config, instance, base, port };
}

test('HTTP：MCP 端点鉴权与 initialize', async () => {
  const { env, instance, base } = await boot();
  try {
    const noToken = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(noToken.status, 401);

    const ok = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.result.serverInfo.name, 'apimcp');

    const tools = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    const toolsBody = await tools.json();
    assert.equal(toolsBody.result.tools.length, 32);

    // 通知类消息返回 202
    const notif = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
    assert.equal(notif.status, 202);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('HTTP：REST API 需 UI token', async () => {
  const { env, instance, base } = await boot();
  try {
    const noToken = await fetch(`${base}/api/status`);
    assert.equal(noToken.status, 401);

    const ok = await fetch(`${base}/api/status`, { headers: { 'X-UI-Token': 'test-ui' } });
    assert.equal(ok.status, 200);
    const status = await ok.json();
    assert.equal(status.tool_count, 32);
    assert.equal(status.official_root_ok, true);

    // query token 也允许
    const viaQuery = await fetch(`${base}/api/status?ui=test-ui`);
    assert.equal(viaQuery.status, 200);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('HTTP：项目列表与直连写入', async () => {
  const { env, instance, base } = await boot();
  try {
    const headers = { 'X-UI-Token': 'test-ui', 'Content-Type': 'application/json' };

    const list = await (await fetch(`${base}/api/projects`, { headers })).json();
    assert.equal(list.projects.length, 1);
    assert.equal(list.projects[0].authorized, true);
    // 同步相关字段已随「项目与同步」一起移除
    assert.equal(list.projects[0].sync, undefined);
    assert.equal(list.shadow_root, undefined);

    // 已下线的同步路由不再可用
    const pull = await fetch(`${base}/api/projects/${env.projectId}/pull`, { method: 'POST', headers, body: '{}' });
    assert.equal(pull.status, 404);
    const diff = await fetch(`${base}/api/projects/${env.projectId}/diff`, { headers });
    assert.equal(diff.status, 404);
    const push = await fetch(`${base}/api/projects/${env.projectId}/push`, { method: 'POST', headers, body: '{}' });
    assert.equal(push.status, 404);

    // 编辑器写入直接落官方目录
    const created = await (await fetch(`${base}/api/projects/${env.projectId}/apis`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '直连接口', method: 'GET', url: 'https://api.test/x' })
    })).json();
    assert.equal(created.ok, true);
    assert.ok(fs.existsSync(path.join(env.root, 'offline-data', env.projectId, 'apis', `${created.target_id}.json`)));

    const tree = await (await fetch(`${base}/api/projects/${env.projectId}/tree`, { headers })).json();
    assert.equal(tree.tree.length, 1);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('HTTP：static 控制台页面可访问', async () => {
  const { env, instance, base } = await boot();
  try {
    const page = await fetch(`${base}/?ui=test-ui`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /API MCP 控制台/);
    assert.match(html, /data-theme="golden"/);

    for (const asset of ['/theme.css', '/style.css', '/app.js']) {
      const res = await fetch(`${base}${asset}`);
      assert.equal(res.status, 200, asset);
    }
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('HTTP：客户端配置与工具调用', async () => {
  const { env, instance, base } = await boot();
  try {
    const headers = { 'X-UI-Token': 'test-ui', 'Content-Type': 'application/json' };

    const cfg = await (await fetch(`${base}/api/client-config`, { headers })).json();
    assert.ok(cfg.configs.cursor.includes('mcpServers'));
    assert.ok(cfg.configs.codex.includes('[mcp_servers.'));
    assert.ok(cfg.command);

    const call = await (
      await fetch(`${base}/api/tools/call`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'apipost_list_projects', arguments: {} })
      })
    ).json();
    assert.equal(call.ok, true);
    assert.ok(JSON.stringify(call.result).includes('测试项目'));

    const bad = await (
      await fetch(`${base}/api/tools/call`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'apipost_list_apis', arguments: {} })
      })
    ).json();
    assert.equal(bad.ok, false);
    assert.match(bad.error, /缺少 project_id/);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('HTTP：配置读写与主题字段', async () => {
  const { env, instance, base, config } = await boot();
  try {
    const headers = { 'X-UI-Token': 'test-ui', 'Content-Type': 'application/json' };

    const put = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ theme: 'dark', font_scale: 115, allowed_project_ids: [env.projectId] })
    });
    const updated = await put.json();
    assert.equal(updated.theme, 'dark');
    assert.equal(updated.font_scale, 115);
    assert.deepEqual(updated.allowed_project_ids, [env.projectId]);
    assert.equal(updated.has_token, true);
    assert.equal(updated.token, undefined);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('HTTP��nav_order �־û����ɶ���', async () => {
  const { env, instance, base } = await boot();
  try {
    const headers = { 'X-UI-Token': 'test-ui', 'Content-Type': 'application/json' };
    const order = ['tools', 'design', 'recent', 'overview'];

    const put = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ nav_order: order })
    });
    assert.equal(put.status, 200);
    const updated = await put.json();
    assert.deepEqual(updated.nav_order, order);

    const got = await fetch(`${base}/api/config`, { headers });
    const config = await got.json();
    assert.deepEqual(config.nav_order, order);

    // ������ʱ��գ�����������
    const bad = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ nav_order: 'not-an-array' })
    });
    const badBody = await bad.json();
    assert.deepEqual(badBody.nav_order, []);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});
