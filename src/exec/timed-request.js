/**
 * 带分阶段计时的 HTTP/1.1 传输层。
 *
 * 为什么不用 fetch：undici 的 fetch 不暴露 DNS / TCP / TLS 各阶段的耗时，
 * 而 Apipost 的响应区会展示 Request / Socket / Lookup / Connect / SecureConnect /
 * Response / End / Done 八段，这里用 node:http(s) 自己采集。
 *
 * 只要调用方没有显式注入 fetchImpl，http.js 就会走这条路径；
 * 注入了就仍用 fetch（测试里的假实现、以及 HTTP/2 分支），此时 timings 为 null。
 */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
/** 这些状态码会把请求降级为 GET 并丢弃 body */
const DOWNGRADE_TO_GET = new Set([301, 302, 303]);

/** 单跳的计时结果（毫秒），键与 Apipost 的展示分段一致 */
function emptyTimings() {
  return {
    request_ms: 0,
    socket_ms: 0,
    lookup_ms: 0,
    connect_ms: 0,
    tls_ms: 0,
    waiting_ms: 0,
    download_ms: 0,
    total_ms: 0,
    redirects: 0
  };
}

function addInto(target, src) {
  for (const key of Object.keys(target)) {
    if (key === 'redirects') continue;
    target[key] += Number(src[key]) || 0;
  }
}

/** 该响应体是否需要解压，返回对应的解压流；不支持时返回 null */
function decoderFor(encoding) {
  const value = String(encoding || '').toLowerCase().trim();
  if (!value || value === 'identity') return null;
  if (value.includes('br')) return zlib.createBrotliDecompress();
  if (value.includes('gzip') || value.includes('x-gzip')) return zlib.createGunzip();
  if (value.includes('deflate')) return zlib.createInflate();
  return null;
}

/**
 * 发一跳请求（不处理跳转）。
 * @returns {Promise<object>} 单跳结果，timings 为该跳的绝对值
 */
function requestOnce({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port = target.port || (isHttps ? 443 : 80);

    const timings = emptyTimings();
    // startAt 是「发出请求」的时刻；socket 之后的每段都以它为基准再相减
    const startAt = Date.now();
    let socketAt = 0;
    let lookupAt = 0;
    let connectAt = 0;
    let secureAt = 0;
    let finishAt = 0;
    let responseAt = 0;

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        // 不复用连接：keep-alive 会让 Lookup / Connect 恒为 0，失去展示意义
        agent: false,
        rejectUnauthorized: false,
        // 自签证书场景与 http2.js 保持一致
        servername: isHttps ? target.hostname : undefined
      },
      (res) => {
        responseAt = Date.now();
        // waiting 从「请求写完」算起，而不是从 socket 建立算起，避免与建连各段重复计数
        timings.waiting_ms = Math.max(0, responseAt - (finishAt || socketAt || startAt));

        const chunks = [];
        const encoding = res.headers['content-encoding'];
        const decoder = decoderFor(encoding);

        const collect = (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

        if (decoder) {
          decoder.on('data', collect);
          decoder.on('error', () => {
            // 解压失败时退化成原始字节，不让请求整体失败
          });
          res.pipe(decoder);
          decoder.on('end', () => finish());
        } else {
          res.on('data', collect);
          res.on('end', () => finish());
        }

        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          timings.download_ms = Math.max(0, Date.now() - responseAt);

          const bodyBuffer = Buffer.concat(chunks);
          const setCookies = [];
          const raw = res.headers['set-cookie'];
          if (Array.isArray(raw)) setCookies.push(...raw);
          else if (raw) setCookies.push(raw);

          const responseHeaders = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (key === 'set-cookie') continue;
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
          }

          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || '',
            headers: responseHeaders,
            setCookies,
            bodyBuffer,
            bodyText: bodyBuffer.toString('utf8'),
            protocol: 'HTTP/1.1',
            timings
          });
        };
      }
    );

    // ---- 分段打点 ----
    // 各段刻意做成「不重叠」，条形图可直接堆叠：
    //   request = 起点→拿到 socket；lookup/connect/tls 为各自的增量；
    //   waiting = 请求写完→收到响应头；download = 响应头→响应体读完
    req.on('socket', (socket) => {
      socketAt = Date.now();
      timings.socket_ms = Math.max(0, socketAt - startAt);

      // 复用连接时不会再触发 lookup/connect，这两段留 0
      if (!socket.connecting) return;

      socket.on('lookup', () => {
        lookupAt = Date.now();
        timings.lookup_ms = Math.max(0, lookupAt - socketAt);
      });
      socket.on('connect', () => {
        connectAt = Date.now();
        timings.connect_ms = Math.max(0, connectAt - (lookupAt || socketAt));
      });
      socket.on('secureConnect', () => {
        secureAt = Date.now();
        timings.tls_ms = Math.max(0, secureAt - (connectAt || lookupAt || socketAt));
      });
    });

    // 请求体写完的时刻，作为 waiting（TTFB）的起点，避免与建连各段重叠
    req.on('finish', () => {
      finishAt = Date.now();
    });

    req.on('error', (err) => {
      // 附带阶段信息，方便判断是 DNS、建连还是传输阶段挂的
      const stage = !socketAt
        ? 'request'
        : !responseAt
          ? 'connect'
          : 'download';
      err.networkStage = stage;
      reject(err);
    });

    if (timeoutMs && Number(timeoutMs) > 0) {
      req.setTimeout(Number(timeoutMs), () => {
        req.destroy(new Error(`请求超时（>${timeoutMs}ms）`));
      });
    }

    if (body !== undefined && body !== null && body !== '' && !['GET', 'HEAD'].includes(method)) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

