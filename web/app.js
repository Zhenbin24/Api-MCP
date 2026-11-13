/* API MCP 控制台 */

const UI_TOKEN = new URLSearchParams(location.search).get('ui') || '';
/** 桌面端（Electron 壳）注入 apimcpShell；浏览器访问时为 undefined */
const IS_DESKTOP = Boolean(window.apimcpShell && window.apimcpShell.isDesktop);

if (IS_DESKTOP) {
  document.addEventListener('DOMContentLoaded', () => document.body.classList.add('is-desktop'));
}

/** 原生标题栏按钮区跟随主题 */
function syncTitleBarColors() {
  if (!IS_DESKTOP || typeof window.apimcpShell.setTitleBarColors !== 'function') return;
  const style = getComputedStyle(document.documentElement);
  const color = style.getPropertyValue('--bg-header').trim();
  const symbolColor = style.getPropertyValue('--font-title').trim();
  if (!color || !symbolColor) return;
  window.apimcpShell.setTitleBarColors({ color, symbolColor });
}

const api = {
  async req(method, path, body, options = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-UI-Token': UI_TOKEN
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  },
  get: (p, o) => api.req('GET', p, undefined, o),
  put: (p, b, o) => api.req('PUT', p, b, o),
  post: (p, b, o) => api.req('POST', p, b, o)
};

/* ---------------- 状态 ---------------- */

const state = {
  status: null,
  config: null,
  projects: [],
  view: 'design',
  /** 顶栏切换的当前项目（与接口设计页双向同步） */
  currentProjectId: null,
  currentEnvId: '',
  environments: [],
  activeProject: null,
  tree: null,
  flows: [],
  runs: [],
  clientConfigs: null,
  runResult: null,
  openTabs: new Set(),
  currentTab: null
};

/* ---------------- 工具 ---------------- */

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
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

function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.className = isError ? 'show err' : 'show';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    node.className = '';
  }, 3200);
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/**
 * 写剪贴板。
 *
 * 先走异步 Clipboard API；被拒（Electron 权限、文档未聚焦、非安全上下文）时
 * 降级到隐藏 textarea + execCommand('copy')，该路径不经权限处理器。
 *
 * @returns {Promise<{ok: boolean, error: Error|null}>}
 */
async function copyText(text) {
  const content = String(text ?? '');
  let firstError = null;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return { ok: true, error: null };
    }
  } catch (err) {
    // 落到下面的 execCommand 兜底
    firstError = err;
  }

  try {
    const area = document.createElement('textarea');
    area.value = content;
    // 不能用 display:none / visibility:hidden，否则无法选中
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = document.execCommand('copy');
    area.remove();
    if (ok) return { ok: true, error: null };
    return { ok: false, error: firstError || new Error('浏览器拒绝了复制操作') };
  } catch (err) {
    return { ok: false, error: firstError || err };
  }
}

/** 复制失败时的统一提示（带原因，方便排查） */
function toastCopyFailed(error) {
  const reason = error?.message ? `：${error.message}` : '';
  toast(`复制失败${reason}`, true);
}

function fmtTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function fmtDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/* ---------------- 主题 ---------------- */

