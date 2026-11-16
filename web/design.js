/* 接口设计器：树 + 编辑器（挂在 window.ApiDesign 上，由 app.js 调用） */

/* 包进 IIFE：避免顶层函数泄漏到全局，与其它页面脚本（transfer.js 的 loadTree 等）撞名 */
(() => {
'use strict';

/* ---------------- 控制台桥接 ---------------- */
// app.js 在脚本加载阶段就已 installConsoleBridge()，这里直接取。
const toast = (message, isError) => window.__consoleToast?.(message, isError);
const api = {
  get: (p, o) => window.__consoleApi.get(p, o),
  post: (p, b, o) => window.__consoleApi.post(p, b, o),
  put: (p, b, o) => window.__consoleApi.put(p, b, o),
  req: (m, p, b, o) => window.__consoleApi.req(m, p, b, o)
};
const showModal = (...args) => window.__consoleShowModal?.(...args);
const closeModal = (...args) => window.__consoleCloseModal?.(...args);
const copyText = (...args) => window.__consoleCopy?.(...args);
const toastCopyFailed = (...args) => window.__consoleCopyFailed?.(...args);
const refreshEnvironments = (...args) => window.__consoleRefreshEnvs?.(...args);
const renderTopbarEnvs = (...args) => window.__consoleRenderTopbarEnvs?.(...args);

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const BODY_MODES = [
  ['none', '无'],
  ['json', 'JSON'],
  ['raw', 'Raw'],
  ['xml', 'XML'],
  ['html', 'HTML'],
  ['javascript', 'JavaScript'],
  ['plain', 'Text'],
  ['form-data', 'form-data'],
  ['urlencoded', 'x-www-form-urlencoded'],
  ['binary', 'Binary'],
  ['msgpack', 'MsgPack']
];
const AUTH_TYPES = [
  ['noauth', '无鉴权'],
  ['inherit', '继承项目默认'],
  ['basic', 'Basic Auth'],
  ['bearer', 'Bearer Token'],
  ['kv', 'API Key (KV)'],
  ['oauth2', 'OAuth 2.0'],
  ['digest', 'Digest Auth'],
  ['oauth1', 'OAuth 1.0'],
  ['hawk', 'Hawk'],
  ['awsv4', 'AWS Signature'],
  ['ntlm', 'NTLM (Beta)'],
  ['edgegrid', 'Akamai EdgeGrid']
];

/** 执行层（src/exec/auth.js）目前真正能用的类型，其余只占位展示 */
const AUTH_RUNTIME_SUPPORTED = new Set(['noauth', 'inherit', 'basic', 'bearer', 'kv', 'apikey', 'oauth2']);
const FIELD_TYPES = ['String', 'Integer', 'Number', 'Boolean', 'Array', 'Object', 'File'];

/* ---------------- 工具 ---------------- */

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'value') node.value = v ?? '';
    else if (k === 'checked') node.checked = Boolean(v);
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

function deepClone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function field(label, control, hint) {
  return h(
    'div',
    { class: 'form-row' },
    h('label', { class: 'form-label' }, label),
    h('div', { class: 'form-control' }, control, hint ? h('div', { class: 'form-hint' }, hint) : null)
  );
}

function select(options, value, onChange, extra = {}) {
  const node = h(
    'select',
    { ...extra, onchange: (e) => onChange(e.target.value) },
    ...options.map(([v, label]) => h('option', { value: v, ...(String(v) === String(value) ? { selected: true } : {}) }, label ?? v))
  );
  node.value = String(value ?? '');
  return node;
}

function input(value, onChange, { type = 'text', placeholder = '', readonly = false, mono = false } = {}) {
  return h('input', {
    type,
    value: value ?? '',
    placeholder,
    readonly,
    class: mono ? 'mono-input' : '',
    oninput: (e) => onChange(e.target.value)
  });
}

/**
 * 多行文本输入。
 *
 * toolbar 控制是否带「美化 / 压缩 / 格式化 XML」工具条：
 *  - 'json'：美化 + 压缩
 *  - 'xml' ：格式化 XML
 *  - 'code'：美化 + 压缩 + 格式化 XML（按内容判断可用性）
 *  - false ：纯 textarea
 *
 * 格式化只改文本、不改语义：JSON 走 parse→stringify，XML/HTML 复用 prettyMarkup。
 * 非法内容不静默处理，直接 toast 报错并保留原文。
 */
function textarea(value, onChange, { rows = 6, placeholder = '', mono = true, readonly = false, toolbar = false, label = '' } = {}) {
  const el = h('textarea', {
    rows,
    placeholder,
    class: mono ? 'mono-input' : '',
    style: `min-height:${rows * 22}px`,
    ...(readonly ? { readonly: true } : {}),
    oninput: (e) => onChange(e.target.value)
  }, value ?? '');

  if (!toolbar) return el;

  const kinds = toolbar === 'json' ? ['json'] : toolbar === 'xml' ? ['xml'] : ['json', 'xml'];
  const stat = h('span', { class: 'hint code-editor-stat' });

  const refreshStat = () => {
    const text = el.value;
    const lines = text ? text.split('\n').length : 0;
    const bytes = new TextEncoder().encode(text).length;
    stat.textContent = `${lines} 行 · ${bytes} B`;
  };

  const applyJson = (pretty) => {
    const raw = String(el.value || '').trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const next = pretty ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed);
      el.value = next;
      onChange(next);
      refreshStat();
    } catch (err) {
      toast(`JSON 格式错误，无法${pretty ? '美化' : '压缩'}：${err.message}`, true);
    }
  };

  const formatXml = () => {
    const raw = String(el.value || '').trim();
    if (!raw) return;
    const next = prettyMarkup(raw);
    el.value = next;
    onChange(next);
    refreshStat();
  };

  const buttons = [];
  if (kinds.includes('json')) {
    buttons.push(h('button', { class: 'small', title: '转成缩进多行', onclick: () => applyJson(true) }, '美化'));
    buttons.push(h('button', { class: 'small', title: '压成单行', onclick: () => applyJson(false) }, '压缩'));
  }
  if (kinds.includes('xml')) {
    buttons.push(h('button', { class: 'small', title: '按标签层级缩进', onclick: formatXml }, '格式化 XML'));
  }

  refreshStat();
  // 外部改动（例如切换接口后重绘）不需要额外同步：每次都是新建元素

  return h(
    'div',
    { class: 'code-editor' },
    h(
      'div',
      { class: 'code-editor-bar' },
      label ? h('span', { class: 'code-editor-title' }, label) : null,
      h('span', { class: 'spacer-flex' }),
      ...buttons,
      stat
    ),
    el
  );
}

function paramId() {
  return `p_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
}

function newParam(overrides = {}) {
  return {
    description: '',
    field_type: 'String',
    is_checked: 1,
    key: '',
    not_null: -1,
    param_id: paramId(),
    value: '',
    ...overrides
  };
}

/* ---------------- 参数表 ---------------- */

const CONTENT_TYPE_OPTIONS = [
  ['auto', '自动 (content-type)'],
  ['application/json', 'application/json'],
  ['text/plain', 'text/plain'],
  ['application/xml', 'application/xml'],
  ['application/octet-stream', 'application/octet-stream'],
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg']
];

/**
 * 参数表。
 *
 * withFileType 为 true 时用于 form-data：值列里内嵌类型下拉与（File 时的）文件选择，
 * 并额外给出「内容类型」列——列宽与 .param-head 保持一致，表头与数据行才能对齐。
 * 其它调用方（urlencoded / 全局参数）不传该选项，仍用原来的 6 列布局。
 */
function paramTable(list, onChange, { withFileType = false, addLabel = '添加参数' } = {}) {
  const rows = [];

  const commit = () => onChange(list.map((p) => ({ ...p })));

  const render = () => {
    rows.length = 0;

    if (withFileType) {
      rows.push(
        h(
          'div',
          { class: 'param-head' },
          h('span', {}),
          h('span', {}, '参数名'),
          h('span', {}, '参数值'),
          h('span', {}, '内容类型'),
          h('span', {}, '描述'),
          h('span', {})
        )
      );
    }

    list.forEach((p, index) => {
      const isFile = String(p.field_type || '').toLowerCase() === 'file';

      const valueCell = withFileType
        ? h(
            'div',
            { class: 'param-value-cell' },
            select(
              FIELD_TYPES.map((t) => [t, t]),
              p.field_type || 'String',
              (v) => {
                p.field_type = v;
                commit();
                render();
              },
              { class: 'param-type' }
            ),
            isFile
              ? fileValueCell(p, commit)
              : h('input', {
                  type: 'text',
                  class: 'mono-input',
                  placeholder: 'value',
                  value: p.value ?? '',
                  oninput: (e) => {
                    p.value = e.target.value;
                    commit();
                  }
                })
          )
        : h('input', {
            type: 'text',
            class: 'mono-input',
            placeholder: 'value',
            value: p.value ?? '',
            oninput: (e) => {
              p.value = e.target.value;
              commit();
            }
          });

      rows.push(
        h(
          'div',
          { class: withFileType ? 'param-row with-file' : 'param-row' },
          h('input', {
            type: 'checkbox',
            checked: Number(p.is_checked) !== 0 && Number(p.is_checked) !== -1,
            onchange: (e) => {
              p.is_checked = e.target.checked ? 1 : -1;
              commit();
            }
          }),
          h('input', {
            type: 'text',
            class: 'mono-input',
            placeholder: 'key',
            value: p.key ?? '',
            oninput: (e) => {
              p.key = e.target.value;
              commit();
            }
          }),
          valueCell,
          withFileType
            ? select(
                CONTENT_TYPE_OPTIONS,
                p.content_type || 'auto',
                (v) => {
                  p.content_type = v;
                  commit();
                },
                { class: 'param-ctype' }
              )
            : select(
                FIELD_TYPES.map((t) => [t, t]),
                p.field_type || 'String',
                (v) => {
                  p.field_type = v;
                  commit();
                  render();
                },
                { class: 'param-type' }
              ),
          h('input', {
            type: 'text',
            placeholder: '说明',
            value: p.description ?? '',
            oninput: (e) => {
              p.description = e.target.value;
              commit();
            }
          }),
          h(
            'button',
            {
              class: 'small danger',
              title: '删除',
              onclick: () => {
                list.splice(index, 1);
                commit();
                render();
              }
            },
            '×'
          )
        )
      );
    });

    if (list.length === 0) {
      rows.push(h('div', { class: 'param-empty' }, '暂无参数'));
    }

    rows.push(
      h(
        'button',
        {
          class: 'small param-add',
          onclick: () => {
            list.push(newParam({ ...(withFileType ? { content_type: 'auto' } : {}) }));
            commit();
            render();
          }
        },
        `+ ${addLabel}`
      )
    );
    container.replaceChildren(...rows);
  };

  const container = h('div', { class: 'param-table' });
  render();
  return container;
}

/** File 类型的值单元格：显示文件名，桌面端可点按钮选文件 */
function fileValueCell(p, commit) {
  const nameEl = h(
    'span',
    { class: 'param-file-name mono', title: p.value || '' },
    p.value ? String(p.value).split(/[\\/]/).pop() : '未选择文件'
  );

  const pick = window.apimcpShell?.pickFile
    ? h(
        'button',
        {
          class: 'small',
          onclick: async () => {
            try {
              const picked = await window.apimcpShell.pickFile();
              if (!picked) return;
              p.value = picked.path || '';
              nameEl.textContent = picked.name || String(picked.path || '').split(/[\\/]/).pop();
              nameEl.title = p.value;
              commit();
            } catch (err) {
              toast(err.message, true);
            }
          }
        },
        '选择文件'
      )
    : null;

  return h(
    'div',
    { class: 'param-file-cell' },
    nameEl,
    pick ||
      h('input', {
        type: 'text',
        class: 'mono-input',
        placeholder: '文件路径',
        value: p.value ?? '',
        oninput: (e) => {
          p.value = e.target.value;
          nameEl.textContent = e.target.value ? e.target.value.split(/[\\/]/).pop() : '未选择文件';
          nameEl.title = e.target.value;
          commit();
        }
      })
  );
}

/* ---------------- 编辑器状态 ---------------- */

const editor = {
  projectId: null,
  tree: [],
  selectedId: null,
  data: null,
  // 三个独立数据域各自的未保存状态，互不影响
  dirty: false, // design 域（基础/参数/Body/鉴权/脚本/响应）
  caseDirty: false, // case 域（data.cases）
  mockDirty: false, // mock 域（data.mock）
  activeTab: 'basic',
  /** 请求构建区当前页签（header/query/path/body/auth/cookie/pre/post） */
  wsTab: 'header',
  /** 响应区当前页签（body/headers/cookies/example/request/console） */
  debugTab: 'body',
  activeMode: 'design',
  /** 目录编辑器的子页签（目录设置 / 目录参数 / 接口列表） */
  folderTab: 'basic',
  /** 响应示例页签的当前示例下标与编辑态 */
  exampleIndex: 0,
  exampleEditing: false,
  /**
   * 顶部多标签页。每一项是「打开着的接口」的快照，
   * 当前编辑中的那一个在 editor 顶层字段里（data / dirty / activeMode ...）。
   * 仅内存保存：刷新页面后清空，避免保留已删除对象的 id。
   */
  tabs: [],
  activeTabId: null,
  // 响应体查看状态
  debugView: 'pretty',
  debugFormat: 'auto',
  debugEncoding: 'utf-8',
  // 调试面板「隐藏敏感值」开关，默认关闭（本地调试优先看全）
  debugMask: false,
  /** 左树关键词过滤（空串表示不过滤） */
  treeKeyword: '',
  /** 左树里被折叠起来的目录 target_id 集合 */
  collapsed: new Set(),
  apiIndex: []
};

const DIRTY_LABELS = { design: '未保存', case: '用例未保存', mock: 'Mock 未保存' };

function resetDirty(scope = 'design') {
  markClean(scope);
}

function markDirty(scope = 'design') {
  const key = scope === 'case' ? 'caseDirty' : scope === 'mock' ? 'mockDirty' : 'dirty';
  if (editor[key]) return;
  editor[key] = true;
  syncDirtyBadge();
}

function markClean(scope = 'design') {
  const key = scope === 'case' ? 'caseDirty' : scope === 'mock' ? 'mockDirty' : 'dirty';
  if (!editor[key]) return;
  editor[key] = false;
  syncDirtyBadge();
}

/** 丢弃所有未保存改动（切换接口 / 离开页面时用） */
function discardUnsaved() {
  editor.dirty = false;
  editor.caseDirty = false;
  editor.mockDirty = false;
  syncDirtyBadge();
}

/** 汇总所有标签页的未保存改动：离开页面 / 切换项目的守卫靠它 */
function hasUnsaved() {
  if (editor.dirty || editor.caseDirty || editor.mockDirty) return true;
  return anyTabDirty();
}

function isDirty(scope = 'design') {
  if (scope === 'case') return Boolean(editor.caseDirty);
  if (scope === 'mock') return Boolean(editor.mockDirty);
  return Boolean(editor.dirty);
}

/** 只更新工具条上的「未保存」徽标，避免整树重绘导致输入框失焦 */
function syncDirtyBadge() {
  const badge = document.getElementById('dirty-badge');
  if (!badge) return;
  const parts = [];
  if (editor.dirty) parts.push(DIRTY_LABELS.design);
  if (editor.caseDirty) parts.push(DIRTY_LABELS.case);
  if (editor.mockDirty) parts.push(DIRTY_LABELS.mock);
  if (parts.length > 0) {
    badge.className = 'tag warn';
    badge.textContent = parts.join(' · ');
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

/* ---------------- 多标签页 ---------------- */

const MAX_TABS = 12;

/** 把当前编辑状态回写进它对应的 tab 快照 */
function snapshotActiveTab() {
  if (!editor.activeTabId) return;
  const tab = editor.tabs.find((t) => String(t.targetId) === String(editor.activeTabId));
  if (!tab) return;
  tab.data = editor.data;
  tab.name = editor.data?.name || tab.name;
  tab.method = editor.data?.method || tab.method;
  tab.targetType = editor.targetType;
  tab.indexMeta = editor.indexMeta;
  tab.mode = editor.activeMode;
  tab.dirty = editor.dirty;
  tab.caseDirty = editor.caseDirty;
  tab.mockDirty = editor.mockDirty;
}

/** 把 tab 快照装回当前编辑状态 */
function restoreTab(tab) {
  editor.selectedId = tab.targetId;
  editor.data = tab.data;
  editor.targetType = tab.targetType;
  editor.indexMeta = tab.indexMeta;
  editor.activeMode = tab.mode || 'design';
  editor.dirty = Boolean(tab.dirty);
  editor.caseDirty = Boolean(tab.caseDirty);
  editor.mockDirty = Boolean(tab.mockDirty);
  editor.activeTabId = tab.targetId;
}

/** 汇总所有 tab 的脏标记：beforeunload 与外部跳转守卫靠它 */
function anyTabDirty() {
  if (editor.dirty || editor.caseDirty || editor.mockDirty) return true;
  return editor.tabs.some((t) => t.dirty || t.caseDirty || t.mockDirty);
}

/** 打开（或激活）一个接口 tab */
async function openTab(projectId, targetId, { activate = true } = {}) {
  const key = String(targetId);

  const existing = editor.tabs.find((t) => String(t.targetId) === key);
  if (existing) {
    if (activate) {
      snapshotActiveTab();
      restoreTab(existing);
      rerenderTree();
      rerenderPane();
      renderTabBar();
    }
    return existing;
  }

  if (editor.tabs.length >= MAX_TABS) {
    toast(`最多同时打开 ${MAX_TABS} 个标签页，请先关闭一些`, true);
    return null;
  }

  // 先按原来的单文档方式加载，再把结果封成新 tab
  snapshotActiveTab();
  await loadApi(projectId, targetId);

  const tab = {
    targetId,
    name: editor.data?.name || targetId,
    method: editor.data?.method || '',
    targetType: editor.targetType,
    data: editor.data,
    indexMeta: editor.indexMeta,
    mode: editor.activeMode,
    dirty: false,
    caseDirty: false,
    mockDirty: false
  };
  editor.tabs.push(tab);
  if (activate) editor.activeTabId = key;
  renderTabBar();
  return tab;
}

/**
 * 批量关闭标签页。
 *
 * 先 snapshotActiveTab() 把当前编辑状态落进快照，脏标记才不会看漏；
 * 普通关闭对所有有未保存改动的目标只弹一次 confirm，force 则完全跳过确认
 * （用于「强制关闭」系列菜单项）。
 */
function closeTabsByIds(ids, { force = false } = {}) {
  snapshotActiveTab();
  const keys = new Set(ids.map((id) => String(id)));
  const targets = editor.tabs.filter((t) => keys.has(String(t.targetId)));
  if (targets.length === 0) return;

  if (!force) {
    const dirtyTabs = targets.filter((t) => t.dirty || t.caseDirty || t.mockDirty);
    if (dirtyTabs.length > 0) {
      const message =
        dirtyTabs.length === 1
          ? `「${dirtyTabs[0].name}」有未保存的修改，确定关闭？`
          : `${dirtyTabs.length} 个标签页有未保存的修改（${dirtyTabs.map((t) => t.name).join('、')}），确定关闭？`;
      if (!confirm(message)) return;
    }
  }

  // 记住活动 tab 在剩余列表里的落点，关完激活相邻的那个
  const activeKey = String(editor.activeTabId || '');
  const activeIndex = editor.tabs.findIndex((t) => String(t.targetId) === activeKey);
  const closingActive = keys.has(activeKey);

  editor.tabs = editor.tabs.filter((t) => !keys.has(String(t.targetId)));

  if (!closingActive) {
    renderTabBar();
    return;
  }

  const next = editor.tabs[Math.min(activeIndex, editor.tabs.length - 1)] || null;
  if (next) {
    restoreTab(next);
    rerenderTree();
    rerenderPane();
  } else {
    editor.activeTabId = null;
    editor.selectedId = null;
    editor.data = null;
    editor.activeMode = 'design';
    rerenderTree();
    rerenderPane();
  }
  renderTabBar();
}

/** 关闭单个 tab；当前 tab 关闭后激活相邻的一个 */
function closeTab(targetId) {
  closeTabsByIds([targetId]);
}

function renderTabBar() {
  const host = document.getElementById('editor-tabs');
  if (!host) return;

  if (editor.tabs.length === 0) {
    host.replaceChildren();
    host.style.display = 'none';
    return;
  }
  host.style.display = '';

  const tabsNode = h(
    'div',
    { class: 'editor-tabs-list' },
    ...editor.tabs.map((tab) => {
      const isActive = String(tab.targetId) === String(editor.activeTabId);
      const dirty = isActive
        ? editor.dirty || editor.caseDirty || editor.mockDirty
        : tab.dirty || tab.caseDirty || tab.mockDirty;
      return h(
        'div',
        {
          class: `editor-tab${isActive ? ' active' : ''}`,
          title: tab.name,
          onclick: () => {
            if (isActive) return;
            snapshotActiveTab();
            const target = editor.tabs.find((t) => String(t.targetId) === String(tab.targetId));
            if (!target) return;
            restoreTab(target);
            rerenderTree();
            rerenderPane();
            renderTabBar();
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            e.stopPropagation();
            openTabContextMenu(e, tab);
          }
        },
        tab.method ? h('span', { class: `method ${String(tab.method).toUpperCase()}` }, tab.method) : null,
        h('span', { class: 'editor-tab-name' }, tab.name),
        dirty ? h('span', { class: 'editor-tab-dot', title: '未保存' }) : null,
        h(
          'span',
          {
            class: 'editor-tab-close',
            title: '关闭',
            onclick: (e) => {
              e.stopPropagation();
              closeTab(tab.targetId);
            }
          },
          '×'
        )
      );
    })
  );

  // 右端「...」：批量关闭 / 保存，标签很多时不用一个个点
  const moreBtn = h(
    'button',
    {
      class: 'editor-tabs-more',
      title: '标签页操作',
      onclick: (e) => {
        e.stopPropagation();
        openTabBulkMenu(moreBtn);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTabBulkMenu(moreBtn);
      }
    },
    '⋯'
  );

  host.replaceChildren(tabsNode, moreBtn);
}

/* ---------------- 标签页右键菜单 ---------------- */

/** 单个标签页的右键菜单 */
function openTabContextMenu(e, tab) {
  const key = String(tab.targetId);
  const index = editor.tabs.findIndex((t) => String(t.targetId) === key);
  const isApi = tab.targetType === 'api';
  const items = [];

  items.push(ctxMenuItem('关闭', () => closeTabsByIds([key], { force: true }), { icon: 'close' }));

  const others = editor.tabs.filter((t) => String(t.targetId) !== key).map((t) => String(t.targetId));
  items.push(
    ctxMenuItem('关闭其他', () => closeTabsByIds(others), {
      icon: 'close',
      disabled: others.length === 0,
      hint: '当前只有一个标签页'
    })
  );

  const right = editor.tabs.slice(index + 1).map((t) => String(t.targetId));
  items.push(
    ctxMenuItem('关闭右侧', () => closeTabsByIds(right), {
      icon: 'right',
      disabled: right.length === 0,
      hint: '当前标签页已在最右'
    })
  );

  items.push(h('div', { class: 'ctx-menu-sep' }));
  items.push(ctxMenuItem('复制名称', () => copyTabName(tab), { icon: 'copy' }));
  items.push(
    ctxMenuItem('复制接口 URL', () => copyTabUrl(tab), {
      icon: 'copy',
      disabled: !tab.indexMeta?.url,
      hint: '目录与文档没有接口 URL'
    })
  );

  items.push(
    ctxSubMenu(
      '复制为 cURL',
      () => [
        ctxMenuItem('Bash', () => copyTabAsCurl(tab, 'bash'), { icon: 'curl' }),
        ctxMenuItem('CMD', () => copyTabAsCurl(tab, 'cmd'), { icon: 'curl' })
      ],
      { icon: 'curl', disabled: !isApi }
    )
  );

  openContextMenu(e.clientX, e.clientY, items);
}

/** 标签栏右端「...」的批量菜单 */
function openTabBulkMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  const allIds = editor.tabs.map((t) => String(t.targetId));
  const activeKey = String(editor.activeTabId || '');
  const others = allIds.filter((id) => id !== activeKey);
  const items = [];

  items.push(ctxMenuItem('关闭所有标签', () => closeTabsByIds(allIds), { icon: 'close', disabled: allIds.length === 0 }));
  items.push(
    ctxMenuItem('强制关闭所有标签', () => closeTabsByIds(allIds, { force: true }), {
      icon: 'close',
      disabled: allIds.length === 0,
      hint: '跳过未保存确认'
    })
  );
  items.push(ctxMenuItem('关闭其他标签', () => closeTabsByIds(others), { icon: 'close', disabled: others.length === 0 }));
  items.push(
    ctxMenuItem('强制关闭其他所有标签', () => closeTabsByIds(others, { force: true }), {
      icon: 'close',
      disabled: others.length === 0,
      hint: '跳过未保存确认'
    })
  );

  items.push(h('div', { class: 'ctx-menu-sep' }));
  items.push(ctxMenuItem('保存所有标签', () => saveAllTabs(), { icon: 'save' }));

  // 从按钮下方弹出；用 openContextMenu 保证收边与关闭逻辑一致
  openContextMenu(rect.left, rect.bottom + 4, items);
}

async function copyTabName(tab) {
  const res = await copyText(tab.name || '');
  if (!res.ok) {
    toastCopyFailed(res.error);
    return;
  }
  toast('已复制标签名称');
}

async function copyTabUrl(tab) {
  const url = tab.indexMeta?.url || '';
  if (!url) {
    toast('该标签没有接口 URL', true);
    return;
  }
  const res = await copyText(url);
  if (!res.ok) {
    toastCopyFailed(res.error);
    return;
  }
  toast('已复制接口 URL');
}

/** 非活动标签也能生成 cURL：直接用它自己的快照，不依赖编辑器当前内容 */
async function copyTabAsCurl(tab, dialect) {
  const isActive = String(tab.targetId) === String(editor.activeTabId);
  if (isActive) snapshotActiveTab();
  const node = {
    target_id: tab.targetId,
    target_type: tab.targetType,
    method: tab.method,
    url: tab.indexMeta?.url || tab.data?.url || '',
    name: tab.name
  };
  await copyDefinitionAsCurl(node, dialect, tab.data);
}

/**
 * 保存所有标签的设计域。
 *
 * 活动 tab 走 saveActiveMode（会连带保存用例 / Mock 草稿），
 * 其余 tab 直接用自己的 data 快照 PUT 落库——它们没有内存中的用例/Mock 草稿。
 */
async function saveAllTabs() {
  snapshotActiveTab();
  const activeKey = String(editor.activeTabId || '');
  // 目录也有设计域（名称 / 描述 / 目录参数），一并保存
  const targets = editor.tabs.filter(
    (t) => t.targetType === 'api' || t.targetType === 'doc' || t.targetType === 'folder'
  );
  let ok = 0;
  const failed = [];
  let pendingAux = 0;

  for (const tab of targets) {
    if (String(tab.targetId) === activeKey) continue;
    if (tab.caseDirty || tab.mockDirty) pendingAux += 1;
    try {
      await api.put(`/projects/${editor.projectId}/apis/${tab.targetId}`, {
        data: tab.data,
        preserve_aux: true
      });
      tab.dirty = false;
      ok += 1;
    } catch (err) {
      failed.push(`${tab.name}：${err.message}`);
    }
  }

  // 活动 tab 交给现有链路，保留它对用例 / Mock 的保存能力。
  // 压测页签没有可保存内容（saveActiveMode 只弹提示），跳过以免白弹一次 toast。
  if (editor.activeTabId && (editor.activeMode || 'design') !== 'stress') {
    try {
      await saveActiveMode(window.__designRefresh);
      ok += 1;
    } catch (err) {
      failed.push(`${editor.data?.name || editor.activeTabId}：${err.message}`);
    }
  }

  renderTabBar();
  if (failed.length > 0) {
    toast(`保存完成 ${ok} 个，失败 ${failed.length} 个（${failed[0]}）`, true);
    return;
  }
  toast(pendingAux > 0 ? `已保存 ${ok} 个标签；${pendingAux} 个标签的用例/Mock 草稿需切换过去单独保存` : `已保存 ${ok} 个标签`);
}

/* ---------------- 数据加载 ---------------- */

async function loadTree(projectId) {
  const res = await api.get(`/projects/${projectId}/tree`);
  editor.tree = res.tree || [];
  const flat = await api.get(`/projects/${projectId}/apis`);
  editor.apiIndex = flat.items || [];
  return res;
}

async function loadApi(projectId, targetId, { keepAux = false } = {}) {
  const res = await api.get(`/projects/${projectId}/apis/${targetId}`);
  editor.data = deepClone(res.data);
  editor.selectedId = targetId;
  editor.targetType = res.target_type;
  editor.indexMeta = res.index;
  editor.folderTab = 'basic';
  // 状态定义按项目缓存，切换项目时重取
  if (!marksCache || marksCache.projectId !== projectId) {
    await loadMarks(projectId);
  }
  // 目录页签需要服务列表（用于选择前置 URL）
  if (res.target_type === 'folder') {
    await loadFolderServers();
  }
  // 切换接口时重置面板缓存；同接口重载（保存后刷新）保留附属域的草稿与脏标记
  if (!keepAux) {
    window.ApiExtra?.resetCases?.();
    window.ApiExtra?.resetMock?.();
    window.ApiExtra?.resetStress?.();
    editor.caseDirty = false;
    editor.mockDirty = false;
  }
  resetDirty('design');
  syncDirtyBadge();
  return res;
}

function defaultRequest() {
  return {
    auth: { type: 'inherit' },
    body: { binary: null, mode: 'none', parameter: [], raw: '', raw_parameter: [], raw_schema: { type: 'object' } },
    cookie: { parameter: [] },
    header: { parameter: [] },
    post_tasks: [],
    pre_tasks: [],
    query: { parameter: [], query_add_equal: 1 },
    restful: { parameter: [] }
  };
}

function ensureShape(data) {
  if (!data) return data;
  data.request = data.request || defaultRequest();
  data.request.auth = data.request.auth || { type: 'inherit' };
  data.request.body = data.request.body || defaultRequest().body;
  for (const key of ['query', 'header', 'cookie', 'restful']) {
    if (!data.request[key]) data.request[key] = { parameter: [] };
    if (!Array.isArray(data.request[key].parameter)) data.request[key].parameter = [];
  }
  data.request.pre_tasks = Array.isArray(data.request.pre_tasks) ? data.request.pre_tasks : [];
  data.request.post_tasks = Array.isArray(data.request.post_tasks) ? data.request.post_tasks : [];
  data.response = data.response || { example: [], is_check_result: 1 };
  data.response.example = Array.isArray(data.response.example) ? data.response.example : [];
  return data;
}

function scriptSource(tasks) {
  return (tasks || [])
    .filter((t) => t && t.type === 'customScript' && Number(t.enabled) > 0)
    .map((t) => t.data)
    .filter(Boolean)
    .join('\n\n');
}

function setScriptSource(tasks, source) {
  const others = (tasks || []).filter((t) => !(t && t.type === 'customScript'));
  const text = String(source || '').trim();
  if (!text) return others;
  return [
    ...others,
    { name: '', type: 'customScript', data: text, enabled: 1, id: `script_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }
  ];
}

