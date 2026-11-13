import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 数据根：解析优先级、首次初始化、幂等性。
 *
 * 这些函数依赖 process.env.APPDATA / APIMCP_HOME 等环境变量，
 * 每个用例自造临时 APPDATA 并还原，避免写到真实的 %APPDATA%\ApiMCP。
 */

function withTempAppData() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'apimcp-dataroot-'));
  const appData = path.join(base, 'Roaming');
  fs.mkdirSync(appData, { recursive: true });

  const before = {
    APPDATA: process.env.APPDATA,
    APIMCP_HOME: process.env.APIMCP_HOME,
    APIPOST_MCP_HOME: process.env.APIPOST_MCP_HOME,
    APIMCP_DATA_ROOT: process.env.APIMCP_DATA_ROOT,
    APIPOST_DATA_ROOT: process.env.APIPOST_DATA_ROOT
  };
  process.env.APPDATA = appData;
  for (const key of ['APIMCP_HOME', 'APIPOST_MCP_HOME', 'APIMCP_DATA_ROOT', 'APIPOST_DATA_ROOT']) {
    delete process.env[key];
  }

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

/** 每个用例重新导入，避免模块级状态互相影响 */
async function freshPaths(tag) {
  return import(`../src/store/paths.js?t=${Date.now()}-${tag}`);
}

test('数据根：默认指向 %APPDATA%\\ApiMCP\\data，与 Apipost 单机版无关', async () => {
  const env = withTempAppData();
  try {
    // 故意造一个 Apipost 单机版数据目录，回归「以前会误认它」的 bug
    const legacy = path.join(env.appData, 'Apipost单机版');
    fs.mkdirSync(path.join(legacy, 'offline-data'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'offline-projects.json'), '[]');

    const paths = await freshPaths('default');
    assert.equal(paths.defaultDataRoot(), path.join(env.appData, 'ApiMCP', 'data'));
    assert.equal(paths.resolveDataRoot(), path.join(env.appData, 'ApiMCP', 'data'));
    assert.notEqual(
      paths.resolveDataRoot().toLowerCase(),
      legacy.toLowerCase(),
      '不得再自动指向 Apipost 单机版目录'
    );
  } finally {
    env.restore();
  }
});

test('数据根：首次初始化建出骨架，且 meta 与 teams 的 team_id 一致', async () => {
  const env = withTempAppData();
  try {
    const paths = await freshPaths('init');
    const root = paths.ensureDataRoot();

    assert.ok(fs.existsSync(root), '数据根应被创建');
    assert.ok(fs.existsSync(path.join(root, 'offline-data')), '应有 offline-data 目录');
    assert.ok(fs.existsSync(path.join(root, 'offline-data-local')), '应有 offline-data-local 目录');

    const index = JSON.parse(fs.readFileSync(path.join(root, 'offline-projects.json'), 'utf8'));
    assert.deepEqual(index, [], '项目索引初始应为空数组');

    const teams = JSON.parse(fs.readFileSync(path.join(root, 'offline-data-local', 'teams.json'), 'utf8'));
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'offline-data-local', 'meta.json'), 'utf8'));
    assert.ok(Array.isArray(teams) && teams.length >= 1, '应有一个默认团队');
    assert.equal(meta.default_team_id, teams[0].team_id, 'meta 的默认团队必须与 teams 里的一致');
  } finally {
    env.restore();
  }
});

test('数据根：重复初始化是幂等的，不覆盖已有内容', async () => {
  const env = withTempAppData();
  try {
    const paths = await freshPaths('idempotent');
    const root = paths.ensureDataRoot();

    // 写入一些用户内容
    fs.writeFileSync(path.join(root, 'offline-projects.json'), JSON.stringify([{ project_id: 'p1' }]));
    const teamsBefore = fs.readFileSync(path.join(root, 'offline-data-local', 'teams.json'), 'utf8');
    const metaBefore = fs.readFileSync(path.join(root, 'offline-data-local', 'meta.json'), 'utf8');

    paths.ensureDataRoot();

    const index = JSON.parse(fs.readFileSync(path.join(root, 'offline-projects.json'), 'utf8'));
    assert.deepEqual(index, [{ project_id: 'p1' }], '已有项目索引不得被清空');
    assert.equal(fs.readFileSync(path.join(root, 'offline-data-local', 'teams.json'), 'utf8'), teamsBefore);
    assert.equal(fs.readFileSync(path.join(root, 'offline-data-local', 'meta.json'), 'utf8'), metaBefore);
  } finally {
    env.restore();
  }
});

