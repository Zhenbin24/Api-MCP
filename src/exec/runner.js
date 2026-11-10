import { openShadow } from '../store/shadow.js';
import { findApiItem, readApiFile, ensureApiFile, TARGET_TYPE } from '../store/apis.js';
import { assertEnv, readEnvVarsHistory, readGlobalVars, readGlobalVarsHistory, listEnvironments, envBaseUrl } from '../store/envs.js';
import { readGlobalParams } from '../store/projects.js';
import { assertFlow } from '../store/flows.js';
import { newRunId, saveRun } from '../store/runs.js';
import { executeRequest, createCookieJar } from './http.js';
import { stepId as makeStepId } from '../util/ids.js';

/** 当前环境：显式指定 > 官方记忆的偏好环境 > 第一个环境 */
export function resolveEnvironment(target, { envId, preferredEnvId } = {}) {
  const envs = listEnvironments(target);
  if (envs.length === 0) throw new Error('项目还没有任何环境，请先用 apipost_create_environment 创建');
  if (envId) return assertEnv(target, envId);
  const pick =
    envs.find((e) => e.env_id === preferredEnvId) ||
    envs.find((e) => String(e.env_id) === '1') ||
    envs[0];
  return pick;
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
  shadowRoot,
  projectId,
  targetId,
  input = {},
  envId,
  preferredEnvId,
  source = 'mcp',
  fetchImpl,
  timeoutMs,
  /** 仅控制台「发送」需要：把二进制原始字节一并带回（不落盘） */
  includeBinary = false
}) {
  const target = openShadow({ shadowRoot, projectId });
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
  const globalParams = shadowGlobalParams(target);

  const result = await executeRequest({
    apiDetail,
    input,
    env,
    ...ctx,
    globalParams,
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
        ? `接口执行通过，run_id=${run.run_id}。使用 apipost_get_execution_result 查看完整请求/响应。`
        : `接口执行失败：${result.error || '未知错误'}。使用 apipost_get_execution_result 查看详情。`
  };

  if (includeBinary) {
    summary.content_type = result.response?.content_type || '';
    summary.is_binary = Boolean(result.response?.is_binary);
    summary.body_base64 = result.live_binary?.body_base64 || null;
    summary.too_large_for_base64 = Boolean(result.live_binary?.too_large);
  }

  return summary;
}

/** 执行计划 */
export async function runFlow({
  shadowRoot,
  projectId,
  flowId,
  envId,
  preferredEnvId,
  source = 'mcp',
  fetchImpl,
  timeoutMs
}) {
  const target = openShadow({ shadowRoot, projectId });
  const flow = assertFlow(target, flowId);
  const env = resolveEnvironment(target, { envId: envId || flow.environment_id, preferredEnvId });
  const ctx = envContext(target, env);
  const globalParams = shadowGlobalParams(target);
  const cookieJar = createCookieJar();

  const startedAt = new Date().toISOString();
  const startTs = Date.now();
  const steps = [];
  const allWrites = { environment: {}, globals: {} };

  for (const step of flow.steps || []) {
    const snapshot = step.api_snapshot;
    if (!snapshot) {
      steps.push({
        step_id: step.step_id,
        target_id: step.target_id,
        name: '',
        method: '',
        url: '',
        status: 'failed',
        error: '步骤缺少接口快照，请删除后重新添加接口'
      });
      break;
    }

    const result = await executeRequest({
      apiDetail: snapshot,
      input: step.input || {},
      env,
      ...ctx,
      globalParams,
      runBuiltinScripts: false, // 流程忽略接口自带脚本
      extraPreScript: step.pre_script || '',
      extraPostScript: step.post_script || '',
      cookieJar,
      fetchImpl,
      timeoutMs
    });

    // 变量写回同步进当前上下文，后续步骤可直接引用
    mergeWrites(ctx, env, result.variable_writes);
    mergeWrites(allWrites, env, result.variable_writes);

    steps.push({
      step_id: step.step_id,
      target_id: step.target_id,
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
    });

    // 失败继续执行后续步骤（便于观察整条链路），但整体标记 failed
  }

  const run = {
    run_id: newRunId(),
    project_id: projectId,
    source,
    scope: 'flow',
    flow_id: flow.flow_id,
    flow_name: flow.name,
    target_ids: (flow.steps || []).map((s) => s.target_id),
    environment_id: env.env_id,
    status: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    elapsed_ms: Date.now() - startTs,
    steps
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
    message:
      run.status === 'passed'
        ? `执行计划跑通（${steps.length} 步），run_id=${run.run_id}`
        : `执行计划存在 ${failedSteps.length} 个失败步骤，run_id=${run.run_id}`
  };
}

function shadowProjectRootForParams(target) {
  return target.shadowRoot;
}

function shadowGlobalParams(target) {
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

/** 把脚本里 apt.environment.set / apt.globals.set 的值持久化到影子（运行时值） */
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
