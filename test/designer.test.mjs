import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http2 from 'node:http2';
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
  const instance = createServer({ config, officialRoot: env.root });
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

/* ---------------- 另存为 ---------------- */

test('另存为：完整复制接口内容', async () => {
  const { env, instance, req } = await boot();
  try {

    const src = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '源接口',
      target_type: 'api',
      method: 'POST',
      url: 'https://api.test/src'
    });
    const srcId = src.data.target_id;

    // 写入丰富内容
    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${srcId}`);
    const data = detail.data.data;
    data.description = '源描述';
    data.tags = ['标签A', '标签B'];
    data.mark_id = '2';
    data.request.query.parameter = [
      { description: '', field_type: 'String', is_checked: 1, key: 'q', not_null: -1, param_id: 'p1', value: 'v' }
    ];
    data.request.body = {
      binary: null,
      mode: 'json',
      parameter: [],
      raw: '{"a":1}',
      raw_parameter: [],
      raw_schema: { type: 'object', properties: { a: { type: 'integer' } } }
    };
    data.request.pre_tasks = [{ type: 'customScript', enabled: 1, id: 'x', data: 'console.log(1)' }];
    data.response.example = [
      {
        example_id: 'e1',
        expect: { code: '200', name: '成功', is_default: 1, verify_type: 'schema', content_type: 'json', schema: { type: 'object' } },
        raw: '{"ok":true}',
        raw_parameter: []
      }
    ];
    await req('PUT', `/api/projects/${env.projectId}/apis/${srcId}`, { data });

    // 另存为副本
    const created = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '源接口 副本',
      target_type: 'api',
      method: 'POST',
      url: 'https://api.test/src',
      parent_id: '0'
    });
    const dstId = created.data.target_id;

    const srcDetail = await req('GET', `/api/projects/${env.projectId}/apis/${srcId}`);
    const payload = structuredClone(srcDetail.data.data);
    payload.name = '源接口 副本';
    payload.parent_id = '0';
    payload.target_id = dstId;
    await req('PUT', `/api/projects/${env.projectId}/apis/${dstId}`, { data: payload });

    const dst = await req('GET', `/api/projects/${env.projectId}/apis/${dstId}`);
    const d = dst.data.data;
    assert.equal(d.name, '源接口 副本');
    assert.equal(d.url, 'https://api.test/src');
    assert.equal(d.method, 'POST');
    assert.equal(d.description, '源描述');
    assert.deepEqual(d.tags, ['标签A', '标签B']);
    assert.equal(d.mark_id, '2');
    assert.equal(d.request.query.parameter[0].key, 'q');
    assert.equal(d.request.body.raw, '{"a":1}');
    assert.equal(d.request.pre_tasks.length, 1);
    assert.equal(d.response.example[0].raw, '{"ok":true}');

    // 原接口未变
    const origin = await req('GET', `/api/projects/${env.projectId}/apis/${srcId}`);
    assert.equal(origin.data.data.name, '源接口');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('另存为：指定目标文件夹', async () => {
  const { env, instance, req } = await boot();
  try {
    const folder = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '目标目录',
      target_type: 'folder'
    });
    const folderId = folder.data.target_id;

    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '待复制',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/x',
      parent_id: folderId
    });

    assert.equal(api.data.parent_id, folderId);

    const list = await req('GET', `/api/projects/${env.projectId}/apis`);
    const item = list.data.items.find((i) => i.target_id === api.data.target_id);
    assert.equal(item.parent_id, folderId);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('另存为：目录不级联复制子项', async () => {
  const { env, instance, req } = await boot();
  try {

    const srcFolder = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '源目录',
      target_type: 'folder'
    });
    const srcFolderId = srcFolder.data.target_id;

    // 源目录下建两个接口
    await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '子1',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/1',
      parent_id: srcFolderId
    });
    await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '子2',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/2',
      parent_id: srcFolderId
    });

    // 只复制目录
    const copy = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '源目录 副本',
      target_type: 'folder',
      parent_id: '0'
    });

    const list = await req('GET', `/api/projects/${env.projectId}/apis`);
    const children = list.data.items.filter((i) => i.parent_id === copy.data.target_id);
    assert.equal(children.length, 0, '副本目录下不应有子项');

    const srcChildren = list.data.items.filter((i) => i.parent_id === srcFolderId);
    assert.equal(srcChildren.length, 2, '源目录的子项应保留');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('保存：version 递增，改动直接落官方目录', async () => {
  const { env, instance, req } = await boot();
  try {
    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '版本测试',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/v'
    });
    const id = api.data.target_id;

    const d1 = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = d1.data.data;
    data.name = '版本测试2';

    const put = await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });
    assert.equal(put.data.ok, true);
    assert.ok(put.data.version >= 2, `version 应递增，实际 ${put.data.version}`);

    // 不经过推送，官方目录里的文件已是新版本
    const official = JSON.parse(
      fs.readFileSync(path.join(env.root, 'offline-data', env.projectId, 'apis', `${id}.json`), 'utf8')
    );
    assert.equal(official.data.name, '版本测试2');
    assert.ok(official.version >= 2, `官方文件 version 应递增，实际 ${official.version}`);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('保存：允许重名，target_id 不同', async () => {
  const { env, instance, req } = await boot();
  try {
    const a = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '同名',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/a'
    });
    const b = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '同名',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/b'
    });
    assert.notEqual(a.data.target_id, b.data.target_id);

    const list = await req('GET', `/api/projects/${env.projectId}/apis`);
    const same = list.data.items.filter((i) => i.name === '同名');
    assert.equal(same.length, 2);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

/* ---------------- marks ---------------- */

test('marks：读取默认状态', async () => {
  const { env, instance, req } = await boot();
  try {
    const res = await req('GET', `/api/projects/${env.projectId}/marks`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.marks));
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('marks：写入后可读回', async () => {
  const { env, instance, req } = await boot();
  try {
    const marks = [
      { mark_id: '1', name: '开发中', color: '#2857FF', is_default_mark: 1, is_sys_default: 1 },
      { mark_id: '2', name: '已完成', color: '#26CEA4', is_default_mark: -1, is_sys_default: 1 },
      { mark_id: '99', name: '自定义状态', color: '#FF00AA', is_default_mark: -1, is_sys_default: -1 }
    ];
    const put = await req('PUT', `/api/projects/${env.projectId}/marks`, { marks });
    assert.equal(put.status, 200);
    assert.equal(put.data.marks.length, 3);

    const got = await req('GET', `/api/projects/${env.projectId}/marks`);
    assert.equal(got.data.marks.length, 3);
    const custom = got.data.marks.find((m) => m.mark_id === '99');
    assert.equal(custom.name, '自定义状态');
    assert.equal(custom.color, '#FF00AA');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

/* ---------------- msgpack ---------------- */

test('msgpack：body 构建使用 application/msgpack', async () => {
  const { buildBody } = await import('../src/exec/http.js');
  const built = buildBody({ mode: 'msgpack', raw: '{"a":1}', parameter: [] }, undefined, undefined);
  assert.equal(built.mode, 'msgpack');
  assert.equal(built.text, '{"a":1}');
  assert.equal(built.contentType, 'application/msgpack');
});

/* ---------------- HTTP/2 ---------------- */

test('http2：http: 地址回退到 HTTP/1.1 并给 warning', async () => {
  const { transmitHttp2 } = await import('../src/exec/http2.js');
  const res = await transmitHttp2({
    url: 'http://127.0.0.1:1/test',
    method: 'GET',
    headers: {},
    body: undefined,
    timeoutMs: 5000
  });
  assert.equal(res.fallback, true);
  assert.match(res.reason, /https/);
});

test('http2：对本地 h2 服务真实收发', async (t) => {
  const { transmitHttp2 } = await import('../src/exec/http2.js');
  const { getSelfSignedCert } = await import('./self-signed.mjs');

  const cert = getSelfSignedCert();
  if (!cert) {
    t.skip('无法生成自签证书');
    return;
  }

  const server = http2.createSecureServer({
    key: cert.key,
    cert: cert.cert,
    allowHTTP1: true
  });

  server.on('stream', (stream, headers) => {
    const pathName = headers[':path'];
    if (pathName === '/json') {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ ok: true, echo: headers['x-test'] || null }));
    } else if (pathName === '/echo' && headers[':method'] === 'POST') {
      let buf = '';
      stream.on('data', (c) => {
        buf += c;
      });
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ received: buf }));
      });
    } else {
      stream.respond({ ':status': 404 });
      stream.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const res = await transmitHttp2({
      url: `https://127.0.0.1:${port}/json`,
      method: 'GET',
      headers: { 'x-test': 'abc' },
      body: undefined,
      timeoutMs: 8000
    });

    assert.equal(res.status, 200);
    assert.equal(res.protocol, 'HTTP/2');
    assert.deepEqual(JSON.parse(res.bodyText), { ok: true, echo: 'abc' });
    assert.equal(res.headers['content-type'], 'application/json');

    // POST 带回显
    const echo = await transmitHttp2({
      url: `https://127.0.0.1:${port}/echo`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'h2' }),
      timeoutMs: 8000
    });
    assert.equal(echo.status, 200);
    assert.deepEqual(JSON.parse(echo.bodyText), { received: '{"hello":"h2"}' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/** 尝试用 openssl 生成自签证书；没有 openssl 时返回 null */
async function makeSelfSignedCert() {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const fsmod = await import('node:fs');
  const dir = fsmod.mkdtempSync(path.join(os.tmpdir(), 'h2cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(dir, 'key.pem'),
        '-out', path.join(dir, 'cert.pem'),
        '-days', '1',
        '-subj', '/CN=127.0.0.1'
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    return {
      key: fsmod.readFileSync(path.join(dir, 'key.pem')),
      cert: fsmod.readFileSync(path.join(dir, 'cert.pem'))
    };
  } catch {
    return null;
  } finally {
    try {
      fsmod.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
