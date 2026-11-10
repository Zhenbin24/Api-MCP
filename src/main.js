#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, resolveRoots, DEFAULT_PORT } from './server/config.js';
import { createServer } from './server/serve.js';
import { ToolContext } from './mcp/tools.js';
import { startStdioServer } from './mcp/stdio.js';
import { isOfficialRoot, defaultOfficialRoot, ownRoot, configPath } from './store/paths.js';

const VERSION = '1.0.0';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stdio') out.stdio = true;
    else if (arg === '--serve') out.serve = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--open') out.open = true;
    else if (arg === '--no-open') out.open = false;
    else if (arg === '--data-root') out.dataRoot = argv[++i];
    else if (arg.startsWith('--data-root=')) out.dataRoot = arg.split('=').slice(1).join('=');
    else if (arg === '--shadow-root') out.shadowRoot = argv[++i];
    else if (arg.startsWith('--shadow-root=')) out.shadowRoot = arg.split('=').slice(1).join('=');
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) out.port = Number(arg.split('=')[1]);
    else out._.push(arg);
  }
  return out;
}

const HELP = `
API MCP 服务 v${VERSION}

用法:
  apipost-mcp.exe                 启动常驻服务 + Web 控制台（默认打开浏览器）
  apipost-mcp.exe --stdio         作为 stdio MCP 服务运行（供 Cursor / Claude Code 等直接拉起）
  apipost-mcp.exe --serve         仅启动 HTTP 服务（不自动开浏览器）
  apipost-mcp.exe --data-root <dir>   指定 API 单机版数据目录
  apipost-mcp.exe --shadow-root <dir> 指定影子工作区目录
  apipost-mcp.exe --port <n>      指定监听端口（默认 ${DEFAULT_PORT}）
  apipost-mcp.exe --version       显示版本
  apipost-mcp.exe --help          显示帮助

环境变量:
  APIPOST_DATA_ROOT   等同 --data-root
  APIPOST_MCP_HOME    本软件配置目录（默认 %APPDATA%\\ApiPostMCP）
  APIPOST_MCP_CONFIG  配置文件路径
`.trim();

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(`apipost-mcp ${VERSION}`);
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  let config = loadConfig();
  if (args.dataRoot) {
    config.data_root = path.resolve(args.dataRoot);
    saveConfig(config);
  }
  if (args.shadowRoot) {
    config.shadow_root = path.resolve(args.shadowRoot);
    saveConfig(config);
  }

  const { officialRoot, shadowRoot } = resolveRoots(config, {
    dataRoot: args.dataRoot,
    shadowRoot: args.shadowRoot
  });

  // ---- stdio 模式 ----
  if (args.stdio) {
    // 与控制台总开关保持一致：服务停用时 stdio 也不应工作，
    // 否则 Cursor 这类走 --stdio 的客户端会绕过「停用服务」。
    if (config.enabled === false) {
      console.error('[apipost-mcp] MCP 服务已在控制台中停用，stdio 模式不会启动。');
      console.error('[apipost-mcp] 请在控制台「总览」中开启服务后重试。');
      process.exit(2);
    }
    const ctx = new ToolContext({ officialRoot, shadowRoot, config });
    startStdioServer(ctx);
    return;
  }

  // ---- HTTP 模式 ----
  if (!isOfficialRoot(officialRoot)) {
    console.error(`[apipost-mcp] 警告：未在 ${officialRoot} 找到 API 单机版数据。`);
    console.error(`[apipost-mcp] 请先安装并打开 API 单机版，或用 --data-root 指定目录。`);
  }

  fs.mkdirSync(shadowRoot, { recursive: true });

  const instance = createServer({
    config,
    officialRoot,
    shadowRoot,
    log: (msg) => console.log(msg)
  });

  const port = args.port || config.port || DEFAULT_PORT;
  let address;
  try {
    address = await instance.listen(port);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`[apipost-mcp] 端口 ${port} 已被占用。请关闭占用进程，或用 --port 指定其它端口。`);
    } else {
      console.error(`[apipost-mcp] 启动失败：${err.message}`);
    }
    process.exit(1);
  }

  const actualPort = typeof address === 'object' && address ? address.port : port;
  config.port = actualPort;
  saveConfig(config);

  const uiUrl = `http://127.0.0.1:${actualPort}/?ui=${config.ui_token}`;
  console.log('');
  console.log('  API MCP 服务已启动');
  console.log(`  数据目录: ${officialRoot}`);
  console.log(`  影子目录: ${shadowRoot}`);
  console.log(`  控制台  : ${uiUrl}`);
  console.log(`  MCP 端点: http://127.0.0.1:${actualPort}/mcp`);
  console.log(`  Token   : ${config.token}`);
  console.log(`  配置    : ${configPath()}`);
  console.log('');

  if (args.open !== false) openBrowser(uiUrl);

  const shutdown = async () => {
    console.log('\n[apipost-mcp] 正在关闭…');
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`[apipost-mcp] ${err?.stack || err}`);
  process.exit(1);
});
