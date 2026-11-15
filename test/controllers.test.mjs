import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeTempRoot, cleanup, makeContext } from './helpers.mjs';
import { callTool } from '../src/mcp/tools.js';
import { openProject } from '../src/store/target.js';
import { createApiOrFolder, writeApiFile } from '../src/store/apis.js';
import { createFlow, updateFlow, getFlow, listFlows, deleteFlow } from '../src/store/flows.js';
import { normalizeFlowNodes, countSteps, collectTargetIds, NODE_TYPE, nodeType } from '../src/store/flow-nodes.js';
import { runFlow } from '../src/exec/runner.js';

/** 起一个回显服务，按路径返回不同状态码 */
async function startEcho(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (handler) return handler(req, res, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url, method: req.method }));
    });
  });
  const address = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())));
  return { server, base: `http://127.0.0.1:${address.port}`, close: () => new Promise((r) => server.close(r)) };
}

/** 建一个接口，返回 target_id */
function makeApi(target, { name, url, method = 'GET' }) {
  const created = createApiOrFolder(target, { name, parentId: '0', targetType: 'api', method, url });
  return created.target_id;
}

/* ---------------- 节点模型 ---------------- */

test('节点模型：历史数据无 type 时按 step 处理', () => {
  const legacy = { step_id: 's1', target_id: 't1', api_snapshot: {}, input: {} };
  assert.equal(nodeType(legacy), NODE_TYPE.STEP);
  assert.equal(nodeType({ type: 'unknown' }), NODE_TYPE.STEP);
  assert.equal(nodeType({ type: 'if' }), NODE_TYPE.IF);
});

test('节点模型：countSteps 只数接口步骤，控制器不计入', () => {
  const nodes = [
    { step_id: 's1', target_id: 't1', api_snapshot: {} },
    { step_id: 'c1', type: 'loop', times: 2, children: [{ step_id: 's2', target_id: 't2', api_snapshot: {} }] },
    { step_id: 'w1', type: 'wait', ms: 10 }
  ];
  assert.equal(countSteps(nodes), 2);
  assert.deepEqual(collectTargetIds(nodes), ['t1', 't2']);
});

test('节点模型：控制器缺子节点时报错', () => {
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    assert.throws(() => normalizeFlowNodes(target, [{ type: 'if', condition: 'true', children: [] }]), /至少要有一个子节点/);
    assert.throws(() => normalizeFlowNodes(target, [{ type: 'loop', times: 0, children: [] }]), /循环次数必须大于 0/);
    assert.throws(() => normalizeFlowNodes(target, [{ type: 'while', condition: 'a', children: [] }]), /至少要有一个子节点/);
    assert.throws(() => normalizeFlowNodes(target, [{ type: 'if', condition: '', children: [{ target_id: 'x' }] }]), /必须填写条件/);
  } finally {
    cleanup(env.base);
  }
});

test('节点模型：整个计划没有接口步骤时报错', () => {
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    assert.throws(() => normalizeFlowNodes(target, [{ type: 'wait', ms: 100 }]), /至少需要一个 HTTP 接口步骤/);
  } finally {
    cleanup(env.base);
  }
});

/* ---------------- 计划 CRUD ---------------- */

