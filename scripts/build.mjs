#!/usr/bin/env node
/**
 * 打包：esbuild 单文件 bundle -> Node SEA (single executable application) -> dist/apipost-mcp.exe
 *
 * 步骤：
 *  1. esbuild 把 src/main.js 及其依赖打成 dist/bundle.cjs（web 资源以字符串内联）
 *  2. 用 node --experimental-sea-config 生成 SEA blob
 *  3. 复制 node.exe，postject 注入 blob + 资源
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const build = path.join(dist, 'build');

const log = (msg) => console.log(`[build] ${msg}`);

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

/** 把 web 静态资源内联成一个 JS 模块 */
function generateWebAssets() {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-assets.mjs')], { stdio: 'inherit', cwd: root });
}

async function bundle() {
  const esbuild = await import('esbuild');
  fs.mkdirSync(dist, { recursive: true });

  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'main.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(dist, 'apipost-mcp.cjs'),
    // SEA 的 CJS 入口不支持 shebang，这里用一行注释代替
    banner: {
      js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;'
    },
    define: {
      'import.meta.url': '__importMetaUrl'
    },
    external: [],
    minify: false,
    logLevel: 'warning',
    metafile: true
  });

  const size = fs.statSync(path.join(dist, 'apipost-mcp.cjs')).size;
  log(`bundle 完成: ${(size / 1024).toFixed(1)} KB`);
  return path.join(dist, 'apipost-mcp.cjs');
}

function makeSeaConfig(bundlePath) {
  const config = {
    main: bundlePath,
    output: path.join(build, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
  };
  const configPath = path.join(build, 'sea-config.json');
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log('生成 sea-config.json');
  return configPath;
}

function generateBlob(configPath) {
  execFileSync(process.execPath, ['--experimental-sea-config', configPath], {
    stdio: 'inherit',
    cwd: root
  });
  const blob = path.join(build, 'sea-prep.blob');
  const size = fs.statSync(blob).size;
  log(`SEA blob 生成: ${(size / 1024 / 1024).toFixed(1)} MB`);
  return blob;
}

async function inject({ blob, outExe }) {
  fs.copyFileSync(process.execPath, outExe);
  log(`复制 node.exe -> ${path.basename(outExe)}`);

  const postject = await import('postject');
  await postject.default.inject(outExe, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: undefined
  });
  log('注入 NODE_SEA_BLOB 完成');
}

function writeReadme() {
  const text = `API MCP v1.0.0
==================

一个兼容 Apipost 单机版 30 个 MCP 工具的本地服务（Windows）。
官方数据目录只读，所有改动先落在影子工作区，确认后手动推送。

一、直接双击运行
----------------
  apipost-mcp.exe
会自动启动本地服务（http://127.0.0.1:39100）并在浏览器里打开控制台。

想要独立窗口（不再占用浏览器标签页）？请用 npm run build:desktop 构建桌面端
（dist\\desktop\\ApiPostMCP-Desktop-win32-x64\\ApiPostMCP-Desktop.exe），
桌面端自带服务，也可附着到本 exe 已启动的服务上。两种方式数据完全共享。

二、配置到 AI 客户端
--------------------
1) 打开控制台 → 「客户端配置」
2) 选 Cursor / Claude Code / VS Code / Trae / Codex，复制配置
3) 粘到对应客户端配置文件里，重启客户端

Cursor 的位置：%USERPROFILE%\\.cursor\\mcp.json

命令形式（stdio 模式，推荐）：
  "command": "D:\\\\path\\\\to\\\\apipost-mcp.exe",
  "args": ["--stdio"]

三、数据在哪
------------
官方数据（只读）：%APPDATA%\\Apipost单机版\\
影子工作区：      %APPDATA%\\ApiPostMCP\\workspace\\
本软件配置：      %APPDATA%\\ApiPostMCP\\config.json

四、常用命令
------------
  apipost-mcp.exe --stdio                   作为 stdio MCP 服务运行
  apipost-mcp.exe --serve                   只启动 HTTP 服务，不打开浏览器
  apipost-mcp.exe --data-root "D:\\data"    指定 Apipost 数据目录
  apipost-mcp.exe --shadow-root "D:\\sh"    指定影子目录
  apipost-mcp.exe --port 39101              换端口
  apipost-mcp.exe --help                    查看帮助

  桌面端（需另行构建）：
  npm run build:desktop                     产出独立窗口版（Electron）
  npm run dev:desktop                       免打包直接调试桌面端

五、同步模型（重要）
--------------------
- Agent 的所有写入只落在影子工作区，不会改到 Apipost
- 改完后到控制台「项目与同步」点「推送」，Apipost 单机版才能看到
- Apipost 里改了东西，点「拉取」同步到影子
- 两侧都改会标为「有冲突」，需逐文件选择保留哪一侧

六、开机自启（可选）
--------------------
Win+R 输入 shell:startup，把 apipost-mcp.exe 的快捷方式放进去。
快捷方式属性里把「运行方式」设为最小化，避免黑框常驻。

七、说明
--------
本软件与 Apipost 官方无隶属关系，仅按官方 MCP 工具语义操作你本机的
Apipost 单机版项目数据。
`;
  const target = path.join(dist, 'README.txt');
  fs.writeFileSync(target, text, 'utf8');
  log('生成 README.txt');
}

async function main() {
  const skipSea = process.argv.includes('--no-sea');

  rmrf(build);
  fs.mkdirSync(build, { recursive: true });

  generateWebAssets();
  const bundlePath = await bundle();
  writeReadme();

  if (skipSea) {
    log('已跳过 SEA 打包（--no-sea）');
    return;
  }

  const configPath = makeSeaConfig(bundlePath);
  const blob = generateBlob(configPath);
  const outExe = path.join(dist, 'apipost-mcp.exe');
  await inject({ blob, outExe });

  // 清理中间产物
  rmrf(build);

  const size = fs.statSync(outExe).size;
  log('');
  log('=========================================');
  log(` 构建成功: ${outExe}`);
  log(` 体积: ${(size / 1024 / 1024).toFixed(1)} MB`);
  log('=========================================');
}

main().catch((err) => {
  console.error(`[build] 失败: ${err?.stack || err}`);
  process.exit(1);
});