/* ---------------- 页签：基础 ---------------- */

/** 接口状态（marks）缓存 */
let marksCache = null;

async function loadMarks(projectId) {
  if (marksCache && marksCache.projectId === projectId) return marksCache.marks;
  try {
    const res = await api.get(`/projects/${projectId}/marks`);
    marksCache = { projectId, marks: res.marks || [] };
  } catch {
    marksCache = { projectId, marks: [] };
  }
  return marksCache.marks;
}

/** 接口状态下拉（彩色圆点 + 状态管理入口） */
function statusSelector() {
  const d = editor.data;
  const marks = marksCache?.marks || [];
  const current = marks.find((m) => String(m.mark_id) === String(d.mark_id)) || marks[0] || null;

  const dot = current ? h('span', { class: 'status-dot', style: `background:${current.color}` }) : null;
  const label = current ? current.name : '未设置';

  const trigger = h(
    'div',
    {
      class: 'status-trigger',
      onclick: (e) => {
        e.stopPropagation();
        toggleMenu();
      }
    },
    dot,
    h('span', { class: 'status-name' }, label),
    h('span', { class: 'status-caret' }, '▾')
  );

  let menu = null;

  const closeMenu = () => {
    if (menu) {
      menu.remove();
      menu = null;
      document.removeEventListener('click', closeMenu, true);
    }
  };

  const toggleMenu = () => {
    if (menu) {
      closeMenu();
      return;
    }
    const items = marks.map((m) =>
      h(
        'div',
        {
          class: `status-item${String(m.mark_id) === String(d.mark_id) ? ' active' : ''}`,
          onclick: () => {
            d.mark_id = String(m.mark_id);
            markDirty();
            closeMenu();
            rerenderPane();
          }
        },
        h('span', { class: 'status-dot', style: `background:${m.color}` }),
        h('span', {}, m.name)
      )
    );

    items.push(h('div', { class: 'status-sep' }));
    items.push(
      h(
        'div',
        {
          class: 'status-item status-manage',
          onclick: () => {
            closeMenu();
            openMarksManager();
          }
        },
        h('span', { class: 'status-dot', style: 'background:var(--font-light)' }),
        h('span', {}, '接口状态管理')
      )
    );

    menu = h('div', { class: 'status-menu' }, ...items);
    trigger.append(menu);
    document.addEventListener('click', closeMenu, true);
  };

  return h('div', { class: 'status-selector' }, trigger);
}

/** 状态管理弹窗：增删改 marks */
function openMarksManager() {
  const showModal = window.__consoleShowModal;
  const closeModal = window.__consoleCloseModal;
  if (!showModal) return;

  let marks = deepClone(marksCache?.marks || []);

  const listHost = h('div', { class: 'marks-list' });

  const renderList = () => {
    const nodes = [];
    marks.forEach((m, index) => {
      nodes.push(
        h(
          'div',
          { class: 'marks-row' },
          h('input', {
            type: 'color',
            value: m.color || '#2857FF',
            class: 'marks-color',
            oninput: (e) => {
              marks[index].color = e.target.value;
            }
          }),
          h('input', {
            type: 'text',
            value: m.name || '',
            placeholder: '状态名称',
            oninput: (e) => {
              marks[index].name = e.target.value;
            }
          }),
          h(
            'button',
            {
              class: 'small danger',
              disabled: marks.length <= 1,
              onclick: () => {
                marks.splice(index, 1);
                renderList();
              }
            },
            '删除'
          )
        )
      );
    });
    if (marks.length === 0) nodes.push(h('div', { class: 'empty' }, '暂无状态'));
    listHost.replaceChildren(...nodes);
  };
  renderList();

  const body = h(
    'div',
    {},
    h('div', { class: 'hint', style: 'margin-bottom:10px' }, '状态会显示在接口名左侧的彩色圆点上，用于标记接口进度。'),
    listHost,
    h(
      'button',
      {
        class: 'small mt12',
        onclick: () => {
          marks.push({
            mark_id: `${Date.now()}`,
            name: '新状态',
            color: '#2857FF',
            is_default_mark: -1,
            is_sys_default: -1
          });
          renderList();
        }
      },
      '+ 添加状态'
    )
  );

  showModal('接口状态管理', body, [
    h('button', { onclick: closeModal }, '取消'),
    h(
      'button',
      {
        class: 'primary',
        onclick: async () => {
          try {
            const res = await api.put(`/projects/${editor.projectId}/marks`, { marks });
            marksCache = { projectId: editor.projectId, marks: res.marks || [] };
            closeModal();
            rerenderPane();
            toast('状态已保存');
          } catch (err) {
            toast(err.message, true);
          }
        }
      },
      '保存'
    )
  ]);
}

/** 标签编辑（chip 输入） */
function tagsEditor() {
  const d = editor.data;
  if (!Array.isArray(d.tags)) d.tags = [];

  const host = h('div', { class: 'tag-editor' });

  const collectAllTags = () => {
    const set = new Set();
    for (const item of editor.apiIndex) {
      for (const t of item.tags || []) set.add(t);
    }
    return [...set];
  };

  const render = () => {
    const nodes = d.tags.map((tag, index) =>
      h(
        'span',
        { class: 'tag-chip' },
        tag,
        h(
          'span',
          {
            class: 'tag-chip-x',
            onclick: () => {
              d.tags.splice(index, 1);
              markDirty();
              render();
            }
          },
          '×'
        )
      )
    );

    const inputEl = h('input', {
      type: 'text',
      class: 'tag-input',
      placeholder: '输入后回车添加',
      list: 'known-tags',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const value = e.target.value.trim();
          if (!value) return;
          if (!d.tags.includes(value)) d.tags.push(value);
          e.target.value = '';
          markDirty();
          render();
        } else if (e.key === 'Backspace' && !e.target.value && d.tags.length > 0) {
          d.tags.pop();
          markDirty();
          render();
        }
      }
    });

    const datalist = h(
      'datalist',
      { id: 'known-tags' },
      ...collectAllTags().map((t) => h('option', { value: t }))
    );

    host.replaceChildren(...nodes, inputEl, datalist);
  };
  render();
  return host;
}

/** 详细说明（折叠） */
function descriptionField() {
  const d = editor.data;
  let expanded = Boolean(String(d.description || '').trim());

  const host = h('div', { class: 'desc-field' });

  const render = () => {
    if (!expanded) {
      host.replaceChildren(
        h(
          'div',
          {
            class: 'desc-add',
            onclick: () => {
              expanded = true;
              render();
            }
          },
          '+ 添加详细说明'
        )
      );
      return;
    }
    host.replaceChildren(
      textarea(
        d.description || '',
        (v) => {
          d.description = v;
          markDirty();
        },
        { rows: 4, mono: false, placeholder: '接口用途、注意事项、调用约定等' }
      )
    );
  };
  render();
  return host;
}

/** 元信息栏：状态 / 目录 / 标签 / 详细说明 */
function metaBar() {
  const d = editor.data;
  if (editor.targetType !== 'api') return null;

  const folderOptions = [['0', '根目录']];
  const folders = folderOptionsWithDepth();
  for (const f of folders) {
    folderOptions.push([f.id, `${'　'.repeat(f.depth)}${f.name}`]);
  }

  return h(
    'div',
    { class: 'meta-bar' },
    h(
      'div',
      { class: 'meta-row' },
      // 接口名称放在最前面：对齐 Apipost，顶部一眼能看到当前在编辑哪个接口
      h('label', { class: 'meta-label' }, '接口名称'),
      h(
        'div',
        { class: 'meta-value meta-name' },
        input(
          d.name || '',
          (v) => {
            d.name = v;
            markDirty();
            // 侧栏标题实时跟随（只改文本，不重绘树，避免输入框失焦）
            if (editor.selectedId) syncTreeName(editor.selectedId, v || '未命名');
          },
          { placeholder: '接口名称' }
        )
      ),
      h('label', { class: 'meta-label' }, '状态'),
      h('div', { class: 'meta-value' }, statusSelector()),
      h('label', { class: 'meta-label' }, '目录'),
      h(
        'div',
        { class: 'meta-value meta-folder' },
        select(folderOptions, String(d.parent_id || '0'), (v) => {
          d.parent_id = v;
          markDirty();
        })
      ),
      h('label', { class: 'meta-label' }, '标签'),
      h('div', { class: 'meta-value meta-tags' }, tagsEditor())
    ),
    h(
      'div',
      { class: 'meta-row meta-row-desc' },
      h('label', { class: 'meta-label' }, '详细说明'),
      h('div', { class: 'meta-value' }, descriptionField())
    )
  );
}

/* ---------------- 页签：参数 ---------------- */

function paramSection(title, holder, key, onChange = markDirty) {
  if (!holder) return null;
  if (!Array.isArray(holder.parameter)) holder.parameter = [];
  return h(
    'div',
    { class: 'param-section' },
    h(
      'div',
      { class: 'param-section-title' },
      title,
      h('span', { class: 'tab-badge' }, holder.parameter.length),
      h(
        'button',
        {
          class: 'small param-bulk-btn',
          title: '按文本批量导入参数',
          onclick: () => openBulkEdit(holder.parameter, onChange, title)
        },
        '批量编辑'
      )
    ),
    paramTable(holder.parameter, (next) => {
      holder.parameter = next;
      onChange();
    })
  );
}

/**
 * 参数页签：接口编辑器与全局参数/目录参数共用。
 * @param {object} request 目标 request 配置
 * @param {function} onChange 变更回调
 * @param {{sections?: string[]}} opts 只显示指定小节
 */
function tabParams(request = editor.data.request, onChange = markDirty, opts = {}) {
  const req = request;
  const sections = opts.sections || ['query', 'restful', 'header'];
  const parts = [];
  if (sections.includes('query')) parts.push(paramSection('Query 参数', req.query, 'query', onChange));
  if (sections.includes('restful')) parts.push(paramSection('Path 参数', req.restful, 'restful', onChange));
  if (sections.includes('header')) parts.push(paramSection('Header 参数', req.header, 'header', onChange));
  // Cookie 不再单独建表：历史数据仅提示 + 引导迁移到 Header
  parts.push(cookieNotice(req.cookie, onChange));
  parts.push(
    h('div', { class: 'param-sections-hint hint' }, '参数值支持 {{变量名}}；Cookie 请写成 Header：Key = Cookie，Value = a=1; b=2')
  );
  return h('div', { class: 'param-sections' }, ...parts.filter(Boolean));
}

/**
 * Cookie 历史数据提示：Cookie 参数表已从界面移除，旧数据仍在发送时拼进 Cookie 头。
 * 提供「复制为 Cookie 头」与「清空」，不自动改动用户数据。
 * @param {object} holder cookie 配置对象 { parameter: [] }
 * @param {function} onChange 变更回调
 */
function cookieNotice(holder, onChange = markDirty) {
  if (!holder || !Array.isArray(holder.parameter) || holder.parameter.length === 0) return null;

  const items = holder.parameter.filter((p) => p && p.key);
  if (items.length === 0) return null;

  const toCookieString = () => items.map((p) => `${p.key}=${p.value ?? ''}`).join('; ');

  const notice = h(
    'div',
    { class: 'cookie-notice' },
    h(
      'div',
      { class: 'cookie-notice-head' },
      h('span', { class: 'tag warn' }, 'Cookie 参数已移除'),
      h('span', { class: 'hint' }, `以下 ${items.length} 条历史 Cookie 参数不在界面展示，发送时仍会合并进 Cookie 请求头`)
    ),
    h(
      'div',
      { class: 'cookie-notice-list' },
      ...items.map((p) => h('div', { class: 'cookie-notice-item' }, h('code', {}, p.key), h('span', { class: 'mono' }, p.value ?? '')))
    ),
    h(
      'div',
      { class: 'btn-row' },
      h(
        'button',
        {
          class: 'small',
          onclick: async () => {
            const res = await copyText(toCookieString());
            if (res.ok) toast('已复制 Cookie 值，粘贴到 Header 的 Cookie 里');
            else toastCopyFailed(res.error);
          }
        },
        '复制为 Cookie 头'
      ),
      h(
        'button',
        {
          class: 'small danger',
          onclick: () => {
            if (!confirm(`确定清空这 ${items.length} 条历史 Cookie 参数？清空后需自行在 Header 中维护。`)) return;
            holder.parameter = [];
            onChange();
            // 清空后立即移除提示块：调用方的 onChange 只标脏，不一定重绘
            notice.remove();
            toast('历史 Cookie 参数已清空');
          }
        },
        '清空历史 Cookie 参数'
      )
    )
  );

  return notice;
}

/* ---------------- 页签：Body ---------------- */

/**
 * Body 页签：接口编辑器 / 全局参数 / 目录参数共用。
 * @param {object} body Body 配置对象（会被原地修改）
 * @param {function} onChange 变更回调
 * @param {{allowedModes?: string[][]}} opts 限定可选模式（全局/目录参数只允许 none / form-data / urlencoded）
 */
function tabBody(body = editor.data.request.body, onChange = markDirty, opts = {}) {
  const modes = opts.allowedModes || BODY_MODES;
  const mode = String(body.mode || 'none');
  const isRaw = ['json', 'raw', 'xml', 'html', 'javascript', 'plain'].includes(mode);
  const isForm = ['form-data', 'urlencoded'].includes(mode);

  let jsonHint = null;
  if (mode === 'json' && String(body.raw || '').trim()) {
    try {
      JSON.parse(body.raw);
      jsonHint = h('div', { class: 'form-hint ok' }, 'JSON 格式正确');
    } catch (err) {
      jsonHint = h('div', { class: 'form-hint err' }, `JSON 语法错误：${err.message}`);
    }
  }

  return h(
    'div',
    { class: 'form-grid' },
    field(
      'Body 类型',
      select(modes, mode, (v) => {
        body.mode = v;
        if (['form-data', 'urlencoded'].includes(v) && !Array.isArray(body.parameter)) body.parameter = [];
        onChange();
        if (opts.rerender !== false) rerenderPane();
        opts.onModeChange?.();
      })
    ),
    isRaw
      ? h(
          'div',
          { class: 'form-row full' },
          h('label', { class: 'form-label' }, '请求体'),
          h(
            'div',
            { class: 'form-control' },
            textarea(
              body.raw || '',
              (v) => {
                body.raw = v;
                onChange();
                if (mode === 'json') updateJsonHint(v);
              },
              {
                rows: 14,
                placeholder: mode === 'json' ? '{\n  "key": "value"\n}' : '',
                // JSON 给美化/压缩，XML/HTML 给标签缩进，其余纯文本不给工具条
                toolbar: mode === 'json' ? 'json' : mode === 'xml' || mode === 'html' ? 'xml' : false
              }
            ),
            h('div', { id: 'json-hint' }, jsonHint)
          )
        )
      : null,
    isForm
      ? h(
          'div',
          { class: 'form-row full' },
          h('label', { class: 'form-label' }, mode === 'form-data' ? 'Form 字段' : 'URL Encoded 字段'),
          h(
            'div',
            { class: 'form-control' },
            paramTable(
              Array.isArray(body.parameter) ? body.parameter : [],
              (next) => {
                body.parameter = next;
                onChange();
              },
              { withFileType: true }
            )
          )
        )
      : null,
    mode === 'none'
      ? h('div', { class: 'form-row full' }, h('div', { class: 'form-hint' }, '该接口不发送请求体'))
      : null,
    mode === 'binary' ? binaryBodyEditor(body) : null
  );
}

/** binary Body：文件路径 / 类型 / 文件名；桌面端可直接选文件 */
function binaryBodyEditor(body) {
  if (!body.binary || typeof body.binary !== 'object') body.binary = { file_path: '', file_type: '', file_name: '' };
  const bin = body.binary;

  const setField = (key, value) => {
    bin[key] = value;
    markDirty();
  };

  const pickBtn = window.apimcpShell?.pickFile
    ? h(
        'button',
        {
          class: 'small',
          onclick: async () => {
            try {
              const picked = await window.apimcpShell.pickFile();
              if (!picked) return;
              bin.file_path = picked.path || '';
              if (!bin.file_name) bin.file_name = picked.name || '';
              markDirty();
              rerenderPane();
            } catch (err) {
              toast(err.message, true);
            }
          }
        },
        '选择文件'
      )
    : null;

  return h(
    'div',
    { class: 'form-row full' },
    h('label', { class: 'form-label' }, '上传文件'),
    h(
      'div',
      { class: 'form-control' },
      h(
        'div',
        { class: 'row-gap' },
        h('input', {
          type: 'text',
          class: 'mono-input',
          style: 'flex:1',
          value: bin.file_path || '',
          placeholder: '文件绝对路径（运行服务所在机器）',
          oninput: (e) => setField('file_path', e.target.value)
        }),
        pickBtn
      ),
      h(
        'div',
        { class: 'row-gap mt8' },
        h('input', {
          type: 'text',
          class: 'mono-input',
          value: bin.file_type || '',
          placeholder: 'Content-Type（默认 application/octet-stream）',
          oninput: (e) => setField('file_type', e.target.value)
        }),
        h('input', {
          type: 'text',
          class: 'mono-input',
          value: bin.file_name || '',
          placeholder: '文件名（默认取路径末段）',
          oninput: (e) => setField('file_name', e.target.value)
        })
      ),
      h(
        'div',
        { class: 'form-hint' },
        window.apimcpShell?.pickFile
          ? '路径是运行服务所在机器上的路径，桌面端可直接选文件'
          : '浏览器控制台无法读取本地文件路径，请填写运行服务所在机器上的绝对路径'
      )
    )
  );
}

function updateJsonHint(text) {
  const holder = document.getElementById('json-hint');
  if (!holder) return;
  const raw = String(text || '').trim();
  if (!raw) {
    holder.replaceChildren();
    return;
  }
  try {
    JSON.parse(raw);
    holder.replaceChildren(h('div', { class: 'form-hint ok' }, 'JSON 格式正确'));
  } catch (err) {
    holder.replaceChildren(h('div', { class: 'form-hint err' }, `JSON 语法错误：${err.message}`));
  }
}

/* ---------------- 页签：鉴权 ---------------- */