function hexToHsl(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
  if (!m) return null;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex({ h, s, l }) {
  const lv = Math.max(0, Math.min(100, l)) / 100;
  const sv = Math.max(0, Math.min(100, s)) / 100;
  const c = (1 - Math.abs(2 * lv - 1)) * sv;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const mm = lv - c / 2;
  const to = (v) => Math.round((v + mm) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function applyCustomTheme(baseHex) {
  const hsl = hexToHsl(baseHex);
  const root = document.documentElement;
  if (!hsl) return;
  const side = hslToHex({ ...hsl, l: hsl.l - 6 });
  const content = hslToHex({ ...hsl, l: Math.min(100, hsl.l + 5) });
  const header = hslToHex({ ...hsl, l: hsl.l + 1 });
  const deep = hslToHex({ ...hsl, l: Math.max(0, hsl.l - 14) });
  root.style.setProperty('--bg-page', baseHex);
  root.style.setProperty('--bg-search', baseHex);
  root.style.setProperty('--bg-side', side);
  root.style.setProperty('--bg-table-header', side);
  root.style.setProperty('--bg-highlight-change', side);
  root.style.setProperty('--bg-tooltip', side);
  root.style.setProperty('--bg-content', content);
  root.style.setProperty('--bg-header', header);
  root.style.setProperty('--bg-deep-gray', deep);
  root.style.setProperty('--border-color', `hsl(${hsl.h} ${Math.min(100, hsl.s)}% ${Math.max(0, hsl.l - 18)}% / 0.25)`);
  root.style.setProperty('--border-strong', `hsl(${hsl.h} ${Math.min(100, hsl.s)}% ${Math.max(0, hsl.l - 18)}% / 0.45)`);
  root.style.setProperty('--scrollbar-thumb', deep);
}

function clearCustomTheme() {
  const root = document.documentElement;
  for (const v of [
    '--bg-page',
    '--bg-search',
    '--bg-side',
    '--bg-table-header',
    '--bg-highlight-change',
    '--bg-tooltip',
    '--bg-content',
    '--bg-header',
    '--bg-deep-gray',
    '--border-color',
    '--border-strong',
    '--scrollbar-thumb'
  ]) {
    root.style.removeProperty(v);
  }
}

function applyTheme() {
  const cfg = state.config || {};
  let theme = cfg.theme || 'golden';
  if (cfg.follow_system_theme) {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    theme = dark ? 'dark' : 'golden';
  }
  document.documentElement.dataset.theme = theme === 'custom' ? 'golden' : theme;
  clearCustomTheme();
  if (theme === 'custom') applyCustomTheme(cfg.theme_custom_bg || '#faf5ea');
  document.documentElement.style.setProperty('--font-scale', String((cfg.font_scale || 100) / 100));
  syncTitleBarColors();
}

/* ---------------- 数据加载 ---------------- */

async function refreshStatus() {
  try {
    state.status = await api.get('/status');
    const pill = $('status-pill');
    const on = state.status.enabled && state.status.official_root_ok;
    pill.className = on ? 'status-pill' : 'status-pill off';
    $('status-text').textContent = on ? `运行中 · ${state.status.tool_count} 工具` : '未就绪';
    $('endpoint').textContent = `http://127.0.0.1:${state.status.port}/mcp`;
  } catch (err) {
    toast(`无法连接服务：${err.message}`, true);
  }
}

async function refreshConfig() {
  state.config = await api.get('/config');
  applyTheme();
}

async function refreshProjects() {
  const data = await api.get('/projects');
  state.projects = data.projects || [];
  if (!state.currentProjectId || !state.projects.some((p) => p.project_id === state.currentProjectId)) {
    state.currentProjectId = state.projects[0]?.project_id || null;
  }
}

/** 顶栏：拉当前项目的环境列表 */
async function refreshEnvironments(projectId) {
  const targetId = projectId || state.currentProjectId;
  if (!targetId) {
    state.environments = [];
    state.currentEnvId = '';
    return;
  }
  try {
    const res = await api.get(`/projects/${targetId}/environments`);
    state.environments = res.environments || [];
    state.currentEnvId = res.current_env_id || state.environments[0]?.env_id || '';
  } catch {
    state.environments = [];
    state.currentEnvId = '';
  }
}

/** 切换当前环境（写入项目记录，并同步内存态） */
async function switchEnvironment(projectId, envId) {
  await api.post(`/projects/${projectId}/environments/current`, { environment_id: envId });
  state.currentEnvId = envId;
  const target = state.environments.find((e) => e.env_id === envId);
  if (target) state.environments = state.environments.map((e) => ({ ...e, is_current: e.env_id === envId }));
  toast(`已切换到环境「${target?.name || envId}」`);
}

async function loadProjectData(projectId) {
  const [tree, flows, runs] = await Promise.all([
    api.get(`/projects/${projectId}/tree`).catch(() => ({ tree: [] })),
    api.get(`/projects/${projectId}/flows`).catch(() => ({ flows: [] })),
    api.get(`/projects/${projectId}/runs?limit=20`).catch(() => ({ runs: [] }))
  ]);
  state.tree = tree;
  state.flows = flows.flows || [];
  state.runs = runs.runs || [];
}

/* ---------------- 侧栏 ---------------- */

const DEFAULT_NAV = [
  { key: 'design', label: '接口设计', icon: '✎' },
  { key: 'transfer', label: '导入导出', icon: '⇅' },
  { key: 'envvars', label: '环境与变量', icon: '⛁' },
  { key: 'recent', label: '最近', icon: '◷' },
  { key: 'overview', label: '总览', icon: '◉' },
  { key: 'clients', label: '客户端配置', icon: '⌘' },
  { key: 'tools', label: '工具清单', icon: '⚙' },
  { key: 'appearance', label: '外观设置', icon: '◑' }
];

/** 「关于」固定末位，不参与拖拽，避免把唯一入口拖丢 */
const PINNED_NAV = { key: 'about', label: '关于', icon: 'ⓘ' };

/**
 * 当前侧栏顺序 = config.nav_order 合并 DEFAULT_NAV：
 * - 只保留 config 里存在于默认表的 key
 * - 缺失的 key 追加到末尾（新增菜单项不会因老配置而消失）
 */
function resolveNavOrder() {
  const saved = Array.isArray(state.config?.nav_order) ? state.config.nav_order : [];
  const known = new Map(DEFAULT_NAV.map((item) => [item.key, item]));
  const out = [];
  const seen = new Set();

  for (const key of saved) {
    const item = known.get(String(key));
    if (item && !seen.has(item.key)) {
      out.push(item);
      seen.add(item.key);
    }
  }
  for (const item of DEFAULT_NAV) {
    if (!seen.has(item.key)) out.push(item);
  }
  return [...out, PINNED_NAV];
}

function renderSidebar() {
  const nav = $('sidebar');
  nav.innerHTML = '';
  const items = resolveNavOrder();

  items.forEach((item, index) => {
    const isPinned = item.key === PINNED_NAV.key;
    const node = el(
      'div',
      {
        class: `nav-item${state.view === item.key ? ' active' : ''}`,
        "data-key": item.key
      },
      el('span', { class: 'ico' }, item.icon),
      item.label
    );

    node.addEventListener('click', () => {
      // 离开接口编辑器且有未保存改动时确认
      if (state.view === 'design' && window.ApiDesign?.hasUnsaved?.()) {
        if (!confirm('接口编辑器有未保存的修改，确定离开？')) return;
        window.ApiDesign.discardUnsaved();
      }
      state.view = item.key;
      render();
    });

    // 拖拽排序（「关于」除外）
    if (!isPinned) {
      node.setAttribute('draggable', 'true');

      node.addEventListener('dragstart', (e) => {
        dragState.key = item.key;
        node.classList.add('dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', item.key);
        } catch {}
      });

      node.addEventListener('dragend', () => {
        node.classList.remove('dragging');
        clearDragOver();
        dragState.key = null;
      });

      node.addEventListener('dragover', (e) => {
        if (!dragState.key || dragState.key === item.key) return;
        e.preventDefault();
        try {
          e.dataTransfer.dropEffect = 'move';
        } catch {}
        clearDragOver();
        node.classList.add('drag-over');
        dragState.overKey = item.key;
      });

      node.addEventListener('dragleave', () => {
        node.classList.remove('drag-over');
      });

      node.addEventListener('drop', async (e) => {
        e.preventDefault();
        const from = dragState.key;
        const to = item.key;
        clearDragOver();
        dragState.key = null;
        dragState.overKey = null;
        if (!from || from === to) return;
        await reorderNav(from, to);
      });
    }

    nav.append(node);
  });
}

const dragState = { key: null, overKey: null };

function clearDragOver() {
  document.querySelectorAll('.nav-item.drag-over').forEach((n) => n.classList.remove('drag-over'));
}

/** 把 from 移到 to 之前并持久化 */
async function reorderNav(fromKey, toKey) {
  const current = resolveNavOrder()
    .filter((i) => i.key !== PINNED_NAV.key)
    .map((i) => i.key);
  const fromIndex = current.indexOf(fromKey);
  const toIndex = current.indexOf(toKey);
  if (fromIndex < 0 || toIndex < 0) return;

  current.splice(fromIndex, 1);
  const insertAt = current.indexOf(toKey);
  current.splice(insertAt < 0 ? current.length : insertAt, 0, fromKey);

  // 先本地生效，界面立刻响应
  state.config = { ...(state.config || {}), nav_order: current };
  renderSidebar();

  try {
    const saved = await api.put('/config', { nav_order: current });
    state.config = saved;
  } catch (err) {
    toast(`保存菜单顺序失败：${err.message}`, true);
  }
}

/* ---------------- 视图：总览 ---------------- */

function viewOverview() {
  const s = state.status || {};
  const c = state.config || {};
  const authorized = (c.allowed_project_ids || []).length;

  return el(
    'div',
    {},
    el('h1', { class: 'page-title' }, '总览'),
    el('p', { class: 'page-sub' }, '本地 API MCP 服务'),

    !s.data_root_ok
      ? el(
          'div',
          { class: 'notice' },
          el('span', {}, '⚠'),
          el(
            'div',
            {},
            '数据目录不可用（无法创建或没有写权限）。请在「外观设置」中指定其它目录后重启服务。',
            el('div', { class: 'hint mt8' }, `当前数据目录：${s.data_root || '-'}`)
          )
        )
      : null,

    el(
      'div',
      { class: 'section' },
      el('div', { class: 'section-title' }, '服务状态'),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'kv' },
          el('span', { class: 'k' }, '运行状态'),
          el(
            'span',
            { class: 'v' },
            el(
              'label',
              { class: 'switch-row' },
              el('input', {
                type: 'checkbox',
                class: 'switch',
                checked: Boolean(s.enabled),
                onchange: async (e) => {
                  const on = e.target.checked;
                  try {
                    state.config = await api.put('/config', { enabled: on });
                    await refreshStatus();
                    render();
                    toast(on ? 'MCP 服务已启用' : 'MCP 服务已停用（stdio 客户端也将无法连接）');
                  } catch (err) {
                    toast(err.message, true);
                    render();
                  }
                }
              }),
              el('span', { class: `tag ${s.enabled ? 'ok' : 'err'}` }, s.enabled ? '运行中' : '已停用')
            )
          ),
          el('span', { class: 'k' }, 'MCP 端点'),
          el('span', { class: 'v mono' }, `http://127.0.0.1:${s.port}/mcp`),
          el('span', { class: 'k' }, 'Bearer Token'),
          el(
            'span',
            { class: 'v mono' },
            '••••••••',
            el(
              'button',
              {
                class: 'small',
                style: 'margin-left:8px',
                onclick: async () => {
                  if (!confirm('重置 Token 后，所有客户端配置都需要更新。确定继续？')) return;
                  try {
                    const res = await api.post('/token');
                    toast('Token 已重置，请更新客户端配置');
                    state.newToken = res.token;
                    render();
                  } catch (err) {
                    toast(err.message, true);
                  }
                }
              },
              '重新生成连接密钥'
            )
          ),
          el('span', { class: 'k' }, '已探测工具'),
          el('span', { class: 'v' }, `${s.tool_count || 0} 个`),
          el('span', { class: 'k' }, '最近调用'),
          el('span', { class: 'v' }, s.last_mcp_call_at ? fmtTime(s.last_mcp_call_at) : '尚未调用'),
          el('span', { class: 'k' }, '启动时长'),
          el('span', { class: 'v' }, fmtDuration(s.uptime_ms))
        ),
        el(
          'div',
          { class: 'hint mt12' },
          '停用后 HTTP 与 stdio 两种接入方式都会拒绝请求；重新开启即可恢复，无需重启进程。'
        )
      )
    ),

    el(
      'div',
      { class: 'section' },
      el('div', { class: 'section-title' }, '接入配置'),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'kv' },
          el('span', { class: 'k' }, '允许写入项目'),
          el(
            'span',
            { class: 'v' },
            el(
              'label',
              { class: 'switch-row' },
              el('input', {
                type: 'checkbox',
                class: 'switch',
                checked: s.allow_write !== false,
                onchange: async (e) => {
                  const on = e.target.checked;
                  try {
                    state.config = await api.put('/config', { allow_write: on });
                    await refreshStatus();
                    render();
                    toast(on ? '已允许写入项目' : '已切换到只读模式');
                  } catch (err) {
                    toast(err.message, true);
                    render();
                  }
                }
              }),
              el(
                'span',
                { class: `tag ${s.allow_write !== false ? 'ok' : 'warn'}` },
                s.allow_write !== false ? '已允许' : '只读'
              )
            )
          ),
          el('span', { class: 'k' }, '允许执行接口'),
          el(
            'span',
            { class: 'v' },
            el(
              'label',
              { class: 'switch-row' },
              el('input', {
                type: 'checkbox',
                class: 'switch',
                checked: s.allow_execute !== false,
                onchange: async (e) => {
                  const on = e.target.checked;
                  try {
                    state.config = await api.put('/config', { allow_execute: on });
                    await refreshStatus();
                    render();
                    toast(on ? '已允许执行接口' : '已关闭接口执行');
                  } catch (err) {
                    toast(err.message, true);
                    render();
                  }
                }
              }),
              el(
                'span',
                { class: `tag ${s.allow_execute !== false ? 'ok' : 'warn'}` },
                s.allow_execute !== false ? '已允许' : '已关闭'
              )
            )
          )
        ),
        el(
          'div',
          { class: 'hint mt12' },
          '只读模式下，同步 OpenAPI、删除接口、增删改环境与变量、修改执行计划都会被拒绝；',
          '「允许执行接口」与写入权限独立，关闭后 execute_api / execute_flow 会被拒绝。'
        ),
        s.allow_write === false
          ? el('div', { class: 'notice mt12' }, el('span', {}, '⚠'), el('div', {}, '当前为只读模式，Agent 只能读取接口定义，任何写入都会被拒绝。'))
          : null
      )
    ),

    el(
      'div',
      { class: 'section' },
      el('div', { class: 'section-title' }, '数据目录'),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'kv' },
          el('span', { class: 'k' }, '数据目录'),
          el('span', { class: 'v mono' }, s.data_root || '-'),
          el('span', { class: 'k' }, '项目数'),
          el('span', { class: 'v' }, `${state.projects.length} 个（已授权 ${authorized || '全部'}）`),
          el('span', { class: 'k' }, '读写方式'),
          el('span', { class: 'v' }, el('span', { class: 'tag ok' }, '本地读写'))
        ),
        el(
          'div',
          { class: 'hint mt12' },
          '所有改动直接写入本软件的数据目录，保存后即时生效，无需手动同步。'
        )
      )
    ),

    projectAuthSection(),

    el(
      'div',
      { class: 'section' },
      el('div', { class: 'section-title' }, '快速开始'),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'hint' },
          '1. 打开「客户端配置」，复制 Cursor 的一段配置到 ~/.cursor/mcp.json',
          el('br'),
          '2. 重启 Cursor，在对话里让它调用 apimcp_list_projects',
          el('br'),
          '3. 改完接口保存即写入数据目录，刷新页面就能看到'
        ),
        el(
          'div',
          { class: 'btn-row mt12' },
          el(
            'button',
            {
              class: 'primary',
              onclick: () => {
                state.view = 'clients';
                render();
              }
            },
            '去配置客户端'
          )
        )
      )
    )
  );
}

