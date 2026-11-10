/** HTTP/2 传输层：把 node:http2 的响应整理成与 fetch 相同的结构 */
import http2 from 'node:http2';

/**
 * 用 HTTP/2 发送请求。
 * 返回结构与 fetch 路径对齐：{ status, statusText, headers, bodyText, bodyJson, size, setCookies, protocol }
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.method
 * @param {Record<string,string>} opts.headers
 * @param {string|Buffer|undefined} opts.body
 * @param {number} opts.timeoutMs
 */
export async function transmitHttp2({ url, method, headers, body, timeoutMs = 60000 }) {
  const target = new URL(url);

  // HTTP/2 明文（h2c）在 Node 里支持有限，http: 一律回退
  if (target.protocol !== 'https:') {
    return { fallback: true, reason: 'HTTP/2 需要 https://，已回退到 HTTP/1.1' };
  }

  const origin = target.origin;
  const pathWithQuery = `${target.pathname}${target.search}`;

  const session = http2.connect(origin, {
    // 与现有 fetch 路径保持一致：不校验证书
    rejectUnauthorized: false
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        session.close();
      } catch {}
      fn(arg);
    };

    const timer = setTimeout(() => {
      try {
        session.destroy(new Error('HTTP/2 请求超时'));
      } catch {}
      finish(reject, new Error(`HTTP/2 请求超时（>${timeoutMs}ms）`));
    }, timeoutMs);

    session.on('error', (err) => {
      clearTimeout(timer);
      finish(reject, err);
    });

    // 伪头必须小写
    const requestHeaders = { ':method': String(method || 'GET').toUpperCase(), ':path': pathWithQuery };
    const regularHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const key = String(k).toLowerCase();
      // HTTP/2 禁止连接相关的头
      if (['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host'].includes(key)) continue;
      regularHeaders[key] = String(v);
    }
    Object.assign(requestHeaders, regularHeaders);

    let stream;
    try {
      stream = session.request(requestHeaders, { endStream: false });
    } catch (err) {
      clearTimeout(timer);
      finish(reject, err);
      return;
    }

    stream.setEncoding(null);

    let status = 0;
    let statusText = '';
    let responseHeaders = {};
    let setCookies = [];
    const chunks = [];

    stream.on('response', (headersObj) => {
      for (const [key, value] of Object.entries(headersObj)) {
        if (key === ':status') {
          status = Number(value) || 0;
          continue;
        }
        if (key.startsWith(':')) continue;
        if (key === 'set-cookie') {
          setCookies = Array.isArray(value) ? value : [value];
          continue;
        }
        responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      statusText = statusTextFor(status);
    });

    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    stream.on('end', () => {
      clearTimeout(timer);
      const bodyBuffer = Buffer.concat(chunks);
      const bodyText = bodyBuffer.toString('utf8');
      finish(resolve, {
        status,
        statusText,
        headers: responseHeaders,
        bodyText,
        bodyJson: safeJson(bodyText),
        size: bodyBuffer.length,
        setCookies,
        protocol: 'HTTP/2'
      });
    });

    stream.on('error', (err) => {
      clearTimeout(timer);
      finish(reject, err);
    });

    stream.on('aborted', () => {
      clearTimeout(timer);
      finish(reject, new Error('HTTP/2 请求被中止'));
    });

    if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(String(method).toUpperCase())) {
      stream.end(body);
    } else {
      stream.end();
    }
  });
}

function safeJson(text) {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  412: 'Precondition Failed',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
};

function statusTextFor(code) {
  return STATUS_TEXT[code] || '';
}
