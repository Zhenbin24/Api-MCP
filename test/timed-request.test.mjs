import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { requestWithTimings, asFetchLike } from '../src/exec/timed-request.js';

/** 起一个覆盖各类场景的本地服务 */
async function startServer() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/json') {
      const payload = JSON.stringify({ ok: true, echo: req.headers['x-test'] || null, body });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }

    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/json' });
      res.end();
      return;
    }

    if (url.pathname === '/redirect-chain') {
      res.writeHead(301, { Location: '/redirect' });
      res.end();
      return;
    }

    if (url.pathname === '/redirect-post') {
      // 307 保留方法与 body
      res.writeHead(307, { Location: '/json' });
      res.end();
      return;
    }

    if (url.pathname === '/gzip') {
      const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ gz: true, text: 'compressed-body' }), 'utf8'));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': payload.length
      });
      res.end(payload);
      return;
    }

    if (url.pathname === '/deflate') {
      const payload = zlib.deflateSync(Buffer.from('deflate-plain', 'utf8'));
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Encoding': 'deflate',
        'Content-Length': payload.length
      });
      res.end(payload);
      return;
    }

    if (url.pathname === '/cookie') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': ['session=abc; Path=/', 'theme=dark; HttpOnly']
      });
      res.end('{"ok":1}');
      return;
    }

    if (url.pathname === '/status/404') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"nope"}');
      return;
    }

    if (url.pathname === '/slow') {
      await new Promise((r) => setTimeout(r, 60));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"slow":true}');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

const TIMING_KEYS = [
  'request_ms',
  'socket_ms',
  'lookup_ms',
  'connect_ms',
  'tls_ms',
  'waiting_ms',
  'download_ms',
  'total_ms'
];

test('timed-request：基本请求返回 8 段耗时字段', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({
      url: `${srv.base}/json`,
      method: 'GET',
      headers: { 'X-Test': 'abc' },
      timeoutMs: 5000
    });

    assert.equal(res.status, 200);
    assert.equal(res.protocol, 'HTTP/1.1');
    assert.deepEqual(JSON.parse(res.bodyText), { ok: true, echo: 'abc', body: '' });

    for (const key of TIMING_KEYS) {
      assert.equal(typeof res.timings[key], 'number', `缺少计时字段 ${key}`);
      assert.ok(res.timings[key] >= 0, `${key} 不应为负`);
    }
    assert.equal(typeof res.timings.redirects, 'number');
    assert.equal(res.timings.redirects, 0);

    // 各段是「嵌套」而非「相加」关系：Lookup ⊂ Connect ⊂ Response，
    // 所以只能断言串行关系成立
    assert.ok(
      res.timings.total_ms + 5 >= res.timings.waiting_ms + res.timings.download_ms,
      `total_ms=${res.timings.total_ms} 应 >= waiting+download=${res.timings.waiting_ms + res.timings.download_ms}`
    );
    if (res.timings.connect_ms > 0) {
      assert.ok(
        res.timings.connect_ms + 2 >= res.timings.lookup_ms,
        `connect(${res.timings.connect_ms}) 应覆盖 lookup(${res.timings.lookup_ms})`
      );
    }
  } finally {
    await srv.close();
  }
});

test('timed-request：POST body 被正确发送', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({
      url: `${srv.base}/json`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
      timeoutMs: 5000
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.bodyText).body, '{"hello":"world"}');
  } finally {
    await srv.close();
  }
});

test('timed-request：跟随 302 跳转并累计 redirects', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({ url: `${srv.base}/redirect`, method: 'GET', timeoutMs: 5000 });
    assert.equal(res.status, 200);
    assert.equal(res.timings.redirects, 1);
    assert.deepEqual(JSON.parse(res.bodyText).ok, true);
    assert.match(res.finalUrl, /\/json$/);
  } finally {
    await srv.close();
  }
});

test('timed-request：多级跳转累计次数', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({ url: `${srv.base}/redirect-chain`, method: 'GET', timeoutMs: 5000 });
    assert.equal(res.status, 200);
    assert.equal(res.timings.redirects, 2);
  } finally {
    await srv.close();
  }
});