/* ---------------- 视图：项目授权（总览页） ---------------- */

function toggleProjectAuthorization(projectId, checked) {
  const list = new Set(state.config.allowed_project_ids || []);
  if (checked) list.add(projectId);
  else list.delete(projectId);
  return api
    .put('/config', { allowed_project_ids: [...list] })
    .then(async (cfg) => {
      state.config = cfg;
      await refreshProjects();
      render();
      toast(checked ? '已授权' : '已取消授权');
    })
    .catch((err) => toast(err.message, true));
}

/** 新建项目弹窗：空数据目录下唯一的入口 */
function openCreateProjectDialog() {
  const nameInput = el('input', { type: 'text', placeholder: '项目名称，最多 64 个字符' });
  const introInput = el('textarea', { rows: '3', placeholder: '项目说明（可选）' });
  const errorLine = el('div', { class: 'hint', style: 'color:var(--color-error)' });

  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      errorLine.textContent = '请填写项目名称';
      nameInput.focus();
      return;
    }
    try {
      const res = await api.post('/projects', { name, intro: introInput.value.trim() });
      closeModal();
      await refreshProjects();
      const created = res?.project;
      if (created?.project_id) {
        // 项目/环境/设计器三处状态一起切到新项目，否则设计页还会停在空状态
        state.currentProjectId = created.project_id;
        state.designProjectId = created.project_id;
        if (window.ApiDesign?.state) {
          window.ApiDesign.state.projectId = created.project_id;
          window.ApiDesign.state.selectedId = null;
          window.ApiDesign.state.data = null;
          window.ApiDesign.state.tree = [];
          window.ApiDesign.state.apiIndex = [];
        }
        await refreshEnvironments(created.project_id);
      }
      render();
      toast(`项目「${created?.name || name}」已创建`);
    } catch (err) {
      errorLine.textContent = err.message;
    }
  };

  showModal(
    '新建项目',
    el(
      'div',
      { class: 'row-gap' },
      el('div', { class: 'hint' }, '项目数据会保存在本软件的数据目录里，可立即用来设计接口。'),
      nameInput,
      introInput,
      errorLine
    ),
    [
      el('button', { onclick: () => closeModal() }, '取消'),
      el('button', { class: 'primary', onclick: submit }, '创建')
    ]
  );
  nameInput.focus();
}

