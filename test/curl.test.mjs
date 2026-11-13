import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDialect,
  splitCurlBlocks,
  parseCurl,
  parseAll,
  tokenize,
  jsonToSchema,
  schemaToParameters,
  applyParsedToApiData,
  suggestName
} from '../web/curl-parse.js';

/* ---------------- 用户提供的三条真实命令 ---------------- */

const CURL_BASH_MCP = `curl --url "http://127.0.0.1:8000/mcp" \\
  -H "Authorization: Bearer lyQod3RxJK3djBrofQ0kenv4Jkb4Mw9r" \\
  -H "Accept: application/json" \\
  -H "Content-Type: application/json" \\
  -H "X-Access-Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzU4M2M0NTAzZDE5MzQ3NzY4ODY2NDZkNmQxMTg1YmQ1In0.myMGkmDrniZAb59ha6P5QgcS4hZTd0bo7o_-XSfHXgU" \\
  -H "X-Client-App: dcs-cloud-front" \\
  -H "X-Domain-Code: P1871461072416366593" \\
  -H "X-Domain-Type: 21" \\
  -H "X-Zone: st" \\
  -H "X-Request-Id: req-local-2" \\
  --data-raw '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dcs_data_copy","arguments":{"targetProjectId":"P1871461072416366593","targetMenuId":"01a0b3cf930779bdaf3d4531992394f5","name":"aa.txt","virtualPath":"Files/aaa","targetZone":"st"}}}'`;

const CURL_CMD = `curl --url ^"https://test.dcs.cloud/api/data/file/meta/query?page=1^&limit=10^" ^
  -H ^"accept: application/json, text/plain, */*^" ^
  -H ^"accept-language: zh-CN^" ^
  -H ^"content-type: application/json; charset=UTF-8^" ^
  -H ^"lang: zh-CN^" ^
  -H ^"origin: https://test.dcs.cloud^" ^
  -H ^"sec-ch-ua: ^\\^"Not:A-Brand^\\^";v=^\\^"8^\\^", ^\\^"Chromium^\\^";v=^\\^"156^\\^", ^\\^"Google Chrome^\\^";v=^\\^"156^\\^"^" ^
  -H ^"sec-ch-ua-mobile: ?0^" ^
  -H ^"sec-ch-ua-platform: ^\\^"Windows^\\^"^" ^
  -H ^"user-agent: Mozilla/5.0 ^(Windows NT 10.0; Win64; x64^) AppleWebKit/537.36 ^(KHTML, like Gecko^) Chrome/156.0.0.0 Safari/537.36^" ^
  -H ^"x-access-token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIn0.hqDL4HEXecpxMDQJTYjaHadUoer82P9DK3MYWyVqcDA^" ^
  -H ^"x-client-app: dcs-cloud-front^" ^
  -H ^"x-domain-code: P1871461072416366593^" ^
  -H ^"x-domain-type: 21^" ^
  -H ^"x-zone: st^" ^
  --data-raw ^"^{^\\^"recursion^\\^":0,^\\^"filter^\\^":^{^\\^"searchNameList^\\^":^[^]^},^\\^"searchName^\\^":^\\^"^\\^",^\\^"fileExtensionList^\\^":^[^],^\\^"parentId^\\^":^\\^"01a1612636647ecead6700248b8baf7e^\\^",^\\^"projectId^\\^":^\\^"P1871461072416366593^\\^"^}^"`;

const CURL_PS = `curl.exe 'https://api.test/ps' \`
  -H 'accept: application/json' \`
  -H 'x-token: abc'`;

/* ---------------- 方言识别 ---------------- */

test('curl: detectDialect 识别 bash', () => {
  assert.equal(detectDialect(CURL_BASH_MCP), 'bash');
});

test('curl: detectDialect 识别 cmd', () => {
  assert.equal(detectDialect(CURL_CMD), 'cmd');
});

test('curl: detectDialect 识别 powershell', () => {
  assert.equal(detectDialect(CURL_PS), 'powershell');
});

test('curl: 显式 dialect 覆盖自动识别，不做 cmd 反转义', () => {
  // 强制按 bash 解析 CMD 文本：^ 会残留，URL 里出现 ^
  const forced = parseCurl(CURL_CMD, { dialect: 'bash' });
  assert.equal(forced.dialect, 'bash');
  // 正常自动识别时 URL 干净
  const auto = parseCurl(CURL_CMD);
  assert.equal(auto.url, 'https://test.dcs.cloud/api/data/file/meta/query');
});

/* ---------------- 用户真实命令 ---------------- */

