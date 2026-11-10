import { flowId, stepId } from '../util/ids.js';

const FLOWS_INDEX_REL = 'project/executions/flows/index.json';
const flowRelPath = (id) => `project/executions/flows/${id}.json`;

export function readFlowsIndex(target) {
  const index = target.readJson(FLOWS_INDEX_REL, null);
  if (!index || !Array.isArray(index.records)) {
    return { version: 2, updated_at: '', records: [] };
  }
  return index;
}

function writeFlowsIndex(target, index) {
  target.writeJson(FLOWS_INDEX_REL, index);
  return index;
}

function summarizeFlow(flow) {
  return {
    flow_id: flow.flow_id,
    project_id: flow.project_id,
    name: flow.name,
    description: flow.description,
    environment_id: flow.environment_id,
    source: flow.source,
    step_count: Array.isArray(flow.steps) ? flow.steps.length : 0,
    created_at: flow.created_at,
    updated_at: flow.updated_at
  };
}

export function listFlows(target) {
  return readFlowsIndex(target).records;
}

export function getFlow(target, flowIdValue) {
  const flow = target.readJson(flowRelPath(flowIdValue), null);
  if (!flow || flow.flow_id !== flowIdValue) return null;
  return flow;
}

export function assertFlow(target, flowIdValue) {
  if (!flowIdValue) throw new Error('缺少 flow_id');
  const flow = getFlow(target, flowIdValue);
  if (!flow) throw new Error(`执行计划不存在：${flowIdValue}`);
  return flow;
}

export function saveFlow(target, flow) {
  const index = readFlowsIndex(target);
  const now = target.now();
  const existing = index.records.find((r) => r.flow_id === flow.flow_id);
  const payload = {
    ...flow,
    project_id: target.projectId,
    created_at: existing?.created_at || flow.created_at || now,
    updated_at: now
  };
  delete payload.status;
  delete payload.ignored_differences;

  target.writeJson(flowRelPath(payload.flow_id), payload);
  const summary = summarizeFlow(payload);
  index.records = [summary, ...index.records.filter((r) => r.flow_id !== payload.flow_id)];
  writeFlowsIndex(target, { version: 2, updated_at: now, records: index.records });
  return payload;
}

export function createFlow(target, { name, description, environmentId, steps, source = 'mcp' }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('请填写业务流程名称');
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('业务流程至少需要一个 HTTP 接口步骤');
  }
  const now = target.now();
  return saveFlow(target, {
    flow_id: flowId(),
    project_id: target.projectId,
    name: trimmed,
    description: String(description || '').trim(),
    environment_id: environmentId || undefined,
    source,
    steps,
    created_at: now,
    updated_at: now
  });
}

export function updateFlow(target, flowIdValue, patch) {
  const flow = assertFlow(target, flowIdValue);
  const next = {
    ...flow,
    name: patch.name !== undefined ? String(patch.name || '').trim() : flow.name,
    description: patch.description !== undefined ? String(patch.description || '').trim() : flow.description,
    environment_id: 'environmentId' in patch ? patch.environmentId : flow.environment_id,
    steps: patch.steps !== undefined ? patch.steps : flow.steps
  };
  if (!next.name) throw new Error('请填写业务流程名称');
  if (!Array.isArray(next.steps) || next.steps.length === 0) {
    throw new Error('业务流程至少需要一个 HTTP 接口步骤');
  }
  return saveFlow(target, next);
}

export function deleteFlow(target, flowIdValue) {
  const flow = assertFlow(target, flowIdValue);
  target.remove(flowRelPath(flowIdValue));
  const index = readFlowsIndex(target);
  index.records = index.records.filter((r) => r.flow_id !== flowIdValue);
  writeFlowsIndex(target, { version: 2, updated_at: target.now(), records: index.records });
  return { deleted: true, flow_id: flow.flow_id };
}

export function makeStepId() {
  return stepId();
}

/** 组装一个执行计划的 step（固化 api_snapshot） */
export function buildStep({ targetId, apiSnapshot, input = {}, preScript, postScript, stepIdValue }) {
  return {
    step_id: stepIdValue || stepId(),
    target_id: targetId,
    api_snapshot: structuredClone(apiSnapshot),
    input: structuredClone(input || {}),
    ...(preScript != null ? { pre_script: String(preScript) } : {}),
    ...(postScript != null ? { post_script: String(postScript) } : {})
  };
}

export function ensureFlowsDir(target) {
  target.ensureDir('project/executions/flows');
  if (!target.exists(FLOWS_INDEX_REL)) {
    writeFlowsIndex(target, { version: 2, updated_at: target.now(), records: [] });
  }
  return true;
}
