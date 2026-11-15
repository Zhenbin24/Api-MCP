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

/** 从 server 实例取 base（listen 后才有 port） */
function base0(instance) {
  const addr = instance.server?.address?.() || instance.address?.();
  return `http://127.0.0.1:${addr.port}`;
}