test('curl: bash + --url + JSON body（第 1 条）', () => {
  const res = parseCurl(CURL_BASH_MCP);
  assert.equal(res.ok, true);
  assert.equal(res.dialect, 'bash');
  assert.equal(res.method, 'POST');
  assert.equal(res.url, 'http://127.0.0.1:8000/mcp');
  assert.equal(res.headers.length, 9);

  const auth = res.headers.find((h) => h.key === 'Authorization');
  assert.equal(auth.value, 'Bearer lyQod3RxJK3djBrofQ0kenv4Jkb4Mw9r');

  const token = res.headers.find((h) => h.key === 'X-Access-Token');
  assert.ok(token.value.startsWith('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'));

  assert.equal(res.body.mode, 'json');
  assert.equal(res.body.json.method, 'tools/call');
  assert.equal(res.body.json.params.name, 'dcs_data_copy');
  assert.equal(res.body.json.params.arguments.name, 'aa.txt');

  // 格式化后的 JSON 可再解析
  assert.deepEqual(JSON.parse(res.body.raw), res.body.json);
  assert.equal(res.warnings.length, 0);
});

test('curl: cmd 二次转义完整还原（第 2 条）', () => {
  const res = parseCurl(CURL_CMD);
  assert.equal(res.ok, true);
  assert.equal(res.dialect, 'cmd');
  assert.equal(res.method, 'POST');
  assert.equal(res.url, 'https://test.dcs.cloud/api/data/file/meta/query');

  // query 里的 ^& 应还原为 &
  assert.deepEqual(
    res.query.map((q) => `${q.key}=${q.value}`),
    ['page=1', 'limit=10']
  );

  const get = (key) => res.headers.find((h) => h.key === key)?.value;

  // 三重转义还原
  assert.equal(get('sec-ch-ua'), '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"');

  // cmd 的 ^(...^) 括号转义还原
  assert.equal(
    get('user-agent'),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  );

  assert.equal(get('sec-ch-ua-platform'), '"Windows"');
  assert.equal(get('sec-ch-ua-mobile'), '?0');
  assert.equal(get('accept'), 'application/json, text/plain, */*');
  assert.equal(get('content-type'), 'application/json; charset=UTF-8');
  assert.equal(get('x-domain-code'), 'P1871461072416366593');
  assert.equal(get('x-zone'), 'st');
  assert.ok(get('x-access-token')?.startsWith('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'));

  // body 里的 ^" 与 ^[ ^] 应还原
  assert.equal(res.body.mode, 'json');
  assert.equal(res.body.json.recursion, 0);
  assert.deepEqual(res.body.json.filter.searchNameList, []);
  assert.equal(res.body.json.searchName, '');
  assert.deepEqual(res.body.json.fileExtensionList, []);
  assert.equal(res.body.json.parentId, '01a1612636647ecead6700248b8baf7e');
  assert.equal(res.body.json.projectId, 'P1871461072416366593');
  assert.equal(res.warnings.length, 0);
});

test('curl: powershell 反引号续行', () => {
  const res = parseCurl(CURL_PS);
  assert.equal(res.ok, true);
  assert.equal(res.dialect, 'powershell');
  assert.equal(res.url, 'https://api.test/ps');
  assert.equal(res.method, 'GET');
  assert.equal(res.headers.length, 2);
  assert.equal(res.headers.find((h) => h.key === 'accept').value, 'application/json');
});

/* ---------------- 分块 ---------------- */

test('curl: splitCurlBlocks 切分多条命令', () => {
  const blocks = splitCurlBlocks([CURL_BASH_MCP, CURL_CMD, CURL_PS].join('\n\n'));
  assert.equal(blocks.length, 3);
});

test('curl: parseAll 一次解析三种方言', () => {
  const results = parseAll([CURL_BASH_MCP, CURL_CMD, CURL_PS].join('\n\n'));
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.dialect), ['bash', 'cmd', 'powershell']);
  assert.deepEqual(results.map((r) => r.method), ['POST', 'POST', 'GET']);
  assert.ok(results.every((r) => r.ok));
});

/* ---------------- 分词 ---------------- */

test('curl: tokenize 处理单双引号与转义', () => {
  assert.deepEqual(tokenize(`-H 'a: b c' -H "d: e f"`), ['-H', 'a: b c', '-H', 'd: e f']);
  assert.deepEqual(tokenize(`--data-raw '{"a":1}'`), ['--data-raw', '{"a":1}']);
  assert.deepEqual(tokenize('a\\ b c'), ['a b', 'c']);
  assert.deepEqual(tokenize(`"say \\"hi\\""`), ['say "hi"']);
});

/* ---------------- 参数推断 ---------------- */

test('curl: -X 覆盖方法', () => {
  const res = parseCurl(`curl -X PUT https://api.test/x -d '{"a":1}'`);
  assert.equal(res.method, 'PUT');
});