/** 「总览」里的项目授权卡片：勾选决定 MCP 是否能访问该项目 */
function projectAuthSection() {
  const rows = state.projects.map((p) =>
    el(
      'tr',
      {},
      el(
        'td',
        { style: 'width:52px' },
        el('label', { class: 'check' }, el('input', {
          type: 'checkbox',
          checked: Boolean(p.authorized),
          onchange: (e) => toggleProjectAuthorization(p.project_id, e.target.checked)
        }))
      ),
      el(
        'td',
        {},
        el('div', { style: 'font-weight:500;color:var(--font-title)' }, p.name),
        el('div', { class: 'hint mono' }, p.project_id)
      ),
      el('td', { style: 'width:160px' }, fmtTime(p.updated_at)),
      el(
        'td',
        { style: 'width:90px' },
        el(
          'button',
          {
            class: 'small',
            onclick: () => {
              state.activeProject = p.project_id;
              state.view = 'detail';
              loadProjectData(p.project_id).then(render).catch((e) => toast(e.message, true));
            }
          },
          '浏览'
        )
      )
    )
  );

  return el(
    'div',
    { class: 'section' },
    el(
      'div',
      { class: 'section-head' },
      el('div', { class: 'section-title' }, '项目授权'),
      el('button', { class: 'small primary', onclick: openCreateProjectDialog }, '+ 新建项目')
    ),
    el(
      'div',
      { class: 'card' },
      state.projects.length === 0
        ? el(
            'div',
            { class: 'empty' },
            '还没有项目。',
            el('div', { class: 'mt12' },
              el('button', { class: 'primary', onclick: openCreateProjectDialog }, '+ 新建项目')
            )
          )
        : el(
            'div',
            { class: 'table-wrap' },
            el(
              'table',
              {},
              el(
                'thead',
                {},
                el(
                  'tr',
                  {},
                  el('th', { style: 'width:52px' }, '授权'),
                  el('th', {}, '项目'),
                  el('th', { style: 'width:160px' }, '更新时间'),
                  el('th', { style: 'width:90px' }, '操作')
                )
              ),
              el('tbody', {}, rows)
            )
          ),
      el(
        'div',
        { class: 'hint mt12' },
        '取消勾选的项目对 MCP 客户端不可见；全部取消后按「未限制」处理，即所有项目都可访问。'
      )
    )
  );
}


