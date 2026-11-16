import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot, cleanup } from './helpers.mjs';
import { createServer } from '../src/server/serve.js';
import { defaultConfig } from '../src/server/config.js';

async function boot() {
  const env = makeTempRoot();
  const config = {
    ...defaultConfig(),
    enabled: true,
    token: 'test-token',
    ui_token: 'test-ui',
    port: 0,
    data_root: env.root,
    allowed_project_ids: []
  };
  const instance = createServer({ config, dataRoot: env.root });
  const address = await instance.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'X-UI-Token': 'test-ui', 'Content-Type': 'application/json' };
  const req = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
  return { env, instance, req, base };
}

/** 建一个「目录 + 接口（带参数 / body / 响应示例）」的项目 */
async function seed(req, projectId) {
  const folder = await req('POST', `/api/projects/${projectId}/apis`, {
    name: '用户模块',
    target_type: 'folder',
    parent_id: '0'
  });
  assert.equal(folder.data.ok, true);

  const api = await req('POST', `/api/projects/${projectId}/apis`, {
    name: '创建用户',
    target_type: 'api',
    method: 'POST',
    url: 'http://127.0.0.1:8000/users',
    parent_id: folder.data.target_id
  });
  assert.equal(api.data.ok, true);

  const detail = await req('GET', `/api/projects/${projectId}/apis/${api.data.target_id}`);
  const data = detail.data.data;
  data.description = '创建一个新用户。';
  data.request.query.parameter = [
    { key: 'verbose', value: '1', field_type: 'String', description: '是否详细', is_checked: 1, not_null: -1, param_id: 'q1' }
  ];
  data.request.header.parameter = [
    { key: 'X-Token', value: '{{token}}', field_type: 'String', description: '鉴权', is_checked: 1, not_null: 1, param_id: 'h1' }
  ];
  data.request.body.mode = 'json';
  data.request.body.raw = '{"name":"张三","age":18}';
  data.response.example = [
    { example_id: 'e1', expect: { code: '200', name: '成功', content_type: 'json' }, raw: '{"id":1,"name":"张三"}' }
  ];
  await req('PUT', `/api/projects/${projectId}/apis/${api.data.target_id}`, { data });

  return { folderId: folder.data.target_id, apiId: api.data.target_id };
}

