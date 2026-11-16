import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evalJsonPath,
  evalXmlPath,
  resolveSource,
  checkCondition,
  runVisualAssertions
} from '../src/exec/assert-visual.js';

/* ---------------- JSONPath ---------------- */

const SAMPLE = {
  code: 0,
  msg: 'ok',
  data: {
    name: 'alice',
    tags: ['a', 'b', 'c'],
    list: [{ id: 1 }, { id: 2 }]
  }
};

test('evalJsonPath：根路径与点号属性', () => {
  assert.deepEqual(evalJsonPath(SAMPLE, '$').value, SAMPLE);
  assert.equal(evalJsonPath(SAMPLE, '$.code').value, 0);
  assert.equal(evalJsonPath(SAMPLE, '$.data.name').value, 'alice');
});

test('evalJsonPath：不写 $ 前缀时报错', () => {
  const res = evalJsonPath(SAMPLE, 'code');
  assert.equal(res.ok, false);
  assert.match(res.error, /\$ 开头/);
});

test('evalJsonPath：方括号引号属性与下标', () => {
  assert.equal(evalJsonPath(SAMPLE, "$['data']['name']").value, 'alice');
  assert.equal(evalJsonPath(SAMPLE, '$.data.tags[0]').value, 'a');
  assert.equal(evalJsonPath(SAMPLE, '$.data.tags[2]').value, 'c');
  assert.equal(evalJsonPath(SAMPLE, '$.data.tags[-1]').value, 'c');
});

test('evalJsonPath：数组对象属性', () => {
  assert.equal(evalJsonPath(SAMPLE, '$.data.list[1].id').value, 2);
});

test('evalJsonPath：通配返回数组', () => {
  const res = evalJsonPath(SAMPLE, '$.data.tags[*]');
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, ['a', 'b', 'c']);
});

test('evalJsonPath：缺失字段返回 undefined 而不是报错', () => {
  const res = evalJsonPath(SAMPLE, '$.not.exist');
  assert.equal(res.ok, true);
  assert.equal(res.value, undefined);
});

test('evalJsonPath：越界下标返回 undefined', () => {
  assert.equal(evalJsonPath(SAMPLE, '$.data.tags[99]').value, undefined);
});

test('evalJsonPath：不支持递归下降时明确报错', () => {
  const res = evalJsonPath(SAMPLE, '$..name');
  assert.equal(res.ok, false);
  assert.match(res.error, /递归下降/);
});

/* ---------------- XML ---------------- */

test('evalXmlPath：按标签路径取值', () => {
  const xml = '<root><name>alice</name><info><age>30</age></info></root>';
  assert.equal(evalXmlPath(xml, '/root/name').value, 'alice');
  assert.equal(evalXmlPath(xml, 'root/info/age').value, '30');
});

test('evalXmlPath：标签不存在返回 undefined', () => {
  assert.equal(evalXmlPath('<root><a>1</a></root>', '/root/b').value, undefined);
});

test('evalXmlPath：带属性也能命中', () => {
  const xml = '<root><item id="7">value</item></root>';
  assert.equal(evalXmlPath(xml, '/root/item').value, 'value');
});

test('evalXmlPath：空路径返回全文', () => {
  assert.equal(evalXmlPath('<a>x</a>', '').value, '<a>x</a>');
});

/* ---------------- 数据源 ---------------- */

const CTX = {
  response: {
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-trace': 'abc123' },
    setCookies: ['session=xyz; Path=/', 'theme=dark'],
    bodyText: JSON.stringify(SAMPLE),
    bodyJson: SAMPLE
  },
  elapsedMs: 123,
  variables: { get: (k) => (k === 'token' ? 'tok-1' : undefined) },
  envVars: { base: { value: 'http://api.test' }, host: { current_value: 'live.host', value: 'init.host' } },
  globalVars: { shared: { value: 'g-value' } },
  apiDetail: {
    response: {
      example: [
        {
          example_id: 'ex1',
          expect: { is_default: 1, schema: { type: 'object', properties: { code: { type: 'integer' } } } }
        },
        { example_id: 'ex2', expect: { is_default: -1, schema: { type: 'object', properties: { alt: { type: 'string' } } } } }
      ]
    }
  }
};

