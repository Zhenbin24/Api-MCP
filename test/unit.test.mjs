import test from 'node:test';
import assert from 'node:assert/strict';
import { createVariableScope, renderTemplate, hasTemplate } from '../src/exec/template.js';
import { applyAuth, isAuthSupported } from '../src/exec/auth.js';
import { validateSchema, schemaToSample } from '../src/exec/assert.js';
import { parseOpenApi } from '../src/openapi/convert.js';

test('模板：优先级 环境运行时 > 环境默认 > 全局运行时 > 全局默认', () => {
  const scope = createVariableScope({
    envVars: { a: { value: 'env-default' }, b: { value: 'env-b' } },
    envRuntime: { a: { value: 'env-runtime' } },
    globalVars: { b: { value: 'global-b' }, c: { value: 'global-c' } },
    globalRuntime: { c: { value: 'global-c-runtime' } }
  });
  assert.equal(scope.get('a'), 'env-runtime');
  assert.equal(scope.get('b'), 'env-b');
  assert.equal(scope.get('c'), 'global-c-runtime');
  assert.equal(scope.get('missing'), undefined);
});

test('模板：基本替换与未知占位符保留', () => {
  const scope = createVariableScope({ envVars: { token: { value: 'abc' } } });
  assert.equal(renderTemplate('Bearer {{token}}', scope), 'Bearer abc');
  assert.equal(renderTemplate('x={{unknown}}', scope), 'x={{unknown}}');
  assert.equal(renderTemplate('x={{unknown}}', scope, { keepUnknown: false }), 'x=');
});

test('模板：嵌套与内置函数', () => {
  const scope = createVariableScope({ envVars: { a: { value: '{{b}}' }, b: { value: 'deep' } } });
  assert.equal(renderTemplate('{{a}}', scope), 'deep');

  const ts = renderTemplate('{{$timestamp}}', scope);
  assert.match(ts, /^\d{10}$/);
  assert.match(renderTemplate('{{$uuid}}', scope), /^[0-9a-f-]{36}$/);
});

test('模板：对象深度替换', () => {
  const scope = createVariableScope({ envVars: { host: { value: 'example.com' } } });
  const out = renderTemplate({ url: 'https://{{host}}/a', list: ['{{host}}'] }, scope);
  assert.equal(out.url, 'https://example.com/a');
  assert.equal(out.list[0], 'example.com');
});

test('模板：hasTemplate 检测', () => {
  assert.equal(hasTemplate('a{{b}}'), true);
  assert.equal(hasTemplate('plain'), false);
});

test('鉴权：Bearer / Basic / kv / oauth2', () => {
  const bearer = applyAuth({ type: 'bearer', bearer: { key: 'tk' } });
  assert.equal(bearer.headers.Authorization, 'Bearer tk');

  const basic = applyAuth({ type: 'basic', basic: { username: 'u', password: 'p' } });
  assert.equal(basic.headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);

  const kvHeader = applyAuth({ type: 'kv', kv: { in: 'header', key: 'X-Key', value: 'v' } });
  assert.equal(kvHeader.headers['X-Key'], 'v');

  const kvQuery = applyAuth({ type: 'kv', kv: { in: 'query', key: 'api_key', value: 'v' } });
  assert.equal(kvQuery.query.api_key, 'v');

  const oauth2 = applyAuth({ type: 'oauth2', oauth2: { access_token: 'oat', addTokenTo: 'header', headerPrefix: 'Bearer' } });
  assert.equal(oauth2.headers.Authorization, 'Bearer oat');
});

test('鉴权：inherit 回落到项目默认', () => {
  const res = applyAuth({ type: 'inherit' }, { type: 'bearer', bearer: { key: 'global-tk' } });
  assert.equal(res.headers.Authorization, 'Bearer global-tk');
});

test('鉴权：不支持的类型明确报错', () => {
  assert.equal(isAuthSupported('awsv4'), false);
  assert.throws(() => applyAuth({ type: 'awsv4' }), /暂不支持的鉴权类型/);
});

test('断言：schema 校验通过/失败', () => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' } },
    required: ['id']
  };
  assert.deepEqual(validateSchema(schema, { id: 1, name: 'a' }), []);
  const errors = validateSchema(schema, { name: 'a' });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /缺失必填字段/);
  const typeErr = validateSchema(schema, { id: 'x' });
  assert.equal(typeErr.length, 1);
  assert.match(typeErr[0].message, /期望 integer/);
});

test('断言：schemaToSample', () => {
  const sample = schemaToSample({
    type: 'object',
    properties: { a: { type: 'integer' }, b: { type: 'array', items: { type: 'string' } } }
  });
  assert.deepEqual(sample, { a: 0, b: [''] });
});

test('OpenAPI：解析 3.0 接口与参数', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/users/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        get: {
          summary: '获取用户',
          tags: ['用户'],
          parameters: [{ name: 'verbose', in: 'query', schema: { type: 'boolean' } }],
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'integer' }, name: { type: 'string' } },
                    required: ['id']
                  }
                }
              }
            }
          }
        }
      },
      '/users': {
        post: {
          summary: '创建用户',
          tags: ['用户'],
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { name: { type: 'string' } } }
              }
            }
          },
          responses: { 201: { description: 'created', content: { 'application/json': { schema: { type: 'object' } } } } }
        }
      }
    }
  };

  const parsed = parseOpenApi(spec);
  assert.equal(parsed.items.length, 2);

  const get = parsed.items.find((i) => i.method === 'GET');
  assert.equal(get.url, '/users/{id}');
  assert.equal(get.folderPath[0], '用户');
  assert.equal(get.request.restful.parameter[0].key, 'id');
  assert.equal(get.request.query.parameter[0].key, 'verbose');
  assert.equal(get.response.example[0].expect.code, '200');
  assert.equal(get.response.example[0].expect.schema.properties.id.type, 'integer');

  const post = parsed.items.find((i) => i.method === 'POST');
  assert.equal(post.request.body.mode, 'json');
  assert.equal(post.request.body.raw_schema.properties.name.type, 'string');
});

test('OpenAPI：base_path 拼 server url', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://api.example.com/api' }],
    paths: { '/ping': { get: { responses: { 200: { description: 'ok' } } } } }
  };
  const parsed = parseOpenApi(spec, { basePath: true });
  assert.equal(parsed.items[0].url, 'https://api.example.com/api/ping');
});

test('OpenAPI：拒绝非 3.x', () => {
  assert.throws(() => parseOpenApi({ swagger: '2.0', paths: {} }), /仅支持 OpenAPI 3.0 或 3.1/);
});

test('OpenAPI：$ref 解析', () => {
  const spec = {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    components: {
      schemas: { User: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }
    },
    paths: {
      '/u': {
        get: {
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } }
          }
        }
      }
    }
  };
  const parsed = parseOpenApi(spec);
  const schema = parsed.items[0].response.example[0].expect.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.id.type, 'integer');
  assert.deepEqual(schema.required, ['id']);
});
