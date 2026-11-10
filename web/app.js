/* API MCP 控制台 */

const UI_TOKEN = new URLSearchParams(location.search).get('ui') || '';
/** 桌面端（Electron 壳）注入 apipostShell；浏览器访问时为 undefined */
const IS_DESKTOP = Boolean(window.apipostShell && window.apipostShell.isDesktop);

if (IS_DESKTOP) {
  document.addEventListener('DOMContentLoaded', () => document.body.classList.add('is-desktop'));
}

/** 原生标题栏按钮区跟随主题 */
function syncTitleBarColors() {
  if (!IS_DESKTOP || typeof window.apipostShell.setTitleBarColors !== 'function') return;
  const style = getComputedStyle(document.documentElement);
  const color = style.getPropertyValue('--bg-header').trim();
  const symbolColor = style.getPropertyValue('--font-title').trim();
  if (!color || !symbolColor) return;
  window.apipostShell.setTitleBarColors({ color, symbolColor });
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
  { key: 'recent', label: '最近', icon: '◷' },
  { key: 'overview', label: '总览', icon: '◉' },
  { key: 'projects', label: '项目与同步', icon: '▤' },
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
      if (state.view === 'design' && window.ApiDesign?.state?.dirty) {
        if (!confirm('接口编辑器有未保存的修改，确定离开？')) return;
        window.ApiDesign.state.dirty = false;
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
  const behind = state.projects.filter((p) => p.sync?.state === 'behind' || p.sync?.state === 'diverged').length;

  return el(
    'div',
    {},
    el('h1', { class: 'page-title' }, '总览'),
    el('p', { class: 'page-sub' }, 'API 单机版 MCP 服务'),

    !s.official_root_ok
      ? el(
          'div',
          { class: 'notice' },
          el('span', {}, '⚠'),
          el(
            'div',
            {},
            '未找到 API 单机版数据目录。请先安装并打开 API 单机版，或在「外观设置」中指定数据目录。',
            el('div', { class: 'hint mt8' }, `当前探测路径：${s.official_root}`)
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
          el('span', { class: 'k' }, '官方目录'),
          el('span', { class: 'v mono' }, s.official_root || '-'),
          el('span', { class: 'k' }, '影子目录'),
          el('span', { class: 'v mono' }, s.shadow_root || '-'),
          el('span', { class: 'k' }, '项目数'),
          el('span', { class: 'v' }, `${state.projects.length} 个（已授权 ${authorized || '全部'}）`),
          el('span', { class: 'k' }, '待同步'),
          el(
            'span',
            { class: 'v' },
            behind > 0 ? el('span', { class: 'tag warn' }, `${behind} 个项目需处理`) : el('span', { class: 'tag ok' }, '全部最新')
          )
        ),
        el(
          'div',
          { class: 'hint mt12' },
          '所有 MCP 写入只落在影子目录，需在「项目与同步」中手动推送到 API 单机版。'
        )
      )
    ),

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
          '2. 重启 Cursor，在对话里让它调用 apipost_list_projects',
          el('br'),
          '3. 改完接口后回到「项目与同步」点「推送」，API 单机版即可看到改动'
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
          ),
          el(
            'button',
            {
              onclick: () => {
                state.view = 'projects';
                render();
              }
            },
            '管理项目同步'
          )
        )
      )
    )
  );
}

/* ---------------- 视图：项目与同步 ---------------- */

const SYNC_LABEL = {
  synced: { text: '已同步', cls: 'ok' },
  ahead: { text: '待推送', cls: 'info' },
  behind: { text: '官方有更新', cls: 'warn' },
  diverged: { text: '有冲突', cls: 'err' },
  not_pulled: { text: '未拉取', cls: '' },
  unknown: { text: '未知', cls: '' },
  error: { text: '异常', cls: 'err' }
};

