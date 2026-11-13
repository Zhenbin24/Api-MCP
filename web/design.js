/* 接口设计器：树 + 编辑器（挂在 window.ApiDesign 上，由 app.js 调用） */

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
  ['oauth2', 'OAuth 2.0']
];
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

function textarea(value, onChange, { rows = 6, placeholder = '', mono = true } = {}) {
  return h('textarea', {
    rows,
    placeholder,
    class: mono ? 'mono-input' : '',
    style: `min-height:${rows * 22}px`,
    oninput: (e) => onChange(e.target.value)
  }, value ?? '');
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

function paramTable(list, onChange, { withFileType = false, addLabel = '添加参数' } = {}) {
  const rows = [];

  const commit = () => onChange(list.map((p) => ({ ...p })));

  const render = () => {
    rows.length = 0;
    list.forEach((p, index) => {
      rows.push(
        h(
          'div',
          { class: 'param-row' },
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
          h('input', {
            type: 'text',
            class: 'mono-input',
            placeholder: 'value',
            value: p.value ?? '',
            oninput: (e) => {
              p.value = e.target.value;
              commit();
            }
          }),
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
            list.push(newParam());
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
  activeMode: 'design',
  /** 目录编辑器的子页签（基础 / 参数 / Body / 鉴权 / 脚本） */
  folderTab: 'basic',
  debugTab: 'body',
  // 响应体查看状态
  debugView: 'pretty',
  debugFormat: 'auto',
  debugEncoding: 'utf-8',
  // 调试面板「隐藏敏感值」开关，默认关闭（本地调试优先看全）
  debugMask: false,
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

function hasUnsaved() {
  return Boolean(editor.dirty || editor.caseDirty || editor.mockDirty);
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

function tabBasic() {
  const d = editor.data;
  const readOnlyType = editor.targetType !== 'api';

  const folderOptions = [['0', '根目录']];
  for (const item of editor.apiIndex) {
    if (item.target_type !== 'folder') continue;
    if (item.target_id === editor.selectedId) continue;
    folderOptions.push([item.target_id, item.name || item.target_id]);
  }

  return h(
    'div',
    { class: 'form-grid' },
    field('名称', input(d.name, (v) => {
      d.name = v;
      markDirty();
    }, { placeholder: '接口名称' })),
    readOnlyType
      ? null
      : field('方法', select(METHODS.map((m) => [m, m]), String(d.method || 'GET').toUpperCase(), (v) => {
          d.method = v;
          markDirty();
        })),
    field(
      'URL',
      input(d.url, (v) => {
        d.url = v;
        markDirty();
      }, { placeholder: 'https://api.example.com/users 或 {{base}}/users', mono: true }),
      '支持 {{变量名}} 引用环境变量与环境服务地址'
    ),
    field(
      '所属目录',
      select(folderOptions, String(d.parent_id || '0'), (v) => {
        d.parent_id = v;
        markDirty();
      })
    ),
    h(
      'div',
      { class: 'form-row full' },
      h('label', { class: 'form-label' }, '描述'),
      h(
        'div',
        { class: 'form-control' },
        textarea(
          d.description || '',
          (v) => {
            d.description = v;
            markDirty();
          },
          { rows: 3, mono: false, placeholder: '接口用途说明' }
        )
      )
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
    h('div', { class: 'param-section-title' }, title, h('span', { class: 'tab-badge' }, holder.parameter.length)),
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
              { rows: 14, placeholder: mode === 'json' ? '{\n  "key": "value"\n}' : '' }
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

const TABS = [
  ['basic', '基础'],
  ['params', '参数'],
  ['body', 'Body'],
  ['auth', '鉴权'],
  ['scripts', '脚本'],
  ['response', '响应']
];

let paneHost = null;

function rerenderPane() {
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

let lastResponse = null;
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

  // 只读模式（压测 / Mock 页签）不提供发送能力，避免改动设计数据
  if (readonly) {
    return h('div', { class: 'request-bar readonly' }, methodSelect, urlInput, protocolSelect);
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
    cancelBtn
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
    lastResponse = res;

    if (saveResponse && res.response) {
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
      toast('已保存响应到示例，并同步保存接口');
    } else {
      toast(res.status === 'passed' ? `发送成功 · ${res.status_code}` : `发送完成（${res.status_code || '失败'}）`);
    }
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''));
    if (aborted) {
      lastResponse = null;
      toast('已取消发送');
    } else {
      lastResponse = { error: err.message };
      toast(`发送失败：${err.message}`, true);
    }
  } finally {
    sending = false;
    sendAbort = null;
    // 切到调试模式看结果
    if (editor.activeMode !== 'debug') editor.activeMode = 'debug';
    rerenderPane();
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

function debugPanel() {
  if (!lastResponse) {
    return h(
      'div',
      { class: 'debug-empty' },
      h('div', { class: 'debug-empty-icon' }, '🚀'),
      h('div', {}, '还没发送请求'),
      h('div', { class: 'hint' }, '点上方「发送」按钮，响应会显示在这里')
    );
  }

  if (lastResponse.error) {
    return h('div', { class: 'debug-error' }, `发送失败：${lastResponse.error}`);
  }

  const resp = lastResponse.response;
  if (!resp) {
    return h('div', { class: 'debug-error' }, lastResponse.error || '没有响应');
  }

  // 合并二进制字段（在 envelope 顶层）到 response 对象，供渲染与下载使用
  const view = {
    ...resp,
    content_type: resp.content_type || lastResponse.content_type || '',
    is_binary: resp.is_binary !== undefined ? resp.is_binary : Boolean(lastResponse.is_binary),
    body_base64: lastResponse.body_base64 || resp.body_base64 || null,
    too_large_for_base64: Boolean(lastResponse.too_large_for_base64 || resp.too_large_for_base64)
  };

  const status = Number(resp.status) || 0;
  const statusCls = status >= 500 ? 'err' : status >= 400 ? 'warn' : status >= 200 && status < 300 ? 'ok' : '';

  // 未脱敏的完整详情（本地即时返回）；旧服务没有该项时回落到脱敏字段
  const live = lastResponse.live_detail || null;
  const liveReq = live?.request || lastResponse.request || null;
  const liveResp = live?.response || null;

  const meta = h(
    'div',
    { class: 'response-meta' },
    h('span', { class: `tag ${statusCls}` }, `${status} ${resp.status_text || ''}`.trim()),
    h('span', { class: 'hint' }, `${liveResp?.protocol || lastResponse.protocol || 'HTTP/1.1'}`),
    h('span', { class: 'hint' }, `${lastResponse.elapsed_ms ?? '-'} ms`),
    h('span', { class: 'hint' }, formatSize(resp.size || (resp.body || '').length)),
    lastResponse.request?.url
      ? h(
          'code',
          {
            class: 'mono hint meta-url',
            title: lastResponse.request.url,
            onclick: async () => {
              const res = await copyText(lastResponse.request.url);
              if (res.ok) toast('已复制 URL');
              else toastCopyFailed(res.error);
            }
          },
          truncateUrl(lastResponse.request.url)
        )
      : null,
    h('span', { class: 'spacer' }),
    h(
      'button',
      {
        class: 'small',
        onclick: async () => {
          const text = resp.body || '';
          const res = await copyText(text);
          if (res.ok) toast('已复制响应体');
          else toastCopyFailed(res.error);
        }
      },
      '复制响应'
    ),
    h(
      'button',
      {
        class: 'small',
        onclick: () => doSend(true)
      },
      '保存为示例'
    )
  );

  // 响应体：由工具条驱动（美化/原生/预览/可视化 + 格式 + 编码）
  const bodyNode = buildResponseBody(view, lastResponse);

  // 断言
  const assertions = lastResponse.assertions || [];
  const assertNodes =
    assertions.length > 0
      ? assertions.map((a) =>
          h(
            'div',
            { class: 'run-assert' },
            h('span', { class: `tag ${a.passed ? 'ok' : 'err'}` }, a.passed ? '通过' : '失败'),
            h('span', {}, a.name),
            a.message ? h('span', { class: 'hint' }, a.message) : null
          )
        )
      : [h('div', { class: 'empty' }, '没有断言')];

  // 控制台
  const logs = lastResponse.console || [];
  const logNodes =
    logs.length > 0
      ? [h('pre', { class: 'code' }, logs.map((c) => `[${c.level}] ${c.message}`).join('\n'))]
      : [h('div', { class: 'empty' }, '没有日志')];

  // 请求详情
  const requestNode = requestDetailView(liveReq);

  // 响应头（状态行 + 表 + Set-Cookie）
  const responseHeaderNode = h(
    'div',
    { class: 'headers-pane' },
    statusLine({
      protocol: liveResp?.protocol || lastResponse.protocol || 'HTTP/1.1',
      status: resp.status,
      status_text: resp.status_text
    }),
    headersTable(liveResp?.headers || resp.headers, '响应头'),
    liveResp?.set_cookies?.length
      ? h(
          'div',
          { class: 'kv-block mt12' },
          h('div', { class: 'kv-block-title' }, 'Set-Cookie', h('span', { class: 'hint' }, ` ${liveResp.set_cookies.length}`)),
          cookieTable(liveResp.set_cookies, { mask: editor.debugMask })
        )
      : null
  );

  // Cookie 面板：请求侧 + 响应侧
  const reqCookies = liveReq?.cookies || {};
  const cookieHeader = (() => {
    const headers = liveReq?.headers || {};
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
    return key ? headers[key] : '';
  })();
  const cookieNode = h(
    'div',
    { class: 'cookie-pane' },
    h('div', { class: 'kv-block-title' }, '请求带的 Cookie'),
    Object.keys(reqCookies).length > 0
      ? kvTable(reqCookies, { mask: editor.debugMask, keyWidth: 180 })
      : cookieHeader
        ? h('pre', { class: 'code' }, editor.debugMask ? '***' : cookieHeader)
        : h('div', { class: 'form-hint' }, '本次请求没有 Cookie'),
    h('div', { class: 'kv-block-title mt16' }, '响应下发的 Cookie'),
    cookieTable(liveResp?.set_cookies || [], { mask: editor.debugMask })
  );

  const innerTabs = [
    ['body', '实时响应'],
    ['request', '请求详情'],
    ['headers', '响应头'],
    ['cookies', 'Cookie'],
    ['assertions', '断言'],
    ['console', '控制台']
  ];

  const active = editor.debugTab || 'body';
  const contentMap = {
    body: bodyNode,
    request: requestNode,
    headers: responseHeaderNode,
    cookies: cookieNode,
    assertions: h('div', {}, ...assertNodes),
    console: h('div', {}, ...logNodes)
  };

  return h(
    'div',
    { class: 'debug-panel' },
    meta,
    h(
      'div',
      { class: 'debug-toolbar' },
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(editor.debugMask),
          onchange: (e) => {
            editor.debugMask = e.target.checked;
            rerenderPane();
          }
        }),
        '隐藏敏感值'
      ),
      h('span', { class: 'spacer-flex' }),
      h(
        'select',
        {
          class: 'curl-dialect-select',
          title: '复制为 cURL 时使用的 shell 格式',
          onchange: (e) => {
            setCurlDialect(e.target.value);
            rerenderPane();
          }
        },
        ...CURL_DIALECT_OPTIONS.map(([value, label]) =>
          h('option', { value, selected: getCurlDialectSetting() === value }, label)
        )
      ),
      h(
        'button',
        {
          class: 'small',
          disabled: !liveReq,
          onclick: () => copyAsCurl(liveReq)
        },
        '复制为 cURL'
      )
    ),
    h(
      'div',
      { class: 'tabs tabs-sm' },
      ...innerTabs.map(([key, label]) =>
        h(
          'div',
          {
            class: `tab${active === key ? ' active' : ''}`,
            onclick: () => {
              editor.debugTab = key;
              rerenderPane();
            }
          },
          label
        )
      )
    ),
    h('div', { class: 'debug-content' }, contentMap[active] || bodyNode)
  );
}

/** 请求详情面板：方法 + 实际 URL + query + 请求头 + Cookie + body */
function requestDetailView(req) {
  if (!req) return h('div', { class: 'empty' }, '没有请求详情');

  const headers = req.headers || {};
  const query = req.query || {};
  const bodyMode = req.body_mode || 'none';

  return h(
    'div',
    { class: 'request-detail' },
    h(
      'div',
      { class: 'kv-line' },
      h('span', { class: `method ${String(req.method || '').toUpperCase()}` }, req.method || ''),
      h('code', { class: 'mono kv-url' }, req.url || '')
    ),
    Object.keys(query).length > 0
      ? h(
          'div',
          { class: 'kv-block mt12' },
          h('div', { class: 'kv-block-title' }, 'Query 参数', h('span', { class: 'hint' }, ` ${Object.keys(query).length}`)),
          kvTable(query)
        )
      : null,
    h('div', { class: 'kv-block mt12' }, headersTable(headers, '请求头')),
    bodyMode !== 'none'
      ? h(
          'div',
          { class: 'kv-block mt12' },
          collapsible(`请求体（${bodyMode}）`, h('pre', { class: 'code' }, req.body || '(空)'), { open: true })
        )
      : null
  );
}

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
  case: {
    title: '接口用例',
    desc: '为同一接口编排多个测试场景（不同参数、不同断言），一键跑完并汇总结果。',
    items: ['用例列表与增删改', '每条用例独立参数与断言', '批量执行与结果对比']
  },
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
            rerenderPane();
            // 保存按钮文案 / 禁用态跟随页签
            const tb = document.querySelector('.editor-toolbar');
            if (tb) tb.replaceWith(editorToolbar(window.__designRefresh));
          }
        },
        label
      )
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
  ['basic', '基础'],
  ['params', '参数'],
  ['body', 'Body'],
  ['auth', '鉴权'],
  ['scripts', '脚本']
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

  const panes = {
    basic: basicPane,
    params: tabParams(d.request, markDirty, { sections: ['query', 'header'] }),
    body: tabBody(d.request.body = d.request.body || { mode: 'none', parameter: [] }, markDirty, {
      allowedModes: [
        ['none', '不使用'],
        ['form-data', 'form-data'],
        ['urlencoded', 'urlencoded']
      ]
    }),
    auth: tabAuth(d.request, markDirty),
    scripts: tabScripts(d.request, markDirty)
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

  // 暴露给 extra.js 的桥接
  window.__designState = editor;
  window.__designApi = api;
  window.__designRerender = () => rerenderPane();
  window.__designMarkDirty = (scope) => markDirty(scope);
  window.__designMarkClean = (scope) => markClean(scope);
  window.__designIsDirty = (scope) => isDirty(scope);
  window.__designHasUnsaved = () => hasUnsaved();
  window.__designSave = () => saveCurrent(window.__designRefresh);
  window.__designSaveActive = () => saveActiveMode(window.__designRefresh);

  // 文档：专属 Markdown 编辑器（不显示接口的六页签）
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

  // 非设计模式
  if (mode !== 'design') {
    const header = h('div', { class: 'editor-mode-head' }, modeTabs());
    if (mode === 'debug') {
      return h(
        'div',
        { class: 'editor-inner' },
        header,
        requestBar(),
        h('div', { class: 'debug-wrap' }, debugPanel())
      );
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
      header,
      mode === 'case' ? null : requestBar({ readonly: mode !== 'debug' }),
      panel
    );
  }

  const tab = editor.activeTab || 'basic';
  let body;
  if (tab === 'basic') body = tabBasic();
  else if (tab === 'params') body = tabParams();
  else if (tab === 'body') body = tabBody();
  else if (tab === 'auth') body = tabAuth();
  else if (tab === 'scripts') body = tabScripts();
  else body = tabResponse();

  return h(
    'div',
    { class: 'editor-inner' },
    modeTabs(),
    requestBar(),
    metaBar(),
    h(
      'div',
      { class: 'tabs' },
      ...TABS.map(([key, label]) =>
        h(
          'div',
          {
            class: `tab${tab === key ? ' active' : ''}`,
            onclick: () => {
              editor.activeTab = key;
              rerenderPane();
            }
          },
          label
        )
      ),
      h(
        'div',
        {
          class: 'tab tab-action',
          title: '粘贴 curl 命令自动填 URL、Header、Body',
          onclick: () => openCurlImport()
        },
        'curl 导入'
      )
    ),
    h('div', { class: 'editor-body' }, body)
  );
}

/* ---------------- 操作结果提示 ---------------- */

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

/** 统一的「新建后跳转」：刷新树、选中新对象、回到设计模式并重绘 */
async function focusTarget(targetId, onRefresh) {
  await loadTree(editor.projectId);
  await loadApi(editor.projectId, targetId);
  // 回到设计模式（避免停在调试/压测/Mock）
  editor.activeMode = 'design';
  editor.activeTab = editor.targetType === 'doc' ? 'doc' : 'basic';
  rerenderTree();
  rerenderPane();
  const tb = document.querySelector('.editor-toolbar');
  if (tb) tb.replaceWith(editorToolbar(onRefresh));
  if (onRefresh) onRefresh();
}

function openCreateDialog(type, onRefresh) {
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
    parentId: (() => {
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

function editorToolbar(onRefresh) {
  const hasSelection = Boolean(editor.selectedId);
  const isFolder = editor.targetType === 'folder';
  const isDoc = editor.targetType === 'doc';
  const isApi = editor.targetType === 'api';
  // 没有任何项目时，新建接口/目录/文档都无处可落，直接禁用并给出引导
  const noProject = !editor.projectId;

  return h(
    'div',
    { class: 'editor-toolbar' },
    h(
      'button',
      {
        class: 'small',
        disabled: noProject,
        title: noProject ? '请先在「总览」页新建项目' : '新建接口',
        onclick: () => openCreateDialog('api', onRefresh)
      },
      '+ 新建接口'
    ),
    h(
      'button',
      {
        class: 'small',
        disabled: noProject,
        title: noProject ? '请先在「总览」页新建项目' : '新建目录',
        onclick: () => openCreateDialog('folder', onRefresh)
      },
      '+ 新建目录'
    ),
    h(
      'button',
      {
        class: 'small',
        disabled: noProject,
        title: noProject ? '请先在「总览」页新建项目' : '新建文档',
        onclick: () => openCreateDialog('doc', onRefresh)
      },
      '+ 新建文档'
    ),
    h('span', { class: 'spacer-flex' }),
    h('span', {
      id: 'dirty-badge',
      class: 'tag warn',
      style: hasUnsaved() ? '' : 'display:none'
    }, dirtyBadgeText()),
    h(
      'button',
      {
        class: 'primary small',
        disabled: !hasSelection,
        title: '保存（Ctrl+S）',
        onclick: () => Promise.resolve(saveActiveMode(onRefresh)).catch((err) => toast(err.message, true))
      },
      saveButtonLabel()
    ),
    h(
      'button',
      {
        class: 'small',
        disabled: !hasSelection,
        title: '复制一份到指定目录',
        onclick: () => openSaveAs(onRefresh)
      },
      '另存为'
    ),
    h(
      'button',
      {
        class: 'small danger',
        disabled: !hasSelection,
        onclick: async () => {
          const label = isFolder ? '目录（含其下所有内容）' : '接口';
          const removedName = editor.data?.name || editor.selectedId;
          if (!confirm(`确定删除${label}「${removedName}」？`)) return;
          try {
            await api.req('DELETE', `/projects/${editor.projectId}/apis/${editor.selectedId}`);
            editor.selectedId = null;
            editor.data = null;
            discardUnsaved();
            await loadTree(editor.projectId);
            notifyAction('delete', removedName);
            onRefresh();
          } catch (err) {
            toast(err.message, true);
          }
        }
      },
      '删除'
    )
  );
}

/* ---------------- 树 ---------------- */

function renderTreeNodes(nodes, depth = 0) {
  const out = [];
  for (const node of nodes) {
    const indent = 10 + depth * 14;
    const icon = node.target_type === 'folder' ? '📁' : node.target_type === 'doc' ? '📄' : node.target_type === 'sse' ? '📡' : '';

    out.push(
      h(
        'div',
        {
          class: `tree-row${editor.selectedId === node.target_id ? ' active' : ''}`,
          style: `padding-left:${indent}px`,
          onclick: async () => {
            if (hasUnsaved() && !confirm('当前接口有未保存的修改（含用例 / Mock），确定切换？')) return;
            try {
              await loadApi(editor.projectId, node.target_id);
              rerenderTree();
              rerenderPane();
            } catch (err) {
              toast(err.message, true);
            }
          }
        },
        h('span', { class: 'tree-icon' }, icon),
        node.method ? h('span', { class: `method ${node.method}` }, node.method) : null,
        h('span', { class: 'tree-name' }, node.name || node.url || node.target_id)
      )
    );

    if (node.children?.length) out.push(...renderTreeNodes(node.children, depth + 1));
  }
  return out;
}

let treeHost = null;

function rerenderTree() {
  if (!treeHost) return;
  const nodes = renderTreeNodes(editor.tree);
  if (nodes.length === 0) {
    // 没有项目时，引导去总览页建项目（否则用户点新建必然失败）
    if (!editor.projectId) {
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
                  const state = window.__consoleState;
                  if (state) {
                    state.view = 'overview';
                    window.__consoleRender?.();
                  }
                }
              },
              '去新建项目'
            )
          )
        )
      );
      return;
    }
    treeHost.replaceChildren(h('div', { class: 'empty' }, '还没有接口，点上方新建'));
    return;
  }
  treeHost.replaceChildren(...nodes);
}

/* ---------------- 主视图 ---------------- */

function viewApiDesign() {
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
        discardUnsaved();
        // 与顶栏的项目/环境选择保持一致
        if (state.currentProjectId !== e.target.value) {
          state.currentProjectId = e.target.value;
          refreshEnvironments(e.target.value).catch(() => {});
          renderTopbarEnvs();
        }
        await refreshDesign();
      }
    },
    ...state.projects.map((p) =>
      h('option', { value: p.project_id, ...(p.project_id === state.designProjectId ? { selected: true } : {}) }, p.name)
    )
  );

  treeHost = h('div', { class: 'design-tree' });
  paneHost = h('div', { class: 'design-editor-pane' });

  const refresh = async () => {
    await refreshDesign();
  };

  // 绑定 Ctrl+S
  bindSaveShortcut(refresh);

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
      treeHost
    ),
    h(
      'section',
      { class: 'design-main' },
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
        if (first) return loadApi(editor.projectId, first.target_id);
        return null;
      })
      .then(() => {
        rerenderTree();
        rerenderPane();
        const toolbar = container.querySelector('.editor-toolbar');
        if (toolbar) toolbar.replaceWith(editorToolbar(refresh));
      })
      .catch((err) => toast(err.message, true));
  } else {
    setTimeout(() => {
      rerenderTree();
      rerenderPane();
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
