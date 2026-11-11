import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTempRoot, cleanup } from './helpers.mjs';
import { createServer } from '../src/server/serve.js';
import { defaultConfig } from '../src/server/config.js';
import { startOrAttach, probeService, PortInUseError } from '../src/desktop/service-manager.js';
import { sanitizeWindowState, DEFAULT_WINDOW } from '../src/desktop/window-state.js';

function bootConfig(env, overrides = {}) {
  return {
    ...defaultConfig(),
    enabled: true,
    token: 'test-token',
    ui_token: 'test-ui-token',
    port: 0,
    data_root: env.root,
    allowed_project_ids: [],
    ...overrides
  };
}

/** 起一个什么都不做的监听，用来占住端口 */
async function occupy(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('service-manager：端口空闲时以 owned 模式启动并能关闭', async () => {
  const env = makeTempRoot();
  const config = bootConfig(env);
  let service = null;
  try {
    service = await startOrAttach({
      config,
      officialRoot: env.root,
      port: 0,
      createServer: () => createServer({ config, officialRoot: env.root })
    });

    assert.equal(service.mode, 'owned');
    assert.ok(service.port > 0);
    assert.equal(config.port, service.port, 'owned 模式下应把实际端口写回 config');
    assert.match(service.uiUrl, new RegExp(`^http://127\\.0\\.0\\.1:${service.port}/\\?ui=test-ui-token$`));

    // 端口真的在监听
    const res = await fetch(`http://127.0.0.1:${service.port}/api/status`, {
      headers: { 'X-UI-Token': 'test-ui-token' }
    });
    assert.equal(res.status, 200);

    const port = service.port;
    await service.close();
    service = null;
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`), '关闭后端口应释放');
  } finally {
    if (service) await service.close();
    cleanup(env.base);
  }
});

test('service-manager：端口已被同款服务占用时附着，不关闭对方服务', async () => {
  const env = makeTempRoot();
  const ownerConfig = bootConfig(env);
  const owner = createServer({ config: ownerConfig, officialRoot: env.root });
  const address = await owner.listen(0);
  const port = address.port;

  // 第二个实例用同一份 ui_token 去启动，应当附着
  const config = bootConfig(env);
  let service = null;
  try {
    service = await startOrAttach({
      config,
      officialRoot: env.root,
      port,
      createServer: () => createServer({ config, officialRoot: env.root })
    });

    assert.equal(service.mode, 'attached');
    assert.equal(service.port, port);
    assert.equal(service.instance, null);
    assert.match(service.uiUrl, new RegExp(`127\\.0\\.0\\.1:${port}`));

    // 关闭附着实例不应影响原服务
    await service.close();
    service = null;
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { 'X-UI-Token': 'test-ui-token' }
    });
    assert.equal(res.status, 200, '附着模式关闭后，原服务应继续可用');
  } finally {
    if (service) await service.close();
    await owner.close();
    cleanup(env.base);
  }
});

test('service-manager：端口被别的程序占用时抛 PortInUseError', async () => {
  const env = makeTempRoot();
  const occupied = await occupy((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not ours' }));
  });

  const config = bootConfig(env);
  try {
    const err = await startOrAttach({
      config,
      officialRoot: env.root,
      port: occupied.port,
      createServer: () => createServer({ config, officialRoot: env.root })
    }).then(
      () => null,
      (e) => e
    );

    assert.ok(err, '占用端口不是本服务时应抛错');
    assert.ok(err instanceof PortInUseError, `期望 PortInUseError，实际 ${err && err.name}`);
    assert.equal(err.code, 'PORT_IN_USE');
    assert.equal(err.port, occupied.port);
    assert.match(err.message, /已被其它程序占用/);
  } finally {
    await occupied.close();
    cleanup(env.base);
  }
});

test('probeService：能区分本服务、异类服务与空端口', async () => {
  const ours = await occupy((req, res) => {
    if (req.url?.startsWith('/api/status') && req.headers['x-ui-token'] === 'good') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tool_count: 30, port: 1 }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'UI token 无效' }));
  });
  const other = await occupy((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>some other app</html>');
  });

  try {
    assert.equal(await probeService({ port: ours.port, uiToken: 'good' }), true);
    assert.equal(await probeService({ port: ours.port, uiToken: 'bad' }), false);
    assert.equal(await probeService({ port: other.port, uiToken: 'good' }), false);
    assert.equal(await probeService({ port: 0, uiToken: 'good' }), false);

    // 已经关掉的端口：探测应超时/拒绝而不是抛错
    const closed = await occupy(() => {});
    const closedPort = closed.port;
    await closed.close();
    assert.equal(await probeService({ port: closedPort, uiToken: 'good', timeoutMs: 500 }), false);
  } finally {
    await ours.close();
    await other.close();
  }
});

test('window-state：越界坐标被丢弃，尺寸被收敛到合法区间', () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  // 完全落在屏幕内的坐标保留
  const inside = sanitizeWindowState({ x: 100, y: 80, width: 1200, height: 800, maximized: false }, screens);
  assert.deepEqual(inside, { width: 1200, height: 800, maximized: false, x: 100, y: 80 });

  // 拔掉副屏后的离线坐标被丢弃，只保留尺寸
  const offline = sanitizeWindowState({ x: 3000, y: 200, width: 1200, height: 800 }, screens);
  assert.equal(offline.x, undefined);
  assert.equal(offline.y, undefined);
  assert.equal(offline.width, 1200);

  // 过小的尺寸被抬到最小尺寸
  const tiny = sanitizeWindowState({ width: 100, height: 50 }, screens);
  assert.equal(tiny.width, DEFAULT_WINDOW.minWidth);
  assert.equal(tiny.height, DEFAULT_WINDOW.minHeight);

  // 脏数据直接丢弃
  assert.equal(sanitizeWindowState(null, screens), null);
  assert.equal(sanitizeWindowState('nope', screens), null);

  // 默认尺寸兜底
  const empty = sanitizeWindowState({}, screens);
  assert.equal(empty.width, DEFAULT_WINDOW.width);
  assert.equal(empty.height, DEFAULT_WINDOW.height);
  assert.equal(empty.maximized, false);
});