test('数据根：显式参数 > APIMCP_DATA_ROOT > 旧环境变量 > 配置文件 > 默认', async () => {
  const env = withTempAppData();
  try {
    const paths = await freshPaths('priority');
    const explicit = path.join(env.base, 'explicit');
    const fromEnv = path.join(env.base, 'from-env');
    const fromLegacyEnv = path.join(env.base, 'from-legacy-env');
    const fromConfig = path.join(env.base, 'from-config');

    // 配置最低优先级
    assert.equal(paths.resolveDataRoot({ config: { data_root: fromConfig } }), fromConfig);

    // 旧环境变量高于配置
    process.env.APIPOST_DATA_ROOT = fromLegacyEnv;
    assert.equal(paths.resolveDataRoot({ config: { data_root: fromConfig } }), fromLegacyEnv);

    // 新环境变量高于旧环境变量
    process.env.APIMCP_DATA_ROOT = fromEnv;
    assert.equal(paths.resolveDataRoot({ config: { data_root: fromConfig } }), fromEnv);

    // 显式参数最高
    assert.equal(paths.resolveDataRoot({ explicit, config: { data_root: fromConfig } }), explicit);
  } finally {
    env.restore();
  }
});

test('数据根：APIMCP_HOME 让配置与数据一起搬走（绿色便携）', async () => {
  const env = withTempAppData();
  try {
    const portable = path.join(env.base, 'portable');
    process.env.APIMCP_HOME = portable;
    const paths = await freshPaths('portable');

    assert.equal(paths.ownRoot(), portable);
    assert.equal(paths.defaultDataRoot(), path.join(portable, 'data'));
    assert.equal(paths.configPath(), path.join(portable, 'config.json'));

    const root = paths.ensureDataRoot();
    assert.equal(root, path.join(portable, 'data'));
    assert.ok(fs.existsSync(path.join(root, 'offline-projects.json')));
  } finally {
    env.restore();
  }
});

test('数据根：首次初始化播种一个默认项目，且只播种一次', async () => {
  const env = withTempAppData();
  try {
    process.env.APIMCP_HOME = path.join(env.base, 'home');
    fs.mkdirSync(process.env.APIMCP_HOME, { recursive: true });
    const home = process.env.APIMCP_HOME;

    // 首次 resolveRoots：应建出默认项目
    let cfg = await import('../src/server/config.js');
    let roots = cfg.resolveRoots({ data_root: null }, {});
    assert.equal(roots.created, true);

    const projects = await import('../src/store/projects.js');
    let list = projects.listProjects(roots.dataRoot);
    assert.equal(list.length, 1, '首次应播种一个默认项目');
    assert.equal(list[0].name, '默认项目');

    // 项目骨架要完整落地
    const pdir = path.join(roots.dataRoot, 'offline-data', list[0].project_id);
    for (const f of ['project.json', 'apis/index.json', 'envs/index.json', 'global_params.json']) {
      assert.ok(fs.existsSync(path.join(pdir, f)), `默认项目应包含 ${f}`);
    }

    // 再次启动不应重复创建
    roots = cfg.resolveRoots({ data_root: null }, {});
    assert.equal(roots.created, false, '第二次启动不应再算首次初始化');
    assert.equal(projects.listProjects(roots.dataRoot).length, 1, '不应重复播种');

    // 用户删光项目后重启，也不应再凭空出现（只在真正的首次初始化播种）
    projects.deleteProjectDir(roots.dataRoot, list[0].project_id);
    assert.equal(projects.listProjects(roots.dataRoot).length, 0);
    roots = cfg.resolveRoots({ data_root: null }, {});
    assert.equal(projects.listProjects(roots.dataRoot).length, 0, '删光后重启不应再播种');
    assert.ok(home);
  } finally {
    env.restore();
  }
});

test('数据根：canWriteDir 能区分可写与不可写目录', async () => {
  const env = withTempAppData();
  try {
    const paths = await freshPaths('writable');
    const ok = path.join(env.base, 'writable-dir');
    assert.equal(paths.canWriteDir(ok), true, '新建目录应可写');

    // 用一个不存在的盘符构造必然失败的路径（Windows 上不可写）
    const impossible = path.join(env.base, 'probe-file', 'nested');
    fs.writeFileSync(path.join(env.base, 'probe-file'), 'i am a file');
    assert.equal(paths.canWriteDir(impossible), false, '父路径是文件时应判为不可写');

    assert.equal(paths.canWriteDir(''), false, '空路径直接判为不可写');
  } finally {
    env.restore();
  }
});
