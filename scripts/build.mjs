#!/usr/bin/env node
/**
 * 打包：esbuild 单文件 bundle -> Node SEA (single executable application) -> dist/apimcp.exe
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
所有改动直接写入 Apipost 官方数据目录，无需手动同步。

一、直接双击运行
----------------
  apimcp.exe
会自动启动本地服务（默认 http://127.0.0.1:39100）并在浏览器里打开控制台。

启动后终端会打印这几行，其中「控制台」那一行的 ?ui=<token> 就是入口，
token 不能漏（没有它打不开控制台）：

  API MCP 服务已启动
  数据目录: C:\\Users\\<你>\\AppData\\Roaming\\Apipost单机版
  控制台  : http://127.0.0.1:39100/?ui=xxxxxxxx
  MCP 端点: http://127.0.0.1:39100/mcp
  Token   : xxxxxxxx

注意：这是一个前台进程，黑框关了服务就停了。想常驻见第六节。

二、首次使用建议顺序
--------------------
1) 先安装并打开一次 API 单机版（Apipost 离线版），让数据落到
   %APPDATA%\\Apipost单机版\\ ；数据不在默认位置时用 --data-root 指定。
2) 双击 apimcp.exe，浏览器会自动打开控制台。
3) 控制台「总览」把「运行状态」开关打开（服务默认关闭，
   关闭时 HTTP 与 stdio 都会被拒绝，只影响接入、不影响控制台本身）。
4) 确认数据目录探测成功。
5) 勾选要开放给 MCP 的项目，然后就可以开始编辑。
6) 改完接口保存即写入 API 单机版，重新进入项目即可看到。

三、想要独立窗口（桌面端）
--------------------------
  dist\\desktop\\ApiMCP-Desktop-win32-x64\\ApiMCP-Desktop.exe
双击即用，无地址栏无标签页，关窗口等于关这个软件。
分发时必须整个目录一起拷（约 350MB，Electron 运行时在同目录的 dll 和 locales 里）。

它和本 exe 的关系：
  39100 端口空闲        → 桌面端自己起服务，关窗口即停服务
  本 exe 已在跑         → 自动「附着」，只开窗口，关窗口不影响那边
  端口被别的程序占用    → 弹窗提示，用 --port 换端口
两者数据完全共享，也可以同时用。

四、配置到 AI 客户端
--------------------
不用手写：打开控制台 → 左侧「客户端配置」→ 选你的客户端 → 复制 → 粘贴。
支持 Cursor / Claude Code / VS Code / Trae / Codex。

Cursor 的位置：%USERPROFILE%\\.cursor\\mcp.json

命令形式（stdio 模式，由客户端自己拉起，不需要先双击 exe）：
  "command": "D:\\\\path\\\\to\\\\apimcp.exe",
  "args": ["--stdio"]

command 必须写绝对路径；改完要重启客户端。

五、常用命令
------------
  apimcp.exe                           起服务 + 打开浏览器
  apimcp.exe --stdio                   作为 stdio MCP 服务运行
  apimcp.exe --serve                   只启动 HTTP 服务，不打开浏览器
  apimcp.exe --no-open                 不自动开浏览器，其余同无参数
  apimcp.exe --data-root "D:\\data"    指定 Apipost 数据目录
  apimcp.exe --port 39101              换端口
  apimcp.exe --version                 显示版本
  apimcp.exe --help                    查看帮助

桌面端（需另行构建）：
  npm run build:desktop                     产出独立窗口版（Electron）
  npm run dev:desktop                       免打包直接调试桌面端

六、数据在哪（重要）
---------------------
官方数据（读写）：%APPDATA%\\Apipost单机版\\
本软件配置：      %APPDATA%\\ApiMCP\\config.json

- AI 与控制器件的所有改动都直接写入 Apipost 官方目录，不经过中间层
- 保存后重新进入 API 单机版的项目即可看到改动
- 不需要手动「拉取 / 推送」

七、开机自启（可选）
--------------------
Win+R 输入 shell:startup，把 apimcp.exe 的快捷方式放进去。
快捷方式属性里把「运行方式」设为最小化，避免黑框常驻。
建议再给它加 --serve 参数，这样开机只起服务、不弹浏览器。

八、常见问题
------------
双击后没反应 / 一闪而过
  netstat -ano | findstr :39100 看端口是否被占。被同款服务占着属正常，
  被别的程序占了就换端口启动。

控制台提示没有 token / 打不开
  地址必须带 ?ui=<token>。token 在启动时的终端输出里，也能在
  %APPDATA%\\ApiMCP\\config.json 的 ui_token 字段找到。

显示「未找到 API 单机版数据目录」
  先安装并打开一次 API 单机版；数据不在默认位置时用 --data-root 指定，
  或在控制台「外观设置 → 数据目录」里填。

改了接口但 API 单机版里没变
  多半是 API 单机版没重新进入该项目。关掉项目重开一次即可。

九、说明
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
  const outExe = path.join(dist, 'apimcp.exe');
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