test('timed-request：307 保留 POST 方法与 body', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({
      url: `${srv.base}/redirect-post`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"keep":"me"}',
      timeoutMs: 5000
    });
    assert.equal(res.status, 200);
    assert.equal(res.timings.redirects, 1);
    // 307 不降级，body 应保留
    assert.equal(JSON.parse(res.bodyText).body, '{"keep":"me"}');
  } finally {
    await srv.close();
  }
});

test('timed-request：302 跳转把 POST 降级为 GET 并丢弃 body', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({
      url: `${srv.base}/redirect`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"drop":"me"}',
      timeoutMs: 5000
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.bodyText).body, '', '302 后应降级为 GET，body 被丢弃');
  } finally {
    await srv.close();
  }
});

test('timed-request：gzip 响应被解压', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({ url: `${srv.base}/gzip`, method: 'GET', timeoutMs: 5000 });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.bodyText);
    assert.equal(parsed.gz, true);
    assert.equal(parsed.text, 'compressed-body');
    // size 用解压后的字节数，与 fetch 的 arrayBuffer 语义一致
    assert.equal(res.size, Buffer.byteLength(res.bodyText));
  } finally {
    await srv.close();
  }
});

test('timed-request：deflate 响应被解压', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({ url: `${srv.base}/deflate`, method: 'GET', timeoutMs: 5000 });
    assert.equal(res.bodyText, 'deflate-plain');
  } finally {
    await srv.close();
  }
});

test('timed-request：多个 Set-Cookie 全部收集', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({ url: `${srv.base}/cookie`, method: 'GET', timeoutMs: 5000 });
    assert.equal(res.setCookies.length, 2);
    assert.ok(res.setCookies.some((c) => c.startsWith('session=abc')));
    assert.ok(res.setCookies.some((c) => c.startsWith('theme=dark')));
    // set-cookie 不应混进普通响应头
    assert.equal(res.headers['set-cookie'], undefined);
  } finally {
    await srv.close();
  }
});

test('timed-request：4xx 不抛错，正常返回状态码', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({ url: `${srv.base}/status/404`, method: 'GET', timeoutMs: 5000 });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test('timed-request：slow 接口的 waiting_ms 明显大于 0', async () => {
  const srv = await startServer();
  try {
    const res = await requestWithTimings({ url: `${srv.base}/slow`, method: 'GET', timeoutMs: 5000 });
    assert.equal(res.status, 200);
    assert.ok(res.timings.waiting_ms >= 40, `waiting_ms 应 >= 40，实际 ${res.timings.waiting_ms}`);
  } finally {
    await srv.close();
  }
});

test('timed-request：asFetchLike 提供 fetch 兼容接口', async () => {
  const srv = await startServer();
  try {
    const timed = await requestWithTimings({
      url: `${srv.base}/cookie`,
      method: 'GET',
      timeoutMs: 5000
    });
    const like = asFetchLike(timed);

    assert.equal(like.status, 200);
    assert.equal(like.statusText, timed.statusText);

    const collected = {};
    like.headers.forEach((value, key) => {
      collected[key] = value;
    });
    assert.match(String(collected['content-type']), /json/);

    assert.match(String(like.headers.get('Content-Type')), /json/, 'get 应大小写不敏感');
    assert.equal(like.headers.get('x-not-exist'), null);
    assert.equal(like.headers.getSetCookie().length, 2);

    const buf = Buffer.from(await like.arrayBuffer());
    assert.equal(buf.toString('utf8'), timed.bodyText);
    assert.ok(like.__timings && like.__timings.total_ms >= 0);
  } finally {
    await srv.close();
  }
});

test('timed-request：连接失败时抛出带 networkStage 的错误', async () => {
  // 用一个几乎不可能在监听中的端口
  await assert.rejects(
    () => requestWithTimings({ url: 'http://127.0.0.1:1/never', method: 'GET', timeoutMs: 1500 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.networkStage, '错误应带 networkStage 便于定位阶段');
      return true;
    }
  );
});