function tabAuth(request = editor.data.request, onChange = markDirty) {
  const auth = request.auth;
  const type = String(auth.type || 'inherit');

  auth.type = type;
  const sub = auth[type] || {};

  const updater = (keys) => (key) => (value) => {
    if (!auth[type]) auth[type] = {};
    auth[type][key] = value;
    onChange();
  };

  let detail = null;
  if (type === 'basic') {
    auth.basic = auth.basic || { username: '', password: '' };
    detail = h(
      'div',
      { class: 'form-grid' },
      field('用户名', input(auth.basic.username, (v) => {
        auth.basic.username = v;
        onChange();
      })),
      field('密码', input(auth.basic.password, (v) => {
        auth.basic.password = v;
        onChange();
      }, { type: 'password' }))
    );
  } else if (type === 'bearer') {
    auth.bearer = auth.bearer || { key: '' };
    detail = h(
      'div',
      { class: 'form-grid' },
      field('Token', input(auth.bearer.key, (v) => {
        auth.bearer.key = v;
        onChange();
      }, { placeholder: '{{token}}' }), '支持 {{变量名}} 引用环境变量')
    );
  } else if (type === 'kv') {
    auth.kv = auth.kv || { in: 'header', key: '', value: '' };
    detail = h(
      'div',
      { class: 'form-grid' },
      field('位置', select([['header', 'Header'], ['query', 'Query']], auth.kv.in || 'header', (v) => {
        auth.kv.in = v;
        onChange();
      })),
      field('Key', input(auth.kv.key, (v) => {
        auth.kv.key = v;
        onChange();
      }, { placeholder: 'X-API-Key' })),
      field('Value', input(auth.kv.value, (v) => {
        auth.kv.value = v;
        onChange();
      }, { placeholder: '{{apiKey}}' }))
    );
  } else if (type === 'oauth2') {
    auth.oauth2 = auth.oauth2 || { access_token: '', addTokenTo: 'header', headerPrefix: 'Bearer' };
    detail = h(
      'div',
      { class: 'form-grid' },
      field('Access Token', input(auth.oauth2.access_token, (v) => {
        auth.oauth2.access_token = v;
        onChange();
      }, { placeholder: '{{accessToken}}' })),
      field('添加到', select([['header', 'Header'], ['query', 'Query']], auth.oauth2.addTokenTo || 'header', (v) => {
        auth.oauth2.addTokenTo = v;
        onChange();
      })),
      field('前缀', input(auth.oauth2.headerPrefix || '', (v) => {
        auth.oauth2.headerPrefix = v;
        onChange();
      }, { placeholder: 'Bearer' }))
    );
  } else if (type === 'inherit') {
    detail = h('div', { class: 'form-hint' }, '使用项目级 global_params.json 中定义的默认鉴权');
  } else if (!AUTH_RUNTIME_SUPPORTED.has(type)) {
    // 对齐 Apipost 的类型清单，但执行层尚未实现签名算法：明确告知，避免误以为已生效
    detail = h(
      'div',
      { class: 'notice warn' },
      h('span', {}, '!'),
      h(
        'div',
        {},
        h('div', {}, `「${AUTH_TYPES.find(([k]) => k === type)?.[1] || type}」尚未在执行层实现，发送时不会自动加签名。`),
        h('div', { class: 'hint mt8' }, '可先用「预执行」脚本手工拼装 Authorization / 签名头，或改用 Bearer / Basic / API Key。')
      )
    );
  } else {
    detail = h('div', { class: 'form-hint' }, '该接口不携带鉴权信息');
  }

  return h(
    'div',
    { class: 'form-grid' },
    field(
      '鉴权类型',
      select(AUTH_TYPES, type, (v) => {
        auth.type = v;
        onChange();
        rerenderPane();
      })
    ),
    detail
  );
}

/* ---------------- 页签：脚本 ---------------- */

const APT_CHEATSHEET = [
  ['apt.environment.get(key)', '读取环境变量'],
  ['apt.environment.set(key, value)', '写入环境变量（后续步骤可用 {{key}} 引用）'],
  ['apt.globals.get / set', '全局变量读写'],
  ['apt.setRequestHeader(k, v)', '改写请求头'],
  ['apt.setRequestQuery(k, v)', '改写查询参数'],
  ['apt.setRequestBody(body)', '改写请求体'],
  ['apt.response.json()', '把响应解析为 JSON'],
  ['apt.response.text()', '响应原始文本'],
  ['apt.test(name, fn)', '注册断言'],
  ['apt.expect(v).to.equal(x)', '断言链式 API'],
  ['console.log(...)', '写入执行日志']
];

function tabScripts(request = editor.data.request, onChange = markDirty) {
  const req = request;

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'form-row full' },
      h('label', { class: 'form-label' }, '前置脚本'),
      h(
        'div',
        { class: 'form-control' },
        textarea(
          scriptSource(req.pre_tasks),
          (v) => {
            req.pre_tasks = setScriptSource(req.pre_tasks, v);
            onChange();
          },
          { rows: 10, placeholder: '// 发送请求前执行，例如：\napt.environment.set("token", "xxx");' }
        ),
        h('div', { class: 'form-hint' }, '发送请求前执行；可用 apt.* 改写请求与变量')
      )
    ),
    h(
      'div',
      { class: 'form-row full' },
      h('label', { class: 'form-label' }, '后置脚本'),
      h(
        'div',
        { class: 'form-control' },
        textarea(
          scriptSource(req.post_tasks),
          (v) => {
            req.post_tasks = setScriptSource(req.post_tasks, v);
            onChange();
          },
          { rows: 10, placeholder: '// 收到响应后执行，例如：\napt.test("状态码 200", () => apt.expect(apt.response.code()).to.equal(200));' }
        ),
        h('div', { class: 'form-hint' }, '收到响应后执行；断言失败会把该步骤标记为 failed')
      )
    ),
    h(
      'div',
      { class: 'cheatsheet' },
      h('div', { class: 'param-section-title' }, 'apt API 速查'),
      ...APT_CHEATSHEET.map(([code, desc]) =>
        h('div', { class: 'cheatsheet-row' }, h('code', {}, code), h('span', {}, desc))
      )
    )
  );
}

/* ---------------- 页签：响应 ---------------- */

const RESP_CONTENT_TYPES = [
  ['json', 'json'],
  ['xml', 'xml'],
  ['html', 'html'],
  ['text', 'text'],
  ['binary', 'binary']
];

const VERIFY_TYPES = [
  ['schema', 'schema（结构校验）'],
  ['code', 'code（只校验状态码）'],
  ['none', 'none（不校验）']
];

/** schema 是否有实际内容（空对象 / 只有 type:object 视为未配置） */
function hasSchemaContent(schema) {
  if (!schema || typeof schema !== 'object') return false;
  const props = schema.properties;
  const hasProps = props && typeof props === 'object' && Object.keys(props).length > 0;
  if (hasProps) return true;
  if (schema.items) return true;
  if (schema.type && schema.type !== 'object') return true;
  return false;
}

/** 响应示例的响应头校验编辑器：写到 ex.expect.headers */
function expectHeadersEditor(ex, onChange) {
  ex.expect = ex.expect || {};
  const entries = Object.entries(ex.expect.headers || {});
  const host = h('div', { class: 'header-expect' });

  const commit = (next) => {
    ex.expect.headers = next;
    onChange();
  };

  const render = () => {
    const rows = entries.map(([key, value], i) =>
      h(
        'div',
        { class: 'header-expect-row' },
        h('input', {
          type: 'text',
          class: 'mono-input',
          value: key,
          placeholder: 'Header 名',
          oninput: (e) => {
            entries[i] = [e.target.value, entries[i][1]];
            commit(Object.fromEntries(entries.filter(([k]) => k)));
          }
        }),
        h('input', {
          type: 'text',
          class: 'mono-input',
          value,
          placeholder: '期望包含的值',
          oninput: (e) => {
            entries[i] = [entries[i][0], e.target.value];
            commit(Object.fromEntries(entries.filter(([k]) => k)));
          }
        }),
        h(
          'button',
          {
            class: 'small danger',
            title: '删除',
            onclick: () => {
              entries.splice(i, 1);
              commit(Object.fromEntries(entries.filter(([k]) => k)));
              render();
            }
          },
          '×'
        )
      )
    );
    if (entries.length === 0) rows.push(h('div', { class: 'param-empty' }, '暂无响应头校验'));
    rows.push(
      h(
        'button',
        {
          class: 'small',
          onclick: () => {
            entries.push(['', '']);
            render();
          }
        },
        '+ 添加'
      )
    );
    host.replaceChildren(...rows);
  };

  render();
  return host;
}

function tabResponse() {
  const resp = editor.data.response;
  if (!Array.isArray(resp.example)) resp.example = [];

  const listNode = h('div', { class: 'response-list' });

  const renderList = () => {
    const nodes = [];

    resp.example.forEach((ex, index) => {
      ex.expect = ex.expect || { code: '200', name: '成功', is_default: -1, verify_type: 'schema', content_type: 'json', schema: { type: 'object', properties: {} } };

      nodes.push(
        h(
          'div',
          { class: 'response-card' },
          h(
            'div',
            { class: 'response-head' },
            h('span', { class: 'tag info' }, `#${index + 1}`),
            input(ex.expect.name ?? '', (v) => {
              ex.expect.name = v;
              markDirty();
            }, { placeholder: '示例名称' }),
            h('span', { class: 'tag' }, '状态码'),
            input(ex.expect.code ?? '200', (v) => {
              ex.expect.code = v;
              markDirty();
            }, { placeholder: '200' }),
            h(
              'label',
              { class: 'check' },
              h('input', {
                type: 'checkbox',
                checked: Number(ex.expect.is_default) === 1,
                onchange: (e) => {
                  resp.example.forEach((other) => {
                    other.expect = other.expect || {};
                    other.expect.is_default = -1;
                  });
                  ex.expect.is_default = e.target.checked ? 1 : -1;
                  markDirty();
                }
              }),
              '默认'
            ),
            h(
              'button',
              {
                class: 'small danger',
                onclick: () => {
                  resp.example.splice(index, 1);
                  markDirty();
                  renderList();
                }
              },
              '删除'
            )
          ),
          // 校验配置：Content-Type / 校验方式 / 数据结构 / 响应头
          h(
            'div',
            { class: 'response-checks' },
            h(
              'label',
              { class: 'resp-check' },
              h('span', { class: 'hint' }, 'Content-Type'),
              select(
                RESP_CONTENT_TYPES,
                ex.expect.content_type || 'json',
                (v) => {
                  ex.expect.content_type = v;
                  markDirty();
                },
                { class: 'tb-select' }
              )
            ),
            h(
              'label',
              { class: 'resp-check' },
              h('span', { class: 'hint' }, '校验方式'),
              select(
                VERIFY_TYPES,
                ex.expect.verify_type || 'schema',
                (v) => {
                  ex.expect.verify_type = v;
                  markDirty();
                  renderList();
                },
                { class: 'tb-select' }
              )
            )
          ),
          ex.expect.verify_type === 'schema'
            ? h(
                'details',
                { class: 'resp-schema', ...(ex.__schemaOpen ? { open: true } : {}) },
                h(
                  'summary',
                  {},
                  '数据结构（JSON Schema）',
                  hasSchemaContent(ex.expect.schema)
                    ? h('span', { class: 'tag info' }, '已配置')
                    : h('span', { class: 'hint' }, '未配置')
                ),
                h(
                  'div',
                  { class: 'btn-row' },
                  h(
                    'button',
                    {
                      class: 'small',
                      onclick: () => {
                        const schema = window.CurlParse?.jsonToSchema?.(
                          (() => {
                            try {
                              return JSON.parse(ex.raw || '{}');
                            } catch {
                              return null;
                            }
                          })()
                        );
                        if (!schema) {
                          toast('上方响应体不是合法 JSON，无法反推', true);
                          return;
                        }
                        ex.expect.schema = schema;
                        ex.raw_schema = schema;
                        ex.raw_parameter = window.CurlParse?.schemaToParameters?.(schema) || [];
                        ex.__schemaOpen = true;
                        markDirty();
                        renderList();
                      }
                    },
                    '由上方响应体反推'
                  )
                ),
                textarea(
                  JSON.stringify(ex.expect.schema || {}, null, 2),
                  (v) => {
                    // 只在 JSON 合法时写回，避免输入中途把 schema 清空
                    try {
                      const parsed = JSON.parse(v || '{}');
                      ex.expect.schema = parsed;
                      ex.raw_schema = parsed;
                      ex.raw_parameter = window.CurlParse?.schemaToParameters?.(parsed) || [];
                      markDirty();
                    } catch {}
                  },
                  { rows: 10, placeholder: '{\n  "type": "object",\n  "properties": {}\n}' }
                )
              )
            : null,
          h(
            'details',
            { class: 'resp-schema' },
            h(
              'summary',
              {},
              '响应头校验',
              Object.keys(ex.expect.headers || {}).length > 0
                ? h('span', { class: 'tag info' }, `${Object.keys(ex.expect.headers || {}).length} 条`)
                : h('span', { class: 'hint' }, '未配置')
            ),
            expectHeadersEditor(ex, () => {
              markDirty();
              renderList();
            })
          ),
          textarea(
            ex.raw ?? '',
            (v) => {
              ex.raw = v;
              markDirty();
            },
            { rows: 8, placeholder: '{\n  "code": 0,\n  "msg": "ok"\n}' }
          )
        )
      );
    });

    if (resp.example.length === 0) {
      nodes.push(h('div', { class: 'param-empty' }, '暂无响应示例'));
    }

    listNode.replaceChildren(
      ...nodes,
      h(
        'button',
        {
          class: 'small',
          onclick: () => {
            resp.example.push({
              example_id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
              expect: { code: '200', name: '成功', is_default: resp.example.length === 0 ? 1 : -1, verify_type: 'schema', content_type: 'json', schema: { type: 'object', properties: {} } },
              raw: '',
              raw_parameter: []
            });
            markDirty();
            renderList();
          }
        },
        '+ 添加示例'
      )
    );
  };

  renderList();

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'form-row' },
      h('label', { class: 'form-label' }, '结构校验'),
      h(
        'div',
        { class: 'form-control' },
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: Number(resp.is_check_result) === 1,
            onchange: (e) => {
              resp.is_check_result = e.target.checked ? 1 : -1;
              markDirty();
            }
          }),
          '启用响应结构与状态码校验'
        ),
        h('div', { class: 'form-hint' }, '开启后，执行时按默认示例的状态码与 schema 判定通过与否')
      )
    ),
    listNode
  );
}

/* ---------------- 编辑器外壳 ---------------- */

let paneHost = null;

function rerenderPane() {
  window.__syncPaneHostMode?.();
  if (!paneHost) return;
  paneHost.replaceChildren(buildPane());
}

/* ---------------- curl 导入 ---------------- */

const DIALECT_OPTIONS = [
  ['auto', '自动识别'],
  ['bash', 'bash (Linux/macOS/Git Bash)'],
  ['cmd', 'Windows CMD'],
  ['powershell', 'PowerShell']
];

const DIALECT_LABEL = {
  bash: 'bash',
  cmd: 'CMD',
  powershell: 'PowerShell'
};

function openCurlImport() {
  const showModal = window.__consoleShowModal;
  const closeModal = window.__consoleCloseModal;
  const CP = window.CurlParse;

  if (!showModal || !CP) {
    toast('curl 解析器未加载，请刷新页面', true);
    return;
  }

  const state = {
    text: '',
    dialect: 'auto',
    results: [],
    activeIndex: 0
  };

  const input = h('textarea', {
    class: 'mono-input curl-input',
    rows: 16,
    placeholder:
      '粘贴 curl 命令，支持三种来源：\n\n  bash / zsh（Linux、macOS、Git Bash）  行尾 \\ 续行\n  Windows CMD（Chrome 复制为 cURL (cmd)）  行尾 ^ 续行、^" 包裹\n  PowerShell  反引号续行\n\n可以直接粘多条，会分别识别。'
  });

  const dialectSelect = select(DIALECT_OPTIONS, 'auto', (v) => {
    state.dialect = v;
    reparse();
  });

  const previewHost = h('div', { class: 'curl-preview' });
  const blockBar = h('div', { class: 'curl-blocks' });

  const reparse = () => {
    const text = input.value;
    state.text = text;

    if (!text.trim()) {
      state.results = [];
      state.activeIndex = 0;
      renderBlockBar();
      renderPreview();
      return;
    }

    try {
      state.results = CP.parseAll(text, { dialect: state.dialect });
    } catch (err) {
      state.results = [];
      toast(`解析失败：${err.message}`, true);
    }
    if (state.activeIndex >= state.results.length) state.activeIndex = 0;
    renderBlockBar();
    renderPreview();
  };

  const renderBlockBar = () => {
    if (state.results.length <= 1) {
      blockBar.replaceChildren();
      return;
    }
    const nodes = [
      h('span', { class: 'hint' }, `检测到 ${state.results.length} 条命令：`)
    ];
    state.results.forEach((res, index) => {
      nodes.push(
        h(
          'span',
          {
            class: `tag curl-block-tag${index === state.activeIndex ? ' info' : ''}`,
            onclick: () => {
              state.activeIndex = index;
              renderBlockBar();
              renderPreview();
            }
          },
          `#${index + 1} ${String(res.method || '').toUpperCase()} ${truncateUrl(res.url)}`
        )
      );
    });
    blockBar.replaceChildren(...nodes);
  };

  const renderPreview = () => {
    const res = state.results[state.activeIndex];

    if (!res) {
      previewHost.replaceChildren(h('div', { class: 'empty' }, '粘贴 curl 后这里会显示解析结果'));
      updateImportButtons(null);
      return;
    }

    const nodes = [];

    // 状态行
    nodes.push(
      h(
        'div',
        { class: 'curl-status' },
        h('span', { class: `tag ${res.dialect === 'cmd' ? 'warn' : 'info'}` }, DIALECT_LABEL[res.dialect] || res.dialect),
        h('span', { class: `tag ${res.ok ? 'ok' : 'err'}` }, res.ok ? '解析成功' : '缺少 URL'),
        res.method ? h('span', { class: `method ${res.method}` }, res.method) : null
      )
    );

    // URL
    nodes.push(
      h(
        'div',
        { class: 'curl-section' },
        h('div', { class: 'curl-section-title' }, 'URL'),
        h('div', { class: 'curl-url mono' }, res.url || h('span', { class: 'hint' }, '(未识别)'))
      )
    );

    // warnings
    if (res.warnings?.length) {
      nodes.push(
        h(
          'div',
          { class: 'curl-section' },
          ...res.warnings.map((w) => h('div', { class: 'curl-warn' }, `⚠ ${w}`))
        )
      );
    }

    // 参数统计
    const stats = [
      ['Query', res.query?.length || 0],
      ['Header', res.headers?.length || 0],
      ['Cookie', res.cookies?.length || 0],
      ['Path', res.restful?.length || 0]
    ];
    nodes.push(
      h(
        'div',
        { class: 'curl-section' },
        h('div', { class: 'curl-section-title' }, '参数'),
        h(
          'div',
          { class: 'curl-stats' },
          ...stats.map(([label, count]) =>
            h('div', { class: 'curl-stat' }, h('span', { class: 'hint' }, label), h('strong', {}, String(count)))
          )
        )
      )
    );

    // Query 明细
    if (res.query?.length) {
      nodes.push(
        h(
          'details',
          { class: 'curl-details', open: res.query.length <= 6 },
          h('summary', {}, `Query 参数（${res.query.length}）`),
          ...res.query.map((q) =>
            h('div', { class: 'curl-kv' }, h('code', {}, q.key), h('span', { class: 'mono' }, q.value))
          )
        )
      );
    }

    // Header 明细
    if (res.headers?.length) {
      nodes.push(
        h(
          'details',
          { class: 'curl-details' },
          h('summary', {}, `Header（${res.headers.length}）`),
          ...res.headers.map((item) =>
            h(
              'div',
              { class: 'curl-kv' },
              h('code', {}, item.key),
              h('span', { class: 'mono curl-kv-value' }, item.value)
            )
          )
        )
      );
    }

    // Cookie 明细
    if (res.cookies?.length) {
      nodes.push(
        h(
          'details',
          { class: 'curl-details' },
          h('summary', {}, `Cookie（${res.cookies.length}）`),
          ...res.cookies.map((c) =>
            h('div', { class: 'curl-kv' }, h('code', {}, c.key), h('span', { class: 'mono' }, c.value))
          )
        )
      );
    }

    // Body
    const body = res.body || { mode: 'none' };
    if (body.mode !== 'none') {
      const size = (body.raw || '').length;
      const bodyNodes = [
        h(
          'div',
          { class: 'curl-kv' },
          h('code', {}, 'mode'),
          h('span', { class: 'mono' }, body.mode),
          size ? h('span', { class: 'hint' }, ` · ${size} 字符`) : null
        )
      ];
      if (body.parseError) {
        bodyNodes.push(h('div', { class: 'curl-warn' }, '⚠ 声明为 JSON 但无法解析，将按原文保存'));
      }
      if (body.form?.length) {
        for (const f of body.form) {
          bodyNodes.push(
            h(
              'div',
              { class: 'curl-kv' },
              h('code', {}, f.key),
              h('span', { class: 'mono curl-kv-value' }, f.value),
              f.isFile ? h('span', { class: 'tag' }, 'File') : null
            )
          );
        }
      }
      if (body.raw) {
        bodyNodes.push(h('pre', { class: 'code curl-body-preview' }, body.raw));
      }
      nodes.push(h('details', { class: 'curl-details', open: true }, h('summary', {}, 'Body'), ...bodyNodes));
    }

    if (res.auth) {
      nodes.push(
        h(
          'div',
          { class: 'curl-section' },
          h('div', { class: 'curl-section-title' }, '鉴权'),
          h('div', { class: 'curl-kv' }, h('code', {}, res.auth.type), h('span', { class: 'mono' }, `${res.auth.username}:***`))
        )
      );
    }

    previewHost.replaceChildren(...nodes);
    updateImportButtons(res);
  };

  // 底部按钮
  const importCurrentBtn = h(
    'button',
    {
      onclick: () => {
        const res = state.results[state.activeIndex];
        if (!res) return;
        if (!editor.data) {
          toast('请先选择一个接口，或使用「导入为新接口」', true);
          return;
        }
        CP.applyParsedToApiData(ensureShape(editor.data), res);
        markDirty();
        closeModal();
        rerenderPane();
        toast('已填充到当前接口，记得点「保存」');
      }
    },
    '导入到当前接口'
  );

  const importNewBtn = h(
    'button',
    {
      class: 'primary',
      onclick: async () => {
        const res = state.results[state.activeIndex];
        if (!res) return;
        await createApisFromResults([res]);
      }
    },
    '导入为新接口'
  );

  const importAllBtn = h(
    'button',
    {
      onclick: async () => {
        await createApisFromResults(state.results.filter((r) => r.ok));
      }
    },
    '全部导入'
  );

  function updateImportButtons(res) {
    const ok = Boolean(res && res.ok);
    importCurrentBtn.disabled = !ok;
    importNewBtn.disabled = !ok;
    importAllBtn.style.display = state.results.filter((r) => r.ok).length > 1 ? '' : 'none';
  }

  async function createApisFromResults(results) {
    const valid = results.filter((r) => r?.ok);
    if (valid.length === 0) {
      toast('没有可导入的 curl（缺少 URL）', true);
      return;
    }

    const parentId = editor.targetType === 'folder' ? editor.selectedId : '0';
    let created = 0;
    let lastId = null;
    const failures = [];

    for (const res of valid) {
      try {
        const name = CP.suggestName(res) || '新接口';
        const createdApi = await api.post(`/projects/${editor.projectId}/apis`, {
          name,
          target_type: 'api',
          method: res.method || 'GET',
          url: res.url || '',
          parent_id: parentId
        });
        const detail = await api.get(`/projects/${editor.projectId}/apis/${createdApi.target_id}`);
        // GET /apis/:id 返回 { project_id, target_id, target_type, index, data }
        const data = ensureShape(deepClone(detail.data || null));
        if (!data) throw new Error('接口详情为空');
        CP.applyParsedToApiData(data, res);
        await api.put(`/projects/${editor.projectId}/apis/${createdApi.target_id}`, { data });
        created += 1;
        lastId = createdApi.target_id;
      } catch (err) {
        failures.push(err.message || String(err));
      }
    }

    closeModal();
    await loadTree(editor.projectId);
    if (lastId) await loadApi(editor.projectId, lastId);
    rerenderTree();
    rerenderPane();
    const tb = document.querySelector('.editor-toolbar');
    if (tb) tb.replaceWith(editorToolbar(() => refreshDesign()));

    if (failures.length > 0) {
      const first = failures[0];
      toast(`导入 ${created} 个成功，${failures.length} 个失败：${first}`, true);
    } else {
      notifyAction('import', '', created);
    }
  }

  // 组装弹窗
  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reparse, 250);
  });

  const body = h(
    'div',
    { class: 'curl-modal' },
    h(
      'div',
      { class: 'curl-col' },
      h(
        'div',
        { class: 'curl-col-head' },
        h('span', { class: 'form-label' }, 'curl 命令'),
        h(
          'label',
          { class: 'curl-dialect' },
          h('span', { class: 'hint' }, '来源'),
          dialectSelect
        )
      ),
      input
    ),
    h(
      'div',
      { class: 'curl-col' },
      h('div', { class: 'curl-col-head' }, h('span', { class: 'form-label' }, '解析预览')),
      blockBar,
      previewHost
    )
  );

  showModal('curl 导入', body, [h('button', { onclick: closeModal }, '取消'), importAllBtn, importCurrentBtn, importNewBtn]);

  // 首屏
  renderPreview();
  setTimeout(() => input.focus(), 50);
  input.addEventListener('paste', () => {
    // 粘贴后立即解析，不等防抖
    clearTimeout(debounceTimer);
    setTimeout(reparse, 0);
  });
}

function truncateUrl(url) {
  const text = String(url || '');
  if (text.length <= 42) return text;
  return `${text.slice(0, 39)}...`;
}

/* ---------------- 请求栏（发送区） ---------------- */

const PROTOCOLS = [
  ['http/1.1', 'http/1.1'],
  ['http/2', 'http/2']
];

let sending = false;

