import { openProject } from '../store/target.js';
import { findApiItem, readApiFile, ensureApiFile, TARGET_TYPE } from '../store/apis.js';
import {
  assertEnv,
  readEnvVarsHistory,
  readGlobalVars,
  readGlobalVarsHistory,
  listEnvironments,
  envBaseUrl,
  resolveCurrentEnv
} from '../store/envs.js';
import { assertFlow } from '../store/flows.js';
import { NODE_TYPE, nodeType, collectTargetIds } from '../store/flow-nodes.js';
import { newRunId, saveRun } from '../store/runs.js';
import { buildEffectiveRequest } from './inherit.js';
import { executeRequest, createCookieJar } from './http.js';
import { runScript } from './script.js';
import { createVariableScope } from './template.js';
import { stepId as makeStepId } from '../util/ids.js';

/** 当前环境：显式指定 > 项目记录的当前环境 > 配置的偏好环境 > 默认环境 > 第一个 */
export function resolveEnvironment(target, { envId, preferredEnvId } = {}) {
  return resolveCurrentEnv(target, { envId, preferredEnvId });
}

function envContext(target, env) {
  const runtimeAll = readEnvVarsHistory(target);
  return {
    envVars: env?.env_var_list || {},
    envRuntime: runtimeAll[env?.env_id] || {},
    globalVars: readGlobalVars(target),
    globalRuntime: readGlobalVarsHistory(target)
  };
}

/** 单接口执行 */
export async function runApi({
  dataRoot,
  projectId,
  targetId,
  input = {},
  envId,
  preferredEnvId,
  source = 'mcp',
  fetchImpl,
  timeoutMs,
  /** 仅控制台「发送」需要：把二进制原始字节一并带回（不落盘） */
  includeBinary = false,
  /** 仅控制台「发送」需要：带回未脱敏的完整请求 / 响应详情（不落盘） */
  includeLiveDetail = false
}) {
  const target = openProject({ dataRoot, projectId });
  const item = findApiItem(target, targetId);
  if (!item) throw new Error(`接口不存在：${targetId}`);
  if (item.target_type !== TARGET_TYPE.API) {
    throw new Error(
      `一期仅支持 HTTP 接口执行：${item.name || targetId} 的类型是 ${item.target_type}。若想执行整个目录，请先创建执行计划再执行。`
    );
  }
  const file = ensureApiFile(target, targetId);
  const apiDetail = file?.data;
  if (!apiDetail) throw new Error(`接口定义文件缺失：${targetId}`);

  const env = resolveEnvironment(target, { envId, preferredEnvId });
  const ctx = envContext(target, env);
  const globalParams = readGlobalParamsOf(target);
  const effective = buildEffectiveRequest(target, apiDetail, env);

  const result = await executeRequest({
    apiDetail,
    input,
    env,
    ...ctx,
    globalParams,
    requestConfig: effective.request,
    baseUrlOverride: effective.baseUrl,
    runBuiltinScripts: true,
    cookieJar: createCookieJar(),
    fetchImpl,
    timeoutMs
  });

  const run = {
    run_id: newRunId(),
    project_id: projectId,
    source,
    scope: 'api',
    target_ids: [targetId],
    environment_id: env.env_id,
    status: result.status,
    started_at: result.started_at,
    finished_at: result.finished_at,
    elapsed_ms: result.elapsed_ms,
    steps: [
      {
        step_id: makeStepId(),
        target_id: targetId,
        name: item.name || '',
        method: item.method || '',
        url: item.url || '',
        status: result.status,
        status_code: result.response?.status,
        network_elapsed_ms: result.network_elapsed_ms,
        elapsed_ms: result.elapsed_ms,
        input: result.input,
        request: result.request,
        response: result.response,
        auth: undefined,
        cookies: undefined,
        body_mode: result.request?.body_mode,
        assertions: result.assertions,
        console: result.console,
        variables: result.variables,
        error: result.error
      }
    ]
  };

  saveRun(target, run);
  persistVariableWrites(target, env, result.variable_writes);

  const summary = {
    run_id: run.run_id,
    status: run.status,
    scope: 'api',
    target_id: targetId,
    environment_id: env.env_id,
    elapsed_ms: run.elapsed_ms,
    status_code: result.response?.status,
    error: result.error,
    assertions: result.assertions,
    message:
      run.status === 'passed'
        ? `接口执行通过，run_id=${run.run_id}。使用 apimcp_get_execution_result 查看完整请求/响应。`
        : `接口执行失败：${result.error || '未知错误'}。使用 apimcp_get_execution_result 查看详情。`
  };

  if (includeBinary) {
    summary.content_type = result.response?.content_type || '';
    summary.is_binary = Boolean(result.response?.is_binary);
    summary.body_base64 = result.live_binary?.body_base64 || null;
    summary.too_large_for_base64 = Boolean(result.live_binary?.too_large);
  }

  if (includeLiveDetail) {
    summary.live_detail = result.live_detail || null;
  }

  return summary;
}

