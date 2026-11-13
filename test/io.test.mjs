import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeTempRoot, cleanup } from './helpers.mjs';
import { openProject } from '../src/store/target.js';
import { listApiItems, readApiFile, createApiOrFolder, findApiItem, TARGET_TYPE } from '../src/store/apis.js';
import { detectFormat, previewImport, importIntoProject } from '../src/io/import.js';
import { exportProject, projectToOpenApi, projectToPostman } from '../src/io/export.js';
import { yamlToJson, jsonToYaml } from '../src/util/yaml.js';
import { swagger2ToOpenApi } from '../src/io/swagger2.js';
import { parsePostmanCollection } from '../src/io/postman.js';
import { parseHar } from '../src/io/har.js';
import { curlToItems } from '../src/io/curl.js';

/* ---------------- 固定样例 ---------------- */

const OPENAPI_DOC = {
  openapi: '3.0.3',
  info: { title: '演示 API', version: '1.0.0' },
  servers: [{ url: 'https://api.test' }],
  paths: {
    '/users': {
      get: {
        summary: '列出用户',
        tags: ['用户'],
        parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }],
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { total: { type: 'integer' } } }
              }
            }
          }
        }
      }
    },
    '/users/{id}': {
      get: {
        summary: '用户详情',
        tags: ['用户'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } }
      }
    }
  }
};

const SWAGGER_DOC = {
  swagger: '2.0',
  host: 'api.test',
  basePath: '/v1',
  schemes: ['https'],
  consumes: ['application/json'],
  produces: ['application/json'],
  definitions: {
    User: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } }
  },
  paths: {
    '/users': {
      post: {
        summary: '创建用户',
        parameters: [
          { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/User' } },
          { name: 'page', in: 'query', type: 'integer' }
        ],
        responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/User' } } }
      }
    }
  }
};

const POSTMAN_DOC = {
  info: { name: '演示集合', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'base', value: 'https://api.test' }],
  item: [
    {
      name: '用户',
      item: [
        {
          name: '创建用户',
          request: {
            method: 'POST',
            header: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'X-Disabled', value: 'x', disabled: true }
            ],
            auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
            body: { mode: 'raw', raw: '{"name":"x"}', options: { raw: { language: 'json' } } },
            url: {
              raw: '{{base}}/users?dry=1',
              host: ['{{base}}'],
              path: ['users'],
              query: [{ key: 'dry', value: '1' }]
            }
          }
        },
        {
          name: '表单提交',
          request: {
            method: 'PUT',
            header: [],
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'a', value: '1' },
                { key: 'b', value: '2', disabled: true }
              ]
            },
            url: 'https://api.test/form'
          }
        }
      ]
    }
  ]
};

const HAR_DOC = {
  log: {
    version: '1.2',
    creator: { name: '手工录制' },
    entries: [
      {
        request: {
          method: 'POST',
          url: 'https://api.test/orders?page=2',
          headers: [
            { name: 'Accept', value: 'application/json' },
            { name: ':authority', value: 'api.test' },
            { name: 'Host', value: 'api.test' }
          ],
          queryString: [{ name: 'page', value: '2' }],
          postData: { mimeType: 'application/json', text: '{"sku":"a"}' }
        }
      }
    ]
  }
};

const CURL_TEXT = `curl -X POST 'https://api.test/users?page=1' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer abc' \\
  -d '{"name":"a"}'`;

/* ---------------- 工具 ---------------- */

/** 每个用例一个干净项目 */
function withProject(fn) {
  return async () => {
    const env = makeTempRoot();
    try {
      const target = openProject({ dataRoot: env.root, projectId: env.projectId });
      await fn({ env, target, projectId: env.projectId });
    } finally {
      cleanup(env.base);
    }
  };
}

/* ---------------- 格式识别 ---------------- */

test(
  '导入：detectFormat 能识别五种格式',
  withProject(async () => {
    assert.equal(detectFormat(JSON.stringify(OPENAPI_DOC)), 'openapi');
    assert.equal(detectFormat(JSON.stringify(SWAGGER_DOC)), 'swagger');
    assert.equal(detectFormat(JSON.stringify(POSTMAN_DOC)), 'postman');
    assert.equal(detectFormat(JSON.stringify(HAR_DOC)), 'har');
    assert.equal(detectFormat(CURL_TEXT), 'curl');
    // 直接传对象也要能识别
    assert.equal(detectFormat(OPENAPI_DOC), 'openapi');
    assert.equal(detectFormat(SWAGGER_DOC), 'swagger');
  })
);

test(
  '导入：无法识别时给出可读错误',
  withProject(async () => {
    assert.throws(() => detectFormat('{"foo":"bar"}'), /无法识别的格式/);
    assert.throws(() => detectFormat('   '), /内容为空/);
    // 纯文本既不是 JSON 也解析不成 YAML 结构，要提示改用 JSON
    assert.throws(() => previewImport({ payload: '"just a string"' }), /解析失败|无法识别/);
  })
);

