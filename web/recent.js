/* 最近：最近保存 / 历史发送记录 */

const recent = {
  projectId: null,
  kind: 'saved', // saved | runs
  keyword: '',
  limit: 50,
  items: [],
  loading: false,
  detail: null,
  error: null
};

function rEl(tag, attrs = {}, ...children) {
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

function rToast(message, isError) {
  if (window.__consoleToast) window.__consoleToast(message, isError);
}

function relTime(iso) {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function absTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function fmtMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/* ---------------- 数据 ---------------- */

async function loadRecent(projectId, kind, keyword) {
  recent.projectId = projectId;
  recent.kind = kind;
  recent.keyword = keyword ?? recent.keyword;
  recent.loading = true;
  recent.error = null;
  try {
    const qs = new URLSearchParams({
      kind,
      limit: String(recent.limit),
      ...(recent.keyword ? { keyword: recent.keyword } : {})
    });
    const res = await api.get(`/projects/${projectId}/recent?${qs.toString()}`);
    recent.items = res.items || [];
  } catch (err) {
    recent.items = [];
    recent.error = err.message;
    rToast(err.message, true);
  } finally {
    recent.loading = false;
  }
}

/* ---------------- 视图 ---------------- */

let recentHost = null;
let recentListHost = null;

function renderRecentHeader() {
  const projectSelect = rEl(
    'select',
    {
      class: 'design-project-select',
      onchange: async (e) => {
        await loadRecent(e.target.value, recent.kind, '');
        renderRecentAll();
      }
    },
    ...(window.__consoleState?.projects || []).map((p) =>
      rEl('option', { value: p.project_id, ...(p.project_id === recent.projectId ? { selected: true } : {}) }, p.name)
    )
  );

  const search = rEl('input', {
    type: 'text',
    placeholder: '请输入名称',
    value: recent.keyword,
    class: 'recent-search',
    oninput: (e) => {
      // 输入防抖，避免每键一次请求
      clearTimeout(search._t);
      search._t = setTimeout(async () => {
        recent.keyword = e.target.value.trim();
        await loadRecent(recent.projectId, recent.kind, recent.keyword);
        renderRecentList();
      }, 280);
    }
  });

  const tabs = rEl(
    'div',
    { class: 'recent-tabs' },
    rEl(
      'div',
      {
        class: `recent-tab${recent.kind === 'saved' ? ' active' : ''}`,
        onclick: async () => {
          if (recent.kind === 'saved') return;
          recent.kind = 'saved';
          await loadRecent(recent.projectId, 'saved', recent.keyword);
          renderRecentAll();
        }
      },
      '最近保存'
    ),
    rEl(
      'div',
      {
        class: `recent-tab${recent.kind === 'runs' ? ' active' : ''}`,
        onclick: async () => {
          if (recent.kind === 'runs') return;
          recent.kind = 'runs';
          await loadRecent(recent.projectId, 'runs', recent.keyword);
          renderRecentAll();
        }
      },
      '历史发送记录'
    )
  );

  return rEl(
    'div',
    { class: 'recent-head' },
    rEl('div', { class: 'recent-head-left' }, projectSelect, tabs),
    rEl('div', { class: 'recent-head-right' }, search)
  );
}

function renderRecentList() {
  if (!recentListHost) return;

  if (recent.loading) {
    recentListHost.replaceChildren(rEl('div', { class: 'empty' }, '加载中…'));
    return;
  }
  if (recent.error) {
    recentListHost.replaceChildren(rEl('div', { class: 'empty' }, `加载失败：${recent.error}`));
    return;
  }
  if (recent.items.length === 0) {
    recentListHost.replaceChildren(
      rEl(
        'div',
        { class: 'empty recent-empty' },
        rEl('div', { class: 'recent-empty-icon' }, recent.kind === 'saved' ? '🗂' : '📤'),
        rEl('div', {}, '暂无数据'),
        rEl(
          'div',
          { class: 'hint' },
          recent.kind === 'saved'
            ? '在「接口设计」里新建或修改接口后，这里会按保存时间列出'
            : '执行接口或执行计划后，这里会出现发送记录'
        )
      )
    );
    return;
  }

  recentListHost.replaceChildren(
    recent.kind === 'saved' ? renderSavedTable() : renderRunsTable()
  );
}

function renderSavedTable() {
  const rows = recent.items.map((item) => {
    const typeIcon = item.target_type === 'folder' ? '📁' : item.target_type === 'doc' ? '📄' : item.target_type === 'sse' ? '📡' : '';
    return rEl(
      'tr',
      { class: 'recent-row' },
      rEl(
        'td',
        {},
        rEl(
          'div',
          { class: 'recent-name' },
          typeIcon ? rEl('span', { class: 'recent-type-icon' }, typeIcon) : null,
          item.method ? rEl('span', { class: `method ${item.method}` }, item.method) : null,
          rEl('span', { class: 'recent-name-text' }, item.name || item.target_id)
        ),
        item.url ? rEl('div', { class: 'recent-url mono' }, item.url) : null
      ),
      rEl('td', {}, rEl('span', { class: 'tag' }, typeLabel(item.target_type))),
      rEl('td', { title: absTime(item.saved_at) }, relTime(item.saved_at)),
      rEl(
        'td',
        {},
        rEl(
          'div',
          { class: 'btn-row' },
          item.target_type === 'api'
            ? rEl(
                'button',
                {
                  class: 'small',
                  onclick: async () => {
                    try {
                      const res = await api.post(`/projects/${recent.projectId}/run`, { target_id: item.target_id });
                      rToast(res.status === 'passed' ? '执行通过' : `执行失败：${res.error || ''}`, res.status !== 'passed');
                      await loadRecent(recent.projectId, recent.kind, recent.keyword);
                      renderRecentList();
                    } catch (err) {
                      rToast(err.message, true);
                    }
                  }
                },
                '执行'
              )
            : null,
          rEl(
            'button',
            {
              class: 'small',
              onclick: () => {
                window.__consoleOpenDesign?.(recent.projectId, item.target_id);
              }
            },
            '打开编辑'
          )
        )
      )
    );
  });

  return rEl(
    'div',
    { class: 'table-wrap' },
    rEl(
      'table',
      {},
      rEl(
        'thead',
        {},
        rEl(
          'tr',
          {},
          rEl('th', {}, '接口 / 文档'),
          rEl('th', { style: 'width:110px' }, '类型'),
          rEl('th', { style: 'width:130px' }, '保存时间'),
          rEl('th', { style: 'width:170px' }, '操作')
        )
      ),
      rEl('tbody', {}, rows)
    )
  );
}

function typeLabel(type) {
  return (
    {
      api: '接口',
      folder: '目录',
      doc: '文档',
      sse: 'SSE'
    }[type] || type
  );
}

function renderRunsTable() {
  const rows = recent.items.map((run) => {
    const passed = run.status === 'passed';
    const label = run.flow_name ? `执行计划 · ${run.flow_name}` : `单接口 · ${run.total || 1} 步`;
    return rEl(
      'tr',
      { class: 'recent-row' },
      rEl(
        'td',
        {},
        rEl('div', { class: 'recent-name' }, rEl('span', { class: 'recent-name-text' }, label)),
        rEl('div', { class: 'recent-url mono' }, run.run_id)
      ),
      rEl('td', {}, rEl('span', { class: `tag ${passed ? 'ok' : 'err'}` }, passed ? '通过' : '失败')),
      rEl('td', {}, `${run.passed ?? 0}/${run.total ?? 0}`),
      rEl('td', {}, fmtMs(run.elapsed_ms)),
      rEl('td', { title: absTime(run.started_at) }, relTime(run.started_at)),
      rEl(
        'td',
        {},
        rEl(
          'div',
          { class: 'btn-row' },
          rEl(
            'button',
            {
              class: 'small',
              onclick: () => openRunDetail(run.run_id)
            },
            '查看详情'
          )
        )
      )
    );
  });

  return rEl(
    'div',
    { class: 'table-wrap' },
    rEl(
      'table',
      {},
      rEl(
        'thead',
        {},
        rEl(
          'tr',
          {},
          rEl('th', {}, '执行对象'),
          rEl('th', { style: 'width:90px' }, '结果'),
          rEl('th', { style: 'width:70px' }, '步骤'),
          rEl('th', { style: 'width:90px' }, '耗时'),
          rEl('th', { style: 'width:130px' }, '发送时间'),
          rEl('th', { style: 'width:110px' }, '操作')
        )
      ),
      rEl('tbody', {}, rows)
    )
  );
}

async function openRunDetail(runId) {
  try {
    const res = await api.get(`/projects/${recent.projectId}/recent/runs?run_id=${encodeURIComponent(runId)}`);
    const run = res.run;
    const body = rEl('div', { class: 'run-detail' });

    for (const [index, step] of (run.steps || []).entries()) {
      const passed = step.status === 'passed';
      const responseBody = step.response?.body ?? '';
      const requestBody = step.request?.body ?? '';

      body.append(
        rEl(
          'div',
          { class: 'run-step' },
          rEl(
            'div',
            { class: 'run-step-head' },
            rEl('span', { class: `tag ${passed ? 'ok' : 'err'}` }, passed ? '通过' : '失败'),
            step.method ? rEl('span', { class: `method ${String(step.method).toUpperCase()}` }, step.method) : null,
            rEl('span', { class: 'run-step-name' }, `${index + 1}. ${step.name || step.target_id}`),
            rEl('span', { class: 'hint' }, step.status_code ? `HTTP ${step.status_code}` : ''),
            rEl('span', { class: 'hint' }, fmtMs(step.elapsed_ms))
          ),
          step.url ? rEl('div', { class: 'recent-url mono' }, step.url) : null,
          step.error ? rEl('div', { class: 'form-hint err' }, step.error) : null,
          step.assertions?.length
            ? rEl(
                'div',
                { class: 'run-asserts' },
                ...step.assertions.map((a) =>
                  rEl(
                    'div',
                    { class: 'run-assert' },
                    rEl('span', { class: `tag ${a.passed ? 'ok' : 'err'}` }, a.passed ? '通过' : '失败'),
                    rEl('span', {}, a.name),
                    a.message ? rEl('span', { class: 'hint' }, a.message) : null
                  )
                )
              )
            : null,
          step.console?.length
            ? rEl(
                'details',
                { class: 'run-details' },
                rEl('summary', {}, `脚本日志（${step.console.length}）`),
                rEl(
                  'pre',
                  { class: 'code' },
                  step.console.map((c) => `[${c.level}] ${c.message}`).join('\n')
                )
              )
            : null,
          requestBody
            ? rEl(
                'details',
                { class: 'run-details' },
                rEl('summary', {}, '请求体'),
                rEl('pre', { class: 'code' }, requestBody)
              )
            : null,
          responseBody
            ? rEl(
                'details',
                { class: 'run-details' },
                rEl('summary', {}, '响应体'),
                rEl('pre', { class: 'code' }, responseBody)
              )
            : null
        )
      );
    }

    if ((run.steps || []).length === 0) {
      body.append(rEl('div', { class: 'empty' }, '该记录没有步骤详情'));
    }

    showModal(
      `执行详情 · ${run.run_id}`,
      body,
      [
        rEl('button', {
          onclick: () => {
            const text = JSON.stringify(run, null, 2);
            navigator.clipboard
              .writeText(text)
              .then(() => rToast('已复制完整 JSON'))
              .catch(() => rToast('复制失败', true));
          }
        }, '复制 JSON'),
        rEl('button', { onclick: () => window.__consoleCloseModal?.() }, '关闭')
      ]
    );
  } catch (err) {
    rToast(err.message, true);
  }
}

function renderRecentAll() {
  if (!recentHost) return;
  recentHost.replaceChildren(renderRecentHeader(), recentListHost);
  renderRecentList();
}

function viewRecent() {
  const projects = window.__consoleState?.projects || [];
  if (projects.length === 0) {
    return rEl('div', { class: 'empty' }, '还没有项目。请先在 API 单机版里新建项目。');
  }

  if (!recent.projectId) recent.projectId = projects[0].project_id;

  recentHost = rEl('div', { class: 'recent-layout' });
  recentListHost = rEl('div', { class: 'recent-list' });

  renderRecentAll();

  // 首次进入时拉一次数据
  if (!recent.loadedOnce || recent.projectId !== projects[0].project_id) {
    recent.loadedOnce = true;
    loadRecent(recent.projectId, recent.kind, '')
      .then(() => renderRecentList())
      .catch(() => {});
  }

  return rEl(
    'div',
    { class: 'recent-page' },
    rEl('h1', { class: 'page-title' }, '最近'),
    rEl('p', { class: 'page-sub' }, '按保存时间与发送时间排列，快速回到刚才在改的接口'),
    recentHost
  );
}

window.RecentView = {
  view: viewRecent,
  state: recent,
  reload: async () => {
    await loadRecent(recent.projectId, recent.kind, recent.keyword);
    renderRecentList();
  }
};