function requestBar({ readonly = false } = {}) {
  const d = editor.data;
  if (!d || editor.targetType !== 'api') return null;

  const methodSelect = select(
    METHODS.map((m) => [m, m]),
    String(d.method || 'GET').toUpperCase(),
    (v) => {
      d.method = v;
      markDirty();
      rerenderPane();
    },
    { class: 'req-method', disabled: readonly }
  );

  const urlInput = h('input', {
    type: 'text',
    class: 'req-url mono-input',
    value: d.url || '',
    placeholder: 'http://127.0.0.1:5000/ 或 {{base}}/path',
    readOnly: readonly,
    oninput: (e) => {
      d.url = e.target.value;
      markDirty();
    }
  });

  const protocolSelect = select(PROTOCOLS, d.protocol || 'http/1.1', (v) => {
    d.protocol = v;
    markDirty();
  }, { class: 'req-protocol', disabled: readonly });

  // 只读模式（压测 / Mock 页签）不提供发送能力，避免改动设计数据；
  // 保存按钮跟着请求行走，压测没有可保存配置，这里不渲染。
  if (readonly) {
    return h(
      'div',
      { class: 'request-bar readonly' },
      methodSelect,
      urlInput,
      protocolSelect,
      editor.activeMode === 'stress' ? null : saveSplit()
    );
  }

  const sendMain = h(
    'button',
    {
      class: 'send-main',
      disabled: sending,
      onclick: () => doSend(false)
    },
    sending ? '发送中…' : '发送'
  );

  const sendCaret = h(
    'button',
    {
      class: 'send-caret',
      disabled: sending,
      title: '更多发送选项',
      onclick: (e) => {
        e.stopPropagation();
        toggleSendMenu();
      }
    },
    '▾'
  );

  const split = h('div', { class: 'send-split' }, sendMain, sendCaret);

  // 发送中显示「取消发送」
  const cancelBtn = sending
    ? h(
        'button',
        {
          class: 'small danger send-cancel',
          onclick: () => {
            if (sendAbort) sendAbort.abort();
          }
        },
        '取消发送'
      )
    : null;

  let sendMenu = null;

  const closeSendMenu = () => {
    if (sendMenu) {
      sendMenu.remove();
      sendMenu = null;
      document.removeEventListener('click', closeSendMenu, true);
    }
  };

  const toggleSendMenu = () => {
    if (sendMenu) {
      closeSendMenu();
      return;
    }
    sendMenu = h(
      'div',
      { class: 'send-menu' },
      h(
        'div',
        {
          class: 'send-menu-item',
          onclick: () => {
            closeSendMenu();
            doSend(false);
          }
        },
        '发送'
      ),
      h(
        'div',
        {
          class: 'send-menu-item',
          onclick: () => {
            closeSendMenu();
            doSend(true);
          }
        },
        '发送并保存响应'
      )
    );
    split.append(sendMenu);
    document.addEventListener('click', closeSendMenu, true);
  };

  return h(
    'div',
    { class: 'request-bar' },
    methodSelect,
    urlInput,
    protocolSelect,
    split,
    cancelBtn,
    // 保存从页签行下移到这里，占用原 curl 导入的位置
    saveSplit()
  );
}

let sendAbort = null;

async function doSend(saveResponse) {
  if (sending || !editor.selectedId) return;
  sending = true;
  sendAbort = new AbortController();
  const signal = sendAbort.signal;
  rerenderPane();

  try {
    // 有未保存改动时先保存，避免发送旧内容
    if (editor.dirty) {
      const ok = await saveCurrent(window.__designRefresh);
      if (!ok) {
        sending = false;
        sendAbort = null;
        rerenderPane();
        return;
      }
    }

    const res = await api.post(`/projects/${editor.projectId}/apis/${editor.selectedId}/send`, {}, { signal });
    // 响应进右侧常驻响应区（按接口缓存，切回来还在）
    window.ApiWorkspace?.setResponse(editor.selectedId, res);

    if (saveResponse && res.response) {
      saveResponseToExample(res);
      toast('已保存响应到示例，并同步保存接口');
    } else {
      toast(res.status === 'passed' ? `发送成功 · ${res.status_code}` : `发送完成（${res.status_code || '失败'}）`);
    }
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''));
    if (aborted) {
      window.ApiWorkspace?.clearResponse(editor.selectedId);
      toast('已取消发送');
    } else {
      window.ApiWorkspace?.setResponse(editor.selectedId, { error: err.message });
      toast(`发送失败：${err.message}`, true);
    }
  } finally {
    sending = false;
    sendAbort = null;
    rerenderPane();
  }
}

/** 把当前响应写回期望的第一个示例，并保存接口 */
async function saveResponseToExample(res) {
  if (!res?.response) return false;
  const resp = ensureShape(editor.data).response;
  if (!Array.isArray(resp.example) || resp.example.length === 0) {
    resp.example = [
      {
        example_id: `${Date.now().toString(16)}`,
        expect: {
          code: String(res.response.status || 200),
          content_type: 'json',
          is_default: 1,
          mock: '',
          name: '成功',
          schema: { type: 'object', properties: {} },
          verify_type: 'schema'
        },
        raw: '',
        raw_parameter: []
      }
    ];
  }
  resp.example[0].raw = res.response.body || '';
  resp.example[0].expect.code = String(res.response.status || 200);
  markDirty();
  await saveCurrent(window.__designRefresh);
  return true;
}