/* ---------------- Swagger 2.0 ---------------- */

test('Swagger 2.0：升级到 OpenAPI 3 的 servers / schemas / requestBody', () => {
  const openapi = swagger2ToOpenApi(SWAGGER_DOC);
  assert.equal(openapi.openapi, '3.0.3');
  assert.deepEqual(openapi.servers, [{ url: 'https://api.test/v1' }]);
  assert.ok(openapi.components.schemas.User);
  assert.equal(openapi.components.schemas.User.properties.id.type, 'integer');

  const op = openapi.paths['/users'].post;
  assert.equal(op.requestBody.required, true);
  assert.equal(op.requestBody.content['application/json'].schema.$ref, '#/components/schemas/User');
  // query 参数被 schema 化
  assert.equal(op.parameters[0].name, 'page');
  assert.equal(op.parameters[0].schema.type, 'integer');
  // 响应 schema 也转成 content
  assert.ok(op.responses['200'].content['application/json'].schema);
});

test('Swagger 2.0：非 2.0 版本明确报错', () => {
  assert.throws(() => swagger2ToOpenApi({ swagger: '3.0' }), /仅支持 Swagger 2.0/);
});

/* ---------------- Postman ---------------- */

test('Postman：嵌套目录、urlencoded body、bearer 鉴权', () => {
  const { items, collectionName } = parsePostmanCollection(POSTMAN_DOC);
  assert.equal(collectionName, '演示集合');
  assert.equal(items.length, 2);

  const [create, form] = items;
  assert.deepEqual(create.folderPath, ['用户']);
  assert.equal(create.method, 'POST');
  assert.equal(create.request.auth.type, 'bearer');
  assert.equal(create.request.auth.bearer.key, '{{token}}');
  assert.equal(create.request.body.mode, 'json');
  assert.deepEqual(
    create.request.query.parameter.map((p) => `${p.key}=${p.value}`),
    ['dry=1']
  );
  // disabled 的 header 不导入
  assert.ok(!create.request.header.parameter.some((p) => p.key === 'X-Disabled'));

  assert.equal(form.request.body.mode, 'urlencoded');
  assert.deepEqual(
    form.request.body.parameter.map((p) => p.key),
    ['a']
  );
});

test('Postman：非 v2 schema 明确报错', () => {
  assert.throws(
    () => parsePostmanCollection({ info: { schema: 'https://schema.getpostman.com/json/collection/v1.0.0/' }, item: [] }),
    /仅支持 Postman Collection v2/
  );
});

/* ---------------- HAR ---------------- */

test('HAR：json body 与伪头过滤', () => {
  const { items, collectionName } = parseHar(HAR_DOC);
  assert.equal(collectionName, '手工录制');
  assert.equal(items.length, 1);

  const item = items[0];
  assert.equal(item.method, 'POST');
  assert.equal(item.request.body.mode, 'json');
  // URL 上的 query 被提到参数表，URL 本体去掉 query
  assert.equal(item.url, 'https://api.test/orders');
  assert.deepEqual(item.request.query.parameter.map((p) => p.key), ['page']);
  // HTTP/2 的 :authority 与协议层 Host 都不进参数表
  assert.deepEqual(item.request.header.parameter.map((p) => p.key), ['Accept']);
});

test('HAR：缺 log.entries 明确报错', () => {
  assert.throws(() => parseHar({ foo: 1 }), /不是 HAR 文件/);
});

/* ---------------- cURL ---------------- */

test('cURL：解析单条命令为接口', () => {
  const { items } = curlToItems(CURL_TEXT);
  assert.equal(items.length, 1);
  assert.equal(items[0].method, 'POST');
  assert.equal(items[0].url, 'https://api.test/users');
  assert.equal(items[0].request.body.mode, 'json');
  const headerKeys = items[0].request.header.parameter.map((p) => p.key);
  assert.ok(headerKeys.includes('Content-Type'));
  assert.ok(headerKeys.includes('Authorization'));
  assert.deepEqual(items[0].request.query.parameter.map((p) => p.key), ['page']);
});

test('cURL：多条命令一次导入，非 curl 内容报错', () => {
  const two = `${CURL_TEXT}\n\ncurl 'https://api.test/ping'`;
  const { items } = curlToItems(two);
  assert.equal(items.length, 2);
  assert.throws(() => curlToItems('https://api.test/x'), /没有找到 curl/);
});

/* ---------------- 预览 ---------------- */

