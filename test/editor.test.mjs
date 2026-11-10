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
    token: 'test-token',
    ui_token: 'test-ui',
    port: 0,
    data_root: env.root,
    shadow_root: env.shadow,
    allowed_project_ids: []
  };
  const instance = createServer({ config, officialRoot: env.root, shadowRoot: env.shadow });
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

test('ç¼–è¾‘å™¨ï¼šæ–°å»ºæŽ¥å£ -> å‡ºçŽ°åœ¨åˆ—è¡¨ -> è¯¦æƒ…å­—æ®µä¸€è‡´', async () => {
  const { env, instance, req } = await boot();
  try {
    const created = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'æ–°å»ºè®¢å•',
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
    assert.ok(list.data.items.some((i) => i.target_id === targetId && i.name === 'æ–°å»ºè®¢å•'));

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${targetId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.name, 'æ–°å»ºè®¢å•');
    assert.equal(detail.data.data.method, 'POST');
    assert.equal(detail.data.data.url, 'https://api.test/orders');

    // æ ‘é‡Œä¹Ÿåº”è¯¥å‡ºçŽ°
    const tree = await req('GET', `/api/projects/${env.projectId}/tree`);
    const names = JSON.stringify(tree.data.tree);
    assert.ok(names.includes('æ–°å»ºè®¢å•'));
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('ç¼–è¾‘å™¨ï¼šæ–°å»ºç›®å½• -> ç›®å½•ä¸‹å»ºæŽ¥å£ -> çˆ¶ ID æ­£ç¡®', async () => {
  const { env, instance, req } = await boot();
  try {
    const folder = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'è®¢å•æ¨¡å—',
      target_type: 'folder',
      parent_id: '0'
    });
    assert.equal(folder.data.ok, true);
    const folderId = folder.data.target_id;

    const apiResp = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'æŸ¥è¯¢è®¢å•',
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
    assert.ok(folderNode, 'ç›®å½•åº”å‡ºçŽ°åœ¨æ ¹èŠ‚ç‚¹');
    assert.ok(folderNode.children.some((c) => c.target_id === apiResp.data.target_id), 'æŽ¥å£åº”åœ¨ç›®å½•ä¸‹');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('ç¼–è¾‘å™¨ï¼šä¿å­˜ä¿®æ”¹ï¼ˆåç§°/æ–¹æ³•/URL/å‚æ•°/Body/è„šæœ¬ï¼‰', async () => {
  const { env, instance, req } = await boot();
  try {
    const created = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'å¾…æ”¹æŽ¥å£',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/a'
    });
    const targetId = created.data.target_id;

    const before = await req('GET', `/api/projects/${env.projectId}/apis/${targetId}`);
    const data = before.data.data;

    data.name = 'æ”¹åŽæŽ¥å£';
    data.method = 'PUT';
    data.url = 'https://api.test/b';
    data.description = 'æ–°æè¿°';
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
        expect: { code: '201', name: 'åˆ›å»ºæˆåŠŸ', is_default: 1, verify_type: 'schema', content_type: 'json', schema: { type: 'object' } },
        raw: '{"ok":true}',
        raw_parameter: []
      }
    ];

    const saved = await req('PUT', `/api/projects/${env.projectId}/apis/${targetId}`, { data });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.ok, true);

    const after = await req('GET', `/api/projects/${env.projectId}/apis/${targetId}`);
    const d = after.data.data;
    assert.equal(d.name, 'æ”¹åŽæŽ¥å£');
    assert.equal(d.method, 'PUT');
    assert.equal(d.url, 'https://api.test/b');
    assert.equal(d.description, 'æ–°æè¿°');
    assert.equal(d.request.query.parameter[0].key, 'page');
    assert.equal(d.request.header.parameter[0].value, '{{token}}');
    assert.equal(d.request.body.mode, 'json');
    assert.equal(d.request.body.raw, '{"hello":"world"}');
    assert.equal(d.request.pre_tasks[0].data, 'apt.environment.set("a", 1);');
    assert.equal(d.request.auth.type, 'bearer');
    assert.equal(d.response.example[0].expect.code, '201');

    // ç´¢å¼•ä¹Ÿè¦åŒæ­¥æ›´æ–°
    const list = await req('GET', `/api/projects/${env.projectId}/apis`);
    const item = list.data.items.find((i) => i.target_id === targetId);
    assert.equal(item.name, 'æ”¹åŽæŽ¥å£');
    assert.equal(item.method, 'PUT');
    assert.equal(item.url, 'https://api.test/b');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('ç¼–è¾‘å™¨ï¼šåˆ é™¤ç›®å½•çº§è”å­æŽ¥å£', async () => {
  const { env, instance, req } = await boot();
  try {
    const folder = await req('POST', `/api/projects/${env.projectId}/apis`, { name: 'å¾…åˆ ç›®å½•', target_type: 'folder' });
    const folderId = folder.data.target_id;

    const a1 = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'å­æŽ¥å£1',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/1',
      parent_id: folderId
    });
    const a2 = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'å­æŽ¥å£2',
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

test('ç¼–è¾‘å™¨ï¼šæ—  token è¿”å›ž 401', async () => {
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

test('ç¼–è¾‘å™¨ï¼šä¿å­˜åŽ diff æ˜¾ç¤º aheadï¼Œpush åŽå®˜æ–¹ç›®å½•æ›´æ–°', async () => {
  const { env, instance, req } = await boot();
  try {
    // å…ˆæ‹‰å–å»ºç«‹åŸºçº¿
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    const before = await req('GET', `/api/projects/${env.projectId}/diff`);
    assert.equal(before.data.state, 'synced');

    const created = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'æŽ¨é€éªŒè¯æŽ¥å£',
      target_type: 'api',
      method: 'GET',
      url: 'https://api.test/push-check'
    });
    const targetId = created.data.target_id;

    const diff = await req('GET', `/api/projects/${env.projectId}/diff`);
    assert.equal(diff.data.state, 'ahead');
    assert.ok(diff.data.entries.some((e) => e.path.endsWith(`${targetId}.json`)), 'æ–°æŽ¥å£æ–‡ä»¶åº”å‡ºçŽ°åœ¨å·®å¼‚é‡Œ');
    assert.ok(diff.data.entries.some((e) => e.path === 'project/apis/index.json'), 'ç´¢å¼•æ–‡ä»¶åº”å‡ºçŽ°åœ¨å·®å¼‚é‡Œ');

    const push = await req('POST', `/api/projects/${env.projectId}/push`, {});
    assert.equal(push.data.remaining, 'synced');

    // å®˜æ–¹ç›®å½•åº”çœŸçš„å‡ºçŽ°è¯¥æ–‡ä»¶
    const officialFile = path.join(env.root, 'offline-data', env.projectId, 'apis', `${targetId}.json`);
    assert.ok(fs.existsSync(officialFile), 'push åŽå®˜æ–¹ç›®å½•åº”æœ‰è¯¥æŽ¥å£æ–‡ä»¶');

    const officialIndex = JSON.parse(
      fs.readFileSync(path.join(env.root, 'offline-data', env.projectId, 'apis', 'index.json'), 'utf8')
    );
    assert.ok(officialIndex.items.some((i) => i.target_id === targetId && i.name === 'æŽ¨é€éªŒè¯æŽ¥å£'));
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('ç¼–è¾‘å™¨ï¼šdesign.js ä¸Žæ ·å¼å¯è®¿é—®', async () => {
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

/* ---------------- ÐÂ½¨Ìø×ª / ÎÄµµÄÚÈÝ / nav_order ---------------- */

test('ÐÂ½¨£ºÎÄµµ content ¿ÉÐ´Èë²¢¶Á»Ø', async () => {
  const { env, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});

    const doc = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'ÎÒµÄÎÄµµ',
      target_type: 'doc',
      parent_id: '0'
    });
    assert.equal(doc.data.ok, true);
    const docId = doc.data.target_id;

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${docId}`);
    assert.equal(detail.data.target_type, 'doc');
    const data = detail.data.data;
    assert.equal(typeof data.content, 'string');

    data.content = '# ±êÌâ\n\nÕâÊÇ **´ÖÌå** ºÍ `code`¡£';
    const put = await req('PUT', `/api/projects/${env.projectId}/apis/${docId}`, { data });
    assert.equal(put.data.ok, true);

    const again = await req('GET', `/api/projects/${env.projectId}/apis/${docId}`);
    assert.equal(again.data.data.content, '# ±êÌâ\n\nÕâÊÇ **´ÖÌå** ºÍ `code`¡£');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('ÐÂ½¨£ºÄ¿Â¼ÏÂÐÂ½¨½Ó¿Ú£¬¸¸Ä¿Â¼ÕýÈ·ÇÒÏêÇé¿ÉÈ¡', async () => {
  const { env, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});

    const folder = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '·Ö×é',
      target_type: 'folder',
      parent_id: '0'
    });
    const folderId = folder.data.target_id;

    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '×Ó½Ó¿Ú',
      target_type: 'api',
      method: 'POST',
      url: 'https://api.test/sub',
      parent_id: folderId
    });
    assert.equal(api.data.parent_id, folderId);

    // Ìø×ªÄ¿±êÓÐÐ§£ºGET ÏêÇéÄÜÄÃµ½
    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${api.data.target_id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.data.name, '×Ó½Ó¿Ú');
    assert.equal(detail.data.data.parent_id, folderId);

    // Ä¿Â¼ÏêÇéÍ¬Ñù¿ÉÈ¡
    const folderDetail = await req('GET', `/api/projects/${env.projectId}/apis/${folderId}`);
    assert.equal(folderDetail.status, 200);
    assert.equal(folderDetail.data.target_type, 'folder');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('ÐÂ½¨£ºÎÄµµ±£´æºó version µÝÔö', async () => {
  const { env, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    const doc = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: '°æ±¾ÎÄµµ',
      target_type: 'doc'
    });
    const id = doc.data.target_id;

    const d1 = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = d1.data.data;
    data.content = 'µÚÒ»°æ';
    const put = await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });
    assert.ok(put.data.version >= 2);

    const d2 = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    assert.equal(d2.data.data.content, 'µÚÒ»°æ');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});

test('ÐÂ½¨£ºÎÄµµÒ²ÄÜÁí´æÎª¸±±¾', async () => {
  const { env, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    const src = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'Ô­ÎÄ',
      target_type: 'doc'
    });
    const srcId = src.data.target_id;
    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${srcId}`);
    const data = detail.data.data;
    data.content = 'Ô­ÎÄÄÚÈÝ';
    await req('PUT', `/api/projects/${env.projectId}/apis/${srcId}`, { data });

    const copy = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'Ô­ÎÄ ¸±±¾',
      target_type: 'doc',
      parent_id: '0'
    });
    const copyId = copy.data.target_id;

    const srcDetail = await req('GET', `/api/projects/${env.projectId}/apis/${srcId}`);
    const payload = structuredClone(srcDetail.data.data);
    payload.name = 'Ô­ÎÄ ¸±±¾';
    payload.target_id = copyId;
    await req('PUT', `/api/projects/${env.projectId}/apis/${copyId}`, { data: payload });

    const copied = await req('GET', `/api/projects/${env.projectId}/apis/${copyId}`);
    assert.equal(copied.data.data.content, 'Ô­ÎÄÄÚÈÝ');
    assert.equal(copied.data.data.name, 'Ô­ÎÄ ¸±±¾');
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});
