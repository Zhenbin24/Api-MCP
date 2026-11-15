import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTempRoot, cleanup } from './helpers.mjs';
import { createServer } from '../src/server/serve.js';
import { defaultConfig, publicConfig, updateAiConfig } from '../src/server/config.js';
import { AiError, assertAiReady, chatJson, parseImportWithAi, generateCasesWithAi } from '../src/server/ai.js';

/** 起一个假的 OpenAI 兼容服务：按顺序返回预置响应 */
async function startFakeAi(responses) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    calls.push({ url: req.url, auth: req.headers.authorization, body: parsed });

    const next = responses.shift();
    if (!next) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no more mock responses' } }));
      return;
    }
    if (next.status && next.status !== 200) {
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(next.body || { error: { message: 'mock error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: typeof next.content === 'string' ? next.content : JSON.stringify(next.content) } }]
      })
    );
  });
  const address = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())));
  return {
    base: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((r) => server.close(r))
  };
}

function aiConfig(overrides = {}) {
  return {
    ...defaultConfig(),
    enabled: true,
    token: 'test-token',
    ui_token: 'test-ui',
    port: 0,
    ai: {
      enabled: true,
      base_url: 'http://127.0.0.1:1/v1',
      api_key: 'sk-test',
      model: 'gpt-4o-mini',
      timeout_ms: 10000,
      ...overrides
    }
  };
}

/* ---------------- 配置与密钥 ---------------- */

test('AI 配置：publicConfig 不泄漏 api_key，只给 has_api_key', () => {
  const config = aiConfig();
  const pub = publicConfig(config);
  assert.equal(pub.ai.api_key, undefined, 'api_key 不应出现在公开配置里');
  assert.equal(pub.ai.has_api_key, true);
  assert.equal(pub.token, undefined);
  assert.equal(pub.ui_token, undefined);

  const noKey = publicConfig({ ...config, ai: { ...config.ai, api_key: '' } });
  assert.equal(noKey.ai.has_api_key, false);
});

test('AI 配置：updateAiConfig 支持不改 / 清空 / 替换 api_key', () => {
  // 必须隔离配置目录：updateAiConfig 内部会 saveConfig 落盘
  const env = makeTempRoot();
  try {
    const base = defaultConfig();
    base.ai = { enabled: false, base_url: 'https://x/v1', api_key: 'old', model: 'm1', timeout_ms: 60000 };

    // 不传 api_key 时保持原值
    let saved = updateAiConfig(base, { model: 'm2' });
    assert.equal(saved.ai.api_key, 'old');
    assert.equal(saved.ai.model, 'm2');

    // 传空串清空
    saved = updateAiConfig(saved, { api_key: '' });
    assert.equal(saved.ai.api_key, '');

    // 传新值替换
    saved = updateAiConfig(saved, { api_key: 'new-key' });
    assert.equal(saved.ai.api_key, 'new-key');

    // 超时被限制在合理范围
    saved = updateAiConfig(saved, { timeout_ms: 1 });
    assert.equal(saved.ai.timeout_ms, 5000);
    saved = updateAiConfig(saved, { timeout_ms: 999999 });
    assert.equal(saved.ai.timeout_ms, 300000);
  } finally {
    cleanup(env.base);
  }
});

test('AI 就绪校验：未启用 / 缺 key / 地址非法各有明确提示', () => {
  assert.throws(() => assertAiReady({ ai: { enabled: false } }), /未启用/);
  assert.throws(() => assertAiReady({ ai: { enabled: true, api_key: '' } }), /尚未配置 API Key/);
  assert.throws(() => assertAiReady({ ai: { enabled: true, api_key: 'k', base_url: 'ftp://x', model: 'm' } }), /http/);
  assert.throws(() => assertAiReady({ ai: { enabled: true, api_key: 'k', base_url: 'http://x', model: '' } }), /模型名/);
  // 正常配置不抛
  assert.ok(assertAiReady(aiConfig()));
});

/* ---------------- chatJson ---------------- */

test('chatJson：拼接 chat/completions 端点并带上 Bearer', async () => {
  const fake = await startFakeAi([{ content: { ok: true } }]);
  try {
    const config = aiConfig({ base_url: `${fake.base}/v1` });
    const result = await chatJson(config, [{ role: 'user', content: 'hi' }]);
    assert.deepEqual(result, { ok: true });
    assert.equal(fake.calls[0].url, '/v1/chat/completions');
    assert.equal(fake.calls[0].auth, 'Bearer sk-test');
    assert.equal(fake.calls[0].body.response_format.type, 'json_object');
  } finally {
    await fake.close();
  }
});