test('计划 CRUD：带控制器的计划可创建、读取、更新、删除', () => {
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const apiId = makeApi(target, { name: '登录', url: 'http://127.0.0.1:1/login' });
    const flow = createFlow(target, {
      name: '带控制器的计划',
      steps: [
        { target_id: apiId, input: {} },
        { type: 'loop', times: 3, children: [{ target_id: apiId, input: {} }] },
        { type: 'wait', ms: 10 }
      ]
    });

    // 接口步骤数只算真正的接口调用
    assert.equal(flow.steps.length, 3);
    const summary = listFlows(target).find((f) => f.flow_id === flow.flow_id);
    assert.equal(summary.step_count, 2);

    // 读回来结构完整
    const loaded = getFlow(target, flow.flow_id);
    assert.equal(loaded.steps[1].type, 'loop');
    assert.equal(loaded.steps[1].times, 3);
    assert.equal(loaded.steps[1].children.length, 1);

    // 更新：改成 if 控制器，子节点沿用快照
    const updated = updateFlow(target, flow.flow_id, {
      steps: [
        { step_id: flow.steps[0].step_id, target_id: apiId, input: {} },
        {
          type: 'if',
          condition: 'apt.response.code() === 200',
          children: [{ step_id: flow.steps[1].children[0].step_id, target_id: apiId, input: {} }],
          else_children: []
        }
      ]
    });
    assert.equal(updated.steps.length, 2);
    assert.equal(updated.steps[1].type, 'if');
    assert.equal(updated.steps[1].children.length, 1);

    deleteFlow(target, flow.flow_id);
    assert.equal(getFlow(target, flow.flow_id), null);
  } finally {
    cleanup(env.base);
  }
});

/* ---------------- 递归执行器 ---------------- */

test('执行器：老格式（无 type）计划照常可跑', async () => {
  const echo = await startEcho();
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const apiId = makeApi(target, { name: '回显', url: `${echo.base}/hello` });
    // 手工写一个无 type 的老格式步骤，绕过 normalize
    const flow = createFlow(target, { name: '老格式', steps: [{ target_id: apiId, input: {} }] });
    const raw = target.readJson(`project/executions/flows/${flow.flow_id}.json`, null);
    raw.steps = raw.steps.map(({ type, ...rest }) => rest);
    target.writeJson(`project/executions/flows/${flow.flow_id}.json`, raw);

    const result = await runFlow({ dataRoot: env.root, projectId: env.projectId, flowId: flow.flow_id, envId: '2503d4840ac010' });
    assert.equal(result.status, 'passed');
    assert.equal(result.total, 1);
    assert.equal(result.tree[0].type, 'step');
  } finally {
    await echo.close();
    cleanup(env.base);
  }
});

test('执行器：次数控制器按 times 重复执行子节点', async () => {
  let hits = 0;
  const echo = await startEcho((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hit: hits }));
  });
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const apiId = makeApi(target, { name: '计数', url: `${echo.base}/count` });
    const flow = createFlow(target, {
      name: '循环三次',
      steps: [{ type: 'loop', times: 3, children: [{ target_id: apiId, input: {} }] }]
    });

    const result = await runFlow({ dataRoot: env.root, projectId: env.projectId, flowId: flow.flow_id, envId: '2503d4840ac010' });
    assert.equal(result.status, 'passed');
    assert.equal(hits, 3, '子节点应被执行 3 次');
    // 总步数按实际执行次数统计
    assert.equal(result.total, 3);
    assert.equal(result.tree[0].type, 'loop');
    assert.equal(result.tree[0].iterations.length, 3);
  } finally {
    await echo.close();
    cleanup(env.base);
  }
});

test('执行器：条件控制器只跑命中的分支', async () => {
  let loginHits = 0;
  let otherHits = 0;
  const echo = await startEcho((req, res) => {
    if (req.url.includes('login')) loginHits += 1;
    else otherHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'abc', code: 0 }));
  });
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const loginId = makeApi(target, { name: '登录', url: `${echo.base}/login` });
    const otherId = makeApi(target, { name: '其他', url: `${echo.base}/other` });

    const flow = createFlow(target, {
      name: '条件分支',
      steps: [
        { target_id: loginId, input: {} },
        {
          type: 'if',
          // 上一步返回 code=0，条件成立 -> 只跑 children
          condition: 'apt.response.json().code === 0',
          children: [{ target_id: otherId, input: {} }],
          else_children: [{ target_id: otherId, input: {} }]
        }
      ]
    });

    const result = await runFlow({ dataRoot: env.root, projectId: env.projectId, flowId: flow.flow_id, envId: '2503d4840ac010' });
    assert.equal(result.status, 'passed');
    assert.equal(loginHits, 1);
    assert.equal(otherHits, 1, '只应执行命中的那个分支');
    const ifNode = result.tree[1];
    assert.equal(ifNode.type, 'if');
    assert.equal(ifNode.condition_result, true);
    assert.equal(ifNode.branch, 'children');
  } finally {
    await echo.close();
    cleanup(env.base);
  }
});