function viewProjects() {
  const rows = state.projects.map((p) => {
    const sync = p.sync || { state: 'not_pulled', changed_files: 0 };
    const label = SYNC_LABEL[sync.state] || SYNC_LABEL.unknown;
    const authorized = p.authorized;

    return el(
      'tr',
      {},
      el(
        'td',
        {},
        el('label', { class: 'check' }, el('input', {
          type: 'checkbox',
          checked: authorized,
          onchange: async (e) => {
            const list = new Set(state.config.allowed_project_ids || []);
            if (e.target.checked) list.add(p.project_id);
            else list.delete(p.project_id);
            try {
              state.config = await api.put('/config', { allowed_project_ids: [...list] });
              await refreshProjects();
              render();
              toast(e.target.checked ? '已授权' : '已取消授权');
            } catch (err) {
              toast(err.message, true);
            }
          }
        }))
      ),
      el(
        'td',
        {},
        el('div', { style: 'font-weight:500;color:var(--font-title)' }, p.name),
        el('div', { class: 'hint mono' }, p.project_id)
      ),
      el('td', {}, el('span', { class: `tag ${label.cls}` }, label.text), sync.changed_files ? el('span', { class: 'hint', style: 'margin-left:6px' }, `${sync.changed_files} 个文件`) : null),
      el(
        'td',
        {},
        p.counts
          ? el(
              'div',
              { class: 'hint' },
              `接口 ${p.counts.api} · 目录 ${p.counts.folder} · 环境 ${p.counts.environments} · 计划 ${p.counts.flows}`
            )
          : el('span', { class: 'hint' }, '-')
      ),
      el('td', {}, fmtTime(p.updated_at)),
      el(
        'td',
        {},
        el(
          'div',
          { class: 'btn-row' },
          el(
            'button',
            {
              class: 'small',
              onclick: async () => {
                try {
                  await api.post(`/projects/${p.project_id}/pull`, { force: sync.state !== 'ahead' && sync.state !== 'diverged' });
                  await refreshProjects();
                  render();
                  toast('已从 API 拉取最新数据');
                } catch (err) {
                  toast(err.message, true);
                }
              }
            },
            '拉取'
          ),
          el(
            'button',
            {
              class: 'small',
              disabled: sync.changed_files === 0,
              onclick: async () => {
                try {
                  const diff = await api.get(`/projects/${p.project_id}/diff`);
                  openPushModal(p, diff);
                } catch (err) {
                  toast(err.message, true);
                }
              }
            },
            '推送'
          ),
          el(
            'button',
            {
              class: 'small',
              onclick: async () => {
                try {
                  const diff = await api.get(`/projects/${p.project_id}/diff`);
                  openDiffModal(p, diff);
                } catch (err) {
                  toast(err.message, true);
                }
              }
            },
            '查看差异'
          ),
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
  });

  return el(
    'div',
    {},
    el('h1', { class: 'page-title' }, '项目与同步'),
    el('p', { class: 'page-sub' }, '官方目录只读 · 改动先落影子工作区 · 手动推送'),

    el(
      'div',
      { class: 'notice info' },
      el('span', {}, 'ℹ'),
      el(
        'div',
        {},
        '「拉取」把 API 的最新数据同步到影子；「推送」把影子里的改动写回 API。两侧都有改动时会标为「有冲突」，需逐文件选择保留哪一侧。'
      )
    ),

    state.projects.length === 0
      ? el('div', { class: 'empty' }, '还没有发现任何项目。请先在 API 单机版里新建项目。')
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
                el('th', { style: 'width:170px' }, '同步状态'),
                el('th', { style: 'width:230px' }, '内容'),
                el('th', { style: 'width:150px' }, '更新时间'),
                el('th', { style: 'width:270px' }, '操作')
              )
            ),
            el('tbody', {}, rows)
          )
        )
  );
}

function openDiffModal(project, diff) {
  const body = el('div', {});
  if (!diff.entries || diff.entries.length === 0) {
    body.append(el('div', { class: 'empty' }, '没有差异，两侧数据一致。'));
  } else {
    for (const entry of diff.entries) {
      const kindMap = {
        ahead: ['影子已修改', 'info'],
        behind: ['官方已修改', 'warn'],
        conflict: ['冲突', 'err'],
        shadow_added: ['影子新增', 'info'],
        shadow_deleted: ['影子删除', 'warn'],
        official_added: ['官方新增', 'warn'],
        official_deleted: ['官方删除', 'warn']
      };
      const [text, cls] = kindMap[entry.kind] || [entry.kind, ''];
      body.append(
        el(
          'div',
          { class: 'diff-row' },
          el('span', { class: `tag ${cls}` }, text),
          el('span', { class: 'path' }, entry.path)
        )
      );
    }
  }

  showModal(`与 API 的差异 · ${project.name}`, body, [el('button', { onclick: closeModal }, '关闭')]);
}