test('curl: -G 把 data 转 query 且方法为 GET', () => {
  const res = parseCurl(`curl -G https://api.test/search -d 'q=abc&page=2'`);
  assert.equal(res.method, 'GET');
  assert.deepEqual(
    res.query.map((q) => `${q.key}=${q.value}`),
    ['q=abc', 'page=2']
  );
  assert.equal(res.body.mode, 'none');
});

test('curl: -F 生成 form-data 且文件字段标记为 File', () => {
  const res = parseCurl(`curl https://api.test/upload -F 'name=abc' -F 'avatar=@/tmp/a.png'`);
  assert.equal(res.method, 'POST');
  assert.equal(res.body.mode, 'form-data');
  const avatar = res.body.form.find((f) => f.key === 'avatar');
  assert.equal(avatar.isFile, true);
  assert.equal(avatar.value, '/tmp/a.png');
  const name = res.body.form.find((f) => f.key === 'name');
  assert.equal(name.isFile, false);
});

test('curl: -u 解析为 basic 鉴权', () => {
  const res = parseCurl(`curl -u admin:secret https://api.test/x`);
  assert.equal(res.auth.type, 'basic');
  assert.equal(res.auth.username, 'admin');
  assert.equal(res.auth.password, 'secret');
});

test('curl: -b 解析 cookie', () => {
  const res = parseCurl(`curl -b "a=1; b=2" https://api.test/x`);
  assert.deepEqual(
    res.cookies.map((c) => `${c.key}=${c.value}`),
    ['a=1', 'b=2']
  );
});

test('curl: Cookie header 拆到 cookie 表', () => {
  const res = parseCurl(`curl -H 'Cookie: sid=xyz' https://api.test/x`);
  assert.equal(res.cookies.length, 1);
  assert.equal(res.cookies[0].key, 'sid');
  assert.equal(res.cookies[0].value, 'xyz');
  assert.ok(!res.headers.some((h) => h.key.toLowerCase() === 'cookie'));
});

test('curl: applyParsedToApiData 把 cookie 写成 Cookie 头', () => {
  const res = parseCurl(`curl -b "a=1; b=2" https://api.test/x`);
  const data = { request: { header: {}, query: {}, cookie: {}, restful: {}, body: {}, auth: { type: 'inherit' } } };
  applyParsedToApiData(data, res);

  const cookieHeader = data.request.header.parameter.find((h) => String(h.key).toLowerCase() === 'cookie');
  assert.ok(cookieHeader, '应生成 Cookie 请求头');
  assert.equal(cookieHeader.value, 'a=1; b=2');
  assert.deepEqual(data.request.cookie.parameter, [], '不再写入 cookie 参数表');
});

test('curl: applyParsedToApiData 复用已有的 Cookie 头', () => {
  const res = parseCurl(`curl -b "a=1" https://api.test/x`);
  const data = {
    request: {
      header: { parameter: [{ key: 'cookie', value: 'old=0' }] },
      query: {},
      cookie: {},
      restful: {},
      body: {},
      auth: { type: 'inherit' }
    }
  };
  applyParsedToApiData(data, res);

  const cookies = data.request.header.parameter.filter((h) => String(h.key).toLowerCase() === 'cookie');
  assert.equal(cookies.length, 1, '不应产生重复 Cookie 头');
  assert.equal(cookies[0].value, 'a=1');
});

test('curl: URL 中的 {id} 提取为 restful 参数', () => {
  const res = parseCurl(`curl https://api.test/users/{id}/orders/{orderId}`);
  assert.deepEqual(res.restful.map((r) => r.key), ['id', 'orderId']);
});

test('curl: -A / -e 生成对应 header', () => {
  const res = parseCurl(`curl -A "MyAgent/1.0" -e "https://ref.test/" https://api.test/x`);
  assert.equal(res.headers.find((h) => h.key === 'User-Agent').value, 'MyAgent/1.0');
  assert.equal(res.headers.find((h) => h.key === 'Referer').value, 'https://ref.test/');
});

test('curl: urlencoded body 拆分', () => {
  const res = parseCurl(`curl -H 'Content-Type: application/x-www-form-urlencoded' https://api.test/x -d 'a=1&b=hello%20world'`);
  assert.equal(res.body.mode, 'urlencoded');
  const b = res.body.form.find((f) => f.key === 'b');
  assert.equal(b.value, 'hello world');
});

test('curl: --json 快捷参数补 Content-Type', () => {
  const res = parseCurl(`curl https://api.test/x --json '{"a":1}'`);
  assert.equal(res.body.mode, 'json');
  assert.equal(res.headers.find((h) => h.key.toLowerCase() === 'content-type').value, 'application/json');
});

/* ---------------- 异常 ---------------- */