/** 执行计划 */
export async function runFlow({
  dataRoot,
  projectId,
  flowId,
  envId,
  preferredEnvId,
  source = 'mcp',
  fetchImpl,
  timeoutMs
}) {
  const target = openProject({ dataRoot, projectId });
  const flow = assertFlow(target, flowId);
  const env = resolveEnvironment(target, { envId: envId || flow.environment_id, preferredEnvId });
  const ctx = envContext(target, env);
  const globalParams = readGlobalParamsOf(target);
  const cookieJar = createCookieJar();

  const startedAt = new Date().toISOString();
  const startTs = Date.now();
  const steps = [];
  const allWrites = { environment: {}, globals: {} };
  const state = { stopped: false };

  // 一次执行的总上下文：跨步骤共享变量、Cookie 与统计
  const runCtx = {
    target,
    env,
    ctx,
    globalParams,
    cookieJar,
    fetchImpl,
    timeoutMs,
    steps,
    allWrites,
    state,
    stopOnFail: Boolean(flow.stop_on_fail)
  };

  // 递归执行节点树，得到与结构同构的执行报告
  const tree = await executeNodes(flow.steps || [], runCtx, []);

  const run = {
    run_id: newRunId(),
    project_id: projectId,
    source,
    scope: 'flow',
    flow_id: flow.flow_id,
    flow_name: flow.name,
    stop_on_fail: Boolean(flow.stop_on_fail),
    target_ids: collectTargetIds(flow.steps || []),
    environment_id: env.env_id,
    status: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startTs,
    steps,
    tree
  };

  saveRun(target, run);
  persistVariableWrites(target, env, allWrites);

  const failedSteps = steps.filter((s) => s.status === 'failed');
  return {
    run_id: run.run_id,
    status: run.status,
    scope: 'flow',
    flow_id: flow.flow_id,
    flow_name: flow.name,
    environment_id: env.env_id,
    total: steps.length,
    passed: steps.filter((s) => s.status === 'passed').length,
    failed: failedSteps.length,
    failed_steps: failedSteps.map((s) => ({
      step_id: s.step_id,
      target_id: s.target_id,
      name: s.name,
      method: s.method,
      url: s.url,
      status_code: s.status_code,
      error: s.error
    })),
    elapsed_ms: run.elapsed_ms,
    tree,
    message:
      run.status === 'passed'
        ? `执行计划跑通（${steps.length} 步），run_id=${run.run_id}`
        : `执行计划存在 ${failedSteps.length} 个失败步骤，run_id=${run.run_id}`
  };
}

/* ---------------- 递归执行器（支持控制器嵌套） ---------------- */

/**
 * 执行一组节点，返回与节点树同构的执行报告。
 * @param {Array} nodes 节点数组
 * @param {object} runCtx 执行上下文（跨步骤共享）
 * @param {Array<string|number>} path 所在位置，用于报告页还原层级
 */
async function executeNodes(nodes, runCtx, path) {
  const out = [];
  for (let i = 0; i < (nodes || []).length; i += 1) {
    if (runCtx.state.stopped) {
      out.push(skippedNode(nodes[i], '前序步骤失败，已按 stop_on_fail 中止'));
      continue;
    }
    const node = nodes[i];
    const nodePath = [...path, i];
    const type = nodeType(node);

    if (type === NODE_TYPE.STEP) {
      out.push(await executeStepNode(node, runCtx, nodePath));
    } else if (type === NODE_TYPE.IF) {
      out.push(await executeIfNode(node, runCtx, nodePath));
    } else if (type === NODE_TYPE.LOOP) {
      out.push(await executeLoopNode(node, runCtx, nodePath));
    } else if (type === NODE_TYPE.WHILE) {
      out.push(await executeWhileNode(node, runCtx, nodePath));
    } else if (type === NODE_TYPE.WAIT) {
      out.push(await executeWaitNode(node, runCtx, nodePath));
    } else if (type === NODE_TYPE.SCRIPT) {
      out.push(await executeScriptNode(node, runCtx, nodePath));
    } else {
      out.push({ ...skippedNode(node, `未知节点类型：${type}`), path: nodePath });
    }
  }
  return out;
}

