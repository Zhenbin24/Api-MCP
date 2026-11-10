/** 接口用例：存在接口文件的 data.cases 里，与接口绑定 */
import { readApiFile, writeApiFile, findApiItem, readApiIndex } from '../store/apis.js';

function now() {
  return new Date().toISOString();
}

function ensureCases(data) {
  if (!Array.isArray(data.cases)) data.cases = [];
  return data.cases;
}

export function makeEmptyCase(name = '新用例') {
  return {
    case_id: `case_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
    name,
    enabled: 1,
    input: {},
    expect_status: '',
    expect_body_contains: '',
    pre_script: '',
    post_script: '',
    created_at: now(),
    updated_at: now()
  };
}

export function listCases(target, targetId) {
  const file = readApiFile(target, targetId);
  if (!file?.data) throw new Error(`接口不存在：${targetId}`);
  return ensureCases(file.data).map((c) => ({ ...c }));
}

export function upsertCase(target, targetId, payload = {}) {
  const item = findApiItem(target, targetId);
  if (!item) throw new Error(`接口不存在：${targetId}`);
  const file = readApiFile(target, targetId);
  if (!file?.data) throw new Error(`接口定义缺失：${targetId}`);

  const data = file.data;
  const cases = ensureCases(data);
  const incoming = payload.case || payload;

  let targetCase = null;
  if (incoming.case_id) {
    targetCase = cases.find((c) => c.case_id === incoming.case_id) || null;
  }
  if (!targetCase) {
    targetCase = makeEmptyCase(String(incoming.name || '新用例'));
    cases.push(targetCase);
  }

  if (incoming.name !== undefined) targetCase.name = String(incoming.name || '未命名用例');
  if (incoming.enabled !== undefined) targetCase.enabled = Number(incoming.enabled) === 0 ? 0 : 1;
  if (incoming.input !== undefined) targetCase.input = incoming.input || {};
  if (incoming.expect_status !== undefined) targetCase.expect_status = String(incoming.expect_status ?? '');
  if (incoming.expect_body_contains !== undefined) {
    targetCase.expect_body_contains = String(incoming.expect_body_contains ?? '');
  }
  if (incoming.pre_script !== undefined) targetCase.pre_script = String(incoming.pre_script ?? '');
  if (incoming.post_script !== undefined) targetCase.post_script = String(incoming.post_script ?? '');
  targetCase.updated_at = now();

  writeApiFile(target, targetId, data, item);
  return { case: { ...targetCase }, total: cases.length };
}

export function deleteCase(target, targetId, caseId) {
  const item = findApiItem(target, targetId);
  if (!item) throw new Error(`接口不存在：${targetId}`);
  const file = readApiFile(target, targetId);
  if (!file?.data) throw new Error(`接口定义缺失：${targetId}`);

  const data = file.data;
  const cases = ensureCases(data);
  const idx = cases.findIndex((c) => c.case_id === caseId);
  if (idx < 0) throw new Error(`用例不存在：${caseId}`);
  cases.splice(idx, 1);

  writeApiFile(target, targetId, data, item);
  return { deleted: true, case_id: caseId, total: cases.length };
}

/** 项目内所有接口的用例汇总 */
export function collectProjectCases(target) {
  const index = readApiIndex(target);
  const out = [];
  for (const item of index.items || []) {
    if (item.target_type !== 'api') continue;
    const file = readApiFile(target, item.target_id);
    const cases = Array.isArray(file?.data?.cases) ? file.data.cases : [];
    for (const c of cases) {
      out.push({
        ...c,
        target_id: item.target_id,
        api_name: item.name || '',
        method: String(item.method || '').toUpperCase(),
        url: item.url || ''
      });
    }
  }
  return out;
}
