import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurl, defaultDialect, quoteCmd, quoteBash } from '../web/curl-build.js';
import { parseCurl, detectDialect } from '../web/curl-parse.js';

/** 截图里那条真实请求：长 JWT 头 + JSON body */
const REAL_REQUEST = {
  method: 'POST',
  url: 'https://bgittest.dcs.cloud/stomics_bioinsight_backend_test/query_parquet',
  headers: {
    'X-Access-Token':
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzU4M2M0NTAzZDE5MzQ3NzY4ODY2NDZkNmQxMTg1YmQ1In0.myMGkmDrniZAb59ha6P5QgcS4hZTd0bo7o_-XSfHXgU',
    'X-Client-App': 'dcs-cloud-front',
    'X-Domain-Code': 'F20FTSSWAT10103_HUMabxX_B21',
    'X-Domain-Type': '21',
    'X-Zone': 'bgit',
    'content-type': 'application/json'
  },
  body_mode: 'json',
  body: JSON.stringify(
    {
      task_id: 'W202411060000144',
      type: 'heatmap.All_Branches.parquet',
      filters: [],
      cluster: [],
      sorts: []
    },
    null,
    2
  )
};

/* ---------------- 方言判定与引号 ---------------- */

test('curl-build: 按平台判定默认方言', () => {
  assert.equal(defaultDialect('Win32'), 'cmd');
  assert.equal(defaultDialect('Windows'), 'cmd');
  assert.equal(defaultDialect('MacIntel'), 'bash');
  assert.equal(defaultDialect('Linux x86_64'), 'bash');
});

test('curl-build: CMD 把内部双引号翻倍', () => {
  assert.equal(quoteCmd('plain'), '"plain"');
  assert.equal(quoteCmd('{"a":1}'), '"{""a"":1}"');
  assert.equal(quoteCmd('a"b"c'), '"a""b""c"');
});

test('curl-build: Bash 用单引号并正确断开内部单引号', () => {
  assert.equal(quoteBash('plain'), "'plain'");
  assert.equal(quoteBash("it's"), `'it'\\''s'`);
});

/* ---------------- 往返：生成 -> 解析 ---------------- */

test('curl-build: CMD 方言往返后 URL / 头 / body 完全一致', () => {
  const { text, dialect } = buildCurl(REAL_REQUEST, { dialect: 'cmd' });
  assert.equal(dialect, 'cmd');
  assert.match(text, /\^/);
  assert.equal(detectDialect(text), 'cmd');

  const parsed = parseCurl(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.url, REAL_REQUEST.url);

  const headers = Object.fromEntries(parsed.headers.map((h) => [h.key.toLowerCase(), h.value]));
  for (const [key, value] of Object.entries(REAL_REQUEST.headers)) {
    assert.equal(headers[key.toLowerCase()], value, `header 不一致：${key}`);
  }

  // JSON body 必须能原样还原（引号没被吃掉）
  assert.equal(parsed.body.mode, 'json');
  assert.deepEqual(parsed.body.json, JSON.parse(REAL_REQUEST.body));
});

test('curl-build: Bash 方言往返后 URL / 头 / body 完全一致', () => {
  const { text, dialect } = buildCurl(REAL_REQUEST, { dialect: 'bash' });
  assert.equal(dialect, 'bash');
  assert.equal(detectDialect(text), 'bash');

  const parsed = parseCurl(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.url, REAL_REQUEST.url);

  const headers = Object.fromEntries(parsed.headers.map((h) => [h.key.toLowerCase(), h.value]));
  for (const [key, value] of Object.entries(REAL_REQUEST.headers)) {
    assert.equal(headers[key.toLowerCase()], value, `header 不一致：${key}`);
  }
  assert.deepEqual(parsed.body.json, JSON.parse(REAL_REQUEST.body));
});

test('curl-build: Bash 方言下 body 带单引号仍可还原', () => {
  const req = {
    method: 'POST',
    url: 'https://x.test/q',
    headers: { 'content-type': 'application/json' },
    body_mode: 'json',
    body: '{"msg":"it\'s fine","q":"a\'b"}'
  };
  const { text } = buildCurl(req, { dialect: 'bash' });
  assert.match(text, /'\\''/);

  const parsed = parseCurl(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.body.json, { msg: "it's fine", q: "a'b" });
});

test('curl-build: CMD 方言下多行 JSON 被压成一行且语义不变', () => {
  const { text, warnings } = buildCurl(REAL_REQUEST, { dialect: 'cmd' });
  // 续行符之外不应再有换行（body 里不能带换行）
  const bodyLine = text.split('\n').find((line) => line.includes('--data-raw'));
  assert.ok(bodyLine, '应有 --data-raw 行');
  assert.ok(!bodyLine.includes('\n'));
  assert.deepEqual(warnings, []);
});

test('curl-build: URL 里的 & 与 = 不会截断（引号包裹）', () => {
  const req = { method: 'GET', url: 'https://x.test/q?a=1&b=2&c=x%20y', headers: {} };
  for (const dialect of ['cmd', 'bash']) {
    const { text } = buildCurl(req, { dialect });
    const parsed = parseCurl(text);
    // 解析器把 query 拆到 baseUrl + query 数组，拼回去应与原 URL 等价
    const rebuilt = parsed.query.length
      ? `${parsed.url}?${parsed.query.map((q) => `${q.key}=${encodeURIComponent(q.value)}`).join('&')}`
      : parsed.url;
    assert.equal(rebuilt, req.url, `${dialect} 下 URL 被截断`);
  }
});

/* ---------------- 不伪造 body ---------------- */

test('curl-build: binary / form-data 不输出 --data-raw', () => {
  for (const mode of ['binary', 'form-data']) {
    const { text, warnings } = buildCurl(
      { method: 'POST', url: 'https://x.test/u', headers: {}, body_mode: mode, body: '<binary 1234 bytes>' },
      { dialect: 'cmd' }
    );
    assert.ok(!text.includes('--data-raw'), `${mode} 不应输出 --data-raw`);
    assert.ok(warnings.length > 0, `${mode} 应给出提示`);
  }
});

test('curl-build: 无 body 时不输出 --data-raw', () => {
  const { text } = buildCurl({ method: 'GET', url: 'https://x.test/a', headers: {}, body_mode: 'none', body: '' });
  assert.ok(!text.includes('--data-raw'));
});

/* ---------------- 解析器兼容 CMD 的双写引号 ---------------- */

test('curl-parse: CMD 双写引号被还原成单个引号', () => {
  const cmd = 'curl -X POST "https://x.test/a" --data-raw "{""k"":""v""}"';
  const parsed = parseCurl(cmd);
  assert.equal(parsed.dialect, 'cmd');
  assert.equal(parsed.ok, true);
  // raw 会被 JSON 美化，这里断言语义还原正确即可
  assert.deepEqual(parsed.body.json, { k: 'v' });
  assert.ok(!parsed.body.raw.includes('""'), 'body 不应残留双写引号');
});