test('执行器：条件不成立时走 else_children', async () => {
  let elseHits = 0;
  let thenHits = 0;
  const echo = await startEcho((req, res) => {
    if (req.url.includes('else')) elseHits += 1;
    if (req.url.includes('then')) thenHits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 500 }));
  });
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const firstId = makeApi(target, { name: '首步', url: `${echo.base}/first` });
    const thenId = makeApi(target, { name: '命中', url: `${echo.base}/then` });
    const elseId = makeApi(target, { name: '兜底', url: `${echo.base}/else` });

    const flow = createFlow(target, {
      name: '走 else',
      steps: [
        { target_id: firstId, input: {} },
        {
          type: 'if',
          condition: 'apt.response.json().code === 0',
          children: [{ target_id: thenId, input: {} }],
          else_children: [{ target_id: elseId, input: {} }]
        }
      ]
    });

    const result = await runFlow({ dataRoot: env.root, projectId: env.projectId, flowId: flow.flow_id, envId: '2503d4840ac010' });
    assert.equal(elseHits, 1);
    assert.equal(thenHits, 0);
    assert.equal(result.tree[1].branch, 'else_children');
  } finally {
    await echo.close();
    cleanup(env.base);
  }
});

test('执行器：While 达到上限时强制退出并给出提示', async () => {
  const echo = await startEcho((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ again: true }));
  });
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const apiId = makeApi(target, { name: '永远为真', url: `${echo.base}/loop` });
    const flow = createFlow(target, {
      name: '死循环保护',
      steps: [
        {
          type: 'while',
          condition: 'true',
          max_iterations: 3,
          children: [{ target_id: apiId, input: {} }]
        }
      ]
    });

    const result = await runFlow({ dataRoot: env.root, projectId: env.projectId, flowId: flow.flow_id, envId: '2503d4840ac010' });
    const whileNode = result.tree[0];
    assert.equal(whileNode.type, 'while');
    assert.equal(whileNode.iterations, 3, '应跑到上限就停');
    assert.match(whileNode.error || '', /最大迭代次数/);
  } finally {
    await echo.close();
    cleanup(env.base);
  }
});

test('执行器：等待控制器耗时不少于配置值', async () => {
  const echo = await startEcho();
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const apiId = makeApi(target, { name: '回显', url: `${echo.base}/x` });
    const flow = createFlow(target, {
      name: '等待',
      steps: [
        { target_id: apiId, input: {} },
        { type: 'wait', ms: 120 }
      ]
    });

    const result = await runFlow({ dataRoot: env.root, projectId: env.projectId, flowId: flow.flow_id, envId: '2503d4840ac010' });
    const waitNode = result.tree[1];
    assert.equal(waitNode.type, 'wait');
    assert.ok(waitNode.elapsed_ms >= 100, `等待应至少 100ms，实际 ${waitNode.elapsed_ms}`);
  } finally {
    await echo.close();
    cleanup(env.base);
  }
});

