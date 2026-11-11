import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  const req = async (method, path_, body) => {
    const res = await fetch(`${base}${path_}`, {
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
  return { env, instance, req, base, headers };
}

test('编辑器：新建接口 -> 出现在列表 -> 详情字段一致', async () => {
  const { env, instance, req } = await boot();
  try {
    const created = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '新建订单',
      target_type: 'api',
      method: 'POST',
      url: 'https://api.test/orders',
      parent_id: '0'
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.ok, true);
    const targetId = created.data.target_id;
    assert.match(targetId, /^[0-9a-f]{14}$/);

    const list = await req('GET', `/api/projects/${env.projectId}/apis`);
    assert.ok(list.data.items.some((i) => i.target_id === targetId && i.name === '新建订单'));

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${targetId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.name, '新建订单');
    assert.equal(detail.data.data.method, 'POST');
    assert.equal(detail.data.data.url, 'https://api.test/orders');

    // 树里也应该出现
    const tree = await req('GET', `/api/projects/${env.projectId}/tree`);
    const names = JSON.stringify(tree.data.tree);
    assert.ok(names.includes('新建订单'));
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('编辑器：新建目录 -> 目录下建接口 -> 父 ID 正确', async () => {
  const { env, instance, req } = await boot();
  try {
    const folder = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '订单模块',
      target_type: 'folder',
      parent_id: '0'
    });
    assert.equal(folder.data.ok, true);
    const folderId = folder.data.target_id;

    const apiResp = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '查询订单',
      target_type: 'api',
      method: 'GET',
      url: '{{base}}/orders/{id}',
      parent_id: folderId
    });
    assert.equal(apiResp.data.parent_id, folderId);

    const list = await req('GET', `/api/projects/${env.projectId}/apis`);
    const child = list.data.items.find((i) => i.target_id === apiResp.data.target_id);
    assert.equal(child.parent_id, folderId);

    const tree = await req('GET', `/api/projects/${env.projectId}/tree`);
    const folderNode = tree.data.tree.find((n) => n.target_id === folderId);
    assert.ok(folderNode, '目录应出现在根节点');
    assert.ok(folderNode.children.some((c) => c.target_id === apiResp.data.target_id), '接口应在目录下');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('编辑器：保存修改（名称/方法/URL/参数/Body/脚本）', async () => {
  const { env, instance, req } = await boot();
  try {
    const created = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '待改接口',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/a'
    });
    const targetId = created.data.target_id;

    const before = await req('GET', `/api/projects/${env.projectId}/apis/${targetId}`);
    const data = before.data.data;

    data.name = '改后接口';
    data.method = 'PUT';
    data.url = 'https://api.test/b';
    data.description = '新描述';
    data.request.query.parameter = [
      { description: '', field_type: 'String', is_checked: 1, key: 'page', not_null: -1, param_id: 'x1', value: '1' }
    ];
    data.request.header.parameter = [
      { description: '', field_type: 'String', is_checked: 1, key: 'X-Token', not_null: 1, param_id: 'x2', value: '{{token}}' }
    ];
    data.request.body = {
      binary: null,
      mode: 'json',
      parameter: [],
      raw: '{"hello":"world"}',
      raw_parameter: [],
      raw_schema: { type: 'object' }
    };
    data.request.pre_tasks = [{ type: 'customScript', enabled: 1, id: 'p1', data: 'apt.environment.set("a", 1);' }];
    data.request.auth = { type: 'bearer', bearer: { key: '{{token}}' } };
    data.response.example = [
      {
        example_id: 'ex1',
        expect: { code: '201', name: '创建成功', is_default: 1, verify_type: 'schema', content_type: 'json', schema: { type: 'object' } },
        raw: '{"ok":true}',
        raw_parameter: []
      }
    ];

    const saved = await req('PUT', `/api/projects/${env.projectId}/apis/${targetId}`, { data });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.ok, true);

    const after = await req('GET', `/api/projects/${env.projectId}/apis/${targetId}`);
    const d = after.data.data;
    assert.equal(d.name, '改后接口');
    assert.equal(d.method, 'PUT');
    assert.equal(d.url, 'https://api.test/b');
    assert.equal(d.description, '新描述');
    assert.equal(d.request.query.parameter[0].key, 'page');
    assert.equal(d.request.header.parameter[0].value, '{{token}}');
    assert.equal(d.request.body.mode, 'json');
    assert.equal(d.request.body.raw, '{"hello":"world"}');
    assert.equal(d.request.pre_tasks[0].data, 'apt.environment.set("a", 1);');
    assert.equal(d.request.auth.type, 'bearer');
    assert.equal(d.response.example[0].expect.code, '201');

    // 索引也要同步更新
    const list = await req('GET', `/api/projects/${env.projectId}/apis`);
    const item = list.data.items.find((i) => i.target_id === targetId);
    assert.equal(item.name, '改后接口');
    assert.equal(item.method, 'PUT');
    assert.equal(item.url, 'https://api.test/b');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('编辑器：删除目录级联子接口', async () => {
  const { env, instance, req } = await boot();
  try {
    const folder = await req('POST', `/api/projects/${env.projectId}/apis`, { name: '待删目录', target_type: 'folder' });
    const folderId = folder.data.target_id;

    const a1 = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '子接口1',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/1',
      parent_id: folderId
    });
    const a2 = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '子接口2',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/2',
      parent_id: folderId
    });

    const del = await req('DELETE', `/api/projects/${env.projectId}/apis/${folderId}`);
    assert.equal(del.status, 200);
    assert.equal(del.data.deleted_count, 3);

    const list = await req('GET', `/api/projects/${env.projectId}/apis`);
    const ids = list.data.items.map((i) => i.target_id);
    assert.ok(!ids.includes(folderId));
    assert.ok(!ids.includes(a1.data.target_id));
    assert.ok(!ids.includes(a2.data.target_id));
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('编辑器：无 token 返回 401', async () => {
  const { env, instance, base } = await boot();
  try {
    const res = await fetch(`${base}/api/projects/${env.projectId}/apis`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);

    const res2 = await fetch(`${base}/api/projects/${env.projectId}/apis/abcdef12345678`, { method: 'DELETE' });
    assert.equal(res2.status, 401);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('编辑器：保存后官方目录立即更新', async () => {
  const { env, instance, req } = await boot();
  try {
    const created = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '直写验证接口',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/push-check'
    });
    const targetId = created.data.target_id;

    // 官方目录应真的出现该文件（无需推送）
    const officialFile = path.join(env.root, 'offline-data', env.projectId, 'apis', `${targetId}.json`);
    assert.ok(fs.existsSync(officialFile), '保存后官方目录应有该接口文件');

    const officialIndex = JSON.parse(
      fs.readFileSync(path.join(env.root, 'offline-data', env.projectId, 'apis', 'index.json'), 'utf8')
    );
    assert.ok(officialIndex.items.some((i) => i.target_id === targetId && i.name === '直写验证接口'));
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('编辑器：design.js 与样式可访问', async () => {
  const { env, instance, base } = await boot();
  try {
    const js = await fetch(`${base}/design.js`);
    assert.equal(js.status, 200);
    const code = await js.text();
    assert.match(code, /interface|ApiDesign|viewApiDesign/);

    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
    const style = await css.text();
    assert.match(style, /design-layout/);
    assert.match(style, /param-row/);

    const page = await fetch(`${base}/?ui=test-ui`);
    const html = await page.text();
    assert.match(html, /design\.js/);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

/* ---------------- �½���ת / �ĵ����� / nav_order ---------------- */

test('�½����ĵ� content ��д�벢����', async () => {
  const { env, instance, req } = await boot();
  try {

    const doc = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '�ҵ��ĵ�',
      target_type: 'doc',
      parent_id: '0'
    });
    assert.equal(doc.data.ok, true);
    const docId = doc.data.target_id;

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${docId}`);
    assert.equal(detail.data.target_type, 'doc');
    const data = detail.data.data;
    assert.equal(typeof data.content, 'string');

    data.content = '# ����\n\n���� **����** �� `code`��';
    const put = await req('PUT', `/api/projects/${env.projectId}/apis/${docId}`, { data });
    assert.equal(put.data.ok, true);

    const again = await req('GET', `/api/projects/${env.projectId}/apis/${docId}`);
    assert.equal(again.data.data.content, '# ����\n\n���� **����** �� `code`��');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('�½���Ŀ¼���½��ӿڣ���Ŀ¼��ȷ�������ȡ', async () => {
  const { env, instance, req } = await boot();
  try {

    const folder = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '����',
      target_type: 'folder',
      parent_id: '0'
    });
    const folderId = folder.data.target_id;

    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '�ӽӿ�',
      target_type: 'api',
      method: 'POST',
      url: 'https://api.test/sub',
      parent_id: folderId
    });
    assert.equal(api.data.parent_id, folderId);

    // ��תĿ����Ч��GET �������õ�
    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${api.data.target_id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.name, '�ӽӿ�');
    assert.equal(detail.data.data.parent_id, folderId);

    // Ŀ¼����ͬ����ȡ
    const folderDetail = await req('GET', `/api/projects/${env.projectId}/apis/${folderId}`);
    assert.equal(folderDetail.status, 200);
    assert.equal(folderDetail.data.target_type, 'folder');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('�½����ĵ������ version ����', async () => {
  const { env, instance, req } = await boot();
  try {
    const doc = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '�汾�ĵ�',
      target_type: 'doc'
    });
    const id = doc.data.target_id;

    const d1 = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = d1.data.data;
    data.content = '��һ��';
    const put = await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });
    assert.ok(put.data.version >= 2);

    const d2 = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    assert.equal(d2.data.data.content, '��һ��');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('�½����ĵ�Ҳ�����Ϊ����', async () => {
  const { env, instance, req } = await boot();
  try {
    const src = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'ԭ��',
      target_type: 'doc'
    });
    const srcId = src.data.target_id;
    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${srcId}`);
    const data = detail.data.data;
    data.content = 'ԭ������';
    await req('PUT', `/api/projects/${env.projectId}/apis/${srcId}`, { data });

    const copy = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'ԭ�� ����',
      target_type: 'doc',
      parent_id: '0'
    });
    const copyId = copy.data.target_id;

    const srcDetail = await req('GET', `/api/projects/${env.projectId}/apis/${srcId}`);
    const payload = structuredClone(srcDetail.data.data);
    payload.name = 'ԭ�� ����';
    payload.target_id = copyId;
    await req('PUT', `/api/projects/${env.projectId}/apis/${copyId}`, { data: payload });

    const copied = await req('GET', `/api/projects/${env.projectId}/apis/${copyId}`);
    assert.equal(copied.data.data.content, 'ԭ������');
    assert.equal(copied.data.data.name, 'ԭ�� ����');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});