test(
  '预览：只解析不落库，返回计数与样例',
  withProject(async ({ target }) => {
    const preview = previewImport({ payload: OPENAPI_DOC });
    assert.equal(preview.format, 'openapi');
    assert.equal(preview.api_count, 2);
    assert.equal(preview.folder_count, 1);
    assert.equal(preview.sample.length, 2);
    assert.equal(preview.truncated, false);
    // 没写盘
    assert.equal(listApiItems(target).length, 0);
  })
);

test(
  '预览：空接口文档报错',
  withProject(async () => {
    const empty = { openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} };
    assert.throws(() => previewImport({ payload: empty }), /没有解析出任何可导入的接口/);
  })
);

/* ---------------- 落库 ---------------- */

test(
  '导入：OpenAPI 建出目录与接口',
  withProject(async ({ target, projectId }) => {
    const result = importIntoProject(target, { projectId, payload: OPENAPI_DOC });
    assert.equal(result.summary.created, 2);
    assert.equal(result.summary.updated, 0);

    const items = listApiItems(target);
    const folders = items.filter((i) => i.target_type === TARGET_TYPE.FOLDER);
    const apis = items.filter((i) => i.target_type === TARGET_TYPE.API);
    assert.equal(folders.length, 1, 'tags 应建出一个目录');
    assert.equal(folders[0].name, '用户');
    assert.equal(apis.length, 2);
    assert.ok(apis.every((a) => a.parent_id === folders[0].target_id), '接口应挂在目录下');

    // 落盘的接口文件带 query 参数
    const detail = readApiFile(target, apis.find((a) => a.url === '/users').target_id);
    assert.equal(detail.data.request.query.parameter[0].key, 'page');
  })
);

test(
  '导入：folder_id 指定目录',
  withProject(async ({ target, projectId }) => {
    const folder = createApiOrFolder(target, { name: '自定义目录', targetType: TARGET_TYPE.FOLDER, parentId: '0' });
    const result = importIntoProject(target, {
      projectId,
      payload: OPENAPI_DOC,
      folderId: folder.target_id
    });
    assert.equal(result.summary.created, 2);

    // 「用户」目录应建在自定义目录下
    const items = listApiItems(target);
    const userFolder = items.find((i) => i.target_type === TARGET_TYPE.FOLDER && i.name === '用户');
    assert.equal(userFolder.parent_id, folder.target_id);
  })
);

test(
  '导入：url_and_folder 覆盖同目录接口，ignore 跳过',
  withProject(async ({ target, projectId }) => {
    importIntoProject(target, { projectId, payload: OPENAPI_DOC, coverMode: 'url_and_folder' });

    // 再导一次：都应命中 updated
    const again = importIntoProject(target, { projectId, payload: OPENAPI_DOC, coverMode: 'url_and_folder' });
    assert.equal(again.summary.created, 0);
    assert.equal(again.summary.updated, 2);

    // ignore 模式下全部跳过
    const skipped = importIntoProject(target, { projectId, payload: OPENAPI_DOC, coverMode: 'ignore' });
    assert.equal(skipped.summary.created, 0);
    assert.equal(skipped.summary.skipped, 2);

    // both 允许重复
    const both = importIntoProject(target, { projectId, payload: OPENAPI_DOC, coverMode: 'both' });
    assert.equal(both.summary.created, 2);
  })
);

test(
  '导入：无效覆盖方式与无效目录报错',
  withProject(async ({ target, projectId }) => {
    assert.throws(
      () => importIntoProject(target, { projectId, payload: OPENAPI_DOC, coverMode: 'bogus' }),
      /api_cover_mode 无效/
    );
    assert.throws(
      () => importIntoProject(target, { projectId, payload: OPENAPI_DOC, folderId: 'not-a-folder' }),
      /未找到指定的导入目录/
    );
  })
);

/* ---------------- 导出 ---------------- */

test(
  '导出：OpenAPI 保留目录为 tags、path 与参数',
  withProject(async ({ target, projectId }) => {
    importIntoProject(target, { projectId, payload: OPENAPI_DOC });
    const doc = projectToOpenApi(target, { projectId });

    assert.equal(doc.openapi, '3.0.3');
    assert.deepEqual(Object.keys(doc.paths).sort(), ['/users', '/users/{id}']);
    assert.equal(doc.paths['/users'].get.summary, '列出用户');
    assert.deepEqual(doc.paths['/users'].get.tags, ['用户']);
    assert.ok(doc.paths['/users'].get.parameters.some((p) => p.name === 'page' && p.in === 'query'));
    assert.equal(doc.paths['/users/{id}'].get.parameters[0].in, 'path');
    assert.equal(doc.paths['/users/{id}'].get.parameters[0].required, true);
    assert.ok(doc.tags.some((t) => t.name === '用户'));
  })
);