test('文档导出：markdown 包含目录、方法、URL、参数表与 body', async () => {
  const { env, instance, req } = await boot();
  try {
    await seed(req, env.projectId);
    const res = await req('GET', `/api/projects/${env.projectId}/export?format=markdown`);
    assert.equal(res.status, 200);
    // 返回的是纯文本，req() 解析失败时会保留字符串
    const text = res.data;
    assert.ok(typeof text === 'string');
    assert.match(text, /# /, '应有一级标题');
    assert.match(text, /## 用户模块/, '目录应成为二级标题');
    assert.match(text, /### 创建用户/);
    assert.match(text, /`POST` `http:\/\/127\.0\.0\.1:8000\/users`/);
    assert.match(text, /创建一个新用户。/);
    assert.match(text, /\| verbose \| String \|/);
    assert.match(text, /```json\n\{"name":"张三","age":18\}\n```/);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('文档导出：空壳响应示例不生成假 JSON 代码块', async () => {
  const { env, instance, req } = await boot();
  try {
    // 只建接口，不动响应示例 —— 默认模板是空对象
    await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '空示例接口',
      target_type: 'api',
      method: 'GET',
      url: 'http://127.0.0.1:8000/empty',
      parent_id: '0'
    });
    const res = await req('GET', `/api/projects/${env.projectId}/export?format=markdown`);
    const text = res.data;
    assert.match(text, /### 空示例接口/);
    assert.ok(!text.includes('```json\n{\n'), '空壳示例不该输出代码块');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('文档导出：html 自包含且带样式', async () => {
  const { env, instance, req } = await boot();
  try {
    await seed(req, env.projectId);
    const res = await req('GET', `/api/projects/${env.projectId}/export?format=html`);
    const text = res.data;
    assert.match(text, /<!doctype html>/i);
    assert.match(text, /<style>/, '样式应内联，保证离线可看');
    assert.match(text, /<h2>用户模块<\/h2>/);
    assert.match(text, /<table>/);
    assert.match(text, /@media print/, '应包含打印样式');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('文档导出：word 输出 .doc 与 application/msword', async () => {
  const { env, instance, req } = await boot();
  try {
    await seed(req, env.projectId);
    const res = await fetch(`${base0(instance)}/api/projects/${env.projectId}/export?format=word`, {
      headers: { 'X-UI-Token': 'test-ui' }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/msword/);
    const text = await res.text();
    assert.match(text, /xmlns:w="urn:schemas-microsoft-com:office:word"/, '应有 Word 命名空间');
    assert.match(text, /创建用户/);

    const cd = res.headers.get('content-disposition') || '';
    assert.match(cd, /\.doc/);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('文档页 /doc：返回只读 HTML，缺少参数时报 400', async () => {
  const { env, instance, base } = await boot();
  try {
    const noParam = await fetch(`${base}/doc?ui=test-ui`);
    assert.equal(noParam.status, 400);

    const badProject = await fetch(`${base}/doc?project=nope&ui=test-ui`);
    assert.equal(badProject.status, 404);

    const ok = await fetch(`${base}/doc?project=${env.projectId}&ui=test-ui`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') || '', /text\/html/);
    const html = await ok.text();
    assert.match(html, /<div class="doc">/);

    // 没有 ui token 时应被挡掉
    const denied = await fetch(`${base}/doc?project=${env.projectId}`);
    assert.equal(denied.status, 401);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

/* ---------------- example_value：设计页示例值与导出兜底 ---------------- */

test('文档导出：旧数据（只有 value）示例值仍正确回落', async () => {
  const { env, instance, req } = await boot();
  try {
    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '旧数据接口',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/legacy'
    });
    const id = api.data.target_id;

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    // 只有 value，没有 example_value
    data.request.query.parameter = [
      { key: 'page', value: '3', field_type: 'Integer', description: '页码', is_checked: 1, not_null: -1, param_id: 'q1' }
    ];
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

    // OpenAPI：example 应回落到 value
    const openapi = await req('GET', `/api/projects/${env.projectId}/export?format=openapi`);
    const spec = typeof openapi.data === 'string' ? JSON.parse(openapi.data) : openapi.data;
    const params = spec.paths['/legacy'].get.parameters;
    const page = params.find((p) => p.name === 'page');
    assert.ok(page, '应导出 page 参数');
    assert.equal(page.example, '3', '没有 example_value 时应回落到 value');

    // Markdown：示例值列应显示 value
    const md = await req('GET', `/api/projects/${env.projectId}/export?format=markdown`);
    assert.match(String(md.data), /\|\s*page\s*\|.*\|\s*3\s*\|/);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('文档导出：有 example_value 时优先取示例值', async () => {
  const { env, instance, req } = await boot();
  try {
    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '新数据接口',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/newschema'
    });
    const id = api.data.target_id;

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    // 设计页示例值与调试页实际值不同
    data.request.query.parameter = [
      {
        key: 'page',
        value: '99',
        example_value: '1',
        field_type: 'Integer',
        description: '页码',
        is_checked: 1,
        not_null: -1,
        param_id: 'q1'
      }
    ];
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

    const openapi = await req('GET', `/api/projects/${env.projectId}/export?format=openapi`);
    const spec = typeof openapi.data === 'string' ? JSON.parse(openapi.data) : openapi.data;
    const page = spec.paths['/newschema'].get.parameters.find((p) => p.name === 'page');
    assert.equal(page.example, '1', '有 example_value 时应优先取它，而不是发送用的 value');

    const md = await req('GET', `/api/projects/${env.projectId}/export?format=markdown`);
    const text = String(md.data);
    assert.match(text, /\|\s*page\s*\|.*\|\s*1\s*\|/, 'Markdown 示例值列应取 example_value');
    assert.equal(/\|\s*page\s*\|.*\|\s*99\s*\|/.test(text), false, '不应把发送用的 value 当成示例值');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

/** 从 server 实例取 base（listen 后才有 port） */
function base0(instance) {
  const addr = instance.server?.address?.() || instance.address?.();
  return `http://127.0.0.1:${addr.port}`;
}

/* ---------------- 单接口 / 单目录导出（分享与外部调用 OpenAPI 复用） ---------------- */

test('导出：api= 与 folder= 能把范围收窄到单个接口 / 单个目录', async () => {
  const { env, instance, req, base } = await boot();
  try {
    const { folderId, apiId } = await seed(req, env.projectId);

    // 另一个接口放在根目录，用来验证不会被带上
    const other = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '根目录接口',
      target_type: 'api',
      method: 'GET',
      url: 'http://127.0.0.1:8000/other',
      parent_id: '0'
    });
    const otherId = other.data.target_id;

    // ---- OpenAPI：只含指定接口 ----
    const single = await req('GET', `/api/projects/${env.projectId}/export?format=openapi&api=${apiId}`);
    const spec = typeof single.data === 'string' ? JSON.parse(single.data) : single.data;
    assert.ok(spec.paths['/users'], '应包含指定接口的 path');
    assert.equal(spec.paths['/other'], undefined, '不应包含其他接口');

    // ---- OpenAPI：按目录导出 ----
    const byFolder = await req('GET', `/api/projects/${env.projectId}/export?format=openapi&folder=${folderId}`);
    const folderSpec = typeof byFolder.data === 'string' ? JSON.parse(byFolder.data) : byFolder.data;
    assert.ok(folderSpec.paths['/users']);
    assert.equal(folderSpec.paths['/other'], undefined, '目录外接口不应出现');

    // ---- 只读文档页：单接口 ----
    const doc = await fetch(`${base}/doc?project=${env.projectId}&api=${apiId}&ui=test-ui`);
    assert.equal(doc.status, 200);
    const html = await doc.text();
    assert.match(html, /创建用户/, '应包含该接口名称');
    assert.equal(html.includes('根目录接口'), false, '不应包含其他接口');

    // ---- 不传 api/folder 时仍是整个项目 ----
    const all = await req('GET', `/api/projects/${env.projectId}/export?format=openapi`);
    const allSpec = typeof all.data === 'string' ? JSON.parse(all.data) : all.data;
    assert.ok(allSpec.paths['/users']);
    assert.ok(allSpec.paths['/other'], '默认应导出整个项目');

    // 清理用：确保 otherId 已使用，避免未使用变量告警
    assert.ok(otherId);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});