/** 接口步骤：沿用原有单步执行逻辑 */
async function executeStepNode(node, runCtx, path) {
  const snapshot = node.api_snapshot;
  if (!snapshot) {
    const report = {
      ...skippedNode(node, '步骤缺少接口快照，请删除后重新添加接口'),
      status: 'failed',
      path
    };
    runCtx.steps.push(report);
    if (runCtx.stopOnFail) runCtx.state.stopped = true;
    return report;
  }

  // 步骤按自己的接口快照走同一条继承链（全局参数 → 目录 → 接口）
  const stepEffective = buildEffectiveRequest(runCtx.target, snapshot, runCtx.env);
  const result = await executeRequest({
    apiDetail: snapshot,
    input: node.input || {},
    env: runCtx.env,
    ...runCtx.ctx,
    globalParams: runCtx.globalParams,
    requestConfig: stepEffective.request,
    baseUrlOverride: stepEffective.baseUrl,
    runBuiltinScripts: false, // 流程忽略接口自带脚本（全局/目录脚本仍会执行）
    extraPreScript: node.pre_script || '',
    extraPostScript: node.post_script || '',
    cookieJar: runCtx.cookieJar,
    fetchImpl: runCtx.fetchImpl,
    timeoutMs: runCtx.timeoutMs
  });

  // 变量写回同步进当前上下文，后续步骤可直接引用
  mergeWrites(runCtx.ctx, runCtx.env, result.variable_writes);
  mergeWrites(runCtx.allWrites, runCtx.env, result.variable_writes);

  const report = {
    step_id: node.step_id,
    type: NODE_TYPE.STEP,
    path,
    target_id: node.target_id,
    name: snapshot.name || '',
    method: snapshot.method || '',
    url: snapshot.url || '',
    status: result.status,
    status_code: result.response?.status,
    network_elapsed_ms: result.network_elapsed_ms,
    elapsed_ms: result.elapsed_ms,
    input: result.input,
    request: result.request,
    response: result.response,
    auth: undefined,
    cookies: undefined,
    body_mode: result.request?.body_mode,
    assertions: result.assertions,
    console: result.console,
    variables: result.variables,
    error: result.error
  };

  runCtx.steps.push(report);

  if (report.status === 'failed' && runCtx.stopOnFail) {
    runCtx.state.stopped = true;
  }
  return report;
}

/** 条件控制器：条件为真跑 children，否则跑 else_children */
async function executeIfNode(node, runCtx, path) {
  const started = Date.now();
  const evaluated = await evaluateCondition(node.condition, runCtx);
  const branch = evaluated.value ? 'children' : 'else_children';
  const branchNodes = evaluated.value ? node.children : node.else_children;

  const children = evaluated.error
    ? []
    : await executeNodes(branchNodes || [], runCtx, [...path, branch]);

  const failed = Boolean(evaluated.error) || children.some((c) => c.status === 'failed');

  return {
    step_id: node.step_id,
    type: NODE_TYPE.IF,
    path,
    condition: node.condition,
    condition_result: evaluated.value,
    branch: evaluated.error ? null : branch,
    status: evaluated.error ? 'failed' : failed ? 'failed' : 'passed',
    elapsed_ms: Date.now() - started,
    error: evaluated.error || undefined,
    children
  };
}