/** 响应区「保存为示例」按钮入口：用当前接口缓存的响应 */
async function saveAsExample() {
  const res = window.ApiWorkspace?.getResponse(editor.selectedId);
  if (!res?.response) {
    toast('还没有可保存的响应，请先发送', true);
    return;
  }
  try {
    await saveResponseToExample(res);
    toast('已保存响应到示例，并同步保存接口');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 调试面板 ---------------- */

/** 递归渲染 JSON 树 */
function jsonTreeView(value, key = null, depth = 0) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

  if (type === 'object' || type === 'array') {
    const entries = type === 'array' ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    const summary = type === 'array' ? `[${entries.length}]` : `{${entries.length}}`;
    const label = key !== null ? `${key}: ` : '';

    return h(
      'details',
      { class: 'json-node', open: depth < 2 },
      h(
        'summary',
        {},
        label ? h('span', { class: 'json-key' }, label) : null,
        h('span', { class: 'json-summary' }, summary)
      ),
      h('div', { class: 'json-children' }, ...entries.map(([k, v]) => jsonTreeView(v, k, depth + 1)))
    );
  }

  const label = key !== null ? `${key}: ` : '';
  return h(
    'div',
    { class: 'json-leaf' },
    label ? h('span', { class: 'json-key' }, label) : null,
    h('span', { class: `json-value json-${type}` }, type === 'string' ? `"${value}"` : String(value))
  );
}

/* ---------------- 共用展示组件（UiBits） ---------------- */

/** 与 src/store/runs.js 的 SENSITIVE_KEY 保持一致 */
const SENSITIVE_HEADER = /authorization|cookie|token|secret|password|api[-_]?key/i;

function maskValue(key, value) {
  if (!SENSITIVE_HEADER.test(String(key || ''))) return value;
  return '***';
}

/** 键值表：headers / query / cookies 通用 */
function kvTable(pairs, { mask = false, emptyText = '（空）', keyWidth = 200 } = {}) {
  const entries = Array.isArray(pairs) ? pairs : Object.entries(pairs || {});
  if (entries.length === 0) return h('div', { class: 'form-hint' }, emptyText);
  return h(
    'table',
    { class: 'kv-table' },
    h('tbody', {},
      ...entries.map(([k, v]) => {
        const text = mask ? maskValue(k, String(v ?? '')) : String(v ?? '');
        return h(
          'tr',
          {},
          h('td', { class: 'kv-key mono', style: `width:${keyWidth}px` }, String(k)),
          h('td', { class: 'kv-val mono' }, text)
        );
      })
    )
  );
}

function headersTable(headers, label) {
  const entries = Object.entries(headers || {});
  return h(
    'div',
    { class: 'kv-block' },
    label ? h('div', { class: 'kv-block-title' }, label, h('span', { class: 'hint' }, ` ${entries.length}`)) : null,
    kvTable(entries, { mask: Boolean(editor.debugMask), emptyText: '没有' })
  );
}

function statusLine({ protocol, status, status_text }) {
  const code = Number(status) || 0;
  const cls = code >= 500 ? 'err' : code >= 400 ? 'warn' : code >= 200 && code < 300 ? 'ok' : '';
  return h(
    'div',
    { class: 'status-line' },
    h('span', { class: `tag ${cls}` }, `${code || '-'} ${status_text || ''}`.trim()),
    protocol ? h('code', { class: 'mono hint' }, protocol) : null
  );
}

/** 解析 Set-Cookie 字符串为字段表 */
function parseSetCookie(raw) {
  const text = String(raw || '');
  const [pair, ...attrs] = text.split(';').map((s) => s.trim()).filter(Boolean);
  const eq = pair.indexOf('=');
  const out = {
    name: eq < 0 ? pair : pair.slice(0, eq),
    value: eq < 0 ? '' : pair.slice(eq + 1),
    Path: '',
    Domain: '',
    Expires: '',
    HttpOnly: '',
    Secure: '',
    SameSite: ''
  };
  for (const attr of attrs) {
    const idx = attr.indexOf('=');
    const key = idx < 0 ? attr : attr.slice(0, idx);
    const val = idx < 0 ? '是' : attr.slice(idx + 1);
    const canon =
      key.toLowerCase() === 'path'
        ? 'Path'
        : key.toLowerCase() === 'domain'
          ? 'Domain'
          : key.toLowerCase() === 'expires'
            ? 'Expires'
            : key.toLowerCase() === 'httponly'
              ? 'HttpOnly'
              : key.toLowerCase() === 'secure'
                ? 'Secure'
                : key.toLowerCase() === 'samesite'
                  ? 'SameSite'
                  : key;
    out[canon] = val;
  }
  return out;
}

function cookieTable(setCookies, { mask = false } = {}) {
  const list = Array.isArray(setCookies) ? setCookies : [];
  if (list.length === 0) return h('div', { class: 'form-hint' }, '本次响应没有 Set-Cookie');
  return h(
    'div',
    { class: 'cookie-list' },
    ...list.map((raw) => {
      const c = parseSetCookie(raw);
      const attrs = ['Path', 'Domain', 'Expires', 'HttpOnly', 'Secure', 'SameSite']
        .filter((k) => c[k])
        .map((k) => `${k}=${c[k]}`)
        .join(' · ');
      return h(
        'div',
        { class: 'cookie-item' },
        h(
          'div',
          { class: 'cookie-line' },
          h('code', { class: 'cookie-name' }, c.name),
          h('span', { class: 'mono cookie-value' }, mask ? '***' : c.value)
        ),
        attrs ? h('div', { class: 'form-hint' }, attrs) : null
      );
    })
  );
}

/** 可折叠区块 */
function collapsible(title, body, { open = false } = {}) {
  return h('details', { class: 'kv-collapse', ...(open ? { open: true } : {}) }, h('summary', {}, title), body);
}

window.UiBits = { kvTable, headersTable, statusLine, cookieTable, collapsible, parseSetCookie, maskValue };

/* ---------------- 响应体渲染：美化 / 原生 / 预览 / 可视化 ---------------- */

const VIEW_MODES = [
  ['pretty', '美化'],
  ['raw', '原生'],
  ['preview', '预览'],
  ['visual', '可视化']
];

const FORMAT_OPTIONS = [
  ['auto', '自动'],
  ['json', 'JSON'],
  ['xml', 'XML'],
  ['html', 'HTML'],
  ['text', 'Text']
];

const ENCODING_OPTIONS = [
  ['utf-8', 'UTF-8'],
  ['gbk', 'GBK'],
  ['gb18030', 'GB18030'],
  ['big5', 'Big5'],
  ['latin1', 'Latin1']
];

/** 从 base64 按指定编码解码出文本 */
function decodeBase64(base64, encoding = 'utf-8') {
  if (!base64) return null;
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const label = encoding === 'latin1' ? 'iso-8859-1' : encoding;
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** 推断响应的内容格式 */
function detectFormat(resp, override) {
  if (override && override !== 'auto') return override;
  const ct = String(resp.content_type || resp.headers?.['content-type'] || '').toLowerCase();
  if (ct.includes('json') || resp.is_binary === false && looksJson(resp.body)) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (/^text\//.test(ct)) return 'text';
  return looksJson(resp.body) ? 'json' : 'text';
}

function looksJson(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** 简单 XML/HTML 缩进格式化 */
function prettyMarkup(text) {
  const src = String(text || '').replace(/>\s*</g, '><').trim();
  let depth = 0;
  const out = [];
  const tokens = src.split(/(?=<)/);
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    if (/^<\//.test(token)) depth = Math.max(0, depth - 1);
    out.push(`${'  '.repeat(depth)}${token}`);
    if (/^<[^!/?][^>]*[^/]>$/.test(token)) depth += 1;
  }
  return out.join('\n');
}

/** 文件名推断（用于下载） */
function guessFileName(resp, url) {
  const cd = String(resp.headers?.['content-disposition'] || '');
  const match = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  let name = 'response';
  try {
    const u = new URL(url || '');
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) name = seg;
  } catch {}
  const ct = String(resp.content_type || '');
  const ext = ct.includes('json')
    ? '.json'
    : ct.includes('html')
      ? '.html'
      : ct.includes('xml')
        ? '.xml'
        : ct.includes('png')
          ? '.png'
          : ct.includes('jpeg') || ct.includes('jpg')
            ? '.jpg'
            : ct.includes('gif')
              ? '.gif'
              : ct.includes('webp')
                ? '.webp'
                : ct.includes('svg')
                  ? '.svg'
                  : ct.includes('pdf')
                    ? '.pdf'
                    : '.txt';
  return name.includes('.') ? name : `${name}${ext}`;
}

/** 下载响应体 */
function downloadResponse(resp, url) {
  const base64 = resp.body_base64;
  if (!base64) {
    toast('响应体为空或过大，无法下载', true);
    return;
  }
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: resp.content_type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = guessFileName(resp, url);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast(`已下载 ${a.download}`);
  } catch (err) {
    toast(`下载失败：${err.message}`, true);
  }
}

/** 可视化：JSON 数组 → 表格；对象 → 键值表 */
function visualView(json) {
  if (Array.isArray(json)) {
    if (json.length === 0) return h('div', { class: 'empty' }, '空数组');
    const isObjArray = json.every((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (!isObjArray) {
      return h(
        'table',
        { class: 'vis-table' },
        h('thead', {}, h('tr', {}, h('th', { style: 'width:56px' }, '#'), h('th', {}, '值'))),
        h(
          'tbody',
          {},
          ...json.slice(0, 500).map((v, i) =>
            h('tr', {}, h('td', {}, String(i + 1)), h('td', { class: 'mono' }, typeof v === 'object' ? JSON.stringify(v) : String(v)))
          )
        )
      );
    }
    const keys = [...new Set(json.flatMap((item) => Object.keys(item)))];
    return h(
      'div',
      { class: 'vis-scroll' },
      h(
        'table',
        { class: 'vis-table' },
        h('thead', {}, h('tr', {}, h('th', { style: 'width:44px' }, '#'), ...keys.map((k) => h('th', {}, k)))),
        h(
          'tbody',
          {},
          ...json.slice(0, 500).map((item, i) =>
            h(
              'tr',
              {},
              h('td', {}, String(i + 1)),
              ...keys.map((k) => {
                const v = item?.[k];
                const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                return h('td', { class: typeof v === 'object' ? 'mono' : '', title: text }, text);
              })
            )
          )
        )
      )
    );
  }

  if (json && typeof json === 'object') {
    const entries = Object.entries(json);
    if (entries.length === 0) return h('div', { class: 'empty' }, '空对象');
    return h(
      'table',
      { class: 'vis-table' },
      h('thead', {}, h('tr', {}, h('th', { style: 'width:180px' }, '字段'), h('th', {}, '值'))),
      h(
        'tbody',
        {},
        ...entries.map(([k, v]) => {
          const text = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v, null, 0) : String(v);
          return h('tr', {}, h('td', { class: 'mono' }, k), h('td', { class: typeof v === 'object' ? 'mono' : '', title: text }, text));
        })
      )
    );
  }

  return h('div', { class: 'empty' }, '该响应不是对象或数组，无法可视化');
}

/** 构建响应体视图（含工具条） */
function buildResponseBody(resp, envelope) {
  const view = editor.debugView || 'pretty';
  const fmt = editor.debugFormat || 'auto';
  const enc = editor.debugEncoding || 'utf-8';

  // 文本内容：有 base64 时按所选编码重新解码，否则用后端给的 utf8 文本
  const decoded = resp.body_base64 ? decodeBase64(resp.body_base64, enc) : null;
  const text = decoded !== null ? decoded : resp.body || '';
  const contentType = String(resp.content_type || resp.headers?.['content-type'] || '');
  const isImage = /^image\//i.test(contentType);
  const format = detectFormat({ ...resp, body: text }, fmt);
  const url = envelope?.request?.url || editor.data?.url || '';

  // 工具条
  const toolbar = h(
    'div',
    { class: 'response-toolbar' },
    h(
      'div',
      { class: 'seg-group' },
      ...VIEW_MODES.map(([key, label]) =>
        h(
          'button',
          {
            class: `seg${view === key ? ' active' : ''}`,
            onclick: () => {
              editor.debugView = key;
              rerenderPane();
            }
          },
          label
        )
      )
    ),
    h('span', { class: 'toolbar-divider' }),
    h(
      'label',
      { class: 'tb-field' },
      h('span', { class: 'hint' }, '格式'),
      select(FORMAT_OPTIONS, fmt, (v) => {
        editor.debugFormat = v;
        rerenderPane();
      }, { class: 'tb-select' })
    ),
    h(
      'label',
      { class: 'tb-field' },
      h('span', { class: 'hint' }, '编码'),
      select(ENCODING_OPTIONS, enc, (v) => {
        editor.debugEncoding = v;
        rerenderPane();
      }, { class: 'tb-select' })
    ),
    h('span', { class: 'spacer' }),
    h(
      'button',
      {
        class: 'small',
        disabled: !resp.body_base64,
        title: resp.body_base64 ? '下载响应体' : '响应体过大或为空，无法下载',
        onclick: () => downloadResponse(resp, url)
      },
      '下载'
    )
  );

  // 内容
  let content;
  if (!resp.body_base64 && !String(resp.body || '').trim() && !isImage) {
    content = h('div', { class: 'empty' }, '响应体为空');
  } else if (view === 'raw') {
    content = h('pre', { class: 'code debug-body' }, text);
  } else if (view === 'preview') {
    if (isImage) {
      if (resp.too_large_for_base64 || !resp.body_base64) {
        content = h(
          'div',
          { class: 'empty' },
          `图片过大（${formatSize(resp.size)}），无法内联预览，请使用「下载」按钮查看`
        );
      } else {
        content = h(
          'div',
          { class: 'preview-image' },
          h('img', { src: `data:${contentType};base64,${resp.body_base64}`, alt: '响应图片' })
        );
      }
    } else if (format === 'html') {
      content = h(
        'div',
        { class: 'preview-frame' },
        h('iframe', {
          sandbox: '',
          srcdoc: text,
          title: 'HTML 预览'
        })
      );
    } else {
      content = h(
        'div',
        { class: 'empty' },
        `该格式（${contentType || format}）不支持预览。可切换到「美化」或「原生」查看，或使用「下载」`
      );
    }
  } else if (view === 'visual') {
    const json = tryParseJson(text);
    content = json === undefined
      ? h('div', { class: 'empty' }, '该响应不是合法 JSON，无法可视化')
      : visualView(json);
  } else {
    // 美化
    if (format === 'json') {
      const json = tryParseJson(text);
      content = json === undefined
        ? h('pre', { class: 'code debug-body' }, text)
        : h('div', { class: 'json-tree' }, jsonTreeView(json));
    } else if (format === 'xml' || format === 'html') {
      content = h('pre', { class: 'code debug-body' }, prettyMarkup(text));
    } else {
      content = h('pre', { class: 'code debug-body' }, text);
    }
  }

  return h('div', { class: 'response-body-wrap' }, toolbar, h('div', { class: 'response-body-content' }, content));
}

/* 响应面板由 workspace.js 的 responsePane() 提供，不再在此维护 */

/* ---------------- 复制为 cURL ---------------- */

const CURL_DIALECT_KEY = 'apipost_curl_dialect';
const CURL_DIALECT_OPTIONS = [
  ['auto', '跟随系统'],
  ['cmd', 'CMD'],
  ['bash', 'Bash']
];

/** 读取用户选择的格式（auto 表示按系统判断） */
function getCurlDialectSetting() {
  try {
    const saved = localStorage.getItem(CURL_DIALECT_KEY);
    if (saved === 'cmd' || saved === 'bash' || saved === 'auto') return saved;
  } catch {}
  return 'auto';
}

function setCurlDialect(value) {
  try {
    localStorage.setItem(CURL_DIALECT_KEY, value === 'cmd' || value === 'bash' ? value : 'auto');
  } catch {}
}

/** 把请求详情拼成 cURL 并复制 */
async function copyAsCurl(req) {
  if (!req) {
    toast('没有可复制的请求', true);
    return;
  }
  const builder = window.CurlBuild;
  if (!builder) {
    toast('cURL 生成器未加载，请刷新页面', true);
    return;
  }

  const setting = getCurlDialectSetting();
  const dialect = setting === 'auto' ? builder.defaultDialect() : setting;
  const { text, warnings } = builder.buildCurl(req, { dialect });

  const res = await copyText(text);
  if (!res.ok) {
    toastCopyFailed(res.error);
    return;
  }
  if (warnings.length > 0) toast(`已复制为 cURL（${warnings[0]}）`);
  else toast(`已复制为 cURL（${dialect === 'cmd' ? 'CMD' : 'Bash'}）`);
}

/* ---------------- 生成代码片段 ---------------- */

/** 弹窗展示所选语言的调用代码，可一键复制 */
function openCodeSnippet(req) {
  const gen = window.CodeGen;
  if (!gen) {
    toast('代码生成器未加载，请刷新页面', true);
    return;
  }
  if (!req) {
    toast('没有可用的请求详情', true);
    return;
  }

  // 记住上次选的语言，下次打开还是它
  let lang = 'curl';
  try {
    const saved = localStorage.getItem('apipost_codegen_lang');
    if (saved && gen.LANGUAGES.some(([k]) => k === saved)) lang = saved;
  } catch {}

  const codeHost = h('pre', { class: 'code-snippet' });
  const warnHost = h('div', { class: 'form-hint' });
  let current = '';

  const render = () => {
    let result;
    try {
      result = gen.buildSnippet(req, { lang });
    } catch (err) {
      result = { code: `// 生成失败：${err.message}`, warnings: [] };
    }
    current = result.code;
    codeHost.textContent = result.code || '// 没有可生成的代码';
    warnHost.textContent = (result.warnings || []).join(' · ');
  };

  const langSelect = h(
    'select',
    {
      onchange: (e) => {
        lang = e.target.value;
        try {
          localStorage.setItem('apipost_codegen_lang', lang);
        } catch {}
        render();
      }
    },
    ...gen.LANGUAGES.map(([key, label]) =>
      h('option', { value: key, ...(key === lang ? { selected: true } : {}) }, label)
    )
  );

  render();

  const body = h(
    'div',
    { class: 'codegen-body' },
    h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, '语言'), h('div', { class: 'form-control' }, langSelect)),
    codeHost,
    warnHost,
    h('div', { class: 'form-hint' }, '请求里的 {{变量}} 会原样保留，不会被解析成实际值。')
  );

  showModal('生成代码', body, [
    h('button', { onclick: closeModal }, '关闭'),
    h(
      'button',
      {
        class: 'primary',
        onclick: async () => {
          const res = await copyText(current);
          if (res.ok) toast('已复制代码');
          else toastCopyFailed(res.error);
        }
      },
      '复制代码'
    )
  ]);
}

function tryParseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/* ---------------- 模式页签 ---------------- */

const MODES = [
  ['design', '设计'],
  ['debug', '调试'],
  ['case', '接口用例'],
  ['stress', '一键压测'],
  ['mock', 'Mock']
];

const PLACEHOLDER_INFO = {
  stress: {
    title: '一键压测',
    desc: '对该接口发起并发压测，统计成功率与响应耗时分布。',
    items: ['并发数与压测轮次/时长配置', '成功率、平均耗时', 'P50 / P90 / P99 分位统计']
  },
  mock: {
    title: 'Mock',
    desc: '基于接口响应结构生成 Mock 服务，供前端在真实接口未就绪时联调。',
    items: ['可视化定义返回数据结构', '按字段设置 Mock 规则', '触发条件与优先级']
  }
};

function placeholderPanel(mode) {
  const info = PLACEHOLDER_INFO[mode] || { title: mode, desc: '', items: [] };
  return h(
    'div',
    { class: 'placeholder-panel' },
    h('div', { class: 'placeholder-badge' }, '下一轮实现'),
    h('h3', { class: 'placeholder-title' }, info.title),
    h('p', { class: 'placeholder-desc' }, info.desc),
    h(
      'ul',
      { class: 'placeholder-list' },
      ...info.items.map((item) => h('li', {}, item))
    ),
    h('div', { class: 'hint mt16' }, '这一块的功能需求还需要你补充细节，确认后再实现。')
  );
}

/**
 * 主保存按钮 + 下拉（另存为 / 删除）。
 *
 * 原本挂在模式页签行右端，现下移到请求行右端（设计页是契约地址行），
 * 五种模式与文档/目录共用同一份实现。
 */
function saveSplit() {
  const hasSelection = Boolean(editor.selectedId);

  const mainBtn = h(
    'button',
    {
      class: 'save-main',
      disabled: !hasSelection,
      title: '保存（Ctrl+S）',
      onclick: () => Promise.resolve(saveActiveMode(window.__designRefresh)).catch((err) => toast(err.message, true))
    },
    saveButtonLabel()
  );

  const caret = h(
    'button',
    {
      class: 'save-caret',
      disabled: !hasSelection,
      title: '更多保存操作',
      onclick: (e) => {
        e.stopPropagation();
        toggleSaveMenu();
      }
    },
    '▾'
  );

  const split = h('div', { class: 'save-split' }, mainBtn, caret);

  let saveMenu = null;

  const closeSaveMenu = () => {
    if (!saveMenu) return;
    saveMenu.remove();
    saveMenu = null;
    document.removeEventListener('click', closeSaveMenu, true);
  };

  const toggleSaveMenu = () => {
    if (saveMenu) {
      closeSaveMenu();
      return;
    }
    saveMenu = h(
      'div',
      { class: 'send-menu save-menu' },
      h(
        'div',
        {
          class: 'send-menu-item',
          onclick: () => {
            closeSaveMenu();
            openSaveAs(window.__designRefresh);
          }
        },
        '另存为'
      ),
      h(
        'div',
        {
          class: 'send-menu-item danger',
          onclick: async () => {
            closeSaveMenu();
            await removeTarget({
              target_id: editor.selectedId,
              target_type: editor.targetType,
              name: editor.data?.name || editor.selectedId
            });
          }
        },
        '删除'
      )
    );
    split.append(saveMenu);
    document.addEventListener('click', closeSaveMenu, true);
  };

  return split;
}

function modeTabs() {
  const active = editor.activeMode || 'design';
  // 文档与目录只保留「设计」：调试/用例/压测/Mock 对它们无意义
  const nonApi = editor.targetType === 'doc' || editor.targetType === 'folder';
  const visible = nonApi ? MODES.filter(([key]) => key === 'design') : MODES;

  return h(
    'div',
    { class: 'mode-tabs' },
    ...visible.map(([key, label]) =>
      h(
        'div',
        {
          class: `mode-tab${active === key ? ' active' : ''}`,
          onclick: () => {
            if (editor.activeMode === key) return;
            editor.activeMode = key;
            // 保存按钮跟着请求行/契约行重建，rerenderPane 会整体刷新
            rerenderPane();
          }
        },
        label
      )
    ),
    h('span', { class: 'spacer-flex' }),
    h(
      'span',
      { id: 'dirty-badge', class: 'tag warn', style: hasUnsaved() ? '' : 'display:none' },
      dirtyBadgeText()
    ),
    // curl 导入固定在页签行右端；保存按钮已下移到请求行（设计页在契约地址行）
    h(
      'button',
      {
        class: 'small curl-import-btn',
        title: '粘贴 curl 命令自动填 URL、Header、Body',
        onclick: () => openCurlImport()
      },
      'curl 导入'
    )
  );
}

/* ---------------- Markdown 渲染（零依赖轻量实现） ---------------- */

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内语法：代码 > 粗体 > 斜体 > 删除线 > 链接 */
function renderInline(text) {
  let out = escapeHtml(text);

  // 行内代码优先，用占位符保护避免被后续规则处理
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000C${codes.length}\u0000`;
    codes.push(`<code>${code}</code>`);
    return token;
  });

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" />')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  for (let i = 0; i < codes.length; i += 1) {
    out = out.split(`\u0000C${i}\u0000`).join(codes[i]);
  }
  return out;
}

/** 把 Markdown 转成 HTML（覆盖常用语法） */
function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;

  const isBlank = (s) => !String(s).trim();

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2];
      const buf = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      html.push(
        `<pre class="md-code"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`
      );
      continue;
    }

    // 标题
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 分割线
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      html.push('<hr />');
      i += 1;
      continue;
    }

    // 引用
    if (/^\s{0,3}>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${markdownToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // 列表（有序 / 无序）
    const ulMatch = line.match(/^\s{0,3}[-*+]\s+(.*)$/);
    const olMatch = line.match(/^\s{0,3}(\d+)\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch);
      const items = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = ordered ? cur.match(/^\s{0,3}(\d+)\.\s+(.*)$/) : cur.match(/^\s{0,3}[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(renderInline(ordered ? m[2] : m[1]));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((t) => `<li>${t}</li>`).join('')}</${tag}>`);
      continue;
    }

    // 表格
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const parseRow = (row) =>
        row
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && /\|/.test(lines[i]) && !isBlank(lines[i])) {
        bodyRows.push(parseRow(lines[i]));
        i += 1;
      }
      html.push(
        `<table class="md-table"><thead><tr>${header
          .map((h) => `<th>${renderInline(h)}</th>`)
          .join('')}</tr></thead><tbody>${bodyRows
          .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      );
      continue;
    }

    // 普通段落（连续行合并）
    if (!isBlank(line)) {
      const buf = [line];
      i += 1;
      while (i < lines.length && !isBlank(lines[i]) && !/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|~~~)/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      html.push(`<p>${renderInline(buf.join(' '))}</p>`);
      continue;
    }

    i += 1;
  }

  return html.join('\n');
}

/* ---------------- 文档编辑器 ---------------- */

function docEditor() {
  const d = editor.data;
  if (typeof d.content !== 'string') d.content = '';

  const folderOptions = [['0', '根目录']];
  for (const f of folderOptionsWithDepth()) {
    folderOptions.push([f.id, `${'　'.repeat(f.depth)}${f.name}`]);
  }

  const previewHost = h('div', { class: 'doc-preview' });
  const renderPreview = () => {
    previewHost.innerHTML = markdownToHtml(d.content);
  };
  renderPreview();

  const source = h('textarea', {
    class: 'mono-input doc-source',
    rows: 20,
    placeholder: '# 文档标题\n\n支持 Markdown：标题、粗体、列表、代码块、表格、链接…',
    oninput: (e) => {
      d.content = e.target.value;
      markDirty();
      renderPreview();
    }
  }, d.content);

  return h(
    'div',
    { class: 'doc-editor' },
    h(
      'div',
      { class: 'form-grid' },
      field(
        '名称',
        input(d.name, (v) => {
          d.name = v;
          markDirty();
        }, { placeholder: '文档标题' })
      ),
      field(
        '所属目录',
        select(folderOptions, String(d.parent_id || '0'), (v) => {
          d.parent_id = v;
          markDirty();
        })
      )
    ),
    h(
      'div',
      { class: 'doc-split mt16' },
      h(
        'div',
        { class: 'doc-col' },
        h('div', { class: 'doc-col-head' }, 'Markdown 源码'),
        source
      ),
      h(
        'div',
        { class: 'doc-col' },
        h('div', { class: 'doc-col-head' }, '预览'),
        previewHost
      )
    ),
    h(
      'div',
      { class: 'btn-row mt16' },
      h('button', { class: 'primary small', onclick: () => saveCurrent(window.__designRefresh).catch((err) => toast(err.message, true)) }, '保存'),
      h('span', { class: 'hint' }, 'Ctrl+S 也可保存')
    )
  );
}

/* ---------------- 目录：基础 / 参数 / Body / 鉴权 / 脚本 ---------------- */

const FOLDER_TABS = [
  ['basic', '目录设置'],
  ['params', '目录参数'],
  ['list', '接口列表']
];

/** 目录可用服务：来自「环境与变量」页维护的项目共享服务 */
let folderServerCache = null;

async function loadFolderServers() {
  if (!editor.projectId) return [];
  try {
    const res = await api.get(`/projects/${editor.projectId}/servers`);
    folderServerCache = res.servers || [];
  } catch {
    folderServerCache = [];
  }
  return folderServerCache;
}

function folderView() {
  const d = editor.data;
  d.request = d.request || defaultRequest();
  if (!Array.isArray(d.request.header?.parameter)) {
    d.request.header = { parameter: [] };
  }
  const activeTab = editor.folderTab || 'basic';

  const folderOptions = [['0', '根目录']];
  for (const f of folderOptionsWithDepth()) {
    if (f.id === editor.selectedId) continue;
    folderOptions.push([f.id, `${'　'.repeat(f.depth)}${f.name}`]);
  }

  const childCount = editor.apiIndex.filter((i) => i.parent_id === editor.selectedId).length;
  const servers = folderServerCache || [];

  const basicPane = h(
    'div',
    {},
    h(
      'div',
      { class: 'form-grid' },
      field(
        '名称',
        input(d.name, (v) => {
          d.name = v;
          markDirty();
        }, { placeholder: '目录名称' })
      ),
      field(
        '所属目录',
        select(folderOptions, String(d.parent_id || '0'), (v) => {
          d.parent_id = v;
          markDirty();
        })
      ),
      field(
        '服务（前置 URL）',
        select(
          [['0', '跟随环境默认服务']].concat(
            servers.map((s) => [String(s.server_id), s.name || s.server_id])
          ),
          String(d.server_id || '0'),
          (v) => {
            d.server_id = v;
            markDirty();
          }
        ),
        servers.length > 0
          ? '该目录下的接口会使用所选服务在各环境的地址'
          : '项目还没有其他服务，可到「环境与变量 → 环境」里新增'
      )
    ),
    h(
      'div',
      { class: 'form-row full mt12' },
      h('label', { class: 'form-label' }, '描述'),
      h(
        'div',
        { class: 'form-control' },
        textarea(d.description || '', (v) => {
          d.description = v;
          markDirty();
        }, { rows: 3, mono: false, placeholder: '目录用途说明' })
      )
    ),
    h(
      'div',
      { class: 'hint mt12' },
      `该目录下有 ${childCount} 个子项。「参数 / Body / 鉴权 / 脚本」会被其下所有接口继承，接口自身的同名配置优先。`
    )
  );

  const folderChildren = editor.apiIndex.filter(
    (i) => String(i.parent_id || '0') === String(editor.selectedId)
  );

  const listPane = h(
    'div',
    { class: 'folder-api-list' },
    folderChildren.length === 0
      ? h('div', { class: 'empty' }, '该目录下还没有内容')
      : h(
          'div',
          { class: 'folder-api-rows' },
          ...folderChildren.map((item) =>
            h(
              'div',
              {
                class: 'folder-api-row',
                onclick: () => {
                  if (hasUnsaved() && !confirm('当前对象有未保存的修改，确定切换？')) return;
                  loadApi(editor.projectId, item.target_id)
                    .then(() => {
                      editor.activeMode = item.target_type === 'folder' ? 'design' : 'design';
                      rerenderTree();
                      rerenderPane();
                    })
                    .catch((err) => toast(err.message, true));
                }
              },
              h('span', { class: 'tree-icon' }, nodeIcon(item)),
              item.method ? h('span', { class: `method ${String(item.method).toUpperCase()}` }, item.method) : null,
              h('span', { class: 'folder-api-name' }, item.name || item.target_id),
              h('span', { class: 'hint mono folder-api-url' }, item.url || '')
            )
          )
        )
  );

  const panes = {
    basic: basicPane,
    params: tabParams(d.request, markDirty, { sections: ['query', 'restful', 'header'] }),
    list: listPane
  };

  return h(
    'div',
    { class: 'folder-view' },
    h(
      'div',
      { class: 'tabs tabs-sm folder-tabs' },
      ...FOLDER_TABS.map(([key, label]) =>
        h(
          'button',
          {
            class: `tab${activeTab === key ? ' active' : ''}`,
            onclick: () => {
              if (activeTab === key) return;
              editor.folderTab = key;
              rerenderPane();
            }
          },
          label
        )
      )
    ),
    h('div', { class: 'folder-pane' }, panes[activeTab] || basicPane),
    h(
      'div',
      { class: 'btn-row mt16' },
      h('button', { class: 'primary small', onclick: () => saveCurrent(window.__designRefresh).catch((err) => toast(err.message, true)) }, '保存'),
      h('button', { class: 'small', onclick: () => openCreateDialog('api', () => refreshDesign()) }, '+ 在此目录新建接口')
    )
  );
}

function buildPane() {
  const d = ensureShape(editor.data);
  if (!d) return h('div', { class: 'empty' }, '请选择左侧接口');

  const mode = editor.activeMode || 'design';

  // 暴露给 workspace.js / extra.js 的桥接
  window.__designState = editor;
  window.__designApi = api;
  window.__designRerender = () => rerenderPane();
  window.__designMarkDirty = (scope) => markDirty(scope);
  window.__designMarkClean = (scope) => markClean(scope);
  window.__designIsDirty = (scope) => isDirty(scope);
  window.__designHasUnsaved = () => hasUnsaved();
  window.__designSave = () => saveCurrent(window.__designRefresh);
  window.__designSaveActive = () => saveActiveMode(window.__designRefresh);

  // 文档：专属 Markdown 编辑器（不显示接口的模式页签）
  if (editor.targetType === 'doc') {
    return h(
      'div',
      { class: 'editor-inner' },
      modeTabs(),
      h('div', { class: 'editor-body' }, docEditor())
    );
  }

  // 目录：简化界面（名称/目录/描述）
  if (editor.targetType === 'folder') {
    return h(
      'div',
      { class: 'editor-inner' },
      modeTabs(),
      h('div', { class: 'editor-body' }, folderView())
    );
  }

  // 设计页：契约定义视图（单栏，不发送）
  if (mode === 'design') return designPane(d);

  // 调试页：请求构建区 + 常驻响应区（左右分栏，可发送）
  if (mode === 'debug') {
    if (window.ApiWorkspace) return window.ApiWorkspace.shell(d);
    return h('div', { class: 'empty' }, '工作区脚本未加载，请刷新页面');
  }

  // 用例 / 压测 / Mock 面板
  let panel;
  if (mode === 'case') panel = window.ApiExtra ? window.ApiExtra.cases() : placeholderPanel(mode);
  else if (mode === 'stress') panel = window.ApiExtra ? window.ApiExtra.stress() : placeholderPanel(mode);
  else if (mode === 'mock') panel = window.ApiExtra ? window.ApiExtra.mock() : placeholderPanel(mode);
  else panel = placeholderPanel(mode);

  return h(
    'div',
    { class: 'editor-inner' },
    modeTabs(),
    mode === 'case' ? null : requestBar({ readonly: true }),
    panel
  );
}

/* ---------------- 设计页：契约视图 ---------------- */

/**
 * 契约参数表：与调试页的 paramTable 不同，这里面向「接口文档」而非「发送」。
 * 列：参数名 | 类型 | 必填 | 示例值 | 描述
 *
 * 示例值写 example_value，与实际发送用的 value 分开，
 * 避免在设计页改示例值时悄悄改变调试页真正发出去的内容。
 */
function contractTable(list, onChange, { addLabel = '添加参数' } = {}) {
  const host = h('div', { class: 'param-table contract-table' });

  const commit = () => onChange(list.map((p) => ({ ...p })));

  const render = () => {
    const nodes = [];

    nodes.push(
      h(
        'div',
        { class: 'param-head contract-head' },
        h('span', {}),
        h('span', {}, '参数名'),
        h('span', {}, '类型'),
        h('span', {}, '必填'),
        h('span', {}, '示例值'),
        h('span', {}, '描述'),
        h('span', {})
      )
    );

    list.forEach((p, index) => {
      nodes.push(
        h(
          'div',
          { class: 'param-row contract-row' },
          h('input', {
            type: 'checkbox',
            title: '参与接口文档',
            checked: Number(p.is_checked) !== -1,
            onchange: (e) => {
              p.is_checked = e.target.checked ? 1 : -1;
              commit();
            }
          }),
          h('input', {
            type: 'text',
            class: 'mono-input',
            placeholder: '参数名',
            value: p.key ?? '',
            oninput: (e) => {
              p.key = e.target.value;
              commit();
            }
          }),
          select(
            FIELD_TYPES.map((t) => [t, t]),
            p.field_type || 'String',
            (v) => {
              p.field_type = v;
              commit();
            },
            { class: 'param-type' }
          ),
          h(
            'label',
            { class: 'check contract-required', title: '必填字段会写入 OpenAPI 的 required' },
            h('input', {
              type: 'checkbox',
              checked: Number(p.not_null) === 1,
              onchange: (e) => {
                p.not_null = e.target.checked ? 1 : -1;
                commit();
              }
            })
          ),
          h('input', {
            type: 'text',
            class: 'mono-input',
            placeholder: '示例值',
            value: p.example_value ?? '',
            oninput: (e) => {
              p.example_value = e.target.value;
              commit();
            }
          }),
          h('input', {
            type: 'text',
            placeholder: '说明',
            value: p.description ?? '',
            oninput: (e) => {
              p.description = e.target.value;
              commit();
            }
          }),
          h(
            'button',
            {
              class: 'small danger',
              title: '删除',
              onclick: () => {
                list.splice(index, 1);
                commit();
                render();
              }
            },
            '×'
          )
        )
      );
    });

    if (list.length === 0) {
      nodes.push(h('div', { class: 'param-empty' }, '暂无参数'));
    }

    nodes.push(
      h(
        'button',
        {
          class: 'small param-add',
          onclick: () => {
            list.push(newParam({ example_value: '' }));
            commit();
            render();
          }
        },
        `+ ${addLabel}`
      )
    );

    host.replaceChildren(...nodes);
  };

  render();
  return host;
}

/** 契约参数小节：标题 + 计数 + 批量编辑入口 + 表格 */
function contractSection(title, holder, onChange = markDirty) {
  if (!holder) return null;
  if (!Array.isArray(holder.parameter)) holder.parameter = [];
  return h(
    'div',
    { class: 'param-section' },
    h(
      'div',
      { class: 'param-section-title' },
      title,
      h('span', { class: 'tab-badge' }, holder.parameter.length),
      h(
        'button',
        {
          class: 'small param-bulk-btn',
          title: '按文本批量导入参数',
          onclick: () => openBulkEdit(holder.parameter, onChange, title)
        },
        '批量编辑'
      )
    ),
    contractTable(holder.parameter, (next) => {
      holder.parameter = next;
      onChange();
    })
  );
}

/** 设计页：契约定义视图（单栏，不发送） */
function designPane(d) {
  const req = d.request || defaultRequest();
  const resp = d.response || {};

  const examples = Array.isArray(resp.example) ? resp.example : [];
  const mainExample = examples.find((e) => Number(e?.expect?.is_default) === 1) || examples[0] || null;
  const expect = mainExample?.expect || null;
  const schema = expect?.schema;
  const schemaText = schema && Object.keys(schema).length > 0 ? JSON.stringify(schema, null, 2) : '';

  return h(
    'div',
    { class: 'editor-inner design-contract' },
    modeTabs(),
    metaBar(),
    contractRequestLine(d),
    h(
      'div',
      { class: 'contract-body' },
      contractSection('Header 参数', req.header),
      contractSection('Query 参数', req.query),
      contractSection('Path 参数', req.restful),
      contractSection('Cookie 参数', req.cookie),
      h(
        'div',
        { class: 'param-section' },
        h('div', { class: 'param-section-title' }, 'Body', h('span', { class: 'tab-badge' }, String(req.body?.mode || 'none'))),
        tabBody(req.body)
      ),
      h(
        'div',
        { class: 'param-section' },
        h(
          'div',
          { class: 'param-section-title' },
          '响应结构',
          h(
            'span',
            { class: 'tab-badge' },
            `${expect?.code || '-'} · ${expect?.content_type || 'json'}`
          )
        ),
        h(
          'div',
          { class: 'contract-response' },
          h(
            'div',
            { class: 'kv-block' },
            h('div', { class: 'kv-block-title' }, '状态码与类型'),
            h(
              'div',
              { class: 'kv' },
              h('span', { class: 'k' }, '期望状态码'),
              h('span', { class: 'v mono' }, String(expect?.code || '未设置')),
              h('span', { class: 'k' }, 'Content-Type'),
              h('span', { class: 'v mono' }, String(expect?.content_type || '未设置')),
              h('span', { class: 'k' }, '校验方式'),
              h('span', { class: 'v mono' }, String(expect?.verify_type || 'schema'))
            )
          ),
          h(
            'div',
            { class: 'kv-block mt16' },
            h(
              'div',
              { class: 'kv-block-title' },
              '数据结构（JSON Schema）',
              hasSchemaContent(schema)
                ? h('span', { class: 'tag info' }, '已配置')
                : h('span', { class: 'hint' }, '未配置')
            ),
            schemaText
              ? h(
                  'div',
                  { class: 'form-control' },
                  textarea(schemaText, () => {}, { rows: 12, readonly: true, toolbar: 'json' })
                )
              : h(
                  'div',
                  { class: 'form-hint' },
                  '没有配置响应结构。可到「调试 → 响应示例」里编辑，或用「由上方响应体反推」生成。'
                )
          )
        )
      )
    ),
    h(
      'div',
      { class: 'form-hint mt16' },
      '设计页只定义契约，不会发送请求。要实际调用接口请切到「调试」。'
    )
  );
}

/** 设计页顶部的地址行：只读展示，不提供发送按钮，右端承载保存按钮 */
function contractRequestLine(d) {
  return h(
    'div',
    { class: 'contract-addr' },
    h('span', { class: `method ${String(d.method || 'GET').toUpperCase()}` }, String(d.method || 'GET').toUpperCase()),
    h('code', { class: 'mono contract-url' }, d.url || '（未填写 URL）'),
    h('span', { class: 'hint' }, d.protocol || 'http/1.1'),
    saveSplit()
  );
}

/* ---------------- 参数批量编辑弹窗 ---------------- */

const BULK_FORMATS = [
  ['kv', 'Key-Value 格式'],
  ['json', 'Raw-Json 格式'],
  ['desc', '带描述']
];

const BULK_NAMING = [
  ['keep', '保持原样'],
  ['camel', '小驼峰'],
  ['snake', '下划线'],
  ['upper', '全大写']
];

/** 命名风格转换 */
function applyNaming(name, style) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const words = raw
    .replace(/[_\-\s]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean);
  if (style === 'camel') {
    return words
      .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join('');
  }
  if (style === 'snake') return words.map((w) => w.toLowerCase()).join('_');
  if (style === 'upper') return words.map((w) => w.toUpperCase()).join('_');
  return raw;
}

/**
 * 解析批量编辑文本。
 * @param {string} text
 * @param {'kv'|'json'|'desc'} format
 * @returns {{ok: boolean, params?: Array, error?: string}}
 */
function parseBulkText(text, format) {
  const raw = String(text || '');

  if (format === 'json') {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, params: [] };
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return { ok: false, error: `JSON 解析失败：${err.message}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '需要是一个扁平 JSON 对象，例如 {"role":"Manager"}' };
    }
    const params = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && typeof value === 'object') {
        return { ok: false, error: `字段「${key}」是嵌套结构，请先拍平再导入` };
      }
      params.push({ key, value: value === null ? '' : String(value), description: '' });
    }
    return { ok: true, params };
  }

  const params = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const firstColon = trimmed.indexOf(':');
    if (firstColon < 0) {
      return { ok: false, error: `第 ${index + 1} 行缺少冒号，应为「参数名: 参数值」` };
    }
    const key = trimmed.slice(0, firstColon).trim();
    if (!key) return { ok: false, error: `第 ${index + 1} 行参数名为空` };

    const rest = trimmed.slice(firstColon + 1).trim();

    if (format === 'kv') {
      params.push({ key, value: rest, description: '' });
      continue;
    }

    // desc：参数名: 参数值: 描述
    const secondColon = rest.indexOf(':');
    if (secondColon < 0) {
      params.push({ key, value: rest, description: '' });
    } else {
      params.push({
        key,
        value: rest.slice(0, secondColon).trim(),
        description: rest.slice(secondColon + 1).trim()
      });
    }
  }
  return { ok: true, params };
}

/**
 * 批量编辑弹窗：左侧输入、右侧实时预览，底部命名风格与确定/取消。
 * 纯本地解析：不调用 AI，也不需要配置 API Key。
 */
