import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRoot, cleanup, startFakeServer } from './helpers.mjs';
import { createServer } from '../src/server/serve.js';
import { defaultConfig } from '../src/server/config.js';

async function boot() {
  const env = makeTempRoot();
  const fake = await startFakeServer();
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
  return { env, fake, instance, req };
}

/** å»ºä¸€ä¸ªæŒ‡å‘ fake server çš„æŽ¥å£ */
async function makeApi(req, env, fake, { name, method, path: apiPath, base = '{{base}}' }) {
  const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
    name,
    target_type: 'api',
    method,
    url: `${base}${apiPath}`
  });
  const id = api.data.target_id;

  const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
  const data = detail.data.data;
  data.method = method;
  data.url = `${base}${apiPath}`;
  await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

  // çŽ¯å¢ƒæŒ‡å‘ fake server
  const envList = await req('GET', `/api/projects/${env.projectId}/apis`); // touch
  return id;
}

async function pointEnvTo(req, env, fake) {
  // é»˜è®¤çŽ¯å¢ƒ id=1ï¼ˆrunner æœªæŒ‡å®š envId æ—¶ä¼šé€‰å®ƒï¼‰ï¼ŒæŠŠå®ƒçš„é»˜è®¤æœåŠ¡åœ°å€æŒ‡å‘ fake server
  const { openShadow } = await import('../src/store/shadow.js');
  const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });

  for (const envId of ['1', '2503d4840ac010']) {
    const file = target.readJson(`project/envs/${envId}.json`, null);
    if (!file) continue;
    file.server_list = [{ name: 'default', server_id: '1', sort: 1000, uri: fake.url }];
    file.env_var_list = { ...(file.env_var_list || {}), base: { value: fake.url } };
    target.writeJson(`project/envs/${envId}.json`, file);
  }
}