/** 次数控制器：按 times 重复执行 children，每轮可通过 {{$index}} 取当前序号 */
async function executeLoopNode(node, runCtx, path) {
  const started = Date.now();
  const times = Math.max(1, Math.min(1000, Number(node.times) || 1));
  const iterations = [];
  let failed = false;

  for (let index = 0; index < times; index += 1) {
    if (runCtx.state.stopped) {
      iterations.push({
        iteration: index,
        status: 'skipped',
        elapsed_ms: 0,
        children: [],
        error: '前序步骤失败，已中止'
      });
      continue;
    }

    const children = await executeNodes(
      node.children || [],
      withIterationContext(runCtx, index),
      [...path, 'iterations', index, 'children']
    );
    const iterationFailed = children.some((c) => c.status === 'failed');
    if (iterationFailed) failed = true;
    iterations.push({
      iteration: index,
      status: iterationFailed ? 'failed' : 'passed',
      elapsed_ms: children.reduce((sum, c) => sum + (c.elapsed_ms || 0), 0),
      children
    });
  }

  return {
    step_id: node.step_id,
    type: NODE_TYPE.LOOP,
    path,
    times,
    status: failed ? 'failed' : 'passed',
    elapsed_ms: Date.now() - started,
    iterations
  };
}

/** While 控制器：条件为真时循环，有 max_iterations 兜底防死循环 */
async function executeWhileNode(node, runCtx, path) {
  const started = Date.now();
  const maxIterations = Math.max(1, Math.min(1000, Number(node.max_iterations) || 100));
  const iterations = [];
  let failed = false;
  let error = null;
  let index = 0;

  while (index < maxIterations) {
    if (runCtx.state.stopped) break;
    const evaluated = await evaluateCondition(node.condition, runCtx);
    if (evaluated.error) {
      error = evaluated.error;
      failed = true;
      break;
    }
    if (!evaluated.value) break;

    const children = await executeNodes(
      node.children || [],
      withIterationContext(runCtx, index),
      [...path, 'iterations', index, 'children']
    );
    const iterationFailed = children.some((c) => c.status === 'failed');
    if (iterationFailed) failed = true;
    iterations.push({
      iteration: index,
      status: iterationFailed ? 'failed' : 'passed',
      elapsed_ms: children.reduce((sum, c) => sum + (c.elapsed_ms || 0), 0),
      children
    });
    index += 1;
  }

  // 跑到上限还没退出，说明条件可能永远为真，给出明确提示而不是静默结束
  if (index >= maxIterations && !error) {
    error = `While 控制器达到最大迭代次数（${maxIterations}），已强制退出`;
  }

  return {
    step_id: node.step_id,
    type: NODE_TYPE.WHILE,
    path,
    condition: node.condition,
    max_iterations: maxIterations,
    iterations: iterations.length,
    status: failed ? 'failed' : 'passed',
    elapsed_ms: Date.now() - started,
    error: error || undefined,
    children: iterations
  };
}

/** 循环里临时注入 $index / $iteration，轮末不污染外层上下文 */
function withIterationContext(runCtx, index) {
  return {
    ...runCtx,
    ctx: {
      ...runCtx.ctx,
      envRuntime: {
        ...runCtx.ctx.envRuntime,
        $index: { value: String(index) },
        $iteration: { value: String(index + 1) }
      }
    }
  };
}

/** 等待控制器 */
async function executeWaitNode(node, runCtx, path) {
  const started = Date.now();
  const ms = Math.max(0, Math.min(600000, Number(node.ms) || 0));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return {
    step_id: node.step_id,
    type: NODE_TYPE.WAIT,
    path,
    ms,
    status: 'passed',
    elapsed_ms: Date.now() - started
  };
}

/** 脚本控制器：只跑脚本不发请求，断言照常收集 */
async function executeScriptNode(node, runCtx, path) {
  const started = Date.now();
  const writes = { environment: {}, globals: {} };
  const persist = (area, key, value) => {
    if (!writes[area]) writes[area] = {};
    writes[area][key] = value;
  };

  const result = await runScript(
    node.script || '',
    {
      variables: createVariableScope(runCtx.ctx),
      request: { headers: {}, query: {}, body: undefined },
      response: lastResponseLike(runCtx),
      envInfo: { envName: runCtx.env?.name || '', baseUrl: '' },
      cookieJar: runCtx.cookieJar,
      persist
    },
    { phase: 'script' }
  );

  mergeWrites(runCtx.ctx, runCtx.env, writes);
  mergeWrites(runCtx.allWrites, runCtx.env, writes);

  const failedAssertions = (result.assertions || []).filter((a) => a.passed === false);
  const status = result.error || failedAssertions.length > 0 ? 'failed' : 'passed';

  const report = {
    step_id: node.step_id,
    type: NODE_TYPE.SCRIPT,
    path,
    script: node.script || '',
    status,
    elapsed_ms: Date.now() - started,
    assertions: result.assertions || [],
    console: result.console || [],
    error: result.error || (failedAssertions.length > 0 ? failedAssertions[0].message : undefined)
  };

  // 脚本控制器也算一步，计入总步数与失败统计
  runCtx.steps.push(report);
  if (status === 'failed' && runCtx.stopOnFail) runCtx.state.stopped = true;
  return report;
}