function openPushModal(project, diff) {
  const selections = {};
  const body = el('div', {});

  const pushable = (diff.entries || []).filter((e) =>
    ['ahead', 'shadow_added', 'shadow_deleted', 'conflict'].includes(e.kind)
  );

  if (pushable.length === 0) {
    body.append(el('div', { class: 'empty' }, '影子工作区没有需要推送的改动。'));
  } else {
    body.append(
      el('div', { class: 'hint', style: 'margin-bottom:10px' }, `将推送 ${pushable.length} 个文件到 API 单机版：`)
    );
    for (const entry of pushable) {
      const isConflict = entry.kind === 'conflict';
      body.append(
        el(
          'div',
          { class: 'diff-row' },
          el('span', { class: `tag ${isConflict ? 'err' : 'info'}` }, isConflict ? '冲突' : '变更'),
          el('span', { class: 'path' }, entry.path),
          isConflict
            ? el(
                'select',
                {
                  style: 'width:150px',
                  onchange: (e) => {
                    selections[entry.path] = e.target.value;
                  }
                },
                el('option', { value: '' }, '选择保留…'),
                el('option', { value: 'shadow' }, '用影子覆盖'),
                el('option', { value: 'official' }, '保留官方')
              )
            : el('span', { class: 'tag ok' }, '使用影子')
        )
      );
    }
  }

  const doPush = el(
    'button',
    {
      class: 'primary',
      disabled: pushable.length === 0,
      onclick: async () => {
        try {
          const res = await api.post(`/projects/${project.project_id}/push`, { selections });
          closeModal();
          await refreshProjects();
          render();
          toast(`已推送 ${res.applied.length} 个文件到 API`);
        } catch (err) {
          toast(err.message, true);
        }
      }
    },
    '确认推送'
  );

  showModal(`推送到 API · ${project.name}`, body, [
    el('button', { onclick: closeModal }, '取消'),
    doPush
  ]);
}

