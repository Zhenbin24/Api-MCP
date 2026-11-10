import { runId as makeRunId } from '../util/ids.js';

const RUNS_INDEX_REL = 'project/executions/runs/index.json';
const runsDirRel = 'project/executions/runs';
const MAX_RUNS = 50;

const SENSITIVE_KEY = /authorization|cookie|token|secret|password|api[-_]?key/i;

/** 递归给敏感键打码（保留结构，值替换为 ***） */
export function redact(value, key = '') {
  if (SENSITIVE_KEY.test(String(key))) return '***';
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

export function readRunsIndex(target) {
  const index = target.readJson(RUNS_INDEX_REL, null);
  if (!index || !Array.isArray(index.records)) {
    return { version: 2, updated_at: '', records: [] };
  }
  return index;
}

function writeRunsIndex(target, index) {
  target.writeJson(RUNS_INDEX_REL, index);
  return index;
}

const runRelPath = (id) => `${runsDirRel}/${id}.json`;

export function summarizeRun(run) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const failed = steps
    .filter((s) => s.status === 'failed')
    .map((s) => ({
      step_id: s.step_id,
      target_id: s.target_id,
      name: s.name,
      method: s.method,
      url: s.url,
      status_code: s.status_code,
      error: s.error
    }));
  return {
    run_id: run.run_id,
    source: run.source,
    scope: run.scope,
    flow_id: run.flow_id,
    flow_name: run.flow_name,
    environment_id: run.environment_id,
    status: run.status,
    started_at: run.started_at,
    finished_at: run.finished_at,
    elapsed_ms: run.elapsed_ms,
    total: steps.length,
    passed: steps.filter((s) => s.status === 'passed').length,
    failed: failed.length,
    failed_steps: failed,
    detail_file: runRelPath(run.run_id)
  };
}

export function saveRun(target, run) {
  const stored = {
    ...run,
    steps: (run.steps || []).map((s) => ({
      step_id: s.step_id,
      target_id: s.target_id,
      name: s.name,
      method: s.method,
      url: s.url,
      status: s.status,
      status_code: s.status_code,
      network_elapsed_ms: s.network_elapsed_ms,
      elapsed_ms: s.elapsed_ms,
      input: s.input,
      request: s.request,
      response: s.response,
      auth: s.auth,
      cookies: s.cookies,
      body_mode: s.body_mode,
      body_binary: s.body_binary,
      assertions: s.assertions,
      console: s.console,
      variables: s.variables,
      error: s.error
    }))
  };

  const index = readRunsIndex(target);
  const summary = { ...summarizeRun(stored), detail_file: runRelPath(stored.run_id) };
  const records = [summary, ...index.records.filter((r) => r.run_id !== stored.run_id)];
  const keep = records.slice(0, MAX_RUNS);
  const drop = records.slice(MAX_RUNS);

  target.writeJson(runRelPath(stored.run_id), stored);
  writeRunsIndex(target, { version: 2, updated_at: target.now(), records: keep });
  for (const item of drop) {
    const rel = item.detail_file || runRelPath(item.run_id);
    target.remove(rel);
  }
  return stored;
}

export function listRuns(target, { scope, source, status, flowId, limit = 20 } = {}) {
  let records = readRunsIndex(target).records;
  if (scope) records = records.filter((r) => r.scope === scope);
  if (source) records = records.filter((r) => r.source === source);
  if (status) records = records.filter((r) => r.status === status);
  if (flowId) records = records.filter((r) => r.flow_id === flowId);
  const n = Math.max(1, Math.min(MAX_RUNS, Number(limit) || 20));
  return { runs: records.slice(0, n), total: records.length };
}

export function getRun(target, runIdValue) {
  const run = target.readJson(runRelPath(runIdValue), null);
  if (!run || run.run_id !== runIdValue) return null;
  return run;
}

export function assertRun(target, runIdValue) {
  if (!runIdValue) throw new Error('缺少 run_id');
  const run = getRun(target, runIdValue);
  if (!run) throw new Error(`执行记录不存在：${runIdValue}`);
  return run;
}

export function newRunId() {
  return makeRunId();
}

export function ensureRunsDir(target) {
  target.ensureDir(runsDirRel);
  if (!target.exists(RUNS_INDEX_REL)) {
    writeRunsIndex(target, { version: 2, updated_at: target.now(), records: [] });
  }
  return true;
}