/** 取最近一步的响应，供控制器条件与脚本引用 */
function lastResponseLike(runCtx) {
  const last = [...runCtx.steps].reverse().find((s) => s.response);
  if (!last?.response) return null;
  return {
    status: last.response.status,
    headers: last.response.headers,
    bodyText: last.response.body
  };
}

/**
 * 求值控制器条件（JS 表达式）。
 * 表达式里可用的对象与脚本沙箱一致：apt.response / apt.variables / apt.environment 等。
 * 表达式结果按 JS 真值判断；语法错误会返回明确错误而不是静默当作 false。
 */
async function evaluateCondition(condition, runCtx) {
  const source = String(condition || '').trim();
  if (!source) return { value: false, error: '条件表达式为空' };

  // 用断言把"真值"问出来：apt.assert 在条件为假时会抛出 AssertionError
  const result = await runScript(
    `apt.assert(Boolean(${source}), '条件不成立');`,
    {
      variables: createVariableScope(runCtx.ctx),
      request: { headers: {}, query: {}, body: undefined },
      response: lastResponseLike(runCtx),
      envInfo: { envName: runCtx.env?.name || '', baseUrl: '' },
      cookieJar: runCtx.cookieJar,
      persist: () => {}
    },
    { phase: 'condition' }
  );

  if (!result.error) return { value: true };

  // 断言失败说明条件为假，属于正常分支；其它错误（语法 / 运行时）才是真错误
  if (/断言失败/.test(String(result.error))) return { value: false };
  // 表达式本身求值成功但结果非真值时，apt.assert 会抛 AssertionError，上一步已覆盖；
  // 这里只剩真正的语法 / 引用错误
  return { value: false, error: `条件求值失败：${result.error}` };
}

/** 被跳过的节点（中止或未知类型），保持报告树结构完整 */
function skippedNode(node, reason) {
  return {
    step_id: node?.step_id,
    type: nodeType(node),
    status: 'skipped',
    elapsed_ms: 0,
    error: reason,
    children: []
  };
}

function readGlobalParamsOf(target) {
  const params = target.readJson(target.p('global_params.json'), null);
  if (!params) return null;
  return params;
}

function mergeWrites(ctx, env, writes) {
  if (!writes) return;
  for (const [key, value] of Object.entries(writes.environment || {})) {
    if (ctx.envVars && env) {
      ctx.envVars[key] = { ...(ctx.envVars[key] || {}), current_value: value };
    }
    if (ctx.envRuntime) ctx.envRuntime[key] = { value };
  }
  for (const [key, value] of Object.entries(writes.globals || {})) {
    if (ctx.globalVars) ctx.globalVars[key] = { ...(ctx.globalVars[key] || {}), current_value: value };
    if (ctx.globalRuntime) ctx.globalRuntime[key] = { value };
  }
}

/** 把脚本里 apt.environment.set / apt.globals.set 的值持久化到工作区（运行时值） */
function persistVariableWrites(target, env, writes) {
  if (!writes) return;
  const envWrites = writes.environment || {};
  const globalWrites = writes.globals || {};

  if (Object.keys(envWrites).length > 0 && env?.env_id) {
    const history = target.readJson(target.l('env_vars_history.json'), {}) || {};
    history[env.env_id] = { ...(history[env.env_id] || {}) };
    for (const [k, v] of Object.entries(envWrites)) history[env.env_id][k] = { value: v };
    target.writeJson(target.l('env_vars_history.json'), history);
  }

  if (Object.keys(globalWrites).length > 0) {
    const history = target.readJson(target.l('global_vars_history.json'), {}) || {};
    for (const [k, v] of Object.entries(globalWrites)) history[k] = { value: v };
    target.writeJson(target.l('global_vars_history.json'), history);
  }
}

export { envBaseUrl };