/* ---------------- 视图：项目详情 ---------------- */

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
            state.view = 'projects';
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
        `stdio 模式（推荐）：客户端拉起的命令是 "${cfg.command} --stdio"，直接从影子读取数据。`,
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
            try {
              await navigator.clipboard.writeText(content);
              toast('已复制到剪贴板');
            } catch {
              toast('复制失败，请手动选择文本', true);
            }
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
    ['项目与 API', ['apipost_list_projects', 'apipost_create_project', 'apipost_list_apis', 'apipost_get_api_detail', 'apipost_sync_openapi', 'apipost_delete_apis']],
    ['接口执行', ['apipost_execute_api']],
    ['环境与变量', ['apipost_list_environments', 'apipost_switch_environment', 'apipost_create_environment', 'apipost_update_environment', 'apipost_delete_environment', 'apipost_list_environment_servers', 'apipost_create_environment_server', 'apipost_update_environment_server', 'apipost_delete_environment_server', 'apipost_get_environment_variables', 'apipost_upsert_environment_variable', 'apipost_delete_environment_variable', 'apipost_get_global_variables', 'apipost_upsert_global_variable', 'apipost_delete_global_variable']],
    ['执行计划', ['apipost_create_execution_flow', 'apipost_update_execution_flow', 'apipost_list_execution_flows', 'apipost_get_execution_flow', 'apipost_delete_execution_flow', 'apipost_execute_flow']],
    ['执行历史', ['apipost_list_execution_runs', 'apipost_get_execution_result']]
  ];

  const known = new Set(groups.flatMap((g) => g[1]));
  const total = known.size;

  return el(
    'div',
    {},
    el('h1', { class: 'page-title' }, '工具清单'),
    el('p', { class: 'page-sub' }, `共 ${total} 个与官方一致的 apipost_* 工具`),
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
  apipost_list_projects: '获取已授权项目清单与同步状态',
  apipost_create_project: '本地新建项目并自动授权',
  apipost_list_apis: '查询目录、接口与文档清单',
  apipost_get_api_detail: '读取接口完整定义、参数、响应和脚本',
  apipost_sync_openapi: '将 OpenAPI 3.0/3.1 同步到项目',
  apipost_delete_apis: '按接口 ID 删除（级联子项）',
  apipost_execute_api: '按定义执行单个 HTTP 接口',
  apipost_list_environments: '查询项目环境和当前环境',
  apipost_switch_environment: '切换项目当前执行环境',
  apipost_create_environment: '新建环境',
  apipost_update_environment: '修改环境名称或默认服务地址',
  apipost_delete_environment: '删除指定环境',
  apipost_list_environment_servers: '查询项目服务与环境地址',
  apipost_create_environment_server: '新增共享服务并设置环境地址',
  apipost_update_environment_server: '修改服务名称或环境地址',
  apipost_delete_environment_server: '删除共享服务',
  apipost_get_environment_variables: '读取环境变量与运行时值',
  apipost_upsert_environment_variable: '新增或修改环境变量',
  apipost_delete_environment_variable: '删除环境变量',
  apipost_get_global_variables: '读取项目全局变量',
  apipost_upsert_global_variable: '新增或修改全局变量',
  apipost_delete_global_variable: '删除全局变量',
  apipost_create_execution_flow: '创建执行计划（固化接口快照）',
  apipost_update_execution_flow: '更新已有执行计划',
  apipost_list_execution_flows: '查询执行计划摘要',
  apipost_get_execution_flow: '读取执行计划完整详情',
  apipost_delete_execution_flow: '删除指定执行计划',
  apipost_execute_flow: '串行执行执行计划',
  apipost_list_execution_runs: '查询执行历史摘要',
  apipost_get_execution_result: '读取逐步骤请求、响应、断言与日志'
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
    el('p', { class: 'page-sub' }, '配色取自 API 单机版主题 token'),

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
              el('span', { class: 'hint' }, '侧栏与内容区会按官方公式自动推导')
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
          el('span', { class: 'hint' }, `${cfg.font_scale || 100}%（对应官方 font_scale）`)
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
            placeholder: '留空则自动探测 %APPDATA%\\Apipost单机版',
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
    el('p', { class: 'page-sub' }, 'API MCP v1.0.0'),
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'kv' },
        el('span', { class: 'k' }, '版本'),
        el('span', { class: 'v' }, '1.0.0'),
        el('span', { class: 'k' }, 'Node'),
        el('span', { class: 'v mono' }, navigator.userAgent.match(/Node\.js\/[\d.]+/)?.[0] || '未知'),
        el('span', { class: 'k' }, '工具数'),
        el('span', { class: 'v' }, `${s.tool_count || 0} 个`),
        el('span', { class: 'k' }, '配置文件'),
        el('span', { class: 'v mono' }, s.config_path || '%APPDATA%\\ApiPostMCP\\config.json'),
        el('span', { class: 'k' }, '数据目录'),
        el('span', { class: 'v mono' }, s.official_root || '-'),
        el('span', { class: 'k' }, '影子目录'),
        el('span', { class: 'v mono' }, s.shadow_root || '-')
      )
    ),
    el(
      'div',
      { class: 'notice mt16' },
      el('span', {}, '⚠'),
      el(
        'div',
        {},
        '本软件与 Apipost 官方无隶属关系。它只按官方 MCP 工具语义读写你本机 Apipost 单机版的项目数据，且默认采用影子副本策略：官方目录只读，写入需你手动推送。'
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

/* ---------------- 主渲染 ---------------- */

function render() {
  renderSidebar();
  const content = $('content');
  content.innerHTML = '';

  // 切走接口设计页时解绑 Ctrl+S，避免全局副作用
  if (state.view !== 'design') {
    window.ApiDesign?.unbindShortcut?.();
  }

  // 供子模块（最近 / 接口设计）访问的桥接
  window.__consoleState = state;
  window.__consoleToast = toast;
  window.__consoleCloseModal = closeModal;
  window.__consoleShowModal = showModal;
  window.__consoleOpenDesign = async (projectId, targetId) => {
    if (state.view === 'design' && window.ApiDesign?.state?.dirty) {
      if (!confirm('接口编辑器有未保存的修改，确定离开？')) return;
      window.ApiDesign.state.dirty = false;
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
    case 'projects':
      viewNode = viewProjects();
      break;
    case 'design':
      viewNode = window.ApiDesign ? window.ApiDesign.view() : el('div', { class: 'empty' }, '编辑器加载失败');
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