test('执行器：脚本控制器不发请求，断言失败会计入', async () => {
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const apiId = makeApi(target, { name: '回显', url: 'http://127.0.0.1:1/x' });
    const flow = createFlow(target, {
      name: '脚本控制器',
      steps: [
        { type: 'script', script: 'apt.environment.set("greeting", "hi");' },
        { target_id: apiId, input: {} }
      ]
    });
    // 用一个必然失败的脚本替换第一步，验证断言会计入
    const failedFlow = createFlow(target, {
      name: '脚本断言失败',
      steps: [
        { type: 'script', script: 'apt.assert(false, "故意失败");' },
        { target_id: apiId, input: {} }
      ]
    });

    const result = await runFlow({ dataRoot: env.root, projectId: env.projectId, flowId: failedFlow.flow_id, envId: '2503d4840ac010' });
    const scriptNode = result.tree[0];
    assert.equal(scriptNode.type, 'script');
    assert.equal(scriptNode.status, 'failed');
    assert.ok(scriptNode.assertions.some((a) => a.passed === false));
    assert.equal(listFlows(target).length, 2);
  } finally {
    cleanup(env.base);
  }
});

test('执行器：stop_on_fail 中止后续步骤并标记 skipped', async () => {
  const echo = await startEcho((req, res) => {
    if (req.url.includes('fail')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const failId = makeApi(target, { name: '失败', url: `${echo.base}/fail` });
    const afterId = makeApi(target, { name: '之后', url: `${echo.base}/after` });
    const flow = createFlow(target, {
      name: '失败即停',
      steps: [
        { target_id: failId, input: {} },
        { target_id: afterId, input: {} }
      ]
    });
    updateFlow(target, flow.flow_id, { stop_on_fail: true });

    const result = await runFlow({ dataRoot: env.root, projectId: env.projectId, flowId: flow.flow_id, envId: '2503d4840ac010' });
    assert.equal(result.status, 'failed');
    assert.equal(result.total, 1, '第二步应被跳过而不计入');
    assert.equal(result.tree[1].status, 'skipped');
  } finally {
    await echo.close();
    cleanup(env.base);
  }
});

test('执行器：报告树与计划结构同构，可还原层级', async () => {
  const echo = await startEcho();
  const env = makeTempRoot();
  const target = openProject({ dataRoot: env.root, projectId: env.projectId });
  try {
    const apiId = makeApi(target, { name: '回显', url: `${echo.base}/x` });
    const flow = createFlow(target, {
      name: '嵌套结构',
      steps: [
        { target_id: apiId, input: {} },
        {
          type: 'loop',
          times: 2,
          children: [
            {
              type: 'if',
              condition: 'apt.response.json().ok === true',
              children: [{ target_id: apiId, input: {} }],
              else_children: []
            }
          ]
        }
      ]
    });

    const result = await runFlow({ dataRoot: env.root, projectId: env.projectId, flowId: flow.flow_id, envId: '2503d4840ac010' });
    const loopNode = result.tree[1];
    assert.equal(loopNode.type, 'loop');
    assert.equal(loopNode.iterations.length, 2);
    const firstIf = loopNode.iterations[0].children[0];
    assert.equal(firstIf.type, 'if');
    assert.equal(firstIf.children[0].type, 'step');
    // 嵌套里的步骤也应进扁平 steps 列表（供历史统计）
    // 1（外层）+ 2 轮 × 1（if 里命中的那 1 步）= 3
    assert.equal(result.total, 3);
  } finally {
    await echo.close();
    cleanup(env.base);
  }
});

test('MCP：控制器计划仍能通过 create_execution_flow 创建', async () => {
  const echo = await startEcho();
  const env = makeTempRoot();
  try {
    const target = openProject({ dataRoot: env.root, projectId: env.projectId });
    const apiId = makeApi(target, { name: '回显', url: `${echo.base}/x` });
    const ctx = await makeContext(env);
    const created = await callTool(
      'apimcp_create_execution_flow',
      {
        project_id: env.projectId,
        name: 'MCP 平铺计划',
        steps: [{ target_id: apiId, input: {} }]
      },
      ctx
    );
    assert.ok(created.flow_id);
    assert.equal(created.step_count, 1);
  } finally {
    await echo.close();
    cleanup(env.base);
  }
});
