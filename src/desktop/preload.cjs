/* 桌面端 preload：只暴露最小能力给页面，保持 contextIsolation + sandbox */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apipostShell', {
  isDesktop: true,
  platform: process.platform,
  /** 让原生标题栏按钮区跟随控制台主题 */
  setTitleBarColors(payload) {
    if (!payload || typeof payload !== 'object') return;
    const { color, symbolColor } = payload;
    if (typeof color !== 'string' || typeof symbolColor !== 'string') return;
    ipcRenderer.send('shell:titlebar', { color, symbolColor });
  }
});
