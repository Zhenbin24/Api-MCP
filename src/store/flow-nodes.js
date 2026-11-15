/**
 * 执行计划的节点模型：普通接口步骤 + 自动化控制器。
 *
 * 向后兼容原则：历史数据里的步骤**没有 type 字段**，一律按 'step' 处理，
 * 不做任何数据迁移，老计划可以直接跑。
 *
 * 节点形状（除 step 外都允许嵌套 children）：
 *   step   { step_id, target_id, api_snapshot, input, pre_script, post_script }
 *   if     { step_id, type:'if', condition, children: [], else_children: [] }
 *   loop   { step_id, type:'loop', times, children: [] }
 *   while  { step_id, type:'while', condition, max_iterations, children: [] }
 *   wait   { step_id, type:'wait', ms }
 *   script { step_id, type:'script', script }
 */

import { stepId as makeStepId } from '../util/ids.js';
import { findApiItem, ensureApiFile, TARGET_TYPE } from './apis.js';

export const NODE_TYPE = {
  STEP: 'step',
  IF: 'if',
  LOOP: 'loop',
  WHILE: 'while',
  WAIT: 'wait',
  SCRIPT: 'script'
};

/** 能装子节点的控制器类型 */
const CONTAINER_TYPES = new Set([NODE_TYPE.IF, NODE_TYPE.LOOP, NODE_TYPE.WHILE]);

export const NODE_LABEL = {
  step: '接口',
  if: '条件控制器',
  loop: '次数控制器',
  while: 'While 控制器',
  wait: '等待控制器',
  script: '脚本控制器'
};

/** 历史数据没有 type，统一按 step 解释 */
export function nodeType(node) {
  const type = String(node?.type || '').trim();
  return Object.values(NODE_TYPE).includes(type) ? type : NODE_TYPE.STEP;
}

export function isContainer(node) {
  return CONTAINER_TYPES.has(nodeType(node));
}

/** 遍历树里所有节点，带父节点信息，便于统计与校验 */
export function walkNodes(nodes, visit, parent = null, depth = 0) {
  for (const node of nodes || []) {
    visit(node, parent, depth);
    if (nodeType(node) === NODE_TYPE.IF) {
      walkNodes(node.children, visit, node, depth + 1);
      walkNodes(node.else_children, visit, node, depth + 1);
    } else if (CONTAINER_TYPES.has(nodeType(node))) {
      walkNodes(node.children, visit, node, depth + 1);
    }
  }
}

/** 收集计划里所有引用的接口 target_id（去重，保持顺序） */
export function collectTargetIds(nodes) {
  const out = [];
  walkNodes(nodes, (node) => {
    const id = node?.target_id;
    if (nodeType(node) === NODE_TYPE.STEP && id && !out.includes(id)) out.push(id);
  });
  return out;
}

/** 统计执行计划里真正的接口步骤数（控制器不算） */
export function countSteps(nodes) {
  let count = 0;
  walkNodes(nodes, (node) => {
    if (nodeType(node) === NODE_TYPE.STEP) count += 1;
  });
  return count;
}