function openBulkEdit(list, onChange, title = '参数') {
  const showModal = window.__consoleShowModal;
  const closeModal = window.__consoleCloseModal;
  if (!showModal) {
    toast('弹窗组件未加载', true);
    return;
  }

  const state = { format: 'kv', naming: 'keep' };

  const input = h('textarea', {
    class: 'mono-input bulk-edit-input',
    rows: 16,
    placeholder:
      '每行「参数名: 参数值」，空行与 # 开头的行会被忽略\n\n例如：\nrole: Manager\nname: apipost\nage: 23'
  });

  const previewHost = h('div', { class: 'bulk-edit-preview' });
  const namingSelect = select(BULK_NAMING, state.naming, (v) => {
    state.naming = v;
    renderPreview();
  }, { class: 'tb-select' });

  const formatTabs = h('div', { class: 'tabs tabs-sm bulk-edit-tabs' });

  const renderFormatTabs = () => {
    formatTabs.replaceChildren(
      ...BULK_FORMATS.map(([key, label]) =>
        h(
          'div',
          {
            class: `tab${state.format === key ? ' active' : ''}`,
            onclick: () => {
              state.format = key;
              input.placeholder =
                key === 'json'
                  ? '扁平 JSON 对象，例如：\n{\n  "role": "Manager",\n  "name": "apipost",\n  "age": 23\n}'
                  : key === 'desc'
                    ? '每行「参数名: 参数值: 描述」，例如：\nrole: Manager: 角色\nname: apipost: 名称'
                    : '每行「参数名: 参数值」，例如：\nrole: Manager\nname: apipost';
              renderFormatTabs();
              renderPreview();
            }
          },
          label
        )
      )
    );
  };

  let parsed = [];
  const renderPreview = () => {
    const result = parseBulkText(input.value, state.format);
    if (!result.ok) {
      parsed = [];
      previewHost.replaceChildren(h('div', { class: 'form-hint err' }, result.error));
      return;
    }
    parsed = result.params.map((p) => ({ ...p, key: applyNaming(p.key, state.naming) }));

    if (parsed.length === 0) {
      previewHost.replaceChildren(h('div', { class: 'empty' }, "输入「参数名: 参数值」查看预览"));
      return;
    }

    previewHost.replaceChildren(
      h(
        'div',
        { class: 'bulk-preview-list' },
        h(
          'div',
          { class: 'bulk-preview-head' },
          h('span', {}, '参数名'),
          h('span', {}, '参数值'),
          h('span', {}, '描述')
        ),
        ...parsed.map((p) =>
          h(
            'div',
            { class: 'bulk-preview-row' },
            h('span', { class: 'mono' }, p.key),
            h('span', { class: 'mono' }, p.value),
            h('span', { class: 'hint' }, p.description || '')
          )
        ),
        h('div', { class: 'form-hint mt8' }, `共 ${parsed.length} 条`)
      )
    );
  };

  input.addEventListener('input', renderPreview);
  renderFormatTabs();
  renderPreview();

  const confirm = () => {
    if (parsed.length === 0) {
      toast('没有可导入的参数', true);
      return;
    }
    let added = 0;
    let updated = 0;
    for (const item of parsed) {
      const key = String(item.key || '').trim();
      if (!key) continue;
      const existing = list.find((p) => String(p.key || '').trim() === key);
      if (existing) {
        existing.value = item.value;
        if (item.description) existing.description = item.description;
        updated += 1;
      } else {
        list.push(newParam({ key, value: item.value, description: item.description || '' }));
        added += 1;
      }
    }
    onChange();
    closeModal();
    rerenderPane();
    toast(`已导入 ${added} 条${updated > 0 ? `，覆盖 ${updated} 条同名参数` : ''}`);
  };

  showModal(
    `批量编辑 · ${title}`,
    h(
      'div',
      { class: 'bulk-edit-body' },
      formatTabs,
      h(
        'div',
        { class: 'bulk-edit-split' },
        h('div', { class: 'bulk-edit-col' }, h('div', { class: 'bulk-edit-col-title' }, '输入'), input),
        h('div', { class: 'bulk-edit-col' }, h('div', { class: 'bulk-edit-col-title' }, '预览'), previewHost)
      ),
      h(
        'div',
        { class: 'bulk-edit-foot' },
        h('span', { class: 'hint' }, '命名方式'),
        namingSelect
      )
    ),
    [
      h('button', { onclick: () => closeModal() }, '取消'),
      h(
        'button',
        {
          onclick: async () => {
            const text = parsed.map((p) => `${p.key}: ${p.value}`).join('\n');
            const res = await copyText(text);
            if (res.ok) toast('已复制预览结果');
            else toastCopyFailed(res.error);
          }
        },
        '复制'
      ),
      h('button', { class: 'primary', onclick: confirm }, '确定')
    ]
  );

  input.focus();
}

/* ---------------- 响应示例面板（调试页页签） ---------------- */

/**
 * 响应示例：左侧「成功 / 失败」切换与编辑、新建期望，右侧导入/字段描述/美化/删除。
 * 工具条严格左右两栏对齐，是 Apipost 响应示例页的标志性布局。
 */
function responseExamplePane() {
  const d = ensureShape(editor.data);
  if (!d) return h('div', { class: 'empty' }, '请选择接口');

  const resp = d.response;
  if (!Array.isArray(resp.example)) resp.example = [];

  const host = h('div', { class: 'example-pane' });

  const render = () => {
    const list = resp.example;
    const activeIndex = Math.min(
      Math.max(0, Number(editor.exampleIndex) || 0),
      Math.max(0, list.length - 1)
    );
    editor.exampleIndex = activeIndex;
    const current = list[activeIndex] || null;

    if (current) {
      current.expect = current.expect || {
        code: '200',
        name: '成功',
        is_default: list.length === 1 ? 1 : -1,
        verify_type: 'schema',
        content_type: 'json',
        schema: { type: 'object', properties: {} }
      };
    }

    const editing = Boolean(editor.exampleEditing);

    const switchTabs = h(
      'div',
      { class: 'seg-group example-switch' },
      ...list.map((ex, i) =>
        h(
          'button',
          {
            class: `seg${i === activeIndex ? ' active' : ''}`,
            onclick: () => {
              editor.exampleIndex = i;
              editor.exampleEditing = false;
              render();
            }
          },
          (ex.expect && ex.expect.name) || `示例${i + 1}`
        )
      )
    );

    const leftTools = h(
      'div',
      { class: 'example-tools-left' },
      switchTabs,
      list.length > 0
        ? h(
            'button',
            {
              class: 'small',
              onclick: () => {
                editor.exampleEditing = !editing;
                render();
              }
            },
            editing ? '完成' : '编辑'
          )
        : null,
      h(
        'button',
        {
          class: 'small primary',
          onclick: () => {
            resp.example.push({
              example_id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
              expect: {
                code: '200',
                name: `示例${list.length + 1}`,
                is_default: list.length === 0 ? 1 : -1,
                verify_type: 'schema',
                content_type: 'json',
                schema: { type: 'object', properties: {} }
              },
              raw: '',
              raw_parameter: []
            });
            editor.exampleIndex = resp.example.length - 1;
            editor.exampleEditing = true;
            markDirty();
            render();
          }
        },
        '+ 新建期望'
      )
    );

    const live = window.ApiWorkspace?.getResponse(editor.selectedId);
    const liveBody = live?.response?.body || '';

    const rightTools = h(
      'div',
      { class: 'example-tools-right' },
      h(
        'button',
        {
          class: 'small',
          disabled: !current || !liveBody,
          title: liveBody ? '把上一次响应的响应体写入当前示例' : '还没有可导入的响应，请先到「实时响应」发送一次',
          onclick: () => {
            if (!current) return;
            current.raw = liveBody;
            markDirty();
            render();
            toast('已从现有响应导入');
          }
        },
        '从现有响应导入'
      ),
      h(
        'button',
        {
          class: 'small',
          disabled: !current,
          title: '根据示例响应体反推 JSON Schema',
          onclick: () => {
            if (!current) return;
            const parsed = (() => {
              try {
                return JSON.parse(current.raw || '{}');
              } catch {
                return null;
              }
            })();
            const schema = window.CurlParse?.jsonToSchema?.(parsed);
            if (!schema) {
              toast('示例响应体不是合法 JSON，无法反推结构', true);
              return;
            }
            current.expect.schema = schema;
            current.raw_schema = schema;
            current.raw_parameter = window.CurlParse?.schemaToParameters?.(schema) || [];
            markDirty();
            render();
            toast('已生成字段描述');
          }
        },
        '字段描述'
      ),
      h(
        'button',
        {
          class: 'small',
          disabled: !current,
          onclick: () => {
            const text = String(current?.raw || '').trim();
            if (!text) {
              toast('示例响应体为空', true);
              return;
            }
            try {
              current.raw = JSON.stringify(JSON.parse(text), null, 2);
              markDirty();
              render();
            } catch (err) {
              toast(`JSON 格式错误：${err.message}`, true);
            }
          }
        },
        '美化'
      ),
      h(
        'button',
        {
          class: 'small danger',
          disabled: !current,
          onclick: () => {
            if (!current) return;
            if (!confirm(`删除示例「${current.expect?.name || ''}」？`)) return;
            resp.example.splice(activeIndex, 1);
            editor.exampleIndex = 0;
            editor.exampleEditing = false;
            markDirty();
            render();
          }
        },
        '删除'
      )
    );

    const toolbar = h('div', { class: 'example-toolbar' }, leftTools, h('span', { class: 'spacer' }), rightTools);

    const editorArea = !current
      ? h('div', { class: 'empty' }, '还没有响应示例，点「+ 新建期望」开始定义')
      : editing
        ? h(
            'div',
            { class: 'example-editor' },
            h(
              'div',
              { class: 'example-meta' },
              h('span', { class: 'hint' }, '名称'),
              input(current.expect.name || '', (v) => {
                current.expect.name = v;
                markDirty();
              }, { placeholder: '示例名称' }),
              h('span', { class: 'hint' }, '状态码'),
              input(String(current.expect.code ?? '200'), (v) => {
                current.expect.code = v;
                markDirty();
              }, { placeholder: '200' }),
              h('span', { class: 'hint' }, 'Content-Type'),
              select(RESP_CONTENT_TYPES, current.expect.content_type || 'json', (v) => {
                current.expect.content_type = v;
                markDirty();
              }, { class: 'tb-select' }),
              h(
                'label',
                { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: Number(current.expect.is_default) === 1,
                  onchange: (e) => {
                    resp.example.forEach((other) => {
                      other.expect = other.expect || {};
                      other.expect.is_default = -1;
                    });
                    current.expect.is_default = e.target.checked ? 1 : -1;
                    markDirty();
                  }
                }),
                '默认期望'
              )
            ),
            textarea(current.raw ?? '', (v) => {
              current.raw = v;
              markDirty();
            }, { rows: 16, placeholder: '{\n  "code": 0,\n  "msg": "ok"\n}', toolbar: 'json' }),
            h(
              'details',
              { class: 'example-advanced' },
              h('summary', {}, '详细配置（校验方式 / 数据结构 / 响应头）'),
              h(
                'div',
                { class: 'form-grid mt12' },
                field('校验方式', select(VERIFY_TYPES, current.expect.verify_type || 'schema', (v) => {
                  current.expect.verify_type = v;
                  markDirty();
                  render();
                }))
              ),
              current.expect.verify_type === 'schema'
                ? h(
                    'div',
                    { class: 'mt12' },
                    h('div', { class: 'form-label' }, '数据结构（JSON Schema）'),
                    textarea(
                      JSON.stringify(current.expect.schema || {}, null, 2),
                      (v) => {
                        try {
                          const parsed = JSON.parse(v || '{}');
                          current.expect.schema = parsed;
                          current.raw_schema = parsed;
                          current.raw_parameter = window.CurlParse?.schemaToParameters?.(parsed) || [];
                          markDirty();
                        } catch {}
                      },
                      { rows: 12, toolbar: 'json' }
                    )
                  )
                : null,
              h(
                'div',
                { class: 'mt12' },
                h('div', { class: 'form-label' }, '响应头校验'),
                expectHeadersEditor(current, () => {
                  markDirty();
                  render();
                })
              )
            )
          )
        : h(
            'div',
            { class: 'example-view' },
            current.raw
              ? h('pre', { class: 'code' }, current.raw)
              : h('div', { class: 'empty' }, '示例响应体为空，点「编辑」填写')
          );

    host.replaceChildren(toolbar, editorArea);
  };

  render();
  return host;
}



/**
 * 统一的操作结果提示。
 * @param {'create'|'update'|'delete'|'saveAs'|'import'|'doc'} action
 * @param {string} name 对象名称
 * @param {number} [count] import 时的数量
 */
function notifyAction(action, name, count) {
  const label = String(name || '');
  let text;
  switch (action) {
    case 'create':
      text = `已新建「${label}」`;
      break;
    case 'update':
      text = `已保存「${label}」`;
      break;
    case 'doc':
      text = `已保存文档「${label}」`;
      break;
    case 'delete':
      text = `已删除「${label}」`;
      break;
    case 'saveAs':
      text = `已另存为「${label}」`;
      break;
    case 'import':
      text = `已导入 ${count ?? 1} 个接口`;
      break;
    default:
      text = '已保存';
  }
  toast(text);
}

/* ---------------- 编辑器头部工具条 ---------------- */

/** 保存设计域（按钮与 Ctrl+S 共用） */
async function saveCurrent(onRefresh) {
  if (!editor.selectedId || !editor.data) {
    toast('没有可保存的内容', true);
    return false;
  }
  // preserve_aux：只提交设计字段，避免用旧快照覆盖已保存的 cases / mock
  const payload = { data: editor.data, preserve_aux: true };
  await api.put(`/projects/${editor.projectId}/apis/${editor.selectedId}`, payload);
  resetDirty('design');
  await loadTree(editor.projectId);
  // 重新加载以同步 version 等字段；keepAux 保住用例 / Mock 面板的内存草稿
  await loadApi(editor.projectId, editor.selectedId, { keepAux: true });
  // 保存后 tab 上的名称 / 方法 / 脏点都要跟着更新
  snapshotActiveTab();
  renderTabBar();
  rerenderTree();
  rerenderPane();
  const tb = document.querySelector('.editor-toolbar');
  if (tb) tb.replaceWith(editorToolbar(onRefresh));
    notifyAction('update', editor.data?.name || editor.selectedId);
  if (onRefresh) onRefresh();
  return true;
}

/** 按当前页签决定保存哪一块（设计 / 用例 / Mock） */
async function saveActiveMode(onRefresh) {
  const mode = editor.activeMode || 'design';
  if (mode === 'case') {
    return window.ApiExtra?.saveCase?.();
  }
  if (mode === 'mock') {
    return window.ApiExtra?.saveMock?.();
  }
  if (mode === 'stress') {
    toast('压测配置无需保存');
    return false;
  }
  return saveCurrent(onRefresh);
}

/* ---------------- Ctrl+S ---------------- */

function bindSaveShortcut(refreshFn) {
  unbindSaveShortcut();
  window.__designRefresh = refreshFn;
  window.__designSaveHandler = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (String(e.key).toLowerCase() !== 's') return;
    // 弹窗打开时不拦截，避免影响弹窗内操作
    if (document.querySelector('.modal-mask')) return;
    e.preventDefault();
    e.stopPropagation();
    Promise.resolve(saveActiveMode(window.__designRefresh)).catch((err) => toast(err.message, true));
  };
  window.addEventListener('keydown', window.__designSaveHandler, true);
}

function unbindSaveShortcut() {
  if (window.__designSaveHandler) {
    window.removeEventListener('keydown', window.__designSaveHandler, true);
    window.__designSaveHandler = null;
  }
}

/* ---------------- 另存为 ---------------- */

/** 把扁平接口索引按层级整理成带缩进的文件夹选项 */
function folderOptionsWithDepth() {
  const folders = editor.apiIndex.filter((i) => i.target_type === 'folder');
  const byParent = new Map();
  for (const f of folders) {
    const pid = f.parent_id || '0';
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(f);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  const out = [];
  const walk = (parentId, depth) => {
    for (const f of byParent.get(parentId) || []) {
      out.push({ id: f.target_id, name: f.name || f.target_id, depth });
      walk(f.target_id, depth + 1);
    }
  };
  walk('0', 0);
  return out;
}

/* ---------------- 新建（弹窗表单） ---------------- */

const CREATE_META = {
  api: { title: '新建接口', defaultName: '新接口', placeholder: '接口名称' },
  folder: { title: '新建目录', defaultName: '新目录', placeholder: '目录名称' },
  doc: { title: '新建文档', defaultName: '新文档', placeholder: '文档名称' }
};

/** 统一的「新建后跳转」：刷新树、选中新对象、回到接口工作区并重绘 */
async function focusTarget(targetId, onRefresh) {
  await loadTree(editor.projectId);
  await loadApi(editor.projectId, targetId);
  // 回到接口工作区（避免停在压测/Mock/期望）
  editor.activeMode = 'design';
  editor.activeTab = editor.targetType === 'doc' ? 'doc' : 'basic';
  editor.wsTab = 'header';
  rerenderTree();
  rerenderPane();
  const tb = document.querySelector('.editor-toolbar');
  if (tb) tb.replaceWith(editorToolbar(onRefresh));
  if (onRefresh) onRefresh();
}

function openCreateDialog(type, onRefresh, { parentId } = {}) {
  const showModal = window.__consoleShowModal;
  const closeModal = window.__consoleCloseModal;
  if (!showModal) {
    toast('弹窗组件未加载', true);
    return;
  }

  // 没有项目时无处落地，直接引导去新建项目
  if (!editor.projectId) {
    toast('请先在「总览」页新建项目', true);
    return;
  }

  const meta = CREATE_META[type];
  if (!meta) return;

  const state = {
    name: meta.defaultName,
    parentId: parentId != null
      ? String(parentId)
      : (() => {
          // 当前选中目录时默认建在其下
          return editor.targetType === 'folder' && editor.selectedId ? editor.selectedId : '0';
        })(),
    keyword: ''
  };

  const nameInput = h('input', {
    type: 'text',
    value: state.name,
    placeholder: meta.placeholder,
    oninput: (e) => {
      state.name = e.target.value;
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    }
  });

  const searchInput = h('input', {
    type: 'text',
    placeholder: '请输入',
    oninput: (e) => {
      state.keyword = e.target.value.trim().toLowerCase();
      renderFolderList();
    }
  });

  const folderListHost = h('div', { class: 'folder-list' });
  const folders = folderOptionsWithDepth();

  const renderFolderList = () => {
    const nodes = [];
    const addOption = (id, label, depth) => {
      const active = String(state.parentId) === String(id);
      nodes.push(
        h(
          'div',
          {
            class: `folder-option${active ? ' active' : ''}`,
            style: `padding-left:${10 + depth * 16}px`,
            onclick: () => {
              state.parentId = String(id);
              renderFolderList();
            }
          },
          h('span', { class: 'folder-icon' }, id === '0' ? '🏠' : '📁'),
          h('span', { class: 'folder-name' }, label)
        )
      );
    };

    if (!state.keyword || '根目录'.includes(state.keyword)) addOption('0', '根目录', 0);
    for (const f of folders) {
      if (state.keyword && !String(f.name).toLowerCase().includes(state.keyword)) continue;
      addOption(f.id, f.name, f.depth + 1);
    }

    if (nodes.length === 0) {
      nodes.push(h('div', { class: 'empty', style: 'padding:12px' }, '没有匹配的目录'));
    }
    folderListHost.replaceChildren(...nodes);
  };
  renderFolderList();

  const submit = async () => {
    const name = String(state.name || '').trim();
    if (!name) {
      toast('名称不能为空', true);
      return;
    }
    try {
      const created = await api.post(`/projects/${editor.projectId}/apis`, {
        name,
        target_type: type,
        method: type === 'api' ? 'GET' : undefined,
        url: type === 'api' ? '' : undefined,
        parent_id: state.parentId
      });
      closeModal();
      await focusTarget(created.target_id, onRefresh);
      notifyAction('create', name);
    } catch (err) {
      toast(`创建失败：${err.message}`, true);
    }
  };

  const body = h(
    'div',
    { class: 'saveas-form' },
    h('div', { class: 'saveas-field' }, h('label', { class: 'form-label' }, '名称'), nameInput),
    h(
      'div',
      { class: 'saveas-field' },
      h('label', { class: 'form-label' }, '所属目录'),
      searchInput,
      folderListHost
    ),
    h('div', { class: 'hint' }, type === 'api' ? '创建后可继续配置参数、Body、鉴权等。' : type === 'doc' ? '创建后进入 Markdown 编辑器。' : '创建后可继续在其中新建接口或目录。')
  );

  showModal(meta.title, body, [h('button', { onclick: closeModal }, '取消'), h('button', { class: 'primary', onclick: submit }, '创建')]);
  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  }, 60);
}

function openSaveAs(onRefresh) {
  const showModal = window.__consoleShowModal;
  const closeModal = window.__consoleCloseModal;
  if (!showModal) {
    toast('弹窗组件未加载', true);
    return;
  }
  if (!editor.data) {
    toast('请先选择一个接口', true);
    return;
  }

  const sourceName = editor.data.name || '未命名';
  const isFolder = editor.targetType === 'folder';
  const isDoc = editor.targetType === 'doc';

  const state = {
    name: `${sourceName} 副本`,
    parentId: String(editor.data.parent_id || '0'),
    keyword: ''
  };

  const nameInput = h('input', {
    type: 'text',
    value: state.name,
    placeholder: '新名称',
    oninput: (e) => {
      state.name = e.target.value;
    }
  });

  const searchInput = h('input', {
    type: 'text',
    placeholder: '请输入',
    oninput: (e) => {
      state.keyword = e.target.value.trim().toLowerCase();
      renderFolderList();
    }
  });

  const folderListHost = h('div', { class: 'folder-list' });
  const folders = folderOptionsWithDepth();

  const renderFolderList = () => {
    const nodes = [];

    const addOption = (id, label, depth) => {
      const active = String(state.parentId) === String(id);
      nodes.push(
        h(
          'div',
          {
            class: `folder-option${active ? ' active' : ''}`,
            style: `padding-left:${10 + depth * 16}px`,
            onclick: () => {
              state.parentId = String(id);
              renderFolderList();
            }
          },
          h('span', { class: 'folder-icon' }, depth === 0 && id === '0' ? '🏠' : '📁'),
          h('span', { class: 'folder-name' }, label)
        )
      );
    };

    // 根目录始终显示
    if (!state.keyword || '根目录'.includes(state.keyword) || 'root'.includes(state.keyword)) {
      addOption('0', '根目录', 0);
    }

    for (const f of folders) {
      if (state.keyword && !String(f.name).toLowerCase().includes(state.keyword)) continue;
      addOption(f.id, f.name, f.depth + 1);
    }

    if (nodes.length === 0) {
      nodes.push(h('div', { class: 'empty', style: 'padding:12px' }, '没有匹配的目录'));
    }
    folderListHost.replaceChildren(...nodes);
  };

  renderFolderList();

  const doSaveAs = h(
    'button',
    {
      class: 'primary',
      onclick: async () => {
        const name = String(state.name || '').trim();
        if (!name) {
          toast('名称不能为空', true);
          return;
        }
        try {
          // 1. 建壳
          const created = await api.post(`/projects/${editor.projectId}/apis`, {
            name,
            target_type: editor.targetType,
            method: editor.data.method || 'GET',
            url: editor.data.url || '',
            parent_id: state.parentId
          });

          // 2. 拉取源接口最新 data，避免把过期快照里的用例 / Mock 复制到副本
          let latest = editor.data;
          try {
            const fresh = await api.get(`/projects/${editor.projectId}/apis/${editor.selectedId}`);
            if (fresh?.data) latest = fresh.data;
          } catch {}
          const payload = deepClone(latest);
          payload.name = name;
          payload.parent_id = state.parentId;
          payload.target_id = created.target_id;
          await api.put(`/projects/${editor.projectId}/apis/${created.target_id}`, { data: payload });

          closeModal();
          await loadTree(editor.projectId);
          await loadApi(editor.projectId, created.target_id);
          rerenderTree();
          rerenderPane();
          const tb = document.querySelector('.editor-toolbar');
          if (tb) tb.replaceWith(editorToolbar(onRefresh));
          if (onRefresh) onRefresh();
          notifyAction('saveAs', name);
        } catch (err) {
          toast(`另存为失败：${err.message}`, true);
        }
      }
    },
    '确定另存'
  );

  const body = h(
    'div',
    { class: 'saveas-form' },
    h(
      'div',
      { class: 'saveas-field' },
      h('label', { class: 'form-label' }, '名称'),
      nameInput
    ),
    h(
      'div',
      { class: 'saveas-field' },
      h('label', { class: 'form-label' }, '目标文件夹'),
      searchInput,
      folderListHost
    ),
    h(
      'div',
      { class: 'hint' },
      isFolder
        ? '另存目录只复制目录本身，不含其下的子接口。'
        : isDoc
          ? '另存文档会复制标题与内容。'
          : '原接口保持不变，将创建一份新的接口（含参数、Body、脚本、鉴权与响应示例）。'
    )
  );

  showModal(`另存为 · ${sourceName}`, body, [h('button', { onclick: closeModal }, '取消'), doSaveAs]);
  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  }, 60);
}

/** 工具条徽标文案：按域拼「未保存 / 用例未保存 / Mock 未保存」 */
function dirtyBadgeText() {
  const parts = [];
  if (editor.dirty) parts.push(DIRTY_LABELS.design);
  if (editor.caseDirty) parts.push(DIRTY_LABELS.case);
  if (editor.mockDirty) parts.push(DIRTY_LABELS.mock);
  return parts.join(' · ') || DIRTY_LABELS.design;
}

/** 保存按钮文案跟随当前页签 */
function saveButtonLabel() {
  const mode = editor.activeMode || 'design';
  if (mode === 'case') return '保存用例';
  if (mode === 'mock') return '保存 Mock';
  return '保存';
}

/**
 * 「+ 新建」分组菜单：2 列卡片 + 导入区。
 * 只把仓库真实支持的项做成可用；其余置灰并在 title 里写明原因。
 */
const NEW_MENU_ITEMS = [
  [
    { label: 'HTTP', kind: 'api', icon: 'H', color: 'red' },
    { label: 'Event Stream', icon: 'S', color: 'blue', disabled: true, reason: 'SSE 目前只有类型占位，尚无编辑器与执行层' },
    { label: 'WebSocket', icon: 'W', color: 'yellow', disabled: true, reason: 'WebSocket 协议尚未实现' },
    { label: 'Socket.IO', icon: 'IO', color: 'green', disabled: true, reason: 'Socket.IO 协议尚未实现' },
    { label: 'gRPC', icon: 'g', color: 'orange', beta: true, disabled: true, reason: 'gRPC 协议尚未实现' },
    { label: 'GraphQL', icon: 'G', color: 'pink', beta: true, disabled: true, reason: 'GraphQL 协议尚未实现' },
    { label: 'TCP 客户端', icon: 'T', color: 'teal', disabled: true, reason: 'TCP 客户端尚未实现' },
    { label: 'Markdown', kind: 'doc', icon: 'M', color: 'blue' }
  ]
];