function renderTreeNode(node, depth = 0) {
  const indent = 14 + depth * 16;
  const typeIcon = node.target_type === 'folder' ? '📁' : node.target_type === 'doc' ? '📄' : node.target_type === 'sse' ? '📡' : '';

  const row = el(
    'div',
    { class: 'tree-node', style: `padding-left:${indent}px` },
    el('span', { style: 'width:26px' }, typeIcon),
    node.method ? el('span', { class: `method ${node.method}` }, node.method) : null,
    el('span', { class: 'name' }, node.name || node.url || node.target_id),
    node.url ? el('span', { class: 'url' }, node.url) : null,
    node.target_type === 'api'
      ? el(
          'button',
          {
            class: 'small',
            style: 'margin-left:auto',
            onclick: async (e) => {
              e.stopPropagation();
              try {
                toast('正在执行…');
                const res = await api.post(`/projects/${state.activeProject}/run`, { target_id: node.target_id });
                state.runResult = res;
                toast(res.status === 'passed' ? '执行通过' : `执行失败：${res.error || ''}`, res.status !== 'passed');
                await loadProjectData(state.activeProject);
                render();
              } catch (err) {
                toast(err.message, true);
              }
            }
          },
          '执行'
        )
      : null
  );

  const children = (node.children || []).map((c) => renderTreeNode(c, depth + 1));
  return el('div', {}, row, ...children);
}

function viewProjectDetail() {
  const project = state.projects.find((p) => p.project_id === state.activeProject);
  if (!project) {
    return el('div', { class: 'empty' }, '项目未加载');
  }
  const tree = state.tree?.tree || [];
  const counts = state.tree?.counts || {};

  return el(
    'div',
    {},
    el(
      'div',
      { class: 'row-gap' },
      el(
        'button',
        {
          class: 'small',
          onclick: () => {
            state.view = 'overview';
            render();
          }
        },
        '← 返回'
      ),
      el('h1', { class: 'page-title', style: 'margin:0' }, project.name),
      el('span', { class: 'hint mono' }, project.project_id)
    ),
    el(
      'p',
      { class: 'page-sub' },
      `接口 ${counts.api || 0} · 目录 ${counts.folder || 0} · 文档 ${counts.doc || 0} · 环境 ${counts.environments || 0} · 执行计划 ${counts.flows || 0}`
    ),

    el(
      'div',
      { class: 'grid-2' },
      el(
        'div',
        { class: 'section' },
        el('div', { class: 'section-title' }, '接口目录'),
        el('div', { class: 'card', style: 'max-height:480px;overflow:auto' }, tree.length ? tree.map((n) => renderTreeNode(n)) : el('div', { class: 'empty' }, '暂无接口'))
      ),
      el(
        'div',
        {},
        el(
          'div',
          { class: 'section' },
          el('div', { class: 'section-title' }, '执行计划'),
          el(
            'div',
            { class: 'card', style: 'max-height:200px;overflow:auto' },
            state.flows.length === 0
              ? el('div', { class: 'empty' }, '暂无执行计划')
              : state.flows.map((f) =>
                  el(
                    'div',
                    { class: 'diff-row' },
                    el('span', { class: 'tag info' }, `${f.step_count} 步`),
                    el('span', { style: 'flex:1' }, f.name),
                    el('span', { class: 'hint' }, fmtTime(f.updated_at))
                  )
                )
          )
        ),
        el(
          'div',
          { class: 'section' },
          el('div', { class: 'section-title' }, '最近执行'),
          el(
            'div',
            { class: 'card', style: 'max-height:260px;overflow:auto' },
            state.runs.length === 0
              ? el('div', { class: 'empty' }, '暂无执行记录')
              : state.runs.map((r) =>
                  el(
                    'div',
                    { class: 'diff-row' },
                    el('span', { class: `tag ${r.status === 'passed' ? 'ok' : 'err'}` }, r.status === 'passed' ? '通过' : '失败'),
                    el('span', { style: 'flex:1' }, r.flow_name || `单接口 · ${r.total} 步`),
                    el('span', { class: 'hint' }, fmtDuration(r.elapsed_ms)),
                    el('span', { class: 'hint' }, fmtTime(r.started_at))
                  )
                )
          )
        )
      )
    ),

    state.runResult
      ? el(
          'div',
          { class: 'section mt16' },
          el('div', { class: 'section-title' }, '最近一次执行结果'),
          el(
            'div',
            { class: 'card' },
            el(
              'div',
              { class: 'kv' },
              el('span', { class: 'k' }, '状态'),
              el('span', { class: 'v' }, el('span', { class: `tag ${state.runResult.status === 'passed' ? 'ok' : 'err'}` }, state.runResult.status === 'passed' ? '通过' : '失败')),
              el('span', { class: 'k' }, 'run_id'),
              el('span', { class: 'v mono' }, state.runResult.run_id),
              el('span', { class: 'k' }, '耗时'),
              el('span', { class: 'v' }, fmtDuration(state.runResult.elapsed_ms)),
              state.runResult.error ? el('span', { class: 'k' }, '错误') : null,
              state.runResult.error ? el('span', { class: 'v', style: 'color:var(--color-error)' }, state.runResult.error) : null
            ),
            state.runResult.assertions?.length
              ? el(
                  'div',
                  { class: 'mt12' },
                  el('div', { class: 'hint', style: 'margin-bottom:6px' }, '断言'),
                  ...state.runResult.assertions.map((a) =>
                    el('div', { class: 'diff-row' }, el('span', { class: `tag ${a.passed ? 'ok' : 'err'}` }, a.passed ? '通过' : '失败'), el('span', { style: 'flex:1' }, a.name), a.message ? el('span', { class: 'hint' }, a.message) : null)
                  )
                )
              : null
          )
        )
      : null
  );
}

/* ---------------- 视图：客户端配置 ---------------- */

