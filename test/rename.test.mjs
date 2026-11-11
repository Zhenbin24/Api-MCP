import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 配置目录迁移：%APPDATA%\ApiPostMCP → %APPDATA%\ApiMCP
 *
 * 这些函数依赖 process.env.APPDATA，所以每个用例都自己造一个临时 APPDATA，
 * 并在结束后还原环境变量（模块级缓存靠动态 import + 缓存破坏处理）。
 */

/** 造一个临时 APPDATA，返回 {base, appData, 还原函数} */
function withTempAppData() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apimcp-rename-'));
  const appData = path.join(base, 'Roaming');
  fs.mkdirSync(appData, { recursive: true });

  const before = {
    APPDATA: process.env.APPDATA,
    APIMCP_HOME: process.env.APIMCP_HOME,
    APIPOST_MCP_HOME: process.env.APIPOST_MCP_HOME,
    APIMCP_CONFIG: process.env.APIMCP_CONFIG,
    APIPOST_MCP_CONFIG: process.env.APIPOST_MCP_CONFIG
  };
  process.env.APPDATA = appData;
  delete process.env.APIMCP_HOME;
  delete process.env.APIPOST_MCP_HOME;
  delete process.env.APIMCP_CONFIG;
  delete process.env.APIPOST_MCP_CONFIG;

  return {
    base,
    appData,
    restore() {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {}
    }
  };
}

test('迁移：旧目录的 config.json 与 desktop-window.json 被复制到新目录', async () => {
  const env = withTempAppData();
  try {
    const legacy = path.join(env.appData, 'ApiPostMCP');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ token: 'old-token', ui_token: 'old-ui' }));
    fs.writeFileSync(path.join(legacy, 'desktop-window.json'), JSON.stringify({ width: 1000, height: 700 }));
    // 旧目录里的 workspace 不应被带走
    fs.mkdirSync(path.join(legacy, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'workspace', 'leftover.json'), '{}');

    // 每个用例重新导入，避免 APP 目录被上一条用例的结果影响
    const paths = await import(`../src/store/paths.js?t=${Date.now()}`);
    assert.equal(paths.ownRoot(), path.join(env.appData, 'ApiMCP'));

    const result = paths.migrateLegacyOwnRoot();
    assert.equal(result.migrated, true);

    const newRoot = path.join(env.appData, 'ApiMCP');
    assert.ok(fs.existsSync(path.join(newRoot, 'config.json')), 'config.json 应被迁移');
    assert.ok(fs.existsSync(path.join(newRoot, 'desktop-window.json')), 'desktop-window.json 应被迁移');
    assert.ok(!fs.existsSync(path.join(newRoot, 'workspace')), 'workspace 不应被迁移');

    // token 等身份信息保住，客户端配置不用重做
    const migrated = JSON.parse(fs.readFileSync(path.join(newRoot, 'config.json'), 'utf8'));
    assert.equal(migrated.token, 'old-token');
    assert.equal(migrated.ui_token, 'old-ui');

    // 旧目录保持原样（是否删除由使用者决定）
    assert.ok(fs.existsSync(path.join(legacy, 'config.json')));
  } finally {
    env.restore();
  }
});

test('迁移：新目录已存在时不覆盖', async () => {
  const env = withTempAppData();
  try {
    const legacy = path.join(env.appData, 'ApiPostMCP');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ token: 'old-token' }));

    const current = path.join(env.appData, 'ApiMCP');
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'config.json'), JSON.stringify({ token: 'new-token' }));

    const paths = await import(`../src/store/paths.js?t=${Date.now()}-b`);
    const result = paths.migrateLegacyOwnRoot();
    assert.equal(result.migrated, false);

    const kept = JSON.parse(fs.readFileSync(path.join(current, 'config.json'), 'utf8'));
    assert.equal(kept.token, 'new-token', '已存在的新配置不应被旧配置覆盖');
  } finally {
    env.restore();
  }
});

test('迁移：显式指定 APIMCP_HOME 时完全不碰默认目录', async () => {
  const env = withTempAppData();
  try {
    const legacy = path.join(env.appData, 'ApiPostMCP');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ token: 'old-token' }));

    const custom = path.join(env.base, 'custom-home');
    process.env.APIMCP_HOME = custom;

    const paths = await import(`../src/store/paths.js?t=${Date.now()}-c`);
    assert.equal(paths.ownRoot(), custom);

    const result = paths.migrateLegacyOwnRoot();
    assert.equal(result.migrated, false);
    assert.ok(!fs.existsSync(path.join(env.appData, 'ApiMCP')), '不应创建默认目录');
    assert.ok(!fs.existsSync(custom), '不应往自定义目录写东西');
  } finally {
    env.restore();
  }
});

test('迁移：只有旧目录时也不会凭空造新目录（旧目录不存在）', async () => {
  const env = withTempAppData();
  try {
    const paths = await import(`../src/store/paths.js?t=${Date.now()}-d`);
    const result = paths.migrateLegacyOwnRoot();
    assert.equal(result.migrated, false);
    assert.ok(!fs.existsSync(path.join(env.appData, 'ApiMCP')));
  } finally {
    env.restore();
  }
});

test('迁移：环境变量新旧名都认，且新名优先', async () => {
  const env = withTempAppData();
  try {
    process.env.APIPOST_MCP_HOME = path.join(env.base, 'legacy-env');
    let paths = await import(`../src/store/paths.js?t=${Date.now()}-e`);
    assert.equal(paths.ownRoot(), path.join(env.base, 'legacy-env'), '旧环境变量应继续可用');

    process.env.APIMCP_HOME = path.join(env.base, 'new-env');
    paths = await import(`../src/store/paths.js?t=${Date.now()}-f`);
    assert.equal(paths.ownRoot(), path.join(env.base, 'new-env'), '新环境变量优先');
  } finally {
    env.restore();
  }
});