/** 校验单个节点的必填项；返回规范化后的节点 */
function finishNode(target, raw, type, id, existingMap) {
  const existing = raw.step_id && existingMap?.get(raw.step_id);

  if (type === NODE_TYPE.STEP) {
    const targetId = raw.target_id;
    if (!targetId) throw new Error('每个接口步骤都必须提供 target_id');

    const item = findApiItem(target, targetId);
    if (!item) throw new Error(`接口不存在：${targetId}`);
    if (item.target_type !== TARGET_TYPE.API) {
      throw new Error(`执行计划仅支持 HTTP 接口：${item.name || targetId} 的类型是 ${item.target_type}`);
    }

    // 已有步骤沿用原快照（官方语义：只有新增接口才固化最新详情）
    const base = existing && nodeType(existing) === NODE_TYPE.STEP ? existing : null;
    if (base) {
      return {
        ...base,
        step_id: id,
        type: NODE_TYPE.STEP,
        target_id: targetId,
        input: raw.input !== undefined ? structuredClone(raw.input) : base.input,
        ...(raw.pre_script !== undefined ? { pre_script: String(raw.pre_script) } : {}),
        ...(raw.post_script !== undefined ? { post_script: String(raw.post_script) } : {})
      };
    }

    const file = ensureApiFile(target, targetId);
    if (!file?.data) throw new Error(`接口定义文件缺失：${targetId}`);
    return {
      step_id: id,
      type: NODE_TYPE.STEP,
      target_id: targetId,
      api_snapshot: structuredClone(file.data),
      input: structuredClone(raw.input || {}),
      ...(raw.pre_script != null ? { pre_script: String(raw.pre_script) } : {}),
      ...(raw.post_script != null ? { post_script: String(raw.post_script) } : {})
    };
  }

  if (type === NODE_TYPE.IF) {
    const condition = String(raw.condition || '').trim();
    if (!condition) throw new Error('条件控制器必须填写条件表达式');
    const children = normalizeNodes(target, raw.children, { existingNodes: existing?.children });
    const elseChildren = normalizeNodes(target, raw.else_children, { existingNodes: existing?.else_children });
    if (children.length === 0 && elseChildren.length === 0) {
      throw new Error('条件控制器至少要有一个子节点');
    }
    return { step_id: id, type, condition, children, else_children: elseChildren };
  }

  if (type === NODE_TYPE.LOOP) {
    const times = Math.max(0, Math.min(1000, Number(raw.times) || 0));
    if (times <= 0) throw new Error('次数控制器的循环次数必须大于 0');
    const children = normalizeNodes(target, raw.children, { existingNodes: existing?.children });
    if (children.length === 0) throw new Error('次数控制器至少要有一个子节点');
    return { step_id: id, type, times, children };
  }

  if (type === NODE_TYPE.WHILE) {
    const condition = String(raw.condition || '').trim();
    if (!condition) throw new Error('While 控制器必须填写条件表达式');
    const children = normalizeNodes(target, raw.children, { existingNodes: existing?.children });
    if (children.length === 0) throw new Error('While 控制器至少要有一个子节点');
    const maxIterations = Math.max(1, Math.min(1000, Number(raw.max_iterations) || 100));
    return { step_id: id, type, condition, max_iterations: maxIterations, children };
  }

  if (type === NODE_TYPE.WAIT) {
    const ms = Math.max(0, Math.min(600000, Number(raw.ms) || 0));
    return { step_id: id, type, ms };
  }

  if (type === NODE_TYPE.SCRIPT) {
    return { step_id: id, type, script: String(raw.script || '') };
  }

  return null;
}

/** 把一整棵节点数组规范化（递归） */
export function normalizeNodes(target, nodes, { existingNodes = null } = {}) {
  if (!Array.isArray(nodes)) return [];
  const existingMap = new Map();
  if (existingNodes) {
    walkNodes(existingNodes, (node) => {
      if (node?.step_id) existingMap.set(node.step_id, node);
    });
  }
  const usedIds = new Set();
  const out = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const type = nodeType(raw);
    // 复用已有 id（更新计划时前端会带回），id 撞车就换新的避免报告串行
    let id = raw.step_id || makeStepId();
    if (usedIds.has(id)) id = makeStepId();
    usedIds.add(id);
    const node = finishNode(target, raw, type, id, existingMap);
    if (node) out.push(node);
  }
  return out;
}

/**
 * 规范化整个计划的节点树，并校验「至少一个接口步骤」。
 * @returns {Array} 规范化后的节点数组
 */
export function normalizeFlowNodes(target, nodes, { existingNodes = null } = {}) {
  const normalized = normalizeNodes(target, nodes, { existingNodes });
  if (countSteps(normalized) === 0) {
    throw new Error('执行计划至少需要一个 HTTP 接口步骤');
  }
  return normalized;
}

/** 生成一个空控制器节点，给前端「插入控制器」用 */
export function makeControllerNode(type) {
  const id = makeStepId();
  if (type === NODE_TYPE.IF) return { step_id: id, type, condition: '', children: [], else_children: [] };
  if (type === NODE_TYPE.LOOP) return { step_id: id, type, times: 3, children: [] };
  if (type === NODE_TYPE.WHILE) return { step_id: id, type, condition: '', max_iterations: 100, children: [] };
  if (type === NODE_TYPE.WAIT) return { step_id: id, type, ms: 1000 };
  if (type === NODE_TYPE.SCRIPT) return { step_id: id, type, script: '' };
  return null;
}