/**
 * 发送请求并采集 8 段耗时，自动跟随 3xx 跳转。
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.method]
 * @param {Record<string,string>} [opts.headers]
 * @param {string|Buffer} [opts.body]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxRedirects]
 * @returns {Promise<object>} 结构与 fetch 分支返回的内部 response 对齐
 */
export async function requestWithTimings({
  url,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 60000,
  maxRedirects = 10
}) {
  const overallStart = Date.now();
  const total = emptyTimings();

  let currentUrl = url;
  let currentMethod = String(method || 'GET').toUpperCase();
  let currentHeaders = { ...headers };
  let currentBody = body;
  let redirects = 0;
  let result = null;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    result = await requestOnce({
      url: currentUrl,
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
      timeoutMs
    });

    addInto(total, result.timings);

    const location = result.headers.location;
    if (!REDIRECT_CODES.has(Number(result.status)) || !location) break;

    redirects += 1;
    const nextUrl = new URL(location, currentUrl).toString();

    if (DOWNGRADE_TO_GET.has(Number(result.status))) {
      currentMethod = 'GET';
      currentBody = undefined;
      // 降级为 GET 后不能继续带 Content-Length / Content-Type
      for (const key of Object.keys(currentHeaders)) {
        if (/^content-(length|type|encoding)$/i.test(key)) delete currentHeaders[key];
      }
    }

    // 跨域跳转时丢掉鉴权相关的头，避免把凭据泄漏给第三方
    try {
      if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
        for (const key of Object.keys(currentHeaders)) {
          if (/^(authorization|cookie|proxy-authorization)$/i.test(key)) delete currentHeaders[key];
        }
      }
    } catch {}

    currentUrl = nextUrl;
  }

  total.redirects = redirects;
  total.total_ms = Date.now() - overallStart;

  return {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    setCookies: result.setCookies,
    bodyBuffer: result.bodyBuffer,
    bodyText: result.bodyText,
    size: result.bodyBuffer?.length || 0,
    protocol: result.protocol,
    finalUrl: currentUrl,
    timings: total
  };
}

/**
 * 把 requestWithTimings 的结果包装成 fetch Response 的兼容子集，
 * 让 http.js 的后续逻辑（arrayBuffer / headers.forEach / headers.get）不必分叉。
 */
export function asFetchLike(result) {
  const headerEntries = Object.entries(result.headers || {});
  const lower = new Map(headerEntries.map(([k, v]) => [String(k).toLowerCase(), String(v)]));

  return {
    status: result.status,
    statusText: result.statusText,
    headers: {
      forEach: (cb) => {
        for (const [k, v] of headerEntries) cb(v, k);
      },
      get: (name) => {
        const value = lower.get(String(name).toLowerCase());
        return value === undefined ? null : value;
      },
      getSetCookie: () => result.setCookies || []
    },
    arrayBuffer: async () => result.bodyBuffer,
    __timings: result.timings,
    __finalUrl: result.finalUrl
  };
}
