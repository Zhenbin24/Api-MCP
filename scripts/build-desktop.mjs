#!/usr/bin/env node
/**
 * 构建桌面端：esbuild 打包主进程 -> @electron/packager 产出绿色版目录
 *
 * 产物：dist/desktop/ApiMCP-Desktop-win32-x64/ApiMCP-Desktop.exe
 *
 * 用法：
 *   node scripts/build-desktop.mjs                完整构建（需要 Electron 二进制）
 *   node scripts/build-desktop.mjs --bundle-only  只打 bundle，供 electron 直接以开发态运行
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDesktop = path.join(root, 'dist', 'desktop');
const appDir = path.join(distDesktop, 'app');
const APP_NAME = 'ApiMCP-Desktop';
const APP_VERSION = '1.0.0';

const log = (msg) => console.log(`[desktop] ${msg}`);

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function generateWebAssets() {
  return import('node:child_process').then(({ execFileSync }) =>
    execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-assets.mjs')], {
      stdio: 'inherit',
      cwd: root
    })
  );
}

function generateIcon() {
  return import('node:child_process').then(({ execFileSync }) =>
    execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-icon.mjs')], {
      stdio: 'inherit',
      cwd: root
    })
  );
}

async function bundle() {
  const esbuild = await import('esbuild');
  rmrf(appDir);
  fs.mkdirSync(appDir, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'desktop', 'main.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(appDir, 'main.cjs'),
    banner: {
      js: 'const __importMetaUrl = require("url").pathToFileURL(__filename).href;'
    },
    define: {
      'import.meta.url': '__importMetaUrl'
    },
    external: ['electron'],
    minify: false,
    logLevel: 'warning',
    metafile: true
  });

  const size = fs.statSync(path.join(appDir, 'main.cjs')).size;
  log(`bundle 完成: ${(size / 1024).toFixed(1)} KB`);

  // preload 必须保持 cjs 且不打进 bundle（BrowserWindow 的 preload 只接受真实文件路径）
  fs.copyFileSync(path.join(root, 'src', 'desktop', 'preload.cjs'), path.join(appDir, 'preload.cjs'));

  const iconSrc = path.join(root, 'build', 'icon.ico');
  if (fs.existsSync(iconSrc)) {
    fs.copyFileSync(iconSrc, path.join(appDir, 'icon.ico'));
  }

  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'apimcp-desktop',
        productName: 'API MCP 控制台',
        version: APP_VERSION,
        description: 'API MCP 控制台桌面端',
        main: 'main.cjs',
        author: 'API MCP'
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  log(`应用目录就绪: ${path.relative(root, appDir)}`);
}

function electronVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

function readmeText() {
  return `API MCP 控制台（桌面端）v${APP_VERSION}
==============================

双击 ${APP_NAME}.exe 即可打开独立窗口（无地址栏、无标签页）。

分发：必须把整个 ApiMCP-Desktop-win32-x64 目录一起拷贝（约 350MB），
只拿一个 exe 会打不开——Electron 运行时在同目录的 dll 和 locales 里。

一、它和 apimcp.exe 的关系
--------------------------
- 本桌面端自带服务，双击即用，窗口关闭时服务一起退出。
- 如果 apimcp.exe 已经在跑（端口 39100 被占用且 ui_token 一致），
  桌面端会「附着」到已有服务，只开窗口，关闭窗口不影响那边的服务。
- 端口被其它程序占用时会弹窗提示，可用 --port 指定其它端口。

二、首次使用建议顺序
--------------------
1) 先安装并打开一次 API 单机版（Apipost 离线版）。
2) 双击 ${APP_NAME}.exe，窗口直接打开控制台。
3) 「总览」把「运行状态」开关打开（服务默认关闭，关闭时
   HTTP 与 stdio 都会被拒绝，只影响接入、不影响控制台本身）。
4) 确认数据目录探测成功，并勾选要开放给 MCP 的项目。
5) 改完接口保存即写入 API 单机版，重新进入项目即可看到。

三、数据位置（与 apimcp.exe 完全一致）
--------------------------------------
官方数据（读写）：%APPDATA%\\Apipost单机版\\
本软件配置：      %APPDATA%\\ApiMCP\\config.json
窗口位置记忆：    %APPDATA%\\ApiMCP\\desktop-window.json

四、命令行参数
--------------
  ${APP_NAME}.exe                     启动服务 + 打开控制台窗口
  ${APP_NAME}.exe --port 39101        换端口
  ${APP_NAME}.exe --data-root "D:\\\\data"   指定 Apipost 数据目录

五、配到 AI 客户端
------------------
控制台左侧「客户端配置」→ 选客户端 → 复制 → 粘贴，不用手写。
注意那里给的是 apimcp.exe --stdio 的形式（由客户端自己拉起进程），
不需要先双击本桌面端。

六、开发调试
------------
  set APIPOST_MCP_DEV=1
  ${APP_NAME}.exe        # 允许 F12 / Ctrl+Shift+I 打开开发者工具

本软件与 Apipost 官方无隶属关系。
`;
}

async function packageApp() {
  const packager = await import('@electron/packager');
  const version = electronVersion();
  if (!version) {
    throw new Error('未找到 electron，请先 npm install');
  }

  // Electron 二进制默认从 npmmirror 拉取（国内网络更稳），已设置则尊重用户配置
  process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';

  const iconPath = path.join(root, 'build', 'icon.ico');
  log(`开始打包（Electron ${version}）…`);

  const [outDir] = await packager.packager({
    dir: appDir,
    out: distDesktop,
    name: APP_NAME,
    executableName: APP_NAME,
    platform: 'win32',
    arch: 'x64',
    electronVersion: version,
    appVersion: APP_VERSION,
    buildVersion: APP_VERSION,
    asar: true,
    prune: false,
    overwrite: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    extraResource: fs.existsSync(iconPath) ? [iconPath] : [],
    win32metadata: {
      CompanyName: 'API MCP',
      FileDescription: 'API MCP 控制台',
      ProductName: 'API MCP 控制台',
      InternalName: APP_NAME,
      OriginalFilename: `${APP_NAME}.exe`
    },
    quiet: true
  });

  fs.writeFileSync(path.join(outDir, 'README.txt'), readmeText(), 'utf8');

  const exe = path.join(outDir, `${APP_NAME}.exe`);
  if (fs.existsSync(exe)) {
    log(`构建成功: ${path.relative(root, exe)}`);
  } else {
    log(`构建完成: ${path.relative(root, outDir)}`);
  }
  log('提示：整个目录一起分发（Electron 运行时依赖同目录下的 dll/locales 等文件）');
  return outDir;
}

async function main() {
  const bundleOnly = process.argv.includes('--bundle-only');
  await generateWebAssets();
  await generateIcon();
  await bundle();

  if (bundleOnly) {
    log(`已跳过打包，可用: npx electron ${path.relative(root, appDir)}`);
    return;
  }
  await packageApp();
}

main().catch((err) => {
  console.error(`[desktop] 失败: ${err?.stack || err}`);
  process.exit(1);
});