test('resolveSource：status_code / elapsed_time / content_type', () => {
  assert.equal(resolveSource('status_code', '', CTX).value, 201);
  assert.equal(resolveSource('elapsed_time', '', CTX).value, 123);
  assert.match(String(resolveSource('content_type', '', CTX).value), /json/);
});

test('resolveSource：response_header 大小写不敏感', () => {
  assert.equal(resolveSource('response_header', 'X-Trace', CTX).value, 'abc123');
  assert.equal(resolveSource('response_header', 'x-trace', CTX).value, 'abc123');
  assert.equal(resolveSource('response_header', 'missing', CTX).value, undefined);
});

test('resolveSource：response_header 缺表达式时报错', () => {
  const res = resolveSource('response_header', '', CTX);
  assert.equal(res.ok, false);
  assert.match(res.error, /Header 名/);
});

test('resolveSource：response_cookie 从 Set-Cookie 取值', () => {
  assert.equal(resolveSource('response_cookie', 'session', CTX).value, 'xyz');
  assert.equal(resolveSource('response_cookie', 'theme', CTX).value, 'dark');
  assert.equal(resolveSource('response_cookie', 'missing', CTX).value, undefined);
});

test('resolveSource：response_json 走 JSONPath', () => {
  assert.equal(resolveSource('response_json', '$.data.name', CTX).value, 'alice');
  assert.equal(resolveSource('response_json', '$.code', CTX).value, 0);
});