async function viewClients() {
  if (!state.clientConfigs) {
    state.clientConfigs = await api.get('/client-config');
  }
  const cfg = state.clientConfigs;
  const tabs = [
    ['cursor', 'Cursor'],
    ['codex', 'Codex'],
    ['claude_code', 'Claude Code'],
    ['vscode', 'VS Code'],
    ['workbuddy', 'WorkBuddy'],
    ['trae', 'Trae'],
    ['http', 'HTTP (Streamable)']
  ];
  if (!state.currentTab) state.currentTab = 'cursor';

  const content = cfg.configs[state.currentTab] || '';
  const isHttp = state.currentTab === 'http';

  return el(
    'div',
    {},
    el('h1', { class: 'page-title' }, '客户端配置'),
    el('p', { class: 'page-sub' }, `可执行文件：${cfg.command}`),

    el(
      'div',
      { class: 'notice info' },
      el('span', {}, 'ℹ'),
      el(
        'div',
        {},
        `stdio 模式（推荐）：客户端拉起的命令是 "${cfg.command} --stdio"，直接读取本软件的数据目录。`,
        el('br'),
        'HTTP 模式需把 <token> 换成上方总览里显示的 Bearer Token。'
      )
    ),

    el(
      'div',
      { class: 'tabs' },
      ...tabs.map(([key, label]) =>
        el(
          'div',
          {
            class: `tab${state.currentTab === key ? ' active' : ''}`,
            onclick: () => {
              state.currentTab = key;
              render();
            }
          },
          label
        )
      )
    ),

    el('pre', { class: 'code' }, content),
    el(
      'div',
      { class: 'btn-row mt12' },
      el(
        'button',
        {
          class: 'primary',
          onclick: async () => {
            const res = await copyText(content);
            if (res.ok) toast('已复制到剪贴板');
            else toastCopyFailed(res.error);
          }
        },
        '复制配置'
      ),
      isHttp
        ? el(
            'span',
            { class: 'hint' },
            'HTTP 模式下需保证本服务常驻运行（可把它加入开机启动）'
          )
        : el('span', { class: 'hint' }, '把这段粘贴到对应客户端的 MCP 配置文件中')
    ),

    el(
      'div',
      { class: 'section mt16' },
      el('div', { class: 'section-title' }, '配置位置参考'),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'kv' },
          el('span', { class: 'k' }, 'Cursor'),
          el('span', { class: 'v mono' }, '%USERPROFILE%\\.cursor\\mcp.json'),
          el('span', { class: 'k' }, 'Claude Code'),
          el('span', { class: 'v mono' }, '%USERPROFILE%\\.claude\\claude_desktop_config.json'),
          el('span', { class: 'k' }, 'VS Code'),
          el('span', { class: 'v mono' }, '%APPDATA%\\Code\\User\\mcp.json'),
          el('span', { class: 'k' }, 'Trae'),
          el('span', { class: 'v mono' }, 'Trae 设置 → MCP → 添加（粘 JSON）'),
          el('span', { class: 'k' }, 'Codex'),
          el('span', { class: 'v mono' }, '%USERPROFILE%\\.codex\\config.toml')
        )
      )
    )
  );
}

/* ---------------- 视图：工具清单 ---------------- */

function viewTools() {
  const groups = [
    ['项目与 API', ['apimcp_list_projects', 'apimcp_create_project', 'apimcp_list_apis', 'apimcp_get_api_detail', 'apimcp_sync_openapi', 'apimcp_delete_apis']],
    ['接口执行', ['apimcp_execute_api']],
    ['环境与变量', ['apimcp_list_environments', 'apimcp_switch_environment', 'apimcp_create_environment', 'apimcp_update_environment', 'apimcp_delete_environment', 'apimcp_list_environment_servers', 'apimcp_create_environment_server', 'apimcp_update_environment_server', 'apimcp_delete_environment_server', 'apimcp_get_environment_variables', 'apimcp_upsert_environment_variable', 'apimcp_delete_environment_variable', 'apimcp_get_global_variables', 'apimcp_upsert_global_variable', 'apimcp_delete_global_variable', 'apimcp_get_global_params', 'apimcp_update_global_params']],
    ['执行计划', ['apimcp_create_execution_flow', 'apimcp_update_execution_flow', 'apimcp_list_execution_flows', 'apimcp_get_execution_flow', 'apimcp_delete_execution_flow', 'apimcp_execute_flow']],
    ['执行历史', ['apimcp_list_execution_runs', 'apimcp_get_execution_result']],
    ['导入导出', ['apimcp_import_project', 'apimcp_export_project']]
  ];

  const known = new Set(groups.flatMap((g) => g[1]));
  const total = known.size;

  return el(
    'div',
    {},
    el('h1', { class: 'page-title' }, '工具清单'),
    el('p', { class: 'page-sub' }, `共 ${total} 个 apimcp_* 工具`),
    ...groups.map(([name, tools]) =>
      el(
        'div',
        { class: 'section' },
        el('div', { class: 'section-title' }, `${name}（${tools.length}）`),
        el(
          'div',
          { class: 'card' },
          ...tools.map((t) =>
            el(
              'div',
              { class: 'diff-row' },
              el('span', { class: 'mono', style: 'color:var(--color-primary);min-width:290px' }, t),
              el('span', { class: 'hint' }, TOOL_DESC[t] || '')
            )
          )
        )
      )
    )
  );
}

const TOOL_DESC = {
  apimcp_list_projects: '获取已授权项目清单',
  apimcp_create_project: '本地新建项目并自动授权',
  apimcp_list_apis: '查询目录、接口与文档清单',
  apimcp_get_api_detail: '读取接口完整定义、参数、响应和脚本',
  apimcp_sync_openapi: '将 OpenAPI 3.0/3.1 同步到项目',
  apimcp_delete_apis: '按接口 ID 删除（级联子项）',
  apimcp_execute_api: '按定义执行单个 HTTP 接口',
  apimcp_list_environments: '查询项目环境和当前环境',
  apimcp_switch_environment: '切换项目当前执行环境',
  apimcp_create_environment: '新建环境',
  apimcp_update_environment: '修改环境名称或默认服务地址',
  apimcp_delete_environment: '删除指定环境',
  apimcp_list_environment_servers: '查询项目服务与环境地址',
  apimcp_create_environment_server: '新增共享服务并设置环境地址',
  apimcp_update_environment_server: '修改服务名称或环境地址',
  apimcp_delete_environment_server: '删除共享服务',
  apimcp_get_environment_variables: '读取环境变量与运行时值',
  apimcp_upsert_environment_variable: '新增或修改环境变量',
  apimcp_delete_environment_variable: '删除环境变量',
  apimcp_get_global_variables: '读取项目全局变量',
  apimcp_upsert_global_variable: '新增或修改全局变量',
  apimcp_delete_global_variable: '删除全局变量',
  apimcp_get_global_params: '读取项目全局参数（header/query/body/鉴权/脚本）',
  apimcp_update_global_params: '局部更新全局参数，只覆盖传入的 section',
  apimcp_create_execution_flow: '创建执行计划（固化接口快照）',
  apimcp_update_execution_flow: '更新已有执行计划',
  apimcp_list_execution_flows: '查询执行计划摘要',
  apimcp_get_execution_flow: '读取执行计划完整详情',
  apimcp_delete_execution_flow: '删除指定执行计划',
  apimcp_execute_flow: '串行执行执行计划',
  apimcp_list_execution_runs: '查询执行历史摘要',
  apimcp_get_execution_result: '读取逐步骤请求、响应、断言与日志'
};

