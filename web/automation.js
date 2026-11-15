/* 自动化测试：执行计划 + 控制器 + 执行报告（挂在 window.ApiAutomation 上，由 app.js 调用） */

/* 包进 IIFE：避免顶层函数泄漏到全局与其它页面脚本撞名 */
(() => {
'use strict';

const toast = (message, isError) => window.__consoleToast?.(message, isError);
const api = {
  get: (p, o) => window.__consoleApi.get(p, o),
  post: (p, b, o) => window.__consoleApi.post(p, b, o),
  put: (p, b, o) => window.__consoleApi.put(p, b, o),
  req: (m, p, b, o) => window.__consoleApi.req(m, p, b, o)
};
const showModal = (...args) => window.__consoleShowModal?.(...args);
const closeModal = (...args) => window.__consoleCloseModal?.(...args);

/* ---------------- 工具 ---------------- */

function aEl(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'value') node.value = v ?? '';
    else if (k === 'checked') node.checked = Boolean(v);
    else if (k === 'disabled') node.disabled = Boolean(v);
    else if (k === 'selected') node.selected = Boolean(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const child of children.flat(9)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(tag, attrs = {}, ...children) {
  return aEl(tag, attrs, ...children);
}

const deepClone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function stepId() {
  return `step_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function fmtDuration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function fmtTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

/* ---------------- 状态 ---------------- */

const NODE_TYPES = [
  ['if', '条件控制器'],
  ['loop', '次数控制器'],
  ['while', 'While 控制器'],
  ['wait', '等待控制器'],
  ['script', '脚本控制器']
];

const NODE_TYPE_LABEL = {
  step: '接口',
  if: '条件控制器',
  loop: '次数控制器',
  while: 'While 控制器',
  wait: '等待控制器',
  script: '脚本控制器'
};

const state = {
  projectId: null,
  /** 计划摘要列表 */
  flows: [],
  /** 当前打开的计划（完整对象） */
  flow: null,
  /** 当前选中节点 step_id */
  selectedNodeId: null,
  /** 上一次运行结果 */
  runResult: null,
  /** 右侧面板：editor | report */
  pane: 'editor',
  /** 可用接口（用于「添加步骤」下拉） */
  apiOptions: [],
  /** 可用环境 */
  envOptions: [],
  loading: false,
  busy: false,
  error: null
};

const hosts = { listHost: null, detailHost: null };

/* ---------------- 节点工具 ---------------- */

/** 历史数据没有 type，统一按 step 解释（与服务端保持一致） */
function nodeType(node) {
  const type = String(node?.type || '').trim();
  return Object.keys(NODE_TYPE_LABEL).includes(type) ? type : 'step';
}

function nodeLabel(node, index) {
  const type = nodeType(node);
  if (type === 'step') {
    const snap = node.api_snapshot || {};
    return snap.name || node.target_id || `步骤 ${index + 1}`;
  }
  if (type === 'if') return `条件：${node.condition || '(未填写)'}`;
  if (type === 'loop') return `循环 ${node.times || 0} 次`;
  if (type === 'while') return `While：${node.condition || '(未填写)'}`;
  if (type === 'wait') return `等待 ${node.ms || 0} ms`;
  if (type === 'script') return '脚本';
  return type;
}

function childKey(node) {
  return nodeType(node) === 'if' ? 'children' : 'children';
}

/** 在树里找到节点及其父容器，返回 { node, parentArray, index } */
function findNode(nodes, stepIdValue, parentArray = null) {
  for (let i = 0; i < (nodes || []).length; i += 1) {
    const node = nodes[i];
    if (String(node.step_id) === String(stepIdValue)) {
      return { node, parentArray: parentArray || nodes, index: i };
    }
    const arrays = [];
    if (nodeType(node) === 'if') {
      arrays.push(['children', node.children], ['else_children', node.else_children]);
    } else if (['loop', 'while'].includes(nodeType(node))) {
      arrays.push(['children', node.children]);
    }
    for (const [, arr] of arrays) {
      if (!Array.isArray(arr)) continue;
      const found = findNode(arr, stepIdValue, arr);
      if (found) return found;
    }
  }
  return null;
}

/** 统计接口步骤数（控制器不算） */
function countSteps(nodes) {
  let count = 0;
  const walk = (list) => {
    for (const node of list || []) {
      if (nodeType(node) === 'step') count += 1;
      if (nodeType(node) === 'if') {
        walk(node.children);
        walk(node.else_children);
      } else if (['loop', 'while'].includes(nodeType(node))) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return count;
}

/** 深拷贝并重新生成所有 step_id（复制计划用） */
function regenIds(nodes) {
  const out = deepClone(nodes || []);
  const walk = (list) => {
    for (const node of list || []) {
      node.step_id = stepId();
      if (nodeType(node) === 'if') {
        walk(node.children);
        walk(node.else_children);
      } else if (['loop', 'while'].includes(nodeType(node))) {
        walk(node.children);
      }
    }
  };
  walk(out);
  return out;
}

/** 新建一个控制器节点 */
function newController(type) {
  const id = stepId();
  if (type === 'if') return { step_id: id, type, condition: 'apt.response.code() === 200', children: [], else_children: [] };
  if (type === 'loop') return { step_id: id, type, times: 3, children: [] };
  if (type === 'while') return { step_id: id, type, condition: 'true', max_iterations: 100, children: [] };
  if (type === 'wait') return { step_id: id, type, ms: 1000 };
  if (type === 'script') return { step_id: id, type, script: '' };
  return null;
}

/* ---------------- 加载 ---------------- */

async function loadFlows(projectId) {
  state.loading = true;
  state.error = null;
  try {
    const [flowsRes, apisRes, envsRes] = await Promise.all([
      api.get(`/projects/${projectId}/flows`).catch(() => ({ flows: [] })),
      api.get(`/projects/${projectId}/apis`).catch(() => ({ items: [] })),
      api.get(`/projects/${projectId}/environments`).catch(() => ({ environments: [] }))
    ]);
    state.flows = flowsRes.flows || [];
    state.apiOptions = (apisRes.items || []).filter((i) => i.target_type === 'api');
    state.envOptions = envsRes.environments || [];
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
  }
}

async function openFlow(flowIdValue) {
  if (!flowIdValue) {
    state.flow = null;
    state.pane = 'editor';
    renderDetail();
    return;
  }
  state.busy = true;
  renderDetail();
  try {
    const res = await api.get(`/projects/${state.projectId}/flows/${flowIdValue}`);
    state.flow = res.flow;
    state.selectedNodeId = state.flow.steps?.[0]?.step_id || null;
    state.runResult = null;
    state.pane = 'editor';
    renderList();
  } catch (err) {
    toast(`读取计划失败：${err.message}`, true);
  } finally {
    state.busy = false;
    renderDetail();
  }
}

/* ---------------- 计划列表 ---------------- */

function planList() {
  if (state.loading) return aEl('div', { class: 'empty' }, '加载中…');
  if (state.flows.length === 0) {
    return aEl('div', { class: 'empty' }, '还没有执行计划。', aEl('div', { class: 'mt12 form-hint' }, '点下方「+ 新建计划」开始'));
  }
  return aEl(
    'div',
    { class: 'flow-list' },
    ...state.flows.map((flow) =>
      aEl(
        'div',
        {
          class: `flow-item${state.flow?.flow_id === flow.flow_id ? ' active' : ''}`,
          onclick: () => openFlow(flow.flow_id)
        },
        aEl('div', { class: 'flow-item-main' },
          aEl('div', { class: 'flow-item-name' }, flow.name || '未命名计划'),
          aEl('div', { class: 'flow-item-meta' },
            aEl('span', { class: 'tag' }, `${flow.step_count} 步`),
            aEl('span', { class: 'hint' }, fmtTime(flow.updated_at))
          )
        ),
        aEl('button', {
          class: 'flow-item-del small danger',
          title: '删除计划',
          onclick: async (e) => {
            e.stopPropagation();
            await removeFlow(flow);
          }
        }, '×')
      )
    )
  );
}

async function createFlowDialog() {
  const nameInput = aEl('input', { type: 'text', value: '新建计划', placeholder: '计划名称' });
  const envSelect = aEl(
    'select',
    {},
    aEl('option', { value: '' }, '跟随当前环境'),
    ...state.envOptions.map((e) => aEl('option', { value: e.env_id }, e.name))
  );

  const submit = async () => {
    const name = String(nameInput.value || '').trim();
    if (!name) {
      toast('名称不能为空', true);
      return;
    }
    // 新建时至少要有一个接口步骤，先选第一个可选接口
    if (state.apiOptions.length === 0) {
      toast('项目里还没有 HTTP 接口，请先到「接口设计」新建', true);
      return;
    }
    const first = state.apiOptions[0];
    try {
      const res = await api.post(`/projects/${state.projectId}/flows`, {
        name,
        environment_id: envSelect.value || undefined,
        steps: [{ target_id: first.target_id, input: {} }]
      });
      closeModal();
      await loadFlows(state.projectId);
      await openFlow(res.flow.flow_id);
      toast(`已创建「${name}」`);
    } catch (err) {
      toast(`创建失败：${err.message}`, true);
    }
  };

  const body = aEl(
    'div',
    { class: 'flow-form' },
    aEl('div', { class: 'form-row' }, aEl('label', { class: 'form-label' }, '名称'), aEl('div', { class: 'form-control' }, nameInput)),
    aEl('div', { class: 'form-row' }, aEl('label', { class: 'form-label' }, '环境'), aEl('div', { class: 'form-control' }, envSelect)),
    aEl('div', { class: 'form-hint' }, '创建后可在右侧插入接口步骤与控制器。')
  );

  showModal('新建执行计划', body, [aEl('button', { onclick: closeModal }, '取消'), aEl('button', { class: 'primary', onclick: submit }, '创建')]);
  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  }, 60);
}

async function duplicateFlow(flow) {
  try {
    const res = await api.get(`/projects/${state.projectId}/flows/${flow.flow_id}`);
    const created = await api.post(`/projects/${state.projectId}/flows`, {
      name: `${res.flow.name} 副本`,
      description: res.flow.description,
      environment_id: res.flow.environment_id,
      // 重新生成 id，避免与源计划撞号
      steps: regenIds(res.flow.steps)
    });
    await loadFlows(state.projectId);
    await openFlow(created.flow.flow_id);
    toast(`已复制为「${created.flow.name}」`);
  } catch (err) {
    toast(`复制失败：${err.message}`, true);
  }
}

async function removeFlow(flow) {
  if (!confirm(`确定删除执行计划「${flow.name}」？历史执行记录会保留。`)) return;
  try {
    await api.req('DELETE', `/projects/${state.projectId}/flows/${flow.flow_id}`);
    if (state.flow?.flow_id === flow.flow_id) {
      state.flow = null;
      state.runResult = null;
    }
    await loadFlows(state.projectId);
    renderList();
    renderDetail();
    toast(`已删除「${flow.name}」`);
  } catch (err) {
    toast(`删除失败：${err.message}`, true);
  }
}

/* ---------------- 计划详情：头部 ---------------- */

function saveFlow() {
  if (!state.flow) return Promise.resolve();
  return api
    .put(`/projects/${state.projectId}/flows/${state.flow.flow_id}`, {
      name: state.flow.name,
      description: state.flow.description,
      environment_id: state.flow.environment_id || undefined,
      steps: state.flow.steps,
      stop_on_fail: state.flow.stop_on_fail
    })
    .then(async (res) => {
      // 用服务端返回的规范化结果覆盖本地（补齐 api_snapshot、修正 step_id）
      if (res?.flow) state.flow = res.flow;
      await loadFlows(state.projectId);
      renderList();
      toast('计划已保存');
      return res;
    });
}

async function runFlowNow() {
  if (!state.flow || state.busy) return;
  state.busy = true;
  state.pane = 'report';
  renderDetail();
  try {
    // 运行前先落库，保证跑的是界面上看到的版本
    await saveFlow();
    const summary = await api.post(`/projects/${state.projectId}/flows/${state.flow.flow_id}/run`, {});
    state.runResult = summary;
    toast(summary.status === 'passed' ? `执行通过（${summary.total} 步）` : `执行失败（${summary.failed} 步失败）`, summary.status !== 'passed');
  } catch (err) {
    state.runResult = { error: err.message };
    toast(`执行失败：${err.message}`, true);
  } finally {
    state.busy = false;
    // 必须重绘：按钮文案与禁用态都依赖 busy
    renderDetail();
  }
}

function flowHeader() {
  const flow = state.flow;
  const nameInput = aEl('input', {
    type: 'text',
    class: 'flow-name-input',
    value: flow.name || '',
    oninput: (e) => {
      flow.name = e.target.value;
    }
  });

  const envSelect = aEl(
    'select',
    {
      class: 'flow-env-select',
      onchange: (e) => {
        flow.environment_id = e.target.value || undefined;
      }
    },
    aEl('option', { value: '', selected: !flow.environment_id }, '跟随当前环境'),
    ...state.envOptions.map((e) => aEl('option', { value: e.env_id, selected: String(flow.environment_id) === String(e.env_id) }, e.name))
  );

  const stopCheck = aEl('input', {
    type: 'checkbox',
    checked: Boolean(flow.stop_on_fail),
    onchange: (e) => {
      flow.stop_on_fail = e.target.checked;
    }
  });

  return aEl(
    'div',
    { class: 'flow-header' },
    aEl('div', { class: 'flow-header-row' },
      nameInput,
      envSelect,
      aEl('label', { class: 'check', title: '勾选后，任一步骤失败立即中止后续步骤' }, stopCheck, '失败即停'),
      aEl('span', { class: 'spacer-flex' }),
      aEl('button', { class: 'small', disabled: state.busy, onclick: () => saveFlow().catch((e) => toast(e.message, true)) }, '保存'),
      aEl('button', { class: 'primary small', disabled: state.busy, onclick: runFlowNow }, state.busy ? '执行中…' : '▶ 运行')
    ),
    aEl('div', { class: 'flow-header-row flow-tabs' },
      aEl('div', {
        class: `flow-tab${state.pane === 'editor' ? ' active' : ''}`,
        onclick: () => {
          state.pane = 'editor';
          renderDetail();
        }
      }, '步骤编排'),
      aEl('div', {
        class: `flow-tab${state.pane === 'report' ? ' active' : ''}`,
        onclick: () => {
          state.pane = 'report';
          renderDetail();
        }
      }, '执行报告')
    )
  );
}

/* ---------------- 步骤树编辑器 ---------------- */

/** 可插入节点的位置：整棵树的根 + 所有容器节点的 children */
function collectInsertTargets(nodes, options = []) {
  options.push({ label: '顶层', ref: nodes });
  const walk = (list, prefix) => {
    for (const node of list || []) {
      const type = nodeType(node);
      if (type === 'if') {
        if (Array.isArray(node.children)) options.push({ label: `${prefix}${nodeLabel(node, 0)} › 成立分支`, ref: node.children });
        if (Array.isArray(node.else_children)) options.push({ label: `${prefix}${nodeLabel(node, 0)} › 否则分支`, ref: node.else_children });
        walk(node.children, `${prefix}　`);
        walk(node.else_children, `${prefix}　`);
      } else if (['loop', 'while'].includes(type)) {
        if (Array.isArray(node.children)) options.push({ label: `${prefix}${nodeLabel(node, 0)} › 循环体`, ref: node.children });
        walk(node.children, `${prefix}　`);
      }
    }
  };
  walk(nodes, '');
  return options;
}

/** 「添加步骤」/「插入控制器」下拉 */
function addMenu(nodes) {
  const targets = collectInsertTargets(nodes);

  return aEl(
    'div',
    { class: 'flow-add-bar' },
    aEl('select', { class: 'flow-add-target' },
      ...targets.map((t, i) => aEl('option', { value: String(i) }, t.label))
    ),
    // 用一个 select 承载「加什么」，避免菜单被裁剪
    aEl('select', {
      class: 'flow-add-what',
      onchange: (e) => {
        const value = e.target.value;
        if (!value) return;
        e.target.value = '';
        const targetIndex = Number(document.querySelector('.flow-add-target')?.value || 0);
        const target = targets[targetIndex] || targets[0];
        addNodeTo(target.ref, value, nodes);
      }
    },
      aEl('option', { value: '' }, '+ 添加…'),
      aEl('optgroup', { label: '接口步骤' },
        ...state.apiOptions.map((item) => aEl('option', { value: `api:${item.target_id}` }, `${item.method || 'GET'} ${item.name || item.url}`))
      ),
      aEl('optgroup', { label: '控制器' },
        ...NODE_TYPES.map(([key, label]) => aEl('option', { value: `ctl:${key}` }, label))
      )
    )
  );
}

function addNodeTo(container, value, nodes) {
  if (!Array.isArray(container)) return;
  if (value.startsWith('api:')) {
    const targetId = value.slice(4);
    const option = state.apiOptions.find((i) => String(i.target_id) === targetId);
    if (!option) return;
    container.push({
      step_id: stepId(),
      type: 'step',
      target_id: targetId,
      // 快照由服务端在保存时补齐；这里先带上名称供界面展示
      api_snapshot: { name: option.name, method: option.method, url: option.url },
      input: {}
    });
  } else if (value.startsWith('ctl:')) {
    const type = value.slice(4);
    const node = newController(type);
    if (!node) return;
    container.push(node);
    state.selectedNodeId = node.step_id;
  }
  renderDetail();
}

/** 渲染节点列表（递归） */
function renderNodes(nodes, depth = 0, parentKey = '') {
  const out = [];
  (nodes || []).forEach((node, index) => {
    const type = nodeType(node);
    const selected = String(state.selectedNodeId) === String(node.step_id);
    const isContainer = ['if', 'loop', 'while'].includes(type);

    const row = aEl(
      'div',
      {
        class: `flow-node flow-node-${type}${selected ? ' active' : ''}`,
        style: `padding-left:${10 + depth * 18}px`,
        onclick: () => {
          state.selectedNodeId = node.step_id;
          renderDetail();
        }
      },
      aEl('span', { class: 'flow-node-badge' }, NODE_TYPE_LABEL[type] || type),
      aEl('span', { class: 'flow-node-name' }, nodeLabel(node, index)),
      aEl('span', { class: 'spacer-flex' }),
      aEl('button', {
        class: 'flow-node-btn',
        title: '上移',
        disabled: index === 0,
        onclick: (e) => {
          e.stopPropagation();
          [nodes[index - 1], nodes[index]] = [nodes[index], nodes[index - 1]];
          renderDetail();
        }
      }, '↑'),
      aEl('button', {
        class: 'flow-node-btn',
        title: '下移',
        disabled: index === nodes.length - 1,
        onclick: (e) => {
          e.stopPropagation();
          [nodes[index + 1], nodes[index]] = [nodes[index], nodes[index + 1]];
          renderDetail();
        }
      }, '↓'),
      aEl('button', {
        class: 'flow-node-btn danger',
        title: '删除',
        onclick: (e) => {
          e.stopPropagation();
          nodes.splice(index, 1);
          if (String(state.selectedNodeId) === String(node.step_id)) state.selectedNodeId = null;
          renderDetail();
        }
      }, '×')
    );
    out.push(row);

    // 容器：子节点缩进显示
    if (isContainer) {
      const childList = node.children || [];
      if (type === 'if') {
        out.push(aEl('div', { class: 'flow-branch-label', style: `padding-left:${24 + depth * 18}px` }, '成立时'));
        out.push(...renderNodes(childList, depth + 1, 'children'));
        out.push(aEl('div', { class: 'flow-branch-label', style: `padding-left:${24 + depth * 18}px` }, '否则'));
        out.push(...renderNodes(node.else_children || [], depth + 1, 'else_children'));
      } else {
        out.push(aEl('div', { class: 'flow-branch-label', style: `padding-left:${24 + depth * 18}px` }, '循环体'));
        out.push(...renderNodes(childList, depth + 1, 'children'));
      }
    }
  });
  return out;
}

/** 选中节点的属性面板 */
function nodeInspector() {
  const found = state.selectedNodeId ? findNode(state.flow.steps, state.selectedNodeId) : null;
  if (!found) {
    return aEl('div', { class: 'flow-inspector empty-inspector' }, '选择左侧任意节点查看/编辑属性');
  }
  const node = found.node;
  const type = nodeType(node);
  const rows = [];

  rows.push(aEl('div', { class: 'form-row' },
    aEl('label', { class: 'form-label' }, '类型'),
    aEl('div', { class: 'form-control' }, aEl('span', { class: 'tag info' }, NODE_TYPE_LABEL[type] || type))
  ));

  if (type === 'step') {
    const snap = node.api_snapshot || {};
    const apiSelect = aEl(
      'select',
      {
        onchange: (e) => {
          const targetIdValue = e.target.value;
          const option = state.apiOptions.find((i) => String(i.target_id) === targetIdValue);
          if (!option) return;
          node.target_id = targetIdValue;
          node.api_snapshot = { name: option.name, method: option.method, url: option.url };
          // 换接口后旧快照失效，清掉让服务端重新固化
          delete node.api_snapshot.request;
          renderDetail();
        }
      },
      ...state.apiOptions.map((item) =>
        aEl('option', {
          value: item.target_id,
          selected: String(node.target_id) === String(item.target_id)
        }, `${item.method || 'GET'} ${item.name || item.url}`)
      )
    );
    rows.push(aEl('div', { class: 'form-row' }, aEl('label', { class: 'form-label' }, '接口'), aEl('div', { class: 'form-control' }, apiSelect)));

    const pre = aEl('textarea', {
      class: 'mono-input',
      rows: 3,
      placeholder: '// 本步骤前置脚本',
      value: node.pre_script || '',
      oninput: (e) => {
        node.pre_script = e.target.value;
      }
    });
    rows.push(aEl('div', { class: 'form-row' }, aEl('label', { class: 'form-label' }, '前置脚本'), aEl('div', { class: 'form-control' }, pre)));

    const post = aEl('textarea', {
      class: 'mono-input',
      rows: 3,
      placeholder: '// 本步骤后置脚本，例如提取 token：\napt.environment.set("token", apt.response.json().token);',
      value: node.post_script || '',
      oninput: (e) => {
        node.post_script = e.target.value;
      }
    });
    rows.push(aEl('div', { class: 'form-row' }, aEl('label', { class: 'form-label' }, '后置脚本'), aEl('div', { class: 'form-control' }, post)));
  }

  if (type === 'if') {
    const condInput = aEl('textarea', {
      class: 'mono-input',
      rows: 2,
      placeholder: 'apt.response.json().code === 0',
      value: node.condition || '',
      oninput: (e) => {
        node.condition = e.target.value;
      }
    });
    rows.push(aEl('div', { class: 'form-row' },
      aEl('label', { class: 'form-label' }, '条件'),
      aEl('div', { class: 'form-control' },
        condInput,
        aEl('div', { class: 'form-hint' }, 'JS 表达式，可用 apt.response / apt.variables / apt.environment；结果为真走「成立时」分支')
      )
    ));
  }

  if (type === 'loop') {
    const timesInput = aEl('input', {
      type: 'number',
      min: 1,
      max: 1000,
      value: node.times ?? 3,
      oninput: (e) => {
        node.times = Math.max(1, Math.min(1000, Number(e.target.value) || 1));
      }
    });
    rows.push(aEl('div', { class: 'form-row' },
      aEl('label', { class: 'form-label' }, '次数'),
      aEl('div', { class: 'form-control' }, timesInput, aEl('div', { class: 'form-hint' }, '循环体内可用 {{$index}} 取当前轮次（从 0 开始）'))
    ));
  }

  if (type === 'while') {
    const condInput = aEl('textarea', {
      class: 'mono-input',
      rows: 2,
      placeholder: 'apt.variables.get("more") === "true"',
      value: node.condition || '',
      oninput: (e) => {
        node.condition = e.target.value;
      }
    });
    const maxInput = aEl('input', {
      type: 'number',
      min: 1,
      max: 1000,
      value: node.max_iterations ?? 100,
      oninput: (e) => {
        node.max_iterations = Math.max(1, Math.min(1000, Number(e.target.value) || 100));
      }
    });
    rows.push(aEl('div', { class: 'form-row' },
      aEl('label', { class: 'form-label' }, '条件'),
      aEl('div', { class: 'form-control' }, condInput, aEl('div', { class: 'form-hint' }, '每轮开始前判断，为真继续循环'))
    ));
    rows.push(aEl('div', { class: 'form-row' },
      aEl('label', { class: 'form-label' }, '最大次数'),
      aEl('div', { class: 'form-control' }, maxInput, aEl('div', { class: 'form-hint' }, '防死循环上限，达到后强制退出并在报告里提示'))
    ));
  }

  if (type === 'wait') {
    const msInput = aEl('input', {
      type: 'number',
      min: 0,
      max: 600000,
      value: node.ms ?? 1000,
      oninput: (e) => {
        node.ms = Math.max(0, Math.min(600000, Number(e.target.value) || 0));
      }
    });
    rows.push(aEl('div', { class: 'form-row' },
      aEl('label', { class: 'form-label' }, '等待'),
      aEl('div', { class: 'form-control' }, msInput, aEl('div', { class: 'form-hint' }, '毫秒')))
    );
  }

  if (type === 'script') {
    const scriptInput = aEl('textarea', {
      class: 'mono-input',
      rows: 8,
      placeholder: '// 只执行脚本，不发请求\napt.environment.set("k", "v");',
      value: node.script || '',
      oninput: (e) => {
        node.script = e.target.value;
      }
    });
    rows.push(aEl('div', { class: 'form-row' },
      aEl('label', { class: 'form-label' }, '脚本'),
      aEl('div', { class: 'form-control' }, scriptInput)
    ));
  }

  return aEl('div', { class: 'flow-inspector' },
    aEl('div', { class: 'flow-inspector-title' }, '节点属性'),
    ...rows
  );
}

/* ---------------- 执行报告 ---------------- */

function statusTag(status) {
  if (status === 'passed') return aEl('span', { class: 'tag ok' }, '通过');
  if (status === 'failed') return aEl('span', { class: 'tag err' }, '失败');
  if (status === 'skipped') return aEl('span', { class: 'tag warn' }, '跳过');
  return aEl('span', { class: 'tag' }, status || '-');
}

/** 递归渲染报告树 */
function renderReportNodes(nodes, depth = 0) {
  const out = [];
  (nodes || []).forEach((node) => {
    const type = node.type || 'step';
    out.push(
      aEl('div', { class: 'report-node', style: `padding-left:${10 + depth * 16}px` },
        statusTag(node.status),
        aEl('span', { class: 'report-node-type' }, NODE_TYPE_LABEL[type] || type),
        aEl('span', { class: 'report-node-name' },
          type === 'step'
            ? `${node.method || ''} ${node.name || node.url || ''}`.trim()
            : type === 'if'
              ? `条件 ${node.condition || ''} → ${node.branch === 'children' ? '成立' : node.branch === 'else_children' ? '否则' : '未求值'}`
              : type === 'loop'
                ? `循环 ${node.times} 次`
                : type === 'while'
                  ? `While 执行 ${node.iterations ?? 0} 轮`
                  : type === 'wait'
                    ? `等待 ${node.ms} ms`
                    : '脚本'
        ),
        aEl('span', { class: 'spacer-flex' }),
        node.status_code ? aEl('span', { class: 'hint' }, `${node.status_code}`) : null,
        aEl('span', { class: 'hint' }, fmtDuration(node.elapsed_ms))
      )
    );

    if (node.error) {
      out.push(aEl('div', { class: 'report-error', style: `margin-left:${26 + depth * 16}px` }, node.error));
    }
    if (Array.isArray(node.assertions) && node.assertions.length > 0) {
      out.push(
        aEl('div', { class: 'report-asserts', style: `margin-left:${26 + depth * 16}px` },
          ...node.assertions.map((a) =>
            aEl('div', { class: 'run-assert' },
              aEl('span', { class: `tag ${a.passed ? 'ok' : 'err'}` }, a.passed ? '通过' : '失败'),
              aEl('span', {}, a.name),
              a.message ? aEl('span', { class: 'hint' }, a.message) : null
            )
          )
        )
      );
    }

    // 循环轮次
    if (Array.isArray(node.iterations) && node.iterations.length > 0 && typeof node.iterations[0] === 'object') {
      node.iterations.forEach((iter) => {
        out.push(
          aEl('div', { class: 'report-iter', style: `padding-left:${26 + depth * 16}px` },
            statusTag(iter.status),
            aEl('span', { class: 'hint' }, `第 ${iter.iteration + 1} 轮`),
            aEl('span', { class: 'spacer-flex' }),
            aEl('span', { class: 'hint' }, fmtDuration(iter.elapsed_ms))
          )
        );
        out.push(...renderReportNodes(iter.children, depth + 2));
      });
    }

    if (Array.isArray(node.children) && node.children.length > 0 && !Array.isArray(node.iterations)) {
      out.push(...renderReportNodes(node.children, depth + 1));
    }
  });
  return out;
}

function reportPane() {
  if (!state.runResult) {
    return aEl('div', { class: 'empty' }, '还没有执行结果。点右上角「▶ 运行」执行这个计划。');
  }
  if (state.runResult.error) {
    return aEl('div', { class: 'debug-error' }, `执行失败：${state.runResult.error}`);
  }

  const r = state.runResult;
  return aEl(
    'div',
    { class: 'report-pane' },
    aEl('div', { class: 'report-summary' },
      statusTag(r.status),
      aEl('span', {}, `${r.total} 步`),
      aEl('span', { class: 'hint' }, `通过 ${r.passed}`),
      aEl('span', { class: 'hint' }, `失败 ${r.failed}`),
      aEl('span', { class: 'spacer-flex' }),
      aEl('span', { class: 'hint' }, fmtDuration(r.elapsed_ms))
    ),
    Array.isArray(r.failed_steps) && r.failed_steps.length > 0
      ? aEl('div', { class: 'report-failed' },
          aEl('div', { class: 'report-failed-title' }, '失败步骤'),
          ...r.failed_steps.map((s) =>
            aEl('div', { class: 'report-failed-item' },
              aEl('code', {}, `${s.method || ''} ${s.name || s.url || ''}`.trim()),
              s.status_code ? aEl('span', { class: 'tag err' }, String(s.status_code)) : null,
              aEl('span', { class: 'hint' }, s.error || '')
            )
          )
        )
      : null,
    aEl('div', { class: 'report-tree' }, ...renderReportNodes(r.tree || r.steps || []))
  );
}

/* ---------------- 渲染 ---------------- */

function renderList() {
  if (!hosts.listHost) return;
  hosts.listHost.replaceChildren(planList());
}

function renderDetail() {
  if (!hosts.detailHost) return;

  if (!state.flow) {
    hosts.detailHost.replaceChildren(
      aEl('div', { class: 'empty' },
        state.flows.length === 0
          ? '先在左侧新建一个执行计划，把多个接口串成一条业务流并按顺序/条件/循环执行。'
          : '从左侧选择一个执行计划查看与编辑'
      )
    );
    return;
  }

  const content =
    state.pane === 'report'
      ? reportPane()
      : aEl('div', { class: 'flow-editor' },
          aEl('div', { class: 'flow-tree-pane' },
            addMenu(state.flow.steps || []),
            aEl('div', { class: 'flow-tree' },
              ...(state.flow.steps?.length
                ? renderNodes(state.flow.steps)
                : [aEl('div', { class: 'empty' }, '还没有步骤，用上方「添加…」插入接口或控制器')])
            )
          ),
          nodeInspector()
        );

  hosts.detailHost.replaceChildren(flowHeader(), content);
}

function viewAutomation() {
  const consoleState = window.__consoleState;
  if (!consoleState) return aEl('div', { class: 'empty' }, '控制台状态未就绪，请刷新页面');

  if (!state.projectId) {
    state.projectId = consoleState.currentProjectId || consoleState.projects?.[0]?.project_id || null;
  }

  hosts.listHost = aEl('div', { class: 'automation-list-host' });
  hosts.detailHost = aEl('div', { class: 'automation-detail-host' });

  const container = aEl(
    'div',
    { class: 'automation-page' },
    aEl('h1', { class: 'page-title' }, '自动化测试'),
    aEl('p', { class: 'page-sub' }, '把接口串成业务流程，用条件 / 循环 / 等待 / 脚本控制器覆盖多场景，运行后看可视化报告'),
    aEl('div', { class: 'automation-layout' },
      aEl('aside', { class: 'automation-side' },
        aEl('div', { class: 'automation-side-head' },
          aEl('button', { class: 'primary small', onclick: createFlowDialog }, '+ 新建计划'),
          aEl('button', {
            class: 'small',
            disabled: !state.flow,
            title: '复制当前计划',
            onclick: () => state.flow && duplicateFlow(state.flow)
          }, '复制')
        ),
        hosts.listHost
      ),
      aEl('section', { class: 'automation-main' }, hosts.detailHost)
    )
  );

  // 首次进入时加载
  const projectChanged = state.loadedProjectId !== state.projectId;
  if (projectChanged) {
    state.loadedProjectId = state.projectId;
    state.flow = null;
    state.runResult = null;
    state.pane = 'editor';
  }

  loadFlows(state.projectId)
    .then(() => {
      renderList();
      // 首次进入且已有计划时自动打开第一个，省一次点击
      if (!state.flow && state.flows.length > 0 && projectChanged) {
        return openFlow(state.flows[0].flow_id);
      }
      renderDetail();
      return null;
    })
    .catch((err) => {
      toast(err.message, true);
    });

  return container;
}

/* ---------------- 挂载 ---------------- */

window.ApiAutomation = {
  view: viewAutomation,
  state,
  reload: async () => {
    await loadFlows(state.projectId);
    renderList();
    renderDetail();
  },
  /** 供顶栏切项目时清空状态 */
  reset: () => {
    state.flow = null;
    state.flows = [];
    state.runResult = null;
    state.projectId = null;
    state.loadedProjectId = null;
  }
};

})();
