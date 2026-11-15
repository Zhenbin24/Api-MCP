import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnippet, LANGUAGES } from '../web/codegen.js';

const sampleReq = {
  method: 'POST',
  url: 'http://127.0.0.1:8000/api/users',
  headers: { 'Content-Type': 'application/json', 'X-Token': 'abc' },
  body_mode: 'json',
  body: '{"name":"张三","age":18}'
};

test('代码生成：六种语言都有产出且包含 URL', () => {
  assert.equal(LANGUAGES.length, 6);
  for (const [lang] of LANGUAGES) {
    const res = buildSnippet(sampleReq, { lang });
    assert.equal(res.language, lang);
    assert.ok(res.code.length > 0, `${lang} 应产出代码`);
    assert.ok(res.code.includes('http://127.0.0.1:8000/api/users'), `${lang} 应包含 URL`);
  }
});

test('代码生成：未知语言回落到 curl', () => {
  const res = buildSnippet(sampleReq, { lang: 'ruby' });
  assert.equal(res.language, 'curl');
  assert.ok(res.code.startsWith('curl -X POST'));
});

test('代码生成：header 与 body 进入各语言产物', () => {
  const fetchRes = buildSnippet(sampleReq, { lang: 'fetch' }).code;
  assert.match(fetchRes, /method: 'POST'/);
  assert.match(fetchRes, /'X-Token': 'abc'/);
  assert.match(fetchRes, /body: JSON\.stringify\(/);

  const pyRes = buildSnippet(sampleReq, { lang: 'python' }).code;
  assert.match(pyRes, /requests\.post\(url, headers=headers, json=payload\)/);
  assert.match(pyRes, /"Content-Type": "application\/json"/);

  const goRes = buildSnippet(sampleReq, { lang: 'go' }).code;
  assert.match(goRes, /http\.NewRequest\("POST"/);
  assert.match(goRes, /req\.Header\.Set\("X-Token", "abc"\)/);

  const javaRes = buildSnippet(sampleReq, { lang: 'java' }).code;
  assert.match(javaRes, /\.method\("POST", body\)/);
  assert.match(javaRes, /\.addHeader\("X-Token", "abc"\)/);
});

test('代码生成：GET 无 body 时不写请求体', () => {
  const get = { method: 'GET', url: 'http://x/y', headers: {}, body_mode: 'none', body: '' };
  const goRes = buildSnippet(get, { lang: 'go' }).code;
  assert.ok(goRes.includes('nil)'), 'GET 应传 nil body');
  assert.ok(!goRes.includes('strings'), '无 body 时不该 import strings');

  const javaRes = buildSnippet(get, { lang: 'java' }).code;
  assert.match(javaRes, /\.get\(\)/);
});

test('代码生成：无法表达的模式给出 warning 而不是伪造数据', () => {
  const bin = { method: 'POST', url: 'http://x/y', headers: {}, body_mode: 'binary', body: '' };
  const res = buildSnippet(bin, { lang: 'fetch' });
  assert.ok(res.warnings.some((w) => w.includes('binary')));
  assert.ok(!res.code.includes('body:'), 'binary 模式不应生成 body');

  const form = { method: 'POST', url: 'http://x/y', headers: {}, body_mode: 'form-data', body: '' };
  assert.ok(buildSnippet(form, { lang: 'python' }).warnings.length > 0);
});

test('代码生成：缺少 URL 时给 warning', () => {
  const res = buildSnippet({ method: 'GET', headers: {}, body_mode: 'none' }, { lang: 'curl' });
  assert.ok(res.warnings.some((w) => w.includes('URL')));
});

test('代码生成：单引号与反引号被正确转义', () => {
  const req = {
    method: 'POST',
    url: "http://x/y?a=it's",
    headers: {},
    body_mode: 'raw',
    body: "it's `tricky` ${x}"
  };
  const fetchRes = buildSnippet(req, { lang: 'fetch' }).code;
  // 非 JSON body 用模板字符串，内部反引号与 ${ 需要转义
  assert.ok(fetchRes.includes('\\`'), '反引号应被转义');
  assert.ok(fetchRes.includes('\\${'), '${ 应被转义');
});

test('代码生成：JSON body 在 JS 里保持可读缩进', () => {
  const res = buildSnippet(sampleReq, { lang: 'fetch' }).code;
  const bodyBlock = res.split('body: JSON.stringify(')[1] || '';
  assert.match(bodyBlock, /^\{\n {4}"name"/, 'JSON 应缩进且首行紧跟括号');
});