/* ---------------- 视图：外观设置 ---------------- */

function viewAppearance() {
  const cfg = state.config || {};
  const themes = [
    { key: 'golden', name: '暖纸金', side: '#f3ead8', main: '#faf5ea' },
    { key: 'dark', name: '暗色', side: '#241f17', main: '#17140f' },
    { key: 'custom', name: '自定义底色', side: '', main: '' }
  ];

  const save = async (patch) => {
    try {
      state.config = await api.put('/config', patch);
      applyTheme();
      render();
      toast('已保存');
    } catch (err) {
      toast(err.message, true);
    }
  };

  return el(
    'div',
    {},
    el('h1', { class: 'page-title' }, '外观设置'),
    el('p', { class: 'page-sub' }, '配色取自 Apipost 官方主题 token'),

    el(
      'div',
      { class: 'section' },
      el('div', { class: 'section-title' }, '主题'),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'theme-grid' },
          ...themes.map((t) =>
            el(
              'div',
              {
                class: `theme-card${cfg.theme === t.key ? ' active' : ''}`,
                onclick: () => save({ theme: t.key })
              },
              el(
                'div',
                { class: 'theme-preview' },
                el('div', { class: 'side', style: `background:${t.side || cfg.theme_custom_bg || '#f3ead8'}` }),
                el('div', { class: 'main', style: `background:${t.main || cfg.theme_custom_bg || '#faf5ea'}` })
              ),
              el('div', { class: 'theme-name' }, t.name)
            )
          )
        ),
        cfg.theme === 'custom'
          ? el(
              'div',
              { class: 'row-gap mt16' },
              el('label', { class: 'hint' }, '自定义底色'),
              el('input', {
                type: 'text',
                style: 'width:140px',
                value: cfg.theme_custom_bg || '#faf5ea',
                placeholder: '#faf5ea',
                onchange: (e) => save({ theme_custom_bg: e.target.value })
              }),
              el('input', {
                type: 'color',
                style: 'width:44px;height:30px;padding:2px',
                value: cfg.theme_custom_bg || '#faf5ea',
                onchange: (e) => save({ theme_custom_bg: e.target.value })
              }),
              el('span', { class: 'hint' }, '侧栏与内容区会按同一底色自动推导')
            )
          : null,
        el(
          'div',
          { class: 'row-gap mt16' },
          el(
            'label',
            { class: 'check' },
            el('input', {
              type: 'checkbox',
              checked: Boolean(cfg.follow_system_theme),
              onchange: (e) => save({ follow_system_theme: e.target.checked })
            }),
            '跟随系统深色模式'
          )
        )
      )
    ),

    el(
      'div',
      { class: 'section' },
      el('div', { class: 'section-title' }, '字号缩放'),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'row-gap' },
          el('input', {
            type: 'range',
            min: '85',
            max: '130',
            step: '5',
            style: 'width:220px',
            value: String(cfg.font_scale || 100),
            oninput: (e) => {
              document.documentElement.style.setProperty('--font-scale', String(Number(e.target.value) / 100));
            },
            onchange: (e) => save({ font_scale: Number(e.target.value) })
          }),
          el('span', { class: 'hint' }, `${cfg.font_scale || 100}%（界面整体缩放比例）`)
        )
      )
    ),

    el(
      'div',
      { class: 'section' },
      el('div', { class: 'section-title' }, '数据目录'),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'row-gap' },
          el('input', {
            type: 'text',
            value: cfg.data_root || state.status?.official_root || '',
            placeholder: '留空则使用 %APPDATA%\\ApiMCP\\data',
            onchange: (e) => save({ data_root: e.target.value || null })
          }),
          el(
            'button',
            {
              onclick: async () => {
                await refreshStatus();
                render();
                toast('已重新探测');
              }
            },
            '重新检测'
          )
        ),
        el('div', { class: 'hint mt8' }, '修改后需重启服务生效（或先保存再刷新页面验证）')
      )
    )
  );
}

/* ---------------- 视图：关于 ---------------- */

function viewAbout() {
  const s = state.status || {};
  return el(
    'div',
    {},
    el('h1', { class: 'page-title' }, '关于'),
    el('p', { class: 'page-sub' }, `API MCP v${s.version || ''}`),
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'kv' },
        el('span', { class: 'k' }, '版本'),
        el('span', { class: 'v' }, s.version || '-'),
        el('span', { class: 'k' }, 'Node'),
        el('span', { class: 'v mono' }, navigator.userAgent.match(/Node\.js\/[\d.]+/)?.[0] || '未知'),
        el('span', { class: 'k' }, '工具数'),
        el('span', { class: 'v' }, `${s.tool_count || 0} 个`),
        el('span', { class: 'k' }, '配置文件'),
        el('span', { class: 'v mono' }, s.config_path || '%APPDATA%\\ApiMCP\\config.json'),
        el('span', { class: 'k' }, '数据目录'),
        el('span', { class: 'v mono' }, s.official_root || '-')
      )
    ),
    el(
      'div',
      { class: 'notice mt16' },
      el('span', {}, '⚠'),
      el(
        'div',
        {},
        '本软件是独立工具，数据全部保存在自己的数据目录里，不会读写 Apipost 单机版的任何文件。接口数据结构参考 Apipost 的公开格式，仅此而已。'
      )
    )
  );
}