test('chatJson：base_url 已带 /chat/completions 时不重复拼接', async () => {
  const fake = await startFakeAi([{ content: { a: 1 } }]);
  try {
    const config = aiConfig({ base_url: `${fake.base}/v1/chat/completions` });
    await chatJson(config, [{ role: 'user', content: 'hi' }]);
    assert.equal(fake.calls[0].url, '/v1/chat/completions');
  } finally {
    await fake.close();
  }
});

test('chatJson：兼容 ```json 代码围栏包裹的输出', async () => {
  const fake = await startFakeAi([{ content: '```json\n{"items":[{"url":"http://x/y"}]}\n```' }]);
  try {
    const config = aiConfig({ base_url: fake.base });
    const result = await chatJson(config, [{ role: 'user', content: 'hi' }]);
    assert.equal(result.items[0].url, 'http://x/y');
  } finally {
    await fake.close();
  }
});

test('chatJson：401 给出鉴权失败提示且不含 api_key', async () => {
  const fake = await startFakeAi([{ status: 401, body: { error: { message: 'invalid key' } } }]);
  try {
    const config = aiConfig({ base_url: fake.base });
    await assert.rejects(() => chatJson(config, [{ role: 'user', content: 'hi' }]), (err) => {
      assert.match(err.message, /鉴权失败/);
      assert.ok(!err.message.includes('sk-test'), '错误信息不应泄漏 api_key');
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('chatJson：429 提示限流', async () => {
  const fake = await startFakeAi([{ status: 429 }]);
  try {
    const config = aiConfig({ base_url: fake.base });
    await assert.rejects(() => chatJson(config, [{ role: 'user', content: 'hi' }]), /限流或额度不足/);
  } finally {
    await fake.close();
  }
});

test('chatJson：返回非 JSON 时明确报错', async () => {
  const fake = await startFakeAi([{ content: '这不是 JSON' }]);
  try {
    const config = aiConfig({ base_url: fake.base });
    await assert.rejects(() => chatJson(config, [{ role: 'user', content: 'hi' }]), /不是合法 JSON/);
  } finally {
    await fake.close();
  }
});

test('chatJson：连不上时报可读错误', async () => {
  const config = aiConfig({ base_url: 'http://127.0.0.1:1/v1' });
  await assert.rejects(() => chatJson(config, [{ role: 'user', content: 'hi' }]), /无法连接 AI 服务/);
});

/* ---------------- 业务能力 ---------------- */

test('解析导入：把模型输出规整成接口 item', async () => {
  const fake = await startFakeAi([
    {
      content: {
        items: [
          {
            name: '创建用户',
            method: 'post',
            url: 'http://127.0.0.1:8000/users',
            summary: '新建用户',
            query: [{ key: 'verbose', value: '1', description: '是否详细' }],
            headers: [{ key: 'X-Token', value: '{{token}}' }],
            body_mode: 'json',
            body: '{"name":"张三"}'
          }
        ],
        notes: ['未识别到鉴权方式']
      }
    }
  ]);
  try {
    const config = aiConfig({ base_url: fake.base });
    const res = await parseImportWithAi(config, { text: '请帮我导入一个创建用户的接口' });
    assert.equal(res.items.length, 1);
    const item = res.items[0];
    assert.equal(item.method, 'POST');
    assert.equal(item.name, '创建用户');
    assert.equal(item.request.query.parameter[0].key, 'verbose');
    assert.equal(item.request.header.parameter[0].key, 'X-Token');
    assert.equal(item.request.body.mode, 'json');
    assert.equal(item.request.body.raw, '{"name":"张三"}');
    assert.equal(res.warnings[0], '未识别到鉴权方式');
  } finally {
    await fake.close();
  }
});

test('解析导入：空文本直接拒绝，不调用模型', async () => {
  const fake = await startFakeAi([]);
  try {
    const config = aiConfig({ base_url: fake.base });
    await assert.rejects(() => parseImportWithAi(config, { text: '   ' }), /请先粘贴/);
    assert.equal(fake.calls.length, 0);
  } finally {
    await fake.close();
  }
});

test('生成用例：输出可直接保存的用例结构', async () => {
  const fake = await startFakeAi([
    {
      content: {
        cases: [
          {
            name: '正常创建',
            enabled: true,
            input: { query: { verbose: '1' }, body: { name: '张三' } },
            expect: { code: '200', content_type: 'json' }
          },
          {
            name: '缺少必填字段',
            input: { body: {} },
            expect: { code: '400' }
          }
        ],
        notes: ['建议补一个超长字符串用例']
      }
    }
  ]);
  try {
    const config = aiConfig({ base_url: fake.base });
    const res = await generateCasesWithAi(config, {
      apiDetail: { name: '创建用户', method: 'POST', url: 'http://x/users', request: { query: { parameter: [] } } },
      count: 2
    });
    assert.equal(res.cases.length, 2);
    assert.equal(res.cases[0].name, '正常创建');
    assert.equal(res.cases[0].expect.code, '200');
    assert.equal(res.cases[1].expect.code, '400');
    assert.equal(res.cases[1].enabled, 1, 'enabled 默认转成 1');
    assert.equal(res.warnings.length, 1);
  } finally {
    await fake.close();
  }
});

/* ---------------- HTTP 端点 ---------------- */

async function bootAi(responses) {
  const fake = await startFakeAi(responses);
  const env = makeTempRoot();
  const config = {
    ...defaultConfig(),
    enabled: true,
    token: 'test-token',
    ui_token: 'test-ui',
    port: 0,
    data_root: env.root,
    ai: { enabled: true, base_url: fake.base, api_key: 'sk-test', model: 'gpt-4o-mini', timeout_ms: 10000 }
  };
  const instance = createServer({ config, dataRoot: env.root });
  const address = await instance.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const req = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'X-UI-Token': 'test-ui', 'Content-Type': 'application/json' },
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
  return {
    env,
    instance,
    base,
    req,
    fake,
    close: async () => {
      await instance.close();
      await fake.close();
      cleanup(env.base);
    }
  };
}

test('端点 ai/ping：配置正确时返回 ok', async () => {
  const ctx = await bootAi([{ content: { ok: true } }]);
  try {
    const res = await ctx.req('POST', '/api/ai/ping', {});
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  } finally {
    await ctx.close();
  }
});

test('端点 ai/parse-import：返回可导入的 items', async () => {
  const ctx = await bootAi([
    { content: { items: [{ name: 'ping', method: 'GET', url: 'http://127.0.0.1:8000/ping' }] } }
  ]);
  try {
    const res = await ctx.req('POST', '/api/ai/parse-import', { text: 'GET http://127.0.0.1:8000/ping' });
    assert.equal(res.status, 200);
    assert.equal(res.data.items.length, 1);
    assert.equal(res.data.items[0].url, 'http://127.0.0.1:8000/ping');
  } finally {
    await ctx.close();
  }
});

test('端点 ai/gen-cases：接口不存在时 404', async () => {
  const ctx = await bootAi([]);
  try {
    const res = await ctx.req('POST', '/api/ai/gen-cases', { project_id: ctx.env.projectId, target_id: 'nope' });
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('端点 config/ai：写入后 publicConfig 不含 key', async () => {
  const ctx = await bootAi([]);
  try {
    const res = await ctx.req('PUT', '/api/config/ai', {
      enabled: true,
      base_url: 'http://127.0.0.1:9/v1',
      api_key: 'sk-brand-new',
      model: 'm-test'
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ai.api_key, undefined);
    assert.equal(res.data.ai.has_api_key, true);
    assert.equal(res.data.ai.model, 'm-test');

    // 读回也不该有 key
    const got = await ctx.req('GET', '/api/config');
    assert.equal(got.data.ai.api_key, undefined);
  } finally {
    await ctx.close();
  }
});

test('端点：未配置 key 时三个 AI 端点都返回明确 400', async () => {
  const env = makeTempRoot();
  const config = {
    ...defaultConfig(),
    enabled: true,
    token: 'test-token',
    ui_token: 'test-ui',
    port: 0,
    data_root: env.root,
    ai: { enabled: false, base_url: '', api_key: '', model: '', timeout_ms: 60000 }
  };
  const instance = createServer({ config, dataRoot: env.root });
  const address = await instance.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const post = async (p, body) => {
    const res = await fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'X-UI-Token': 'test-ui', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    const ping = await post('/api/ai/ping', {});
    assert.equal(ping.status, 400);
    assert.match(ping.data.error, /未启用|API Key/);

    const parse = await post('/api/ai/parse-import', { text: 'x' });
    assert.equal(parse.status, 400);
    assert.match(parse.data.error, /未启用|API Key/);

    const draft = await post('/api/ai/draft-api', { project_id: env.projectId, description: 'x' });
    assert.equal(draft.status, 400);
    assert.match(draft.data.error, /未启用|API Key/);
  } finally {
    await instance.close();
    cleanup(env.base);
  }
});