const IMPORT_MENU_ITEMS = [
  { label: 'AI 智能提取', action: 'ai', icon: 'AI', color: 'purple' },
  { label: 'cURL 导入', action: 'curl', icon: 'c', color: 'orange' },
  { label: '粘贴接口/文本', action: 'paste', icon: 'P', color: 'yellow' },
  { label: 'IDEA 上传', action: 'idea', icon: 'IDEA', color: 'blue', disabled: true, reason: 'IDEA 插件上传需要配套插件，暂不支持' }
];

function newMenuCard(item, onRefresh) {
  const disabled = Boolean(item.disabled);
  return h(
    'button',
    {
      class: `new-menu-card${disabled ? ' disabled' : ''}`,
      title: disabled ? item.reason : `新建${item.label}`,
      'aria-disabled': disabled ? 'true' : 'false',
      onclick: (e) => {
        e.stopPropagation();
        if (disabled) {
          toast(item.reason, true);
          return;
        }
        closeNewMenu();
        if (item.kind) openCreateDialog(item.kind, onRefresh);
        else if (item.action === 'curl') openCurlImport();
        else if (item.action === 'paste') openPasteImport({ target_id: '0', name: '根目录' });
        else if (item.action === 'ai') openAiDraftDialog(onRefresh);
      }
    },
    h('span', { class: `new-menu-icon c-${item.color || 'gray'}` }, item.icon || '?'),
    h('span', { class: 'new-menu-label' }, item.label),
    item.beta ? h('span', { class: 'new-menu-beta' }, 'Beta') : null
  );
}

let newMenuEl = null;

function closeNewMenu() {
  if (newMenuEl) {
    newMenuEl.remove();
    newMenuEl = null;
    document.removeEventListener('click', closeNewMenu, true);
  }
}

function openNewMenu(anchor, onRefresh) {
  closeNewMenu();
  const panel = h(
    'div',
    { class: 'new-menu' },
    h('div', { class: 'new-menu-group-title' }, '新建'),
    h(
      'div',
      { class: 'new-menu-grid' },
      ...NEW_MENU_ITEMS[0].map((item) => newMenuCard(item, onRefresh))
    ),
    h(
      'button',
      {
        class: 'new-menu-card full',
        onclick: (e) => {
          e.stopPropagation();
          closeNewMenu();
          openCreateDialog('folder', onRefresh);
        }
      },
      h('span', { class: 'new-menu-icon c-purple' }, 'D'),
      h('span', { class: 'new-menu-label' }, '目录')
    ),
    h('div', { class: 'new-menu-sep' }),
    h('div', { class: 'new-menu-group-title' }, '导入'),
    h(
      'div',
      { class: 'new-menu-grid' },
      ...IMPORT_MENU_ITEMS.map((item) => newMenuCard(item, onRefresh))
    )
  );

  newMenuEl = panel;
  document.body.append(panel);

  const rect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - panelRect.width - 8);

  // 默认向下弹；下方放不下（例如按钮固定在侧栏底部）就翻到上方
  let top = rect.bottom + 4;
  if (top + panelRect.height + 8 > window.innerHeight) {
    top = rect.top - panelRect.height - 4;
  }
  top = Math.min(top, window.innerHeight - panelRect.height - 8);

  panel.style.left = `${Math.max(4, left)}px`;
  panel.style.top = `${Math.max(4, top)}px`;

  setTimeout(() => document.addEventListener('click', closeNewMenu, true), 0);
}

/**
 * 顶部工具栏：只放「新建类」入口。
 * 保存 / 另存为 / 删除已经下移到请求行右端（saveSplit，设计页在契约地址行），
 * 因为它们与当前编辑对象强相关，跟着请求走比放在顶部更顺手。
 */
function editorToolbar(onRefresh) {
  // 没有任何项目时，新建接口/目录/文档都无处可落，直接禁用并给出引导
  const noProject = !editor.projectId;

  const newBtn = h(
    'button',
    {
      class: 'small primary',
      disabled: noProject,
      title: noProject ? '请先在「总览」页新建项目' : '新建或导入',
      onclick: (e) => {
        e.stopPropagation();
        openNewMenu(newBtn, onRefresh);
      }
    },
    '+ 新建'
  );

  return h(
    'div',
    { class: 'editor-toolbar' },
    newBtn,
    h(
      'button',
      {
        class: 'small',
        disabled: noProject,
        title: noProject ? '请先在「总览」页新建项目' : '用一句话描述，让 AI 起草接口定义',
        onclick: () => openAiDraftDialog(onRefresh)
      },
      '✦ AI 起草接口'
    )
  );
}

/* ---------------- AI 起草接口 ---------------- */

/**
 * 一句话需求 -> 预览 -> 落库为新接口。
 * 生成结果先预览，用户确认后才真正创建，避免 AI 幻觉直接污染项目数据。
 */
function openAiDraftDialog(onRefresh) {
  if (!editor.projectId) {
    toast('请先在「总览」页新建项目', true);
    return;
  }

  const descInput = h('textarea', {
    rows: 3,
    class: 'mono-input',
    placeholder: '例如：用户登录接口，手机号 + 密码，返回 token 与用户信息',
    oninput: () => {}
  });

  const previewHost = h('div', { class: 'ai-draft-preview' }, h('div', { class: 'empty' }, '填写需求后点「生成」'));
  let draft = null;

  const renderPreview = () => {
    if (!draft) {
      previewHost.replaceChildren(h('div', { class: 'empty' }, '填写需求后点「生成」'));
      return;
    }
    const rows = [
      ['名称', draft.name],
      ['方法', draft.method],
      ['URL', draft.url]
    ];
    const nodes = rows.map(([k, v]) =>
      h('div', { class: 'kv-line' }, h('span', { class: 'k' }, k), h('span', { class: 'v mono' }, String(v || '-')))
    );

    if (draft.query?.length) {
      nodes.push(h('div', { class: 'kv-line' }, h('span', { class: 'k' }, 'Query'), h('span', { class: 'v' }, draft.query.map((p) => p.key).join(', '))));
    }
    if (draft.headers?.length) {
      nodes.push(h('div', { class: 'kv-line' }, h('span', { class: 'k' }, 'Header'), h('span', { class: 'v' }, draft.headers.map((p) => p.key).join(', '))));
    }
    if (draft.body_mode && draft.body_mode !== 'none') {
      nodes.push(
        h('div', { class: 'kv-line' },
          h('span', { class: 'k' }, `Body(${draft.body_mode})`),
          h('pre', { class: 'code-snippet', style: 'max-height:160px;margin:6px 0 0' }, draft.body_raw || '')
        )
      );
    }
    if (draft.description) {
      nodes.push(h('div', { class: 'kv-line' }, h('span', { class: 'k' }, '说明'), h('span', { class: 'v' }, draft.description)));
    }
    if (draft.notes?.length) {
      nodes.push(h('div', { class: 'form-hint mt8' }, `待确认：${draft.notes.join('；')}`));
    }
    previewHost.replaceChildren(...nodes);
  };

  const generateBtn = h('button', {
    class: 'primary',
    onclick: async () => {
      const description = String(descInput.value || '').trim();
      if (!description) {
        toast('请先描述需求', true);
        return;
      }
      generateBtn.disabled = true;
      generateBtn.textContent = '生成中…';
      try {
        const res = await api.post('/ai/draft-api', { project_id: editor.projectId, description });
        draft = res.draft;
        renderPreview();
      } catch (err) {
        toast(err.message, true);
        previewHost.replaceChildren(h('div', { class: 'debug-error' }, err.message));
      } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = '重新生成';
      }
    }
  });

  const createBtn = h('button', {
    class: 'primary',
    onclick: async () => {
      if (!draft) {
        toast('请先生成接口草案', true);
        return;
      }
      try {
        // 1. 建壳（拿到 target_id）
        const created = await api.post(`/projects/${editor.projectId}/apis`, {
          name: draft.name,
          target_type: 'api',
          method: draft.method,
          url: draft.url,
          parent_id: '0'
        });

        // 2. 拉一版默认 data，再把 AI 的字段填进去（保持结构完整）
        const fresh = await api.get(`/projects/${editor.projectId}/apis/${created.target_id}`);
        const data = deepClone(fresh.data || {});
        data.name = draft.name;
        data.method = draft.method;
        data.url = draft.url;
        data.description = draft.description || '';
        data.request = data.request || defaultRequest();
        data.request.query = { ...(data.request.query || {}), parameter: draft.query || [], query_add_equal: 1 };
        data.request.header = { ...(data.request.header || {}), parameter: draft.headers || [] };
        data.request.body = {
          ...(data.request.body || defaultRequest().body),
          mode: draft.body_mode || 'none',
          raw: draft.body_raw || ''
        };
        if (draft.response_raw) {
          data.response = data.response || { example: [], is_check_result: 1 };
          data.response.example = [
            {
              example_id: `${Date.now().toString(16)}`,
              expect: {
                code: '200',
                content_type: 'json',
                is_default: 1,
                name: '成功',
                schema: { type: 'object', properties: {} },
                verify_type: 'schema'
              },
              raw: draft.response_raw,
              raw_parameter: []
            }
          ];
        }
        await api.put(`/projects/${editor.projectId}/apis/${created.target_id}`, { data });

        closeModal();
        await focusTarget(created.target_id, onRefresh);
        notifyAction('create', draft.name);
      } catch (err) {
        toast(`创建失败：${err.message}`, true);
      }
    }
  });

  const body = h(
    'div',
    { class: 'ai-draft-body' },
    h('div', { class: 'form-row' },
      h('label', { class: 'form-label' }, '需求'),
      h('div', { class: 'form-control' }, descInput, h('div', { class: 'form-hint' }, '一句话描述接口用途即可，AI 会补全方法、URL、参数与响应示例'))
    ),
    h('div', { class: 'row-gap mt12' }, generateBtn),
    previewHost
  );

  showModal('AI 起草接口', body, [h('button', { onclick: closeModal }, '取消'), createBtn]);
  setTimeout(() => descInput.focus(), 60);
}

/* ---------------- 树 ---------------- */

/** 节点展示名：接口优先 name，兜底 url / target_id */
function nodeLabel(node) {
  return node.name || node.url || node.target_id;
}

function nodeIcon(node) {
  if (node.target_type === 'folder') return '📁';
  if (node.target_type === 'doc') return '📄';
  if (node.target_type === 'sse') return '📡';
  return '';
}

/**
 * 按关键词过滤树：保留命中的节点与其祖先链。
 * 命中时不折叠（强制展开），否则用户会以为搜不到。
 * @returns {Array} 过滤后的节点数组（不修改原树）
 */
function filterTree(nodes, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return nodes;

  const hit = (node) => {
    const fields = [node.name, node.url, node.method, node.target_id];
    return fields.some((f) => String(f || '').toLowerCase().includes(kw));
  };

  const walk = (list) => {
    const out = [];
    for (const node of list) {
      const children = node.children?.length ? walk(node.children) : [];
      if (hit(node) || children.length > 0) {
        out.push({ ...node, children });
      }
    }
    return out;
  };
  return walk(nodes);
}

/** 判断 candidateId 是否是 ancestorId 自己或它的子孙（拖拽时防止把目录拖进自己） */
function isSelfOrDescendant(candidateId, ancestorId) {
  if (String(candidateId) === String(ancestorId)) return true;
  let changed = true;
  const set = new Set([String(ancestorId)]);
  const items = editor.apiIndex || [];
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parent_id && set.has(String(item.parent_id)) && !set.has(String(item.target_id))) {
        set.add(String(item.target_id));
        changed = true;
      }
    }
  }
  return set.has(String(candidateId));
}

function renderTreeNodes(nodes, depth = 0) {
  const out = [];
  const keyword = editor.treeKeyword || '';

  for (const node of nodes) {
    const indent = 10 + depth * 14;
    const hasChildren = Boolean(node.children?.length);
    const collapsed = !keyword && editor.collapsed.has(String(node.target_id));
    const label = nodeLabel(node);

    const caret = hasChildren
      ? h('span', {
          class: `tree-caret${collapsed ? ' collapsed' : ''}`,
          onclick: (e) => {
            e.stopPropagation();
            const id = String(node.target_id);
            if (editor.collapsed.has(id)) editor.collapsed.delete(id);
            else editor.collapsed.add(id);
            rerenderTree();
          }
        }, '▾')
      : h('span', { class: 'tree-caret tree-caret-empty' });

    const row = h(
      'div',
      {
        class: `tree-row${editor.selectedId === node.target_id ? ' active' : ''}`,
        style: `padding-left:${indent}px`,
        draggable: 'true',
        'data-id': node.target_id,
        'data-type': node.target_type,
        title: node.url ? `${label}\n${node.url}` : label,
        onclick: async () => {
          // 打开到新标签页（已打开则激活），无需因未保存而阻拦——每个 tab 各自保留草稿
          try {
            await openTab(editor.projectId, node.target_id);
            rerenderTree();
            rerenderPane();
          } catch (err) {
            toast(err.message, true);
          }
        },
        ondblclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          startInlineRename(row, node);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openTreeContextMenu(e, node);
        },
        ondragstart: (e) => {
          treeDrag.sourceId = String(node.target_id);
          treeDrag.sourceType = node.target_type;
          row.classList.add('dragging');
          try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', node.target_id);
          } catch {}
        },
        ondragend: () => {
          row.classList.remove('dragging');
          clearTreeDropMarks();
          treeDrag.sourceId = null;
          treeDrag.sourceType = null;
        },
        ondragover: (e) => {
          if (!treeDrag.sourceId || treeDrag.sourceId === String(node.target_id)) return;
          // 目录不能拖进自己或自己的子孙里
          if (isSelfOrDescendant(treeDrag.sourceId, node.target_id)) {
            e.preventDefault();
            clearTreeDropMarks();
            row.classList.add('drop-forbidden');
            return;
          }
          e.preventDefault();
          try {
            e.dataTransfer.dropEffect = 'move';
          } catch {}
          const zone = dropZone(e, row, node);
          clearTreeDropMarks();
          row.classList.add(zone === 'child' ? 'drop-child' : zone === 'before' ? 'drop-before' : 'drop-after');
        },
        ondragleave: () => {
          row.classList.remove('drop-child', 'drop-before', 'drop-after', 'drop-forbidden');
        },
        ondrop: async (e) => {
          e.preventDefault();
          const zone = dropZone(e, row, node);
          clearTreeDropMarks();
          const sourceId = treeDrag.sourceId;
          treeDrag.sourceId = null;
          treeDrag.sourceType = null;
          if (!sourceId || sourceId === String(node.target_id)) return;
          await moveTreeNode(sourceId, node, zone);
        }
      },
      caret,
      h('span', { class: 'tree-icon' }, nodeIcon(node)),
      node.method ? h('span', { class: `method ${node.method}` }, node.method) : null,
      h('span', { class: 'tree-name' }, label)
    );

    out.push(row);

    if (hasChildren && !collapsed) {
      out.push(...renderTreeNodes(node.children, depth + 1));
    }
  }
  return out;
}

/* ---------------- 树：拖拽排序 ---------------- */

const treeDrag = { sourceId: null, sourceType: null };

function clearTreeDropMarks() {
  document
    .querySelectorAll('.tree-row.drop-child, .tree-row.drop-before, .tree-row.drop-after, .tree-row.drop-forbidden, .tree-row.dragging')
    .forEach((n) => n.classList.remove('drop-child', 'drop-before', 'drop-after', 'drop-forbidden', 'dragging'));
}

/** 落点判定：上 1/4 = 插到前面，下 1/4 = 插到后面，中间 = 放进目录 */
function dropZone(e, row, node) {
  const rect = row.getBoundingClientRect();
  const ratio = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
  if (node.target_type === 'folder') {
    if (ratio < 0.25) return 'before';
    if (ratio > 0.75) return 'after';
    return 'child';
  }
  return ratio < 0.5 ? 'before' : 'after';
}

/** 同层相邻两项之间插入：取两侧 sort 的中点 */
function midpointSort(targetNode, zone) {
  const siblings = (editor.apiIndex || [])
    .filter((i) => String(i.parent_id || '0') === String(targetNode.parent_id || '0'))
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

  const idx = siblings.findIndex((i) => String(i.target_id) === String(targetNode.target_id));
  const targetSort = Number(targetNode.sort ?? siblings[idx]?.sort ?? 1000);

  if (zone === 'before') {
    const prev = idx > 0 ? Number(siblings[idx - 1].sort ?? 0) : targetSort - 2000;
    return Math.floor((prev + targetSort) / 2);
  }
  const next = idx >= 0 && idx < siblings.length - 1 ? Number(siblings[idx + 1].sort ?? 0) : targetSort + 2000;
  return Math.floor((targetSort + next) / 2);
}

/** 目标目录下最后一个子项的 sort，用于「拖进目录」时排到末尾 */
function lastChildSort(folderId) {
  const children = (editor.apiIndex || []).filter((i) => String(i.parent_id || '0') === String(folderId));
  if (children.length === 0) return 1000;
  return Math.max(...children.map((c) => Number(c.sort ?? 0))) + 1000;
}

/**
 * 把一个节点移动到目标位置。
 * @param {'before'|'after'|'child'} zone
 */
async function moveTreeNode(sourceId, targetNode, zone) {
  if (isSelfOrDescendant(sourceId, targetNode.target_id)) {
    toast('不能把目录移动到它自己或其子目录里', true);
    return;
  }
  const patch =
    zone === 'child'
      ? { target_id: sourceId, parent_id: String(targetNode.target_id), sort: lastChildSort(targetNode.target_id) }
      : {
          target_id: sourceId,
          parent_id: String(targetNode.parent_id || '0'),
          sort: midpointSort(targetNode, zone)
        };

  try {
    await api.post(`/projects/${editor.projectId}/apis/reorder`, { items: [patch] });
    await loadTree(editor.projectId);
    rerenderTree();
  } catch (err) {
    toast(`移动失败：${err.message}`, true);
  }
}

/* ---------------- 树：右键菜单 ---------------- */

let ctxMenu = null;

function closeContextMenu() {
  if (!ctxMenu) return;
  ctxMenu.remove();
  ctxMenu = null;
  document.removeEventListener('click', closeContextMenu, true);
  document.removeEventListener('keydown', onCtxKeydown, true);
  window.removeEventListener('resize', closeContextMenu);
  window.removeEventListener('scroll', closeContextMenu, true);
}

function onCtxKeydown(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeContextMenu();
  }
}

/**
 * 通用右键菜单底座：任意位置、任意菜单项。
 * 调用方只负责拼 items（ctxMenuItem / ctxSubMenu），定位与关闭逻辑都在这里。
 */
function openContextMenu(x, y, items) {
  closeContextMenu();

  const node = h('div', { class: 'ctx-menu' }, ...items);
  ctxMenu = node;
  document.body.append(node);

  // 视口内收边，避免贴边被裁掉
  const rect = node.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  node.style.left = `${Math.max(4, left)}px`;
  node.style.top = `${Math.max(4, top)}px`;

  // 右侧放不下子菜单时整体左翻，否则二级菜单会被挤出视口
  if (rect.width > 0 && x + rect.width + 150 > window.innerWidth) {
    node.classList.add('ctx-menu-flip');
  }

  document.addEventListener('click', closeContextMenu, true);
  document.addEventListener('keydown', onCtxKeydown, true);
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('scroll', closeContextMenu, true);
  return node;
}

/** 右键菜单图标（16px 线框 SVG，与 Apipost 风格一致） */
const CTX_ICONS = {
  open: 'M3 4h4l1.5 2H13v8H3z',
  rename: 'M11 2l3 3-8 8H3v-3z',
  copy: 'M6 2h6v2H6zM4 6h8v8H4z',
  clone: 'M6 2h6v2H6zM4 6h8v8H4zM10 0v2',
  paste: 'M5 2h6v3H5zM4 5h8v9H4z',
  run: 'M4 2l9 6-9 6z',
  share: 'M3 8v6h10V8M8 1v8M5 4l3-3 3 3',
  curl: 'M2 4l4 4-4 4M8 12h6',
  openapi: 'M3 3h4v4H3zM9 3h4v4H9zM6 9h4v4H6z',
  branch: 'M4 3v10M4 8h5a3 3 0 003-3V3',
  move: 'M2 6h4v6H2zM9 3h5v5',
  edit: 'M11 2l3 3-8 8H3v-3z',
  trash: 'M3 5h10M5 5V3h6v2M4 5l1 9h6l1-9',
  close: 'M4 4l8 8M12 4l-8 8',
  right: 'M6 3l5 5-5 5',
  save: 'M3 3h8l2 2v8H3zM6 3v4h4V3M6 13v-3h4v3'
};

function ctxIcon(name) {
  const path = CTX_ICONS[name];
  if (!path) return h('span', { class: 'ctx-menu-icon' });
  return h(
    'span',
    { class: 'ctx-menu-icon' },
    h(
      'svg',
      {
        viewBox: '0 0 16 16',
        width: '16',
        height: '16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.3',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round'
      },
      h('path', { d: path })
    )
  );
}

/**
 * 右键菜单项。
 * disabled 时只弹原因、不执行动作——避免「点了没反应」的困惑。
 */
function ctxMenuItem(label, onClick, { danger = false, hint = '', icon = '', disabled = false } = {}) {
  const cls = ['ctx-menu-item'];
  if (danger) cls.push('danger');
  if (disabled) cls.push('disabled');
  return h(
    'div',
    {
      class: cls.join(' '),
      title: hint,
      'aria-disabled': disabled ? 'true' : 'false',
      onclick: (e) => {
        e.stopPropagation();
        if (disabled) {
          toast(hint || `${label} 暂不可用`, true);
          return;
        }
        closeContextMenu();
        Promise.resolve(onClick()).catch((err) => toast(err.message, true));
      }
    },
    ctxIcon(icon),
    h('span', { class: 'ctx-menu-label' }, label)
  );
}

/** 带子菜单的菜单项（悬停展开）；disabled 时不展开、只弹原因 */
function ctxSubMenu(label, buildItems, { icon = '', itemsHost, disabled = false, hint = '' } = {}) {
  const node = h(
    'div',
    {
      class: `ctx-menu-item has-sub${disabled ? ' disabled' : ''}`,
      title: hint,
      'aria-disabled': disabled ? 'true' : 'false',
      onclick: (e) => {
        if (!disabled) return;
        e.stopPropagation();
        toast(hint || `${label} 暂不可用`, true);
      }
    },
    ctxIcon(icon),
    h('span', { class: 'ctx-menu-label' }, label),
    h('span', { class: 'ctx-menu-arrow' }, '▸')
  );
  if (disabled) return node;

  const host = itemsHost || h('div', { class: 'ctx-submenu' });
  node.append(host);
  node.addEventListener('mouseenter', () => {
    if (!host.childElementCount) host.append(...buildItems());
  });
  return node;
}

/** 「移动至」的目录选择列表 */
function moveTargets(node) {
  const items = [];
  items.push(
    ctxMenuItem('根目录', async () => {
      await applyMove(node, '0');
    }, { icon: 'move' })
  );
  for (const f of folderOptionsWithDepth()) {
    if (f.id === node.target_id) continue;
    if (node.target_type === 'folder' && isSelfOrDescendant(f.id, node.target_id)) continue;
    items.push(
      ctxMenuItem(f.name, async () => {
        await applyMove(node, f.id);
      }, { icon: 'move' })
    );
  }
  return items;
}

async function applyMove(node, targetParentId) {
  if (String(node.parent_id || '0') === String(targetParentId)) {
    toast('已经在目标位置');
    return;
  }
  await api.post(`/projects/${editor.projectId}/apis/reorder`, {
    items: [{ target_id: node.target_id, parent_id: String(targetParentId) }]
  });
  await loadTree(editor.projectId);
  rerenderTree();
  toast('已移动');
}

/**
 * 把接口定义合成 curl 需要的请求结构（不需要真实响应）。
 * @param {object} node 树节点
 * @param {object} [dataOverride] 显式指定的接口数据（非活动标签页用它的快照）
 */
function requestFromDefinition(node, dataOverride) {
  let data = dataOverride || null;
  if (!data && editor.selectedId === node.target_id) data = editor.data;
  data = data || {};
  const req = data.request || {};

  const headers = {};
  for (const p of req.header?.parameter || []) {
    if (!p || !p.key || Number(p.is_checked) === -1) continue;
    headers[p.key] = p.value ?? '';
  }

  const body = req.body || {};
  const mode = String(body.mode || 'none');
  const bodyText = mode === 'form-data' || mode === 'urlencoded' ? '' : String(body.raw || '');

  return {
    method: String(data.method || node.method || 'GET').toUpperCase(),
    url: String(data.url || node.url || ''),
    headers,
    body_mode: mode,
    body: bodyText
  };
}