test('resolveSource：response_json 非 JSON 响应时报错', () => {
  const res = resolveSource('response_json', '$.a', {
    response: { bodyText: 'plain text', headers: {}, setCookies: [] }
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /不是合法 JSON/);
});

test('resolveSource：response_xml', () => {
  const res = resolveSource('response_xml', '/root/name', {
    response: { bodyText: '<root><name>bob</name></root>', headers: {}, setCookies: [] }
  });
  assert.equal(res.value, 'bob');
});

test('resolveSource：response_schema 默认取 is_default 那条', () => {
  const res = resolveSource('response_schema', 'default', CTX);
  assert.equal(res.ok, true);
  assert.equal(res.value.properties.code.type, 'integer');

  const byId = resolveSource('response_schema', 'ex2', CTX);
  assert.equal(byId.value.properties.alt.type, 'string');
});

test('resolveSource：response_schema 没有示例时报错', () => {
  const res = resolveSource('response_schema', 'default', { response: {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /JSON Schema/);
});

test('resolveSource：var / env_var / global_var', () => {
  assert.equal(resolveSource('var', 'token', CTX).value, 'tok-1');
  assert.equal(resolveSource('var', 'nope', CTX).value, undefined);
  assert.equal(resolveSource('env_var', 'base', CTX).value, 'http://api.test');
  // current_value 优先于 value
  assert.equal(resolveSource('env_var', 'host', CTX).value, 'live.host');
  assert.equal(resolveSource('global_var', 'shared', CTX).value, 'g-value');
});

test('resolveSource：未知数据源报错', () => {
  const res = resolveSource('nonsense', '', CTX);
  assert.equal(res.ok, false);
  assert.match(res.error, /未知数据源/);
});

/* ---------------- 条件 ---------------- */

test('checkCondition：equal 宽松比较数字与数字字符串', () => {
  assert.equal(checkCondition('equal', 200, '200').passed, true);
  assert.equal(checkCondition('equal', 'abc', 'abc').passed, true);
  assert.equal(checkCondition('equal', 0, '0').passed, true);
  assert.equal(checkCondition('equal', 1, '2').passed, false);
});

test('checkCondition：equal 比较对象按 JSON', () => {
  assert.equal(checkCondition('equal', { a: 1 }, JSON.stringify({ a: 1 })).passed, true);
  assert.equal(checkCondition('equal', { a: 1 }, JSON.stringify({ a: 2 })).passed, false);
});

test('checkCondition：not_equal', () => {
  assert.equal(checkCondition('not_equal', 200, '500').passed, true);
  assert.equal(checkCondition('not_equal', 200, '200').passed, false);
});

test('checkCondition：include 支持字符串 / 数组 / 对象', () => {
  assert.equal(checkCondition('include', 'hello world', 'world').passed, true);
  assert.equal(checkCondition('include', ['a', 'b'], 'b').passed, true);
  assert.equal(checkCondition('include', { code: 0 }, 'code').passed, true);
  assert.equal(checkCondition('include', 'hello', 'zzz').passed, false);
});

test('checkCondition：not_include', () => {
  assert.equal(checkCondition('not_include', 'hello', 'zzz').passed, true);
  assert.equal(checkCondition('not_include', 'hello', 'ell').passed, false);
});

test('checkCondition：regex 匹配与非法正则', () => {
  assert.equal(checkCondition('regex', 'abc-123', '^abc-\\d+$').passed, true);
  assert.equal(checkCondition('regex', 'abc', '^\\d+$').passed, false);
  const bad = checkCondition('regex', 'abc', '[unclosed');
  assert.equal(bad.passed, false);
  assert.match(bad.message, /正则表达式不合法/);
});

test('checkCondition：数值比较 gt / lt / gte / lte', () => {
  assert.equal(checkCondition('gt', 10, '5').passed, true);
  assert.equal(checkCondition('gt', 5, '5').passed, false);
  assert.equal(checkCondition('lt', 3, '5').passed, true);
  assert.equal(checkCondition('gte', 5, '5').passed, true);
  assert.equal(checkCondition('lte', 5, '5').passed, true);
});

test('checkCondition：非数值参与比较时明确失败', () => {
  const res = checkCondition('gt', 'abc', '5');
  assert.equal(res.passed, false);
  assert.match(res.message, /无法按数值比较/);
});

test('checkCondition：length_equal 覆盖字符串 / 数组 / 对象', () => {
  assert.equal(checkCondition('length_equal', 'abcd', '4').passed, true);
  assert.equal(checkCondition('length_equal', [1, 2, 3], '3').passed, true);
  assert.equal(checkCondition('length_equal', { a: 1, b: 2 }, '2').passed, true);
  assert.equal(checkCondition('length_equal', 'abc', '9').passed, false);
});

test('checkCondition：exists', () => {
  assert.equal(checkCondition('exists', 0, '').passed, true, '0 算存在');
  assert.equal(checkCondition('exists', '', '').passed, true, '空串算存在');
  assert.equal(checkCondition('exists', undefined, '').passed, false);
  assert.equal(checkCondition('exists', null, '').passed, false);
});

test('checkCondition：empty', () => {
  assert.equal(checkCondition('empty', '', '').passed, true);
  assert.equal(checkCondition('empty', null, '').passed, true);
  assert.equal(checkCondition('empty', [], '').passed, true);
  assert.equal(checkCondition('empty', {}, '').passed, true);
  assert.equal(checkCondition('empty', 'x', '').passed, false);
  assert.equal(checkCondition('empty', 0, '').passed, false);
});

test('checkCondition：type_is', () => {
  assert.equal(checkCondition('type_is', 'abc', 'string').passed, true);
  assert.equal(checkCondition('type_is', 1.5, 'number').passed, true);
  assert.equal(checkCondition('type_is', 3, 'integer').passed, true);
  assert.equal(checkCondition('type_is', [1], 'array').passed, true);
  assert.equal(checkCondition('type_is', null, 'null').passed, true);
  assert.equal(checkCondition('type_is', 'abc', 'number').passed, false);
});

test('checkCondition：schema_match 复用 validateSchema', () => {
  const schema = { type: 'object', properties: { code: { type: 'integer' } }, required: ['code'] };
  const okCtx = { response: { bodyJson: { code: 0 } } };
  const badCtx = { response: { bodyJson: { code: 'x' } } };

  assert.equal(checkCondition('schema_match', schema, '', okCtx).passed, true);
  const bad = checkCondition('schema_match', schema, '', badCtx);
  assert.equal(bad.passed, false);
  assert.match(bad.message, /\$\.code/);
});

test('checkCondition：schema_not_match', () => {
  const schema = { type: 'object', properties: { code: { type: 'integer' } } };
  const okCtx = { response: { bodyJson: { code: 0 } } };
  const badCtx = { response: { bodyJson: { code: 'x' } } };
  assert.equal(checkCondition('schema_not_match', schema, '', badCtx).passed, true);
  assert.equal(checkCondition('schema_not_match', schema, '', okCtx).passed, false);
});

test('checkCondition：schema 缺失时明确失败', () => {
  const res = checkCondition('schema_match', null, '', { response: { bodyJson: {} } });
  assert.equal(res.passed, false);
  assert.match(res.message, /JSON Schema/);
});

test('checkCondition：未知条件', () => {
  const res = checkCondition('nonsense', 1, '1');
  assert.equal(res.passed, false);
  assert.match(res.message, /未知条件/);
});

/* ---------------- 主入口 ---------------- */

function task(data, extra = {}) {
  return { id: 'as_1', type: 'assert', name: '', enabled: 1, data, ...extra };
}

test('runVisualAssertions：忽略非 assert 任务与被禁用的断言', () => {
  const tasks = [
    { type: 'customScript', enabled: 1, data: 'console.log(1)' },
    task({ source: 'status_code', condition: 'equal', value: '201' }, { enabled: -1 }),
    task({ source: 'status_code', condition: 'equal', value: '201' })
  ];
  const out = runVisualAssertions(tasks, CTX);
  assert.equal(out.length, 1);
  assert.equal(out[0].passed, true);
});

test('runVisualAssertions：空任务返回空数组', () => {
  assert.deepEqual(runVisualAssertions([], CTX), []);
  assert.deepEqual(runVisualAssertions(null, CTX), []);
});

test('runVisualAssertions：通过时带 source / expected / actual', () => {
  const out = runVisualAssertions(
    [task({ source: 'response_json', expression: '$.code', condition: 'equal', value: '0' })],
    CTX
  );
  assert.equal(out.length, 1);
  const a = out[0];
  assert.equal(a.passed, true);
  assert.equal(a.phase, 'assert');
  assert.equal(a.source, 'response_json');
  assert.equal(a.expression, '$.code');
  assert.equal(a.expected, '0');
  assert.equal(a.actual, 0);
  assert.equal(a.message, undefined);
});

test('runVisualAssertions：失败时给出原因', () => {
  const out = runVisualAssertions(
    [task({ source: 'response_json', expression: '$.code', condition: 'equal', value: '500' })],
    CTX
  );
  assert.equal(out[0].passed, false);
  assert.match(out[0].message, /期望等于/);
});

test('runVisualAssertions：取值失败（响应非 JSON）也记为失败', () => {
  const out = runVisualAssertions(
    [task({ source: 'response_json', expression: '$.a', condition: 'exists', value: '' })],
    { response: { bodyText: 'plain', headers: {}, setCookies: [] } }
  );
  assert.equal(out[0].passed, false);
  assert.match(out[0].message, /不是合法 JSON/);
});

test('runVisualAssertions：未填比较值的条件不带 expected', () => {
  const out = runVisualAssertions(
    [task({ source: 'response_header', expression: 'x-trace', condition: 'exists', value: '' })],
    CTX
  );
  assert.equal(out[0].passed, true);
  assert.equal(out[0].expected, undefined);
});

test('runVisualAssertions：命名优先用显式名称', () => {
  const named = runVisualAssertions(
    [task({ source: 'status_code', condition: 'equal', value: '201' }, { name: '登录成功' })],
    CTX
  );
  assert.equal(named[0].name, '登录成功');

  // 默认名（断言1 / 断言）会替换成自动拼的描述
  const auto = runVisualAssertions(
    [task({ source: 'status_code', condition: 'equal', value: '201' }, { name: '断言1' })],
    CTX
  );
  assert.match(auto[0].name, /响应码/);
});

test('runVisualAssertions：多条断言保持顺序', () => {
  const out = runVisualAssertions(
    [
      task({ source: 'status_code', condition: 'equal', value: '201' }, { name: '第一条' }),
      task({ source: 'response_json', expression: '$.msg', condition: 'equal', value: 'ok' }, { name: '第二条' })
    ],
    CTX
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].name, '第一条');
  assert.equal(out[1].name, '第二条');
  assert.ok(out.every((a) => a.passed));
});

test('runVisualAssertions：schema 断言端到端', () => {
  const out = runVisualAssertions(
    [task({ source: 'response_schema', expression: 'default', condition: 'schema_match', value: '' }, { name: '结构' })],
    CTX
  );
  // SAMPLE 里 code 是 integer，应通过
  assert.equal(out[0].passed, true, out[0].message);
});
