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
    token: 'test-token',
    ui_token: 'test-ui',
    port: 0,
    data_root: env.root,
    shadow_root: env.shadow,
    allowed_project_ids: []
  };
  const instance = createServer({ config, officialRoot: env.root, shadowRoot: env.shadow });
  const address = await instance.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'X-UI-Token': 'test-ui', 'Content-Type': 'application/json' };
  const req = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
  return { env, instance, req, base };
}

/** 让影子文件 mtime 错开，模拟「先后保存」 */
function touch(file, minutesAgo) {
  const t = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(file, t, t);
}

test('最近：最近保存按 mtime 倒序', async () => {
  const { env, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});

    const a = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '先保存的',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/first'
    });
    const b = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '后保存的',
      target_type: 'api',
      method: 'POST',
      url: 'https://api.test/second'
    });

    const shadowApis = path.join(env.shadow, env.projectId, 'project', 'apis');
    touch(path.join(shadowApis, `${a.data.target_id}.json`), 30);
    touch(path.join(shadowApis, `${b.data.target_id}.json`), 5);

    const res = await req('GET', `/api/projects/${env.projectId}/recent?kind=saved`);
    assert.equal(res.status, 200);
    assert.equal(res.data.kind, 'saved');
    assert.ok(res.data.items.length >= 2);

    const idxA = res.data.items.findIndex((i) => i.target_id === a.data.target_id);
    const idxB = res.data.items.findIndex((i) => i.target_id === b.data.target_id);
    assert.ok(idxB < idxA, '后保存的应排在前面');

    const first = res.data.items[idxB];
    assert.equal(first.name, '后保存的');
    assert.equal(first.method, 'POST');
    assert.equal(first.url, 'https://api.test/second');
    assert.ok(first.saved_at, '应带保存时间');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('最近：关键字过滤（名称/URL/方法）', async () => {
  const { env, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '订单查询',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/orders'
    });
    await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '用户注销',
      target_type: 'api',
      method: 'DELETE',
      url: 'https://api.test/users'
    });

    const byName = await req('GET', `/api/projects/${env.projectId}/recent?kind=saved&keyword=${encodeURIComponent('订单')}`);
    assert.ok(byName.data.items.length >= 1);
    assert.ok(byName.data.items.every((i) => `${i.name}${i.url}${i.method}`.includes('订单')));

    const byUrl = await req('GET', `/api/projects/${env.projectId}/recent?kind=saved&keyword=users`);
    assert.ok(byUrl.data.items.some((i) => i.name === '用户注销'));

    const byMethod = await req('GET', `/api/projects/${env.projectId}/recent?kind=saved&keyword=delete`);
    assert.ok(byMethod.data.items.some((i) => i.name === '用户注销'));

    const none = await req('GET', `/api/projects/${env.projectId}/recent?kind=saved&keyword=zzz不存在`);
    assert.equal(none.data.items.length, 0);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('最近：limit 生效', async () => {
  const { env, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    for (let i = 0; i < 5; i += 1) {
      await req('POST', `/api/projects/${env.projectId}/apis`, {
        name: `批量${i}`,
        target_type: 'api',
        method: 'GET',
        url: `https://api.test/bulk${i}`
      });
    }
    const res = await req('GET', `/api/projects/${env.projectId}/recent?kind=saved&limit=3`);
    assert.equal(res.data.items.length, 3);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('最近：历史发送记录（空 → 有记录）', async () => {
  const { env, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});

    const empty = await req('GET', `/api/projects/${env.projectId}/recent?kind=runs`);
    assert.equal(empty.status, 200);
    assert.equal(empty.data.kind, 'runs');
    assert.equal(empty.data.items.length, 0);

    // 直接写一条 run 记录（避免依赖外网）
    const { openShadow } = await import('../src/store/shadow.js');
    const { saveRun } = await import('../src/store/runs.js');
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });
    saveRun(target, {
      run_id: 'run_recent_test',
      project_id: env.projectId,
      source: 'mcp',
      scope: 'flow',
      flow_name: '订单流程',
      environment_id: '1',
      status: 'failed',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      elapsed_ms: 321,
      steps: [
        {
          step_id: 's1',
          target_id: 't1',
          name: '创建订单',
          method: 'POST',
          url: 'https://api.test/orders',
          status: 'failed',
          status_code: 500,
          elapsed_ms: 300,
          error: '服务端错误',
          assertions: [{ name: '状态码 200', passed: false, message: '实际 500' }],
          console: [{ level: 'log', message: 'hello' }],
          request: { body: '{"a":1}' },
          response: { body: '{"error":"boom"}' }
        }
      ]
    });

    const res = await req('GET', `/api/projects/${env.projectId}/recent?kind=runs`);
    assert.equal(res.data.items.length, 1);
    const run = res.data.items[0];
    assert.equal(run.flow_name, '订单流程');
    assert.equal(run.status, 'failed');
    assert.equal(run.total, 1);
    assert.equal(run.failed, 1);

    // 关键字过滤
    const hit = await req('GET', `/api/projects/${env.projectId}/recent?kind=runs&keyword=${encodeURIComponent('订单')}`);
    assert.equal(hit.data.items.length, 1);
    const miss = await req('GET', `/api/projects/${env.projectId}/recent?kind=runs&keyword=zzz`);
    assert.equal(miss.data.items.length, 0);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('最近：run 详情接口', async () => {
  const { env, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    const { openShadow } = await import('../src/store/shadow.js');
    const { saveRun } = await import('../src/store/runs.js');
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });
    saveRun(target, {
      run_id: 'run_detail_test',
      project_id: env.projectId,
      source: 'mcp',
      scope: 'api',
      environment_id: '1',
      status: 'passed',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      elapsed_ms: 12,
      steps: [
        {
          step_id: 's1',
          target_id: 't1',
          name: '健康检查',
          method: 'GET',
          url: 'https://api.test/health',
          status: 'passed',
          status_code: 200,
          elapsed_ms: 10,
          request: { body: '' },
          response: { body: '{"ok":true}' },
          assertions: [],
          console: []
        }
      ]
    });

    const ok = await req('GET', `/api/projects/${env.projectId}/recent/runs?run_id=run_detail_test`);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.run.run_id, 'run_detail_test');
    assert.equal(ok.data.run.steps[0].response.body, '{"ok":true}');

    const missing = await req('GET', `/api/projects/${env.projectId}/recent/runs?run_id=nope`);
    assert.equal(missing.status, 404);

    const noId = await req('GET', `/api/projects/${env.projectId}/recent/runs`);
    assert.equal(noId.status, 400);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('最近：未授权 token 401，未拉取时自动 pull', async () => {
  const { env, instance, base, req } = await boot();
  try {
    // 未拉取状态下直接查最近，应自动拉取后返回
    const res = await req('GET', `/api/projects/${env.projectId}/recent?kind=saved`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.items));

    const noToken = await fetch(`${base}/api/projects/${env.projectId}/recent?kind=saved`);
    assert.equal(noToken.status, 401);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('最近：recent.js 与样式可访问', async () => {
  const { env, instance, base } = await boot();
  try {
    const js = await fetch(`${base}/recent.js`);
    assert.equal(js.status, 200);
    const code = await js.text();
    assert.match(code, /RecentView/);
    assert.match(code, /最近保存/);
    assert.match(code, /历史发送记录/);

    const style = await (await fetch(`${base}/style.css`)).text();
    assert.match(style, /recent-tab/);
    assert.match(style, /recent-empty/);

    const html = await (await fetch(`${base}/?ui=test-ui`)).text();
    assert.match(html, /recent\.js/);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});
