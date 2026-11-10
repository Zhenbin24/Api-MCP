/**
 * 单进程异步并发压测。
 * 通过「并发数 × 轮次」或「并发数 × 持续时长」方式，循环触发接口执行，
 * 收集耗时分布与成功率，产出 P50/P90/P99 等分位统计。
 *
 * 注意：压测时执行接口的断言与脚本（可按需关闭），会消耗 CPU 影响吞吐。
 */
import { executeRequest, createCookieJar } from './http.js';
import { openShadow } from '../store/shadow.js';
import { findApiItem, ensureApiFile, TARGET_TYPE } from '../store/apis.js';
import { listEnvironments, readEnvVarsHistory, readGlobalVars, readGlobalVarsHistory, assertEnv } from '../store/envs.js';
import { resolveEnvironment } from './runner.js';

const DEFAULT_TIMEOUT_MS = 60000;

function pickEnv(target, envId) {
  const envs = listEnvironments(target);
  if (envs.length === 0) throw new Error('项目还没有任何环境');
  if (envId) return assertEnv(target, envId);
  return envs.find((e) => String(e.env_id) === '1') || envs[0];
}

function contextOf(target, env) {
  const runtimeAll = readEnvVarsHistory(target);
  return {
    envVars: env?.env_var_list || {},
    envRuntime: runtimeAll[env?.env_id] || {},
    globalVars: readGlobalVars(target),
    globalRuntime: readGlobalVarsHistory(target)
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(timings, failures, statusCodes, totalElapsedMs) {
  const sorted = [...timings].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const total = sorted.length + failures;
  const codeDistribution = {};
  for (const [code, count] of Object.entries(statusCodes)) {
    codeDistribution[code] = count;
  }

  return {
    total,
    success: sorted.length,
    failed: failures,
    success_rate: total > 0 ? Number(((sorted.length / total) * 100).toFixed(2)) : 0,
    elapsed_ms: totalElapsedMs,
    qps: totalElapsedMs > 0 ? Number(((total / totalElapsedMs) * 1000).toFixed(2)) : 0,
    latency: {
      min: sorted.length ? sorted[0] : 0,
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      avg: sorted.length ? Number((sum / sorted.length).toFixed(1)) : 0,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99)
    },
    status_codes: codeDistribution
  };
}

/**
 * 执行压测。
 * @param {object} opts
 * @param {string} opts.shadowRoot
 * @param {string} opts.projectId
 * @param {string} opts.targetId
 * @param {number} opts.concurrency   并发数（>=1）
 * @param {'rounds'|'duration'} opts.mode
 * @param {number} opts.rounds        总轮次（mode=rounds 时有效）
 * @param {number} opts.durationMs    持续时长（mode=duration 时有效）
 * @param {boolean} opts.runAssertions 是否执行断言与脚本
 * @param {string} opts.envId
 * @param {function} opts.onProgress   进度回调 (done, total)
 */
export async function runStress(opts) {
  const {
    shadowRoot,
    projectId,
    targetId,
    concurrency = 1,
    mode = 'rounds',
    rounds = 1,
    durationMs = 0,
    runAssertions = true,
    envId,
    onProgress = null
  } = opts;

  const target = openShadow({ shadowRoot, projectId });
  const item = findApiItem(target, targetId);
  if (!item) throw new Error(`接口不存在：${targetId}`);
  if (item.target_type !== TARGET_TYPE.API) {
    throw new Error(`压测仅支持 HTTP 接口：${item.name || targetId} 类型为 ${item.target_type}`);
  }

  const file = ensureApiFile(target, targetId);
  const apiDetail = file?.data;
  if (!apiDetail) throw new Error(`接口定义缺失：${targetId}`);

  const env = pickEnv(target, envId);
  const baseCtx = contextOf(target, env);

  const conc = Math.max(1, Math.min(200, Number(concurrency) || 1));
  const totalRounds = mode === 'rounds' ? Math.max(1, Number(rounds) || 1) : 0;
  const deadline = mode === 'duration' ? Date.now() + Math.max(1000, Number(durationMs) || 1000) : 0;

  const timings = [];
  const statusCodes = {};
  let failures = 0;
  let started = 0;
  let assertionFailed = 0;
  const errorSamples = [];

  const startedAt = Date.now();

  // 每轮执行一次
  const doOne = async () => {
    const result = await executeRequest({
      apiDetail,
      input: {},
      env,
      ...baseCtx,
      globalParams: target.readJson(target.p('global_params.json'), null),
      runBuiltinScripts: runAssertions,
      cookieJar: createCookieJar(),
      timeoutMs: DEFAULT_TIMEOUT_MS
    });

    const code = result.response?.status;
    if (code) statusCodes[String(code)] = (statusCodes[String(code)] || 0) + 1;

    if (result.status === 'passed') {
      timings.push(result.elapsed_ms);
    } else {
      failures += 1;
      if (result.assertions?.some((a) => a.passed === false)) assertionFailed += 1;
      if (errorSamples.length < 5 && result.error) errorSamples.push(result.error);
    }
  };

  // 工人循环
  const worker = async () => {
    while (true) {
      if (mode === 'rounds') {
        if (started >= totalRounds) return;
        started += 1;
      } else {
        if (Date.now() >= deadline) return;
        started += 1;
      }
      try {
        await doOne();
      } catch (err) {
        failures += 1;
        if (errorSamples.length < 5) errorSamples.push(err.message || String(err));
      }
      if (typeof onProgress === 'function') onProgress(started, mode === 'rounds' ? totalRounds : 0);
    }
  };

  const workers = Array.from({ length: conc }, () => worker());
  await Promise.all(workers);

  const elapsed = Date.now() - startedAt;
  const summary = summarize(timings, failures, statusCodes, elapsed);

  return {
    ...summary,
    target_id: targetId,
    api_name: item.name || '',
    method: String(item.method || '').toUpperCase(),
    url: item.url || '',
    environment_id: env.env_id,
    concurrency: conc,
    mode,
    rounds: mode === 'rounds' ? totalRounds : undefined,
    duration_ms: mode === 'duration' ? elapsed : undefined,
    run_assertions: runAssertions,
    assertion_failed: assertionFailed,
    error_samples: errorSamples,
    started_at: new Date(startedAt).toISOString()
  };
}

export { percentile };