test(
  '导出：往返一致 —— 导出再导入命中 updated 而不是重复新建',
  withProject(async ({ target, projectId }) => {
    importIntoProject(target, { projectId, payload: OPENAPI_DOC });
    const exported = exportProject(target, { projectId, format: 'openapi' });

    assert.match(exported.filename, /\.openapi\.json$/);
    assert.match(exported.mime, /application\/json/);

    const roundtrip = importIntoProject(target, { projectId, payload: exported.content });
    assert.equal(roundtrip.summary.created, 0, '不应重复新建');
    assert.equal(roundtrip.summary.updated, 2, '导出的 2 个接口回导后都应命中');
  })
);

test(
  '导出：YAML 能再被解析回来',
  withProject(async ({ target, projectId }) => {
    importIntoProject(target, { projectId, payload: OPENAPI_DOC });
    const yamlOut = exportProject(target, { projectId, format: 'openapi_yaml' });
    assert.match(yamlOut.filename, /\.openapi\.yaml$/);

    const parsed = yamlToJson(yamlOut.content);
    assert.equal(parsed.openapi, '3.0.3');
    assert.deepEqual(Object.keys(parsed.paths).sort(), ['/users', '/users/{id}']);

    const preview = previewImport({ payload: yamlOut.content });
    assert.equal(preview.api_count, 2);
  })
);

test(
  '导出：Postman v2.1 结构正确并能回导',
  withProject(async ({ target, projectId }) => {
    importIntoProject(target, { projectId, payload: OPENAPI_DOC });
    const pm = exportProject(target, { projectId, format: 'postman' });
    const collection = JSON.parse(pm.content);

    assert.equal(collection.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    assert.ok(Array.isArray(collection.item));

    // 目录节点嵌套
    const folder = collection.item.find((i) => i.name === '用户');
    assert.ok(folder, '应有「用户」目录节点');
    assert.ok(Array.isArray(folder.item));
    assert.equal(folder.item.length, 2);

    // 回导
    const preview = previewImport({ payload: pm.content });
    assert.equal(preview.api_count, 2);
    assert.equal(preview.folder_count, 1);
  })
);

test(
  '导出：鉴权与 Body 会带出去',
  withProject(async ({ target, projectId }) => {
    const created = createApiOrFolder(target, {
      name: '登录',
      method: 'POST',
      url: '/login',
      detail: {
        request: {
          auth: { type: 'bearer', bearer: { key: '{{token}}' } },
          body: {
            binary: null,
            mode: 'json',
            parameter: [],
            raw: '{"user":"a"}',
            raw_parameter: [],
            raw_schema: { type: 'object', properties: { user: { type: 'string' } } }
          },
          cookie: { parameter: [] },
          header: { parameter: [] },
          post_tasks: [],
          pre_tasks: [],
          query: { parameter: [] },
          restful: { parameter: [] }
        }
      }
    });
    assert.ok(created.target_id);

    const doc = projectToOpenApi(target, { projectId });
    const op = doc.paths['/login'].post;
    assert.ok(op.requestBody, 'body 应转成 requestBody');
    assert.equal(op.requestBody.content['application/json'].schema.properties.user.type, 'string');

    const collection = projectToPostman(target, { projectId });
    const item = collection.item.find((i) => i.name === '登录');
    assert.equal(item.request.auth.type, 'bearer');
    assert.equal(item.request.auth.bearer[0].value, '{{token}}');
    assert.equal(item.request.body.mode, 'raw');
  })
);

test(
  '导出：不支持的格式报错',
  withProject(async ({ target, projectId }) => {
    assert.throws(() => exportProject(target, { projectId, format: 'apifox' }), /不支持的导出格式/);
  })
);

/* ---------------- YAML 工具 ---------------- */

test('YAML：解析与序列化往返', () => {
  const source = `openapi: 3.0.3
info:
  title: 演示
  version: 1.0.0
servers:
  - url: https://api.test
    description: 生产
paths:
  /users:
    get:
      summary: 列出用户
      parameters:
        - name: page
          in: query
          schema: { type: integer, default: 1 }
`;
  const json = yamlToJson(source);
  assert.equal(json.info.title, '演示');
  assert.equal(json.servers[0].url, 'https://api.test');
  assert.equal(json.paths['/users'].get.parameters[0].schema.type, 'integer');

  const back = yamlToJson(jsonToYaml(json));
  assert.deepEqual(back, json);
});

test('YAML：块标量与多行字符串', () => {
  const src = `desc: |
  第一行
  第二行
folded: >
  a
  b
`;
  const json = yamlToJson(src);
  assert.equal(json.desc, '第一行\n第二行\n');
  assert.equal(json.folded, 'a b\n');

  // 序列化后能读回来
  const back = yamlToJson(jsonToYaml(json));
  assert.deepEqual(back, json);
});

test('YAML：缩进异常与无法解析的行会报错', () => {
  assert.throws(() => yamlToJson('a: 1\n  b: 2\n c: 3'), /YAML/);
  assert.throws(() => yamlToJson('just a bare line'), /YAML/);
});