function openTreeContextMenu(e, node) {
  closeContextMenu();
  const items = [];
  const isFolder = node.target_type === 'folder';
  const refresh = () => window.__designRefresh?.();

  if (isFolder) {
    // ---------- 目录菜单 ----------
    items.push(
      ctxSubMenu(
        '新建',
        () => [
          ctxMenuItem('接口', () => openCreateDialog('api', refresh, { parentId: node.target_id }), { icon: 'open' }),
          ctxMenuItem('目录', () => openCreateDialog('folder', refresh, { parentId: node.target_id }), { icon: 'open' }),
          ctxMenuItem('文档', () => openCreateDialog('doc', refresh, { parentId: node.target_id }), { icon: 'open' })
        ],
        { icon: 'copy' }
      )
    );
    items.push(
      ctxMenuItem('粘贴接口/文本', () => openPasteImport(node), { icon: 'paste' })
    );
    items.push(h('div', { class: 'ctx-menu-sep' }));
    items.push(
      ctxMenuItem('全部运行', () => runAllInFolder(node), { icon: 'run', hint: '串行执行该目录下全部接口' })
    );
    items.push(
      ctxSubMenu(
        '分享',
        () => [
          ctxMenuItem('复制文档链接', () => copyShareLink(node), { icon: 'share' }),
          ctxMenuItem('打开只读文档页', () => openSharePage(node), { icon: 'open' })
        ],
        { icon: 'share' }
      )
    );
    items.push(h('div', { class: 'ctx-menu-sep' }));
    items.push(ctxSubMenu('移动至', () => moveTargets(node), { icon: 'move' }));
    items.push(ctxMenuItem('复制', () => duplicateTarget(node), { icon: 'copy', hint: '仅复制目录自身，不含子内容' }));
    items.push(
      ctxMenuItem('编辑', () => {
        openNode(node);
      }, { icon: 'edit' })
    );
  } else {
    // ---------- 接口 / 文档菜单 ----------
    items.push(
      ctxSubMenu(
        '分享',
        () => [
          ctxMenuItem('复制文档链接', () => copyShareLink(node), { icon: 'share' }),
          ctxMenuItem('打开只读文档页', () => openSharePage(node), { icon: 'open' })
        ],
        { icon: 'share' }
      )
    );
    items.push(
      ctxSubMenu(
        '复制为 cURL',
        () => [
          ctxMenuItem('Bash', () => copyDefinitionAsCurl(node, 'bash'), { icon: 'curl' }),
          ctxMenuItem('CMD', () => copyDefinitionAsCurl(node, 'cmd'), { icon: 'curl' })
        ],
        { icon: 'curl' }
      )
    );
    items.push(
      ctxMenuItem('外部调用 OpenAPI', () => copyTargetOpenApi(node), {
        icon: 'openapi',
        disabled: node.target_type !== 'api',
        hint:
          node.target_type === 'api'
            ? '复制该接口的 OpenAPI 3 片段，可直接交给第三方或导入其他平台'
            : '只有接口能导出 OpenAPI 片段'
      })
    );
    items.push(h('div', { class: 'ctx-menu-sep' }));
    items.push(ctxSubMenu('移动至', () => moveTargets(node), { icon: 'move' }));
    items.push(ctxMenuItem('复制', () => duplicateTarget(node), { icon: 'copy', hint: '同目录生成一份副本' }));
    items.push(ctxMenuItem('克隆', () => cloneTarget(node), { icon: 'clone', hint: '连子内容一起深拷贝到根目录' }));
  }

  items.push(h('div', { class: 'ctx-menu-sep' }));
  items.push(
    ctxMenuItem('删除', () => removeTarget(node), {
      icon: 'trash',
      danger: true,
      hint: isFolder ? '目录会连同其下所有内容一起删除' : ''
    })
  );

  openContextMenu(e.clientX, e.clientY, items);
}

/* ---------------- 右键菜单动作 ---------------- */

/** 打开节点（右键菜单「编辑」与点击树行共用） */
async function openNode(node) {
  try {
    await openTab(editor.projectId, node.target_id);
    rerenderTree();
    rerenderPane();
  } catch (err) {
    toast(err.message, true);
  }
}

/** 粘贴接口/文本：解析后落到指定目录 */
function openPasteImport(node) {
  const showModal = window.__consoleShowModal;
  const closeModal = window.__consoleCloseModal;
  const CP = window.CurlParse;
  if (!showModal || !CP) {
    toast('导入组件未加载，请刷新页面', true);
    return;
  }

  const input = h('textarea', {
    class: 'mono-input curl-input',
    rows: 14,
    placeholder: '粘贴 cURL 命令，或「方法 + URL + 请求头」形式的接口文本'
  });
  const hintLine = h('div', { class: 'form-hint' }, '识别多条会分别创建');

  const submit = async () => {
    const text = input.value.trim();
    if (!text) {
      toast('请先粘贴内容', true);
      return;
    }
    let results = [];
    try {
      results = CP.parseAll(text, { dialect: 'auto' });
    } catch (err) {
      hintLine.textContent = `解析失败：${err.message}`;
      hintLine.className = 'form-hint err';
      return;
    }
    if (results.length === 0) {
      hintLine.textContent = '没有识别到可导入的接口';
      hintLine.className = 'form-hint err';
      return;
    }

    try {
      let ok = 0;
      for (const parsed of results) {
        const name = CP.suggestName(parsed);
        const created = await api.post(`/projects/${editor.projectId}/apis`, {
          name,
          target_type: 'api',
          method: parsed.method || 'GET',
          url: parsed.url || '',
          parent_id: String(node.target_id || '0')
        });
        const detail = await api.get(`/projects/${editor.projectId}/apis/${created.target_id}`);
        const data = detail.data.data;
        if (Array.isArray(parsed.headers)) data.request.header.parameter = parsed.headers;
        if (Array.isArray(parsed.query)) data.request.query.parameter = parsed.query;
        if (parsed.body_mode) {
          data.request.body = {
            ...(data.request.body || {}),
            mode: parsed.body_mode,
            raw: parsed.body_raw || '',
            parameter: parsed.body_params || []
          };
        }
        await api.put(`/projects/${editor.projectId}/apis/${created.target_id}`, { data });
        ok += 1;
      }
      closeModal();
      await loadTree(editor.projectId);
      rerenderTree();
      toast(`已导入 ${ok} 个接口`);
    } catch (err) {
      hintLine.textContent = err.message;
      hintLine.className = 'form-hint err';
    }
  };

  showModal(
    `粘贴接口/文本${node?.name ? ` → ${node.name}` : ''}`,
    h('div', { class: 'row-gap' }, input, hintLine),
    [h('button', { onclick: () => closeModal() }, '取消'), h('button', { class: 'primary', onclick: submit }, '导入')]
  );
  input.focus();
}

/** 全部运行：串行执行目录下全部接口，带进度与停止 */
async function runAllInFolder(node) {
  const children = editor.apiIndex.filter(
    (i) => String(i.parent_id || '0') === String(node.target_id) && i.target_type === 'api'
  );
  if (children.length === 0) {
    toast('该目录下没有接口', true);
    return;
  }
  if (!confirm(`将串行执行 ${children.length} 个接口，会发送真实请求。继续？`)) return;

  const state = { aborted: false };
  let ok = 0;
  const failed = [];

  const showModal = window.__consoleShowModal;
  const closeModal = window.__consoleCloseModal;

  const progress = h('div', { class: 'form-hint' }, `0 / ${children.length}`);
  const bar = h('div', { class: 'run-progress-track' }, h('div', { class: 'run-progress-bar' }));
  const stopBtn = h(
    'button',
    {
      class: 'small danger',
      onclick: () => {
        state.aborted = true;
        stopBtn.disabled = true;
        stopBtn.textContent = '正在停止…';
      }
    },
    '停止'
  );

  let modalOpen = true;
  const finish = () => {
    const summary = `成功 ${ok} / 失败 ${failed.length}`;
    if (modalOpen) closeModal();
    modalOpen = false;
    toast(`全部运行完成：${summary}`);
    if (failed.length > 0) {
      showModal(
        '执行结果',
        h(
          'div',
          { class: 'row-gap' },
          h('div', {}, summary),
          ...failed.map((f) => h('div', { class: 'diff-row' }, h('span', { class: 'tag err' }, '失败'), h('span', {}, f.name)))
        ),
        [h('button', { onclick: () => closeModal() }, '关闭')]
      );
    }
  };

  if (showModal) {
    showModal(
      `全部运行 · ${node.name || node.target_id}`,
      h('div', { class: 'row-gap' }, progress, bar, h('div', { class: 'btn-row' }, stopBtn)),
      [h('button', { onclick: () => { state.aborted = true; } }, '关闭')]
    );
  }

  for (let index = 0; index < children.length; index += 1) {
    if (state.aborted) break;
    const item = children[index];
    progress.textContent = `${index} / ${children.length} 正在执行：${item.name || item.target_id}`;
    bar.style.width = `${(index / children.length) * 100}%`;
    try {
      await api.post(`/projects/${editor.projectId}/apis/${item.target_id}/send`, {});
      ok += 1;
    } catch (err) {
      failed.push({ name: item.name || item.target_id, error: err.message });
    }
    bar.style.width = `${((index + 1) / children.length) * 100}%`;
    progress.textContent = `${index + 1} / ${children.length}`;
  }

  finish();
}

/** 克隆：整棵子树递归深拷贝到根目录 */
async function cloneTarget(node) {
  const copyName = `${nodeLabel(node)} - 副本`;

  const recreate = async (sourceNode, parentId, name) => {
    const created = await api.post(`/projects/${editor.projectId}/apis`, {
      name,
      target_type: sourceNode.target_type,
      method: sourceNode.method || 'GET',
      url: sourceNode.url || '',
      parent_id: String(parentId)
    });
    const createdId = created.target_id;

    if (sourceNode.target_type !== 'folder') {
      try {
        const fresh = await api.get(`/projects/${editor.projectId}/apis/${sourceNode.target_id}`);
        if (fresh?.data) {
          const payload = deepClone(fresh.data);
          payload.name = name;
          payload.parent_id = String(parentId);
          payload.target_id = createdId;
          await api.put(`/projects/${editor.projectId}/apis/${createdId}`, { data: payload });
        }
      } catch {}
      return createdId;
    }

    // 目录：递归复制子节点
    const children = editor.apiIndex.filter((i) => String(i.parent_id || '0') === String(sourceNode.target_id));
    for (const child of children) {
      await recreate(child, createdId, child.name || child.target_id);
    }
    return createdId;
  };

  try {
    const rootId = await recreate(node, '0', copyName);
    await loadTree(editor.projectId);
    rerenderTree();
    toast(`已克隆到根目录（${rootId === node.target_id ? '' : copyName}）`);
  } catch (err) {
    toast(`克隆失败：${err.message}`, true);
  }
}

/**
 * 复制为 cURL：从接口定义合成请求，不需要真实响应。
 * @param {object} node 树节点 / 标签页描述
 * @param {'bash'|'cmd'} dialect
 * @param {object} [dataOverride] 非活动标签页用它的数据快照
 */
async function copyDefinitionAsCurl(node, dialect, dataOverride) {
  const builder = window.CurlBuild;
  if (!builder) {
    toast('cURL 生成器未加载，请刷新页面', true);
    return;
  }
  const req = requestFromDefinition(node, dataOverride);
  const { text, warnings } = builder.buildCurl(req, { dialect });
  const res = await copyText(text);
  if (!res.ok) {
    toastCopyFailed(res.error);
    return;
  }
  toast(warnings.length > 0 ? `已复制（${warnings[0]}）` : `已复制为 cURL（${dialect === 'cmd' ? 'CMD' : 'Bash'}）`);
}

/* ---------------- 分享 / 外部调用 OpenAPI ---------------- */

/**
 * 只读文档页链接。
 * 复用服务端 /doc 路由，带 api= 或 folder= 参数把范围收窄到单个接口/目录。
 */
function docShareUrl(node) {
  const token = new URLSearchParams(location.search).get('ui') || '';
  const key = node.target_type === 'folder' ? 'folder' : 'api';
  const base = `${location.origin}/doc?project=${encodeURIComponent(editor.projectId)}`;
  return `${base}&${key}=${encodeURIComponent(node.target_id)}&ui=${encodeURIComponent(token)}`;
}

/** 分享：复制只读文档链接 */
async function copyShareLink(node) {
  const res = await copyText(docShareUrl(node));
  if (!res.ok) {
    toastCopyFailed(res.error);
    return;
  }
  toast('已复制只读文档链接（本机服务运行期间有效）');
}

/** 分享：在新窗口打开只读文档页 */
function openSharePage(node) {
  window.open(docShareUrl(node), '_blank', 'noopener');
}

/**
 * 外部调用 OpenAPI：只导出该接口的 OpenAPI 3 片段。
 * 复用服务端 export 路由的 api= 过滤，避免在前端重复实现一遍转换。
 */
async function copyTargetOpenApi(node) {
  if (node.target_type !== 'api') {
    toast('只有接口能导出 OpenAPI 片段', true);
    return;
  }
  const qs = `format=openapi&api=${encodeURIComponent(node.target_id)}`;
  const spec = await api.get(`/projects/${editor.projectId}/export?${qs}`);
  const paths = spec?.paths || {};
  if (Object.keys(paths).length === 0) {
    toast('该接口还没有 URL，无法生成 OpenAPI 片段', true);
    return;
  }
  const res = await copyText(JSON.stringify(spec, null, 2));
  if (!res.ok) {
    toastCopyFailed(res.error);
    return;
  }
  toast('已复制 OpenAPI 3 片段');
}

/** 转义 target_id 以便用在 querySelector 里（id 里可能有特殊字符） */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}

/* ---------------- 树：改名 / 复制 / 删除 ---------------- */

/** 双击后把名称换成输入框；回车或失焦提交，Esc 还原 */
function startInlineRename(row, node) {
  const nameEl = row.querySelector('.tree-name');
  if (!nameEl || row.querySelector('.tree-rename')) return;

  const original = nodeLabel(node);
  const inputEl = h('input', {
    type: 'text',
    class: 'tree-rename',
    value: original,
    onclick: (e) => e.stopPropagation(),
    ondblclick: (e) => e.stopPropagation()
  });

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const next = String(inputEl.value || '').trim();
    // 还原 DOM，后续由 rerenderTree 统一重建
    inputEl.replaceWith(h('span', { class: 'tree-name' }, commit && next ? next : original));
    if (!commit || !next || next === original) return;
    await renameTarget(node, next);
  };

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  inputEl.addEventListener('blur', () => finish(true));

  nameEl.replaceWith(inputEl);
  inputEl.focus();
  inputEl.select();
}

/** 只更新某个树节点的显示名，避免整树重绘让输入框失焦 */
function syncTreeName(targetId, name) {
  if (!treeHost) return;
  const row = treeHost.querySelector(`.tree-row[data-id="${cssEscape(targetId)}"]`);
  if (!row) return;
  const nameEl = row.querySelector('.tree-name');
  if (nameEl) nameEl.textContent = name;
  const node = editor.apiIndex.find((i) => String(i.target_id) === String(targetId));
  row.title = node?.url ? `${name}\n${node.url}` : name;
}

/** 改名：只提交 name，服务端会合并进已存文件，不动参数与用例 */
async function renameTarget(node, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    toast('名称不能为空', true);
    return;
  }
  try {
    await api.put(`/projects/${editor.projectId}/apis/${node.target_id}`, { data: { name: trimmed } });

    // 改的是当前打开的这个，就同步编辑器里的名称与头部
    if (String(editor.selectedId) === String(node.target_id) && editor.data) {
      editor.data.name = trimmed;
      rerenderPane();
    }
    await loadTree(editor.projectId);
    rerenderTree();
    notifyAction('update', trimmed);
  } catch (err) {
    toast(`改名失败：${err.message}`, true);
    rerenderTree();
  }
}

/** 复制为副本：建壳 → 取源最新 data → 全量写入副本（含用例与 Mock） */
async function duplicateTarget(node) {
  const sourceName = nodeLabel(node);
  const copyName = `${sourceName} 副本`;
  try {
    const created = await api.post(`/projects/${editor.projectId}/apis`, {
      name: copyName,
      target_type: node.target_type,
      method: node.method || 'GET',
      url: node.url || '',
      parent_id: String(node.parent_id || '0')
    });

    // 目录只复制自身（其下内容不跟过去），与「另存为」保持一致
    if (node.target_type === 'api' || node.target_type === 'doc') {
      // 拉取源最新数据，避免用编辑器里可能过期的快照
      let latest = null;
      try {
        const fresh = await api.get(`/projects/${editor.projectId}/apis/${node.target_id}`);
        latest = fresh?.data || null;
      } catch {
        latest = null;
      }
      if (latest) {
        const payload = deepClone(latest);
        payload.name = copyName;
        payload.parent_id = String(node.parent_id || '0');
        payload.target_id = created.target_id;
        await api.put(`/projects/${editor.projectId}/apis/${created.target_id}`, { data: payload });
      }
    }

    await loadTree(editor.projectId);
    rerenderTree();
    notifyAction('saveAs', copyName);
  } catch (err) {
    toast(`复制失败：${err.message}`, true);
  }
}

/** 删除节点（目录级联），若删的是当前选中项则清空编辑器 */
async function removeTarget(node) {
  const isFolder = node.target_type === 'folder';
  const label = isFolder ? '目录（含其下所有内容）' : node.target_type === 'doc' ? '文档' : '接口';
  const name = nodeLabel(node);
  if (!confirm(`确定删除${label}「${name}」？`)) return;

  try {
    await api.req('DELETE', `/projects/${editor.projectId}/apis/${node.target_id}`);

    // 删掉的正好是当前打开的（目录要连同子孙一起判断）
    const removedSelf = String(editor.selectedId) === String(node.target_id);
    const removedChild = editor.selectedId && isSelfOrDescendant(editor.selectedId, node.target_id);
    if (removedSelf || removedChild) {
      editor.selectedId = null;
      editor.data = null;
      discardUnsaved();
      rerenderPane();
    }

    await loadTree(editor.projectId);
    rerenderTree();
    notifyAction('delete', name);
  } catch (err) {
    toast(`删除失败：${err.message}`, true);
  }
}

let treeHost = null;
/** 树末尾的「+ 新建」按钮（随列表滚动），由 viewApiDesign 创建后交由 rerenderTree 挂载 */
let treeNewBtn = null;

function rerenderTree() {
  if (!treeHost) return;
  const filtered = filterTree(editor.tree, editor.treeKeyword);
  const nodes = renderTreeNodes(filtered);
  const tail = treeNewBtn ? [treeNewBtn] : [];

  if (nodes.length > 0) {
    treeHost.replaceChildren(...nodes, ...tail);
    return;
  }

  if (!editor.projectId) {
    // 没有项目时，引导去总览页建项目（否则用户点新建必然失败）
    treeHost.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        '还没有项目。',
        h(
          'div',
          { class: 'mt12' },
          h(
            'button',
            {
              class: 'small primary',
              onclick: () => {
                const st = window.__consoleState;
                if (st) {
                  st.view = 'overview';
                  window.__consoleRender?.();
                }
              }
            },
            '去新建项目'
          )
        )
      ),
      ...tail
    );
    return;
  }

  treeHost.replaceChildren(
    h('div', { class: 'empty' }, editor.treeKeyword ? '没有匹配的接口' : '还没有接口，点下方「+ 新建」'),
    ...tail
  );
}

/* ---------------- 主视图 ---------------- */

function viewApiDesign() {
  const state = window.__consoleState;
  if (!state) return h('div', { class: 'empty' }, '控制台状态未就绪，请刷新页面');
  if (!state.designProjectId) {
    state.designProjectId = state.projects[0]?.project_id || null;
  }

  const projectSelect = h(
    'select',
    {
      class: 'design-project-select',
      onchange: async (e) => {
        state.designProjectId = e.target.value;
        editor.projectId = e.target.value;
        editor.selectedId = null;
        editor.data = null;
        // 标签页只在当前项目内有效：换项目后全部关闭，避免带着别的项目的 id
        editor.tabs = [];
        editor.activeTabId = null;
        // 换项目后旧的搜索词与折叠状态都没有意义
        editor.treeKeyword = '';
        editor.collapsed.clear();
        const si = document.querySelector('.design-tree-search');
        if (si) si.value = '';
        discardUnsaved();
        // 与顶栏的项目/环境选择保持一致
        if (state.currentProjectId !== e.target.value) {
          state.currentProjectId = e.target.value;
          refreshEnvironments(e.target.value).catch(() => {});
          renderTopbarEnvs();
        }
        await refreshDesign();
        renderTabBar();
      }
    },
    ...state.projects.map((p) =>
      h('option', { value: p.project_id, ...(p.project_id === state.designProjectId ? { selected: true } : {}) }, p.name)
    )
  );

  treeHost = h('div', { class: 'design-tree' });
  paneHost = h('div', { class: 'design-editor-pane' });
  // 接口工作区需要占满高度做左右分栏；文档/目录仍是普通滚动布局
  const syncPaneHostMode = () => {
    const isWorkspace = editor.targetType === 'api' && (editor.activeMode || 'design') === 'debug';
    paneHost.classList.toggle('ws-host', isWorkspace);
  };
  syncPaneHostMode();
  window.__syncPaneHostMode = syncPaneHostMode;

  // 树搜索：防抖后只重绘树，不影响编辑器
  let searchTimer = null;
  const searchInput = h('input', {
    type: 'search',
    class: 'design-tree-search',
    placeholder: '搜索接口 / 目录 / URL',
    value: editor.treeKeyword || '',
    oninput: (e) => {
      const value = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        editor.treeKeyword = value;
        rerenderTree();
      }, 180);
    }
  });

  const refresh = async () => {
    await refreshDesign();
  };

  // 绑定 Ctrl+S
  bindSaveShortcut(refresh);

  // 树末尾的「+ 新建」：跟在最后一个节点后面，像 Apipost 一样长在列表里
  treeNewBtn = h(
    'button',
    {
      class: 'tree-new-btn',
      disabled: state.projects.length === 0,
      title: state.projects.length === 0 ? '请先在「总览」页新建项目' : '新建或导入',
      onclick: (e) => {
        e.stopPropagation();
        openNewMenu(treeNewBtn, refresh);
      }
    },
    h('span', { class: 'tree-new-plus' }, '+'),
    h('span', { class: 'tree-new-label' }, '新建')
  );

  const container = h(
    'div',
    { class: 'design-layout' },
    h(
      'aside',
      { class: 'design-side' },
      h(
        'div',
        { class: 'design-side-head' },
        h('span', { class: 'hint' }, '项目'),
        projectSelect
      ),
      searchInput,
      treeHost
    ),
    h(
      'section',
      { class: 'design-main' },
      h('div', { class: 'editor-tabs', id: 'editor-tabs' }),
      editorToolbar(refresh),
      paneHost
    )
  );

  // 首次进入加载
  if (state.projects.length > 0 && !editor.data) {
    editor.projectId = state.designProjectId;
    refreshDesign()
      .then(() => {
        const first = editor.apiIndex.find((i) => i.target_type === 'api');
        if (first) return openTab(editor.projectId, first.target_id);
        return null;
      })
      .then(() => {
        rerenderTree();
        rerenderPane();
        renderTabBar();
        const toolbar = container.querySelector('.editor-toolbar');
        if (toolbar) toolbar.replaceWith(editorToolbar(refresh));
      })
      .catch((err) => toast(err.message, true));
  } else {
    setTimeout(() => {
      rerenderTree();
      rerenderPane();
      renderTabBar();
    }, 0);
  }

  return container;
}

async function refreshDesign() {
  if (!editor.projectId) return;
  await loadTree(editor.projectId);
  rerenderTree();
  if (!editor.selectedId && editor.apiIndex.length > 0) {
    const first = editor.apiIndex.find((i) => i.target_type === 'api') || editor.apiIndex[0];
    await loadApi(editor.projectId, first.target_id);
    rerenderPane();
  }
}

window.ApiDesign = {
  view: viewApiDesign,
  state: editor,
  reload: refreshDesign,
  unbindShortcut: unbindSaveShortcut,
  hasUnsaved,
  discardUnsaved,
  isDirty,
  /** 共享给「环境与变量」页复用的表单组件 */
  paramTable,
  paramSection,
  cookieNotice,
  field,
  select,
  input,
  textarea,
  scriptSource,
  setScriptSource,
  /** 共享给 workspace.js 的工作区组件 */
  modeTabs,
  requestBar,
  metaBar,
  statusSelector,
  tagsEditor,
  descriptionField,
  folderOptionsWithDepth,
  tabParams,
  tabBody,
  tabAuth,
  tabResponse,
  tabScripts,
  contractTable,
  contractSection,
  openBulkEdit,
  buildResponseBody,
  formatSize,
  truncateUrl,
  copyAsCurl,
  openCodeSnippet,
  saveAsExample,
  markDirty,
  rerenderPane,
  /** 从「最近」等外部入口跳到指定接口 */
  openTarget: async (projectId, targetId) => {
    editor.projectId = projectId;
    editor.selectedId = null;
    editor.data = null;
    discardUnsaved();
    await loadTree(projectId);
    await loadApi(projectId, targetId);
    rerenderTree();
    rerenderPane();
    const tb = document.querySelector('.editor-toolbar');
    if (tb) tb.replaceWith(editorToolbar(() => refreshDesign()));
  }
};

/* 离开页面时若有未保存改动，提示确认 */
window.addEventListener('beforeunload', (e) => {
  if (!hasUnsaved()) return;
  e.preventDefault();
  e.returnValue = '';
});

/** workspace.js 的响应区通过它渲染「响应示例」页签 */
window.__responseExamplePane = responseExamplePane;

})();