/* ---------------- 模态 ---------------- */

function showModal(title, bodyNode, footerNodes = []) {
  const root = $('modal-root');
  root.innerHTML = '';
  root.append(
    el(
      'div',
      { class: 'modal-mask', onclick: (e) => e.target === e.currentTarget && closeModal() },
      el(
        'div',
        { class: 'modal' },
        el('div', { class: 'modal-head' }, title),
        el('div', { class: 'modal-body' }, bodyNode),
        el('div', { class: 'modal-foot' }, ...footerNodes)
      )
    )
  );
}

function closeModal() {
  $('modal-root').innerHTML = '';
}

/* ---------------- 顶栏：项目 / 环境切换 ---------------- */

function renderTopbarEnvs() {
  const host = $('topbar-envs');
  if (!host) return;
  host.innerHTML = '';

  if (state.projects.length === 0) {
    host.append(el('span', { class: 'hint' }, '暂无项目'));
    return;
  }

  const projectSelect = el(
    'select',
    {
      class: 'topbar-select',
      title: '切换项目',
      onchange: async (e) => {
        state.currentProjectId = e.target.value;
        if (window.ApiDesign?.state) window.ApiDesign.state.projectId = e.target.value;
        if (state.view === 'design' && window.ApiDesign?.hasUnsaved?.()) {
          if (!confirm('接口编辑器有未保存的修改，确定切换项目？')) {
            e.target.value = state.currentProjectId;
            return;
          }
          window.ApiDesign.discardUnsaved();
        }
        await refreshEnvironments(e.target.value);
        if (window.ApiEnvvars) {
          window.ApiEnvvars.state.projectId = e.target.value;
          window.ApiEnvvars.state.activeEnvId = '';
        }
        render();
        if (state.view === 'envvars') await window.ApiEnvvars.reload();
        if (state.view === 'transfer' && window.ApiTransfer) await window.ApiTransfer.reload();
      }
    },
    ...state.projects.map((p) =>
      el('option', { value: p.project_id, ...(p.project_id === state.currentProjectId ? { selected: true } : {}) }, p.name)
    )
  );

  const envSelect = el(
    'select',
    {
      class: 'topbar-select',
      title: '切换环境',
      disabled: state.environments.length === 0,
      onchange: async (e) => {
        try {
          await switchEnvironment(state.currentProjectId, e.target.value);
          if (state.view === 'envvars' && window.ApiEnvvars) await window.ApiEnvvars.reload();
          render();
        } catch (err) {
          toast(err.message, true);
        }
      }
    },
    ...state.environments.map((env) =>
      el('option', { value: env.env_id, ...(env.env_id === state.currentEnvId ? { selected: true } : {}) }, env.name || env.env_id)
    )
  );

  host.append(el('span', { class: 'hint' }, '项目'), projectSelect, el('span', { class: 'hint' }, '环境'), envSelect);
}

/* ---------------- 主渲染 ---------------- */

function render() {
  renderSidebar();
  renderTopbarEnvs();
  const content = $('content');
  content.innerHTML = '';

  // 切走接口设计页时解绑 Ctrl+S，避免全局副作用
  if (state.view !== 'design') {
    window.ApiDesign?.unbindShortcut?.();
  }

  // 供子模块（最近 / 接口设计）访问的桥接
  window.__consoleState = state;
  window.__consoleToast = toast;
  window.__consoleApi = api;
  window.__consoleRender = render;
  window.__consoleCopy = copyText;
  window.__consoleCopyFailed = toastCopyFailed;
  window.__consoleCloseModal = closeModal;
  window.__consoleShowModal = showModal;
  window.__consoleOpenDesign = async (projectId, targetId) => {
    if (state.view === 'design' && window.ApiDesign?.hasUnsaved?.()) {
      if (!confirm('接口编辑器有未保存的修改，确定离开？')) return;
      window.ApiDesign.discardUnsaved();
    }
    state.designProjectId = projectId;
    state.view = 'design';
    render();
    // 等设计器首屏渲染完再定位到指定接口
    setTimeout(async () => {
      try {
        if (window.ApiDesign?.state) {
          window.ApiDesign.state.projectId = projectId;
        }
        if (window.ApiDesign?.openTarget) await window.ApiDesign.openTarget(projectId, targetId);
      } catch {}
    }, 120);
  };

  let viewNode;
  switch (state.view) {
    case 'recent':
      viewNode = window.RecentView ? window.RecentView.view() : el('div', { class: 'empty' }, '最近面板加载失败');
      break;
    case 'overview':
      viewNode = viewOverview();
      break;
    case 'design':
      viewNode = window.ApiDesign ? window.ApiDesign.view() : el('div', { class: 'empty' }, '编辑器加载失败');
      break;
    case 'envvars':
      viewNode = window.ApiEnvvars ? window.ApiEnvvars.view() : el('div', { class: 'empty' }, '环境与变量加载失败');
      break;
    case 'transfer':
      viewNode = window.ApiTransfer ? window.ApiTransfer.view() : el('div', { class: 'empty' }, '导入导出加载失败');
      break;
    case 'detail':
      viewNode = viewProjectDetail();
      break;
    case 'clients':
      viewNode = el('div', { class: 'empty' }, '加载中…');
      viewClients()
        .then((node) => {
          if (state.view === 'clients') {
            content.innerHTML = '';
            content.append(node);
          }
        })
        .catch((e) => toast(e.message, true));
      break;
    case 'tools':
      viewNode = viewTools();
      break;
    case 'appearance':
      viewNode = viewAppearance();
      break;
    case 'about':
      viewNode = viewAbout();
      break;
    default:
      viewNode = viewOverview();
  }
  if (viewNode) content.append(viewNode);
}

/* ---------------- 启动 ---------------- */

async function boot() {
  applyTheme();
  try {
    await refreshConfig();
    await refreshStatus();
    await refreshProjects();
    await refreshEnvironments(state.currentProjectId);
  } catch (err) {
    toast(err.message, true);
  }
  render();

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.config?.follow_system_theme) applyTheme();
  });

  setInterval(() => {
    refreshStatus().catch(() => {});
  }, 15000);
}

boot();