test('sendï¼šè¿”å›žå®Œæ•´å“åº”ï¼ˆçŠ¶æ€ç /å¤´/ä½“/è€—æ—¶ï¼‰', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    await pointEnvTo(req, env, fake);

    const id = await makeApi(req, env, fake, { name: 'ping', method: 'GET', path: '/users/42' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'passed');
    assert.equal(res.data.status_code, 200);
    assert.ok(res.data.run_id);

    // å®Œæ•´å“åº”ä½“
    assert.ok(res.data.response, 'åº”è¿”å›ž response å¯¹è±¡');
    assert.equal(res.data.response.status, 200);
    assert.match(res.data.response.body, /alice/);
    assert.ok(res.data.response.headers, 'åº”è¿”å›žå“åº”å¤´');
    assert.ok(typeof res.data.elapsed_ms === 'number');

    // è¯·æ±‚ä¿¡æ¯
    assert.ok(res.data.request);
    assert.match(res.data.request.url, /\/users\/42/);
    assert.ok(Array.isArray(res.data.assertions));
    assert.ok(Array.isArray(res.data.console));
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('sendï¼šæ–­è¨€å¤±è´¥è¿”å›ž failed', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    await pointEnvTo(req, env, fake);

    const api = await req('POST', `/api/projects/${env.projectId}/apis`, {
      name: 'fail-assert',
      target_type: 'api',
      method: 'GET',
      url: '{{base}}/users/42'
    });
    const id = api.data.target_id;

    const detail = await req('GET', `/api/projects/${env.projectId}/apis/${id}`);
    const data = detail.data.data;
    data.request.post_tasks = [
      {
        type: 'customScript',
        enabled: 1,
        id: 'q1',
        data: 'apt.test("id åº”ä¸º 999", function () { apt.expect(apt.response.json().id).to.equal(999); });'
      }
    ];
    await req('PUT', `/api/projects/${env.projectId}/apis/${id}`, { data });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.data.status, 'failed');
    assert.ok(res.data.assertions.some((a) => a.passed === false));
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('sendï¼šéž 2xx åˆ¤ failed ä½†ä»è¿”å›žå“åº”ä½“', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    await pointEnvTo(req, env, fake);

    const id = await makeApi(req, env, fake, { name: 'notfound', method: 'GET', path: '/nope' });
    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});

    assert.equal(res.data.status, 'failed');
    assert.equal(res.data.status_code, 404);
    assert.match(res.data.response.body, /not found/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('sendï¼šæœªæ‰¾åˆ°æŽ¥å£è¿”å›ž 404', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    const res = await req('POST', `/api/projects/${env.projectId}/apis/deadbeef123456/send`, {});
    assert.equal(res.status, 500);
    assert.match(String(res.data.error || ''), /æŽ¥å£ä¸å­˜åœ¨/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

/* ---------------- ¶þ½øÖÆÏìÓ¦ ---------------- */

test('send£ºÎÄ±¾ÏìÓ¦´ø content_type / is_binary=false / body_base64', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'ping', method: 'GET', path: '/users/42' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.data.status, 'passed');
    assert.equal(res.data.is_binary, false);
    assert.match(String(res.data.content_type || ''), /json/);
    assert.ok(res.data.body_base64, 'ÎÄ±¾ÏìÓ¦Ò²Ó¦´ø base64 ¹©±àÂëÇÐ»»');

    // ½âÂë»ØÀ´Ó¦Óë body Ò»ÖÂ
    const decoded = Buffer.from(res.data.body_base64, 'base64').toString('utf8');
    assert.match(decoded, /alice/);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send£ºrun ¼ÇÂ¼²»º¬ body_base64£¨·ÀÖ¹ÀúÊ·ÅòÕÍ£©', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'ping', method: 'GET', path: '/users/42' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.ok(res.data.body_base64, '¼´Ê±ÏìÓ¦Ó¦ÓÐ base64');

    // ¶ÁÂäÅÌ¼ÇÂ¼£¬È·ÈÏÃ»ÓÐ base64
    const { openShadow } = await import('../src/store/shadow.js');
    const { getRun } = await import('../src/store/runs.js');
    const target = openShadow({ shadowRoot: env.shadow, projectId: env.projectId });
    const run = getRun(target, res.data.run_id);
    assert.ok(run, 'Ó¦ÄÜ¶Áµ½ run ¼ÇÂ¼');
    const step = run.steps[0];

    const serialized = JSON.stringify(step);
    assert.equal(serialized.includes('body_base64'), false, 'run ¼ÇÂ¼²»Ó¦º¬ body_base64');
    assert.equal(step.response.has_binary, true);
    assert.equal(step.response.is_binary, false);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send£ºMCP execute_api ·µ»ØÌå±£³Ö¾«¼ò£¨²»´ø base64£©', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'ping', method: 'GET', path: '/users/42' });

    const res = await req('POST', `/api/tools/call`, {
      name: 'apipost_execute_api',
      arguments: { project_id: env.projectId, target_id: id }
    });
    assert.equal(res.data.ok, true);
    const result = res.data.result;
    assert.equal(result.body_base64, undefined, 'MCP ¹¤¾ß²»Ó¦·µ»Ø base64');
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send£ºÍ¼Æ¬ÏìÓ¦ is_binary=true ÇÒ´ø base64', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'img', method: 'GET', path: '/image' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.data.is_binary, true, 'Í¼Æ¬Ó¦ÅÐ¶¨Îª¶þ½øÖÆ');
    assert.match(String(res.data.content_type || ''), /^image\/png/);
    assert.ok(res.data.body_base64, 'Ó¦´ø base64 ¹©Ô¤ÀÀ');

    // base64 ½â³öÀ´Ó¦ÊÇ PNG Ä§Êý
    const buf = Buffer.from(res.data.body_base64, 'base64');
    assert.equal(buf[0], 0x89);
    assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});

test('send£º³¬´óÏìÓ¦²»¸½´ø base64', async () => {
  const { env, fake, instance, req } = await boot();
  try {
    await req('POST', `/api/projects/${env.projectId}/pull`, {});
    await pointEnvTo(req, env, fake);
    const id = await makeApi(req, env, fake, { name: 'big', method: 'GET', path: '/bigtext' });

    const res = await req('POST', `/api/projects/${env.projectId}/apis/${id}/send`, {});
    assert.equal(res.data.body_base64, null, '³¬¹ý 4MB ²»Ó¦´ø base64');
    assert.equal(res.data.too_large_for_base64, true);
    assert.ok(res.data.response.size > 4 * 1024 * 1024);
  } finally {
    await instance.close();
    await fake.close();
    cleanup(env.base);
  }
});
