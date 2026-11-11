/**
 * API MCP 桌面端（Electron 主进程）
 *
 * 双击即开独立窗口，窗口内是现有控制台 UI；服务跑在本进程内。
 * 若端口已被常驻的 apimcp.exe 占用且 ui_token 校验通过，则附着模式只开窗口。
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } from 'electron';
import { loadConfig, saveConfig, resolveRoots, DEFAULT_PORT } from '../server/config.js';
import { createServer } from '../server/serve.js';
import { isOfficialRoot } from '../store/paths.js';
import { startOrAttach, PortInUseError } from './service-manager.js';
import { DEFAULT_WINDOW, loadWindowState, saveWindowState } from './window-state.js';

const APP_NAME = 'API MCP';
const APP_ID = 'com.apimcp.desktop';

/**
 * 允许页面使用的 Web 权限。
 * 只放行剪贴板写入：控制台的「复制 URL / 复制响应 / 复制为 cURL」等按钮
 * 依赖 navigator.clipboard.writeText()，它对应的是 clipboard-sanitized-write。
 * 其余权限（摄像头、地理、通知等）一律拒绝。
 */
const ALLOWED_WEB_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/** 顶栏高度，与 web/style.css 的 .topbar height 保持一致 */
const TITLEBAR_HEIGHT = 52;
const TITLEBAR_BG = '#f4eddf';
const TITLEBAR_FG = '#2c2214';

const log = (msg) => console.log(msg);
const isDev = process.env.APIPOST_MCP_DEV === '1';

let mainWindow = null;
let service = null;
let quitting = false;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-root') out.dataRoot = argv[++i];
    else if (arg.startsWith('--data-root=')) out.dataRoot = arg.slice('--data-root='.length);
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length));
  }
  return out;
}

/** 打包后图标在 resources 下；开发态可能不存在，逐个尝试 */
function resolveIcon() {
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(app.getAppPath(), 'icon.ico'),
    path.join(app.getAppPath(), '..', 'icon.ico')
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return undefined;
}

function screenWorkAreas() {
  try {
    return screen.getAllDisplays().map((d) => d.workArea);
  } catch {
    return [];
  }
}

function isLocalUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function wireNavigationGuards(win) {
  // 站内链接留在窗口，站外链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) return { action: 'allow' };
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isLocalUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();

    // 刷新
    if ((input.control || input.meta) && key === 'r') {
      event.preventDefault();
      win.webContents.reload();
      return;
    }
    if (key === 'f5') {
      event.preventDefault();
      win.webContents.reload();
      return;
    }
    // 开发者工具：仅开发模式
    if (isDev && (key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i'))) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  // 右键菜单：只保留编辑类操作
  win.webContents.on('context-menu', (_event, params) => {
    const template = [];
    if (params.isEditable) {
      template.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy', label: '复制' });
    }
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function createWindow(uiUrl) {
  const workAreas = screenWorkAreas();
  const saved = loadWindowState({ workAreas }) || {};

  const win = new BrowserWindow({
    width: saved.width || DEFAULT_WINDOW.width,
    height: saved.height || DEFAULT_WINDOW.height,
    x: saved.x,
    y: saved.y,
    minWidth: DEFAULT_WINDOW.minWidth,
    minHeight: DEFAULT_WINDOW.minHeight,
    backgroundColor: '#faf5ea',
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    // 顶栏即标题栏：隐藏原生标题栏，只保留右上角窗口按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLEBAR_BG,
      symbolColor: TITLEBAR_FG,
      height: TITLEBAR_HEIGHT
    },
    icon: resolveIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  wireNavigationGuards(win);

  if (saved.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());

  const persist = () => {
    if (win.isDestroyed()) return;
    const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    saveWindowState(
      { ...bounds, maximized: win.isMaximized() },
      { workAreas: screenWorkAreas() }
    );
  };

  let saveTimer = null;
  const persistSoon = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  };
  win.on('resize', persistSoon);
  win.on('move', persistSoon);
  win.on('maximize', persistSoon);
  win.on('unmaximize', persistSoon);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    persist();
  });

  win.loadURL(uiUrl);
  return win;
}

function registerIpc() {
  ipcMain.on('shell:titlebar', (event, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { color, symbolColor } = payload;
    if (typeof color !== 'string' || typeof symbolColor !== 'string') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
    } catch {}
  });

  // binary Body 选文件：返回绝对路径，供后端读取
  ipcMain.handle('shell:pick-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win || mainWindow, {
      title: '选择要上传的文件',
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    return { path: filePath, name: path.basename(filePath) };
  });
}

async function boot() {
  const args = parseArgs(process.argv.slice(1));

  let config = loadConfig();
  if (args.dataRoot) {
    config.data_root = path.resolve(args.dataRoot);
    config = saveConfig(config);
  }

  const { officialRoot } = resolveRoots(config, { dataRoot: args.dataRoot });

  if (!isOfficialRoot(officialRoot)) {
    log(`[desktop] 未在 ${officialRoot} 找到 API 单机版数据，可在控制台「总览」里指定。`);
  }

  const port = Number.isFinite(args.port) && args.port > 0 ? args.port : config.port || DEFAULT_PORT;

  let attached = null;
  try {
    attached = await startOrAttach({
      config,
      officialRoot,
      port,
      createServer: () => createServer({ config, officialRoot, log }),
      log
    });
  } catch (err) {
    const message =
      err instanceof PortInUseError
        ? err.message
        : `启动服务失败：${err?.message || err}`;
    // showMessageBoxSync 会同步阻塞到用户点「确定」，避免对话框一闪而过
    try {
      dialog.showMessageBoxSync({
        type: 'error',
        title: `${APP_NAME} 启动失败`,
        message: `${APP_NAME} 启动失败`,
        detail: message,
        buttons: ['确定'],
        noLink: true
      });
    } catch {
      dialog.showErrorBox(`${APP_NAME} 启动失败`, message);
    }
    app.exit(1);
    return;
  }

  service = attached;
  if (attached.mode === 'owned') saveConfig(config);

  registerIpc();
  mainWindow = createWindow(attached.uiUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!quitting) app.quit();
  });
}

// ---- 单实例 ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.setAppUserModelId(APP_ID);
  app.setName(APP_NAME);
  Menu.setApplicationMenu(null);

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isLocalUrl(url)) return { action: 'allow' };
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
  });

  app.whenReady().then(async () => {
    try {
      // 请求式权限：只放行剪贴板写入
      session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
        callback(ALLOWED_WEB_PERMISSIONS.has(permission))
      );
      // 同步查询式权限：异步剪贴板写入会先过这里，不放行同样会被拒
      session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
        ALLOWED_WEB_PERMISSIONS.has(permission)
      );
    } catch {}

    try {
      await boot();
    } catch (err) {
      dialog.showErrorBox(`${APP_NAME} 启动失败`, String(err?.stack || err));
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (service) {
      const closing = service.close();
      service = null;
      void closing;
    }
  });
}