test('curl: 无 URL 时 ok=false 且有 warning', () => {
  const res = parseCurl(`curl -H 'a: b'`);
  assert.equal(res.ok, false);
  assert.ok(res.warnings.some((w) => w.includes('未识别到 URL')));
});

test('curl: 空文本返回 ok=false', () => {
  const res = parseCurl('   ');
  assert.equal(res.ok, false);
  assert.deepEqual(res.warnings, ['内容为空']);
});

/* ---------------- schema 推导与写入 ---------------- */

test('curl: jsonToSchema 推导嵌套结构', () => {
  const schema = jsonToSchema({ a: 1, b: 'x', c: true, d: { e: [1, 2] } });
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.APIPOST_ORDERS, ['a', 'b', 'c', 'd']);
  assert.equal(schema.properties.a.type, 'integer');
  assert.equal(schema.properties.b.type, 'string');
  assert.equal(schema.properties.c.type, 'boolean');
  assert.equal(schema.properties.d.type, 'object');
  assert.equal(schema.properties.d.properties.e.type, 'array');
  assert.equal(schema.properties.d.properties.e.items.type, 'integer');
  assert.deepEqual(schema.APIPOST_REFS, {});
});

test('curl: schemaToParameters 扁平化嵌套 key', () => {
  const schema = jsonToSchema({ user: { id: 1, name: 'a' } });
  const params = schemaToParameters(schema);
  const keys = params.map((p) => p.key);
  assert.ok(keys.includes('user'));
  assert.ok(keys.includes('user.id'));
  assert.ok(keys.includes('user.name'));
  const idParam = params.find((p) => p.key === 'user.id');
  assert.equal(idParam.field_type, 'Integer');
});

test('curl: applyParsedToApiData 写入官方结构', () => {
  const res = parseCurl(CURL_BASH_MCP);
  const data = {
    request: {
      header: {},
      query: {},
      cookie: {},
      restful: {},
      body: {},
      auth: { type: 'inherit' }
    }
  };

  applyParsedToApiData(data, res);

  assert.equal(data.method, 'POST');
  assert.equal(data.url, 'http://127.0.0.1:8000/mcp');
  assert.equal(data.request.header.parameter.length, 9);
  assert.equal(data.request.query.parameter.length, 0);
  assert.equal(data.request.body.mode, 'json');
  assert.ok(data.request.body.raw.includes('"method": "tools/call"'));
  assert.equal(data.request.body.raw_schema.type, 'object');
  assert.ok(Array.isArray(data.request.body.raw_parameter));
  assert.ok(data.request.body.raw_parameter.some((p) => p.key === 'params'));
  assert.ok(data.request.body.raw_parameter.some((p) => p.key === 'params.name'));

  // 参数项结构对齐官方
  const h = data.request.header.parameter[0];
  for (const field of ['description', 'field_type', 'is_checked', 'key', 'not_null', 'param_id', 'value']) {
    assert.ok(field in h, `header 参数应含 ${field}`);
  }
  assert.equal(h.is_checked, 1);
});

test('curl: applyParsedToApiData 处理 cmd 来源', () => {
  const res = parseCurl(CURL_CMD);
  const data = { request: { header: {}, query: {}, cookie: {}, restful: {}, body: {}, auth: { type: 'inherit' } } };
  applyParsedToApiData(data, res);

  assert.equal(data.method, 'POST');
  assert.equal(data.url, 'https://test.dcs.cloud/api/data/file/meta/query');
  assert.deepEqual(
    data.request.query.parameter.map((q) => `${q.key}=${q.value}`),
    ['page=1', 'limit=10']
  );
  const secChUa = data.request.header.parameter.find((p) => p.key === 'sec-ch-ua');
  assert.equal(secChUa.value, '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"');
  assert.equal(data.request.body.mode, 'json');
  assert.equal(data.request.body.raw_schema.properties.recursion.type, 'integer');
});

test('curl: applyParsedToApiData 写入 basic 鉴权', () => {
  const res = parseCurl(`curl -u u:p https://api.test/x`);
  const data = { request: { header: {}, query: {}, cookie: {}, restful: {}, body: {}, auth: { type: 'inherit' } } };
  applyParsedToApiData(data, res);
  assert.equal(data.request.auth.type, 'basic');
  assert.equal(data.request.auth.basic.username, 'u');
});

/* ---------------- 命名 ---------------- */

test('curl: suggestName 从 URL 推断接口名', () => {
  assert.equal(suggestName({ url: 'https://test.dcs.cloud/api/data/file/meta/query' }), 'query');
  assert.equal(suggestName({ url: 'https://api.test/users/{id}' }), 'users');
  assert.equal(suggestName({ url: '' }), '新接口');
});
