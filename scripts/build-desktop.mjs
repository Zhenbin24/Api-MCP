#!/usr/bin/env node
/**
 * 构建桌面端：esbuild 打包主进程 -> @electron/packager 产出绿色版目录
 *
 * 产物：
 *   dist/desktop/ApiMCP-Desktop-win32-x64/ApiMCP-Desktop.exe
 *   dist/desktop/ApiMCP-Desktop-win32-x64/apimcp.exe（从 dist 复制，供 AI 客户端走 stdio）
 *   dist/desktop/ApiMCP-Desktop-win32-x64.zip（整个目录的压缩包，可直接分发）
 *
 * 用法：
 *   node scripts/build-desktop.mjs                完整构建（需要 Electron 二进制）
 *   node scripts/build-desktop.mjs --bundle-only  只打 bundle，供 electron 直接以开发态运行
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDesktop = path.join(root, 'dist', 'desktop');
const appDir = path.join(distDesktop, 'app');
const APP_NAME = 'ApiMCP-Desktop';
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

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
本软件是独立的本地工具，自带数据目录，不需要安装任何其它软件。

分发：必须把整个 ApiMCP-Desktop-win32-x64 目录一起拷贝（约 360MB），
只拿一个 exe 会打不开——Electron 运行时在同目录的 dll 和 locales 里。
目录内已经附带 apimcp.exe，配 AI 客户端时直接用它。

一、目录里有什么
----------------
${APP_NAME}.exe      桌面端窗口（自带服务，双击即用）
apimcp.exe           命令行 / stdio 版（给 AI 客户端做 MCP 服务）
README.txt           本文件
dll / locales / ...  Electron 运行时，必须一起拷

二、首次使用建议顺序
--------------------
1) 双击 ${APP_NAME}.exe，窗口直接打开控制台（首次会自动创建数据目录，
   并建好一个「默认项目」，打开就能直接写接口）。
2) 「总览」把「运行状态」开关打开（服务默认关闭，关闭时
   HTTP 与 stdio 都会被拒绝，只影响接入、不影响控制台本身）。
3) 改完接口保存即时生效，无需任何同步动作。
4) 「默认项目」可改名或删除，也可在「总览」用「新建项目」建更多。

三、数据位置（与 apimcp.exe 完全一致）
--------------------------------------
数据目录：  %APPDATA%\\ApiMCP\\data\\
本软件配置：%APPDATA%\\ApiMCP\\config.json
窗口位置记忆：%APPDATA%\\ApiMCP\\desktop-window.json

想做成绿色版（数据跟着文件夹走）：启动前设置环境变量
  set APIMCP_HOME=<你的目录>

四、命令行参数
--------------
  ${APP_NAME}.exe                     启动服务 + 打开控制台窗口
  ${APP_NAME}.exe --port 39101        换端口
  ${APP_NAME}.exe --data-root "D:\\\\data"   指定数据目录

五、配到 AI 客户端
------------------
控制台左侧「客户端配置」→ 选客户端 → 复制 → 粘贴，不用手写。
自动填好的命令是本目录下的 apimcp.exe --stdio（由客户端自己拉起进程），
不需要先双击本桌面端。

六、开发调试
------------
  set APIPOST_MCP_DEV=1
  ${APP_NAME}.exe        # 允许 F12 / Ctrl+Shift+I 打开开发者工具
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

  // 把 dist/apimcp.exe 一起放进来，这样整个目录（或 zip）可直接发给别人
  const cliExe = path.join(root, 'dist', 'apimcp.exe');
  if (fs.existsSync(cliExe)) {
    fs.copyFileSync(cliExe, path.join(outDir, 'apimcp.exe'));
    log(`已附带 apimcp.exe（${(fs.statSync(cliExe).size / 1024 / 1024).toFixed(0)} MB）`);
  } else {
    log('警告：未找到 dist/apimcp.exe，桌面端目录将缺少 stdio 版；请先运行 npm run build');
  }

  const exe = path.join(outDir, `${APP_NAME}.exe`);
  if (fs.existsSync(exe)) {
    log(`构建成功: ${path.relative(root, exe)}`);
  } else {
    log(`构建完成: ${path.relative(root, outDir)}`);
  }

  await zipOutput(outDir);
  log('提示：整个目录一起分发（Electron 运行时依赖同目录下的 dll/locales 等文件）');
  return outDir;
}

/** 打成同名 zip，便于一次发出去（Windows 上没有内置 zip 库，走 PowerShell） */
function zipOutput(outDir) {
  if (process.platform !== 'win32') {
    log('非 Windows 平台，跳过 zip 打包');
    return;
  }
  const zipPath = `${outDir}.zip`;
  try {
    fs.rmSync(zipPath, { force: true });
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${outDir}' -DestinationPath '${zipPath}' -Force`
      ],
      { stdio: 'inherit' }
    );
    log(`已生成 ${path.relative(root, zipPath)}（${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(0)} MB）`);
  } catch (err) {
    log(`zip 打包失败（目录本身仍可直接分发）：${err?.message || err}`);
  }
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
