/**
 * 桌面端服务生命周期管理（纯 Node，不依赖 Electron，便于单测）。
 *
 * 两种模式：
 *  - owned    桌面端自己监听端口，启动内置服务；窗口关闭时一并关闭服务。
 *  - attached 端口已被同款服务占用（通常是常驻的 apimcp.exe），
 *             用同样的 ui_token 校验通过后只开窗口，不接管、不关闭对方的服务。
 */

/** 端口被占用 */
export class PortInUseError extends Error {
  constructor(port, reason = '') {
    super(
      `端口 ${port} 已被其它程序占用${reason ? `（${reason}）` : ''}。` +
        `请关闭占用进程，或用 --port 指定其它端口。`
    );
    this.name = 'PortInUseError';
    this.code = 'PORT_IN_USE';
    this.port = port;
    this.reason = reason;
  }
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * 探测端口上是否已有可用的 API MCP 服务。
 * 判定标准：/api/status 用 ui_token 校验通过（200），说明是我们自己的控制台服务。
 *
 * @returns {Promise<boolean>}
 */
export async function probeService({ port, uiToken, host = '127.0.0.1', timeoutMs = 1500 } = {}) {
  if (!port) return false;
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/api/status`, {
      headers: { 'X-UI-Token': String(uiToken || '') },
      signal
    });
    if (res.status !== 200) return false;
    const body = await res.json().catch(() => null);
    return Boolean(body && typeof body === 'object' && 'tool_count' in body);
  } catch {
    return false;
  } finally {
    done();
  }
}

function buildUiUrl({ port, uiToken, host = '127.0.0.1' }) {
  return `http://${host}:${port}/?ui=${encodeURIComponent(uiToken || '')}`;
}

/**
 * 启动服务或附着到已有服务。
 *
 * @param {object} opts
 * @param {object} opts.config        已加载配置（可变）
 * @param {string} opts.officialRoot
 * @param {number} opts.port          期望端口
 * @param {Function} opts.createServer () => 服务实例（依赖注入，便于测试）
 * @param {Function} [opts.log]
 * @returns {Promise<{mode:'owned'|'attached', port:number, host:string, uiUrl:string,
 *                    instance:object|null, close:()=>Promise<void>}>}
 */
export async function startOrAttach({
  config,
  officialRoot,
  port,
  createServer,
  log = () => {}
}) {
  const host = config.host || '127.0.0.1';
  const uiToken = config.ui_token || '';

  let instance;
  try {
    instance = createServer();
  } catch (err) {
    throw err;
  }

  let address;
  try {
    address = await instance.listen(port);
  } catch (err) {
    // 监听失败：先释放可能已分配的句柄，避免 Electron 里残留端口
    try {
      await instance.close();
    } catch {}

    if (err.code === 'EADDRINUSE') {
      if (await probeService({ port, uiToken, host })) {
        log(`[desktop] 端口 ${port} 上已有 API MCP 服务，使用附着模式`);
        return {
          mode: 'attached',
          port,
          host,
          uiUrl: buildUiUrl({ port, uiToken, host }),
          instance: null,
          close: async () => {}
        };
      }
      throw new PortInUseError(port);
    }
    throw err;
  }

  const actualPort = typeof address === 'object' && address ? address.port : port;
  config.port = actualPort;

  return {
    mode: 'owned',
    port: actualPort,
    host,
    uiUrl: buildUiUrl({ port: actualPort, uiToken, host }),
    instance,
    close: async () => {
      try {
        await instance.close();
      } catch {}
    }
  };
}
