/* 接口用例 / 一键压测 / Mock 三个面板（挂在 window.ApiExtra 上，由 design.js 调用） */

const X_MODES = {};

function xh(tag, attrs = {}, ...children) {
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

function xtoast(msg, isErr) {
  window.__consoleToast?.(msg, isErr);
}

function xapi() {
  return window.__designApi;
}

function xstate() {
  return window.__designState;
}

function xmarkDirty(scope) {
  window.__designMarkDirty?.(scope);
}

function xmarkClean(scope) {
  window.__designMarkClean?.(scope);
}

function xisDirty(scope) {
  return Boolean(window.__designIsDirty?.(scope));
}

/* ================= 接口用例 ================= */

const casesState = {
  loadedFor: null,
  cases: [],
  activeIndex: 0,
  running: false,
  expanded: null,
  result: null
};

async function loadCases() {
  const st = xstate();
  if (!st?.selectedId) return;
  if (casesState.loadedFor === st.selectedId) return;
  try {
    const res = await xapi().get(`/projects/${st.projectId}/apis/${st.selectedId}/cases`);
    casesState.cases = res.cases || [];
    casesState.loadedFor = st.selectedId;
    casesState.activeIndex = 0;
    casesState.result = null;
  } catch (err) {
    xtoast(err.message, true);
    casesState.cases = [];
  }
}

function casesPanel() {
  const st = xstate();

  if (!st?.selectedId) {
    return xh('div', { class: 'empty' }, '请先在左侧选择一个接口');
  }
  if (st.targetType !== 'api') {
    return xh('div', { class: 'empty' }, '只有 HTTP 接口支持用例');
  }

  if (casesState.loadedFor !== st.selectedId) {
    loadCases().then(() => {
      window.__designRerender?.();
    });
    return xh('div', { class: 'empty' }, '加载中…');
  }

  const cases = casesState.cases;
  const active = cases[casesState.activeIndex] || null;

  const list = xh(
    'div',
    { class: 'case-list' },
    ...(cases.length === 0
      ? [xh('div', { class: 'empty', style: 'padding:18px' }, '还没有用例')]
      : cases.map((c, index) =>
          xh(
            'div',
            {
              class: `case-item${index === casesState.activeIndex ? ' active' : ''}`,
              onclick: () => {
                casesState.activeIndex = index;
                window.__designRerender?.();
              }
            },
            xh('span', { class: `case-dot${Number(c.enabled) === 1 ? ' on' : ''}` }),
            xh('span', { class: 'case-name' }, c.name || '未命名'),
            xh('span', { class: 'case-meta' }, c.expect_status ? `期望 ${c.expect_status}` : '')
          )
        )),
    xh(
      'button',
      {
        class: 'small mt12',
        onclick: async () => {
          try {
            const res = await xapi().post(`/projects/${st.projectId}/apis/${st.selectedId}/cases`, {
              name: `用例 ${cases.length + 1}`
            });
            casesState.cases = [...cases, res.case];
            casesState.activeIndex = casesState.cases.length - 1;
            xmarkClean('case');
            window.__designRerender?.();
          } catch (err) {
            xtoast(err.message, true);
          }
        }
      },
      '+ 新建用例'
    )
  );

  const editorPane = active ? caseEditor(active) : xh('div', { class: 'empty' }, '选择或新建一个用例');

  return xh(
    'div',
    { class: 'cases-layout' },
    xh('aside', { class: 'cases-side' }, list),
    xh('section', { class: 'cases-main' }, editorPane)
  );
}

/** 保存当前用例（面板内按钮与 Ctrl+S 共用） */
async function saveActiveCase() {
  const st = xstate();
  const index = casesState.activeIndex;
  const current = casesState.cases[index];
  if (!st?.selectedId || !current) {
    xtoast('没有可保存的用例', true);
    return false;
  }
  try {
    const res = await xapi().put(`/projects/${st.projectId}/apis/${st.selectedId}/cases/${current.case_id}`, {
      case: current
    });
    casesState.cases[index] = res.case;
    xmarkClean('case');
    xtoast('用例已保存');
    window.__designRerender?.();
    return true;
  } catch (err) {
    xtoast(err.message, true);
    return false;
  }
}

/** 保存当前 Mock 配置（面板内按钮与 Ctrl+S 共用） */
async function saveMockConfig() {
  const st = xstate();
  if (!st?.selectedId) {
    xtoast('没有可保存的 Mock 配置', true);
    return false;
  }
  let schema = null;
  if (String(mockState.schemaText || '').trim()) {
    try {
      schema = JSON.parse(mockState.schemaText);
    } catch (err) {
      xtoast(`数据结构 JSON 语法错误：${err.message}`, true);
      return false;
    }
  }
  try {
    const res = await xapi().put(`/projects/${st.projectId}/apis/${st.selectedId}/mock`, {
      ...(mockState.mock || {}),
      schema
    });
    mockState.mock = res.mock;
    xmarkClean('mock');
    xtoast('Mock 配置已保存');
    window.__designRerender?.();
    return true;
  } catch (err) {
    xtoast(err.message, true);
    return false;
  }
}

/** 用例的「响应头校验」键值表：expect_headers = { Header: 期望值 } */
function headerExpectTable(c, patch) {
  const entries = Object.entries(c.expect_headers || {});
  const host = xh('div', { class: 'header-expect' });

  const commit = (next) => {
    patch('expect_headers', next);
  };

  const render = () => {
    const rows = entries.map(([key, value], i) =>
      xh(
        'div',
        { class: 'header-expect-row' },
        xh('input', {
          type: 'text',
          class: 'mono-input',
          value: key,
          placeholder: 'Header 名',
          oninput: (e) => {
            const next = Object.fromEntries(entries);
            delete next[key];
            next[e.target.value] = value;
            entries.splice(i, 1, [e.target.value, value]);
            commit(next);
          }
        }),
        xh('input', {
          type: 'text',
          class: 'mono-input',
          value,
          placeholder: '期望值（支持包含匹配）',
          oninput: (e) => {
            entries[i] = [key, e.target.value];
            commit(Object.fromEntries(entries));
          }
        }),
        xh(
          'button',
          {
            class: 'small danger',
            title: '删除',
            onclick: () => {
              entries.splice(i, 1);
              commit(Object.fromEntries(entries));
              render();
            }
          },
          '×'
        )
      )
    );

    if (entries.length === 0) rows.push(xh('div', { class: 'param-empty' }, '暂无响应头校验'));
    rows.push(
      xh(
        'button',
        {
          class: 'small',
          onclick: () => {
            entries.push(['', '']);
            render();
          }
        },
        '+ 添加校验'
      )
    );
    host.replaceChildren(...rows);
  };

  render();
  return host;
}

function caseEditor(c) {
  const st = xstate();
  const index = casesState.activeIndex;

  const patch = (key, value) => {
    const target = casesState.cases[index];
    if (!target) return;
    target[key] = value;
    xmarkDirty('case');
  };

  const save = () => saveActiveCase();

  const inputArea = xh('textarea', {
    class: 'mono-input',
    rows: 10,
    placeholder: '{\n  "query": { "page": "2" },\n  "body": { "name": "test" }\n}',
    style: 'min-height:120px',
    oninput: (e) => {
      try {
        const parsed = JSON.parse(e.target.value || '{}');
        patch('input', parsed);
        e.target.classList.remove('invalid');
      } catch {
        e.target.classList.add('invalid');
      }
    }
  });
  inputArea.value = JSON.stringify(c.input || {}, null, 2);

  return xh(
    'div',
    { class: 'case-editor' },
    xh(
      'div',
      { class: 'form-grid' },
      xh(
        'div',
        { class: 'form-row' },
        xh('label', { class: 'form-label' }, '用例名称'),
        xh('input', {
          type: 'text',
          value: c.name || '',
          oninput: (e) => patch('name', e.target.value)
        })
      ),
      xh(
        'div',
        { class: 'form-row' },
        xh('label', { class: 'form-label' }, '期望状态码'),
        xh('input', {
          type: 'text',
          value: c.expect_status || '',
          placeholder: '200（留空表示不校验）',
          oninput: (e) => patch('expect_status', e.target.value)
        })
      ),
      xh(
        'div',
        { class: 'form-row' },
        xh('label', { class: 'form-label' }, '响应包含文本'),
        xh('input', {
          type: 'text',
          value: c.expect_body_contains || '',
          placeholder: '留空表示不校验',
          oninput: (e) => patch('expect_body_contains', e.target.value)
        })
      ),
      xh(
        'div',
        { class: 'form-row' },
        xh('label', { class: 'form-label' }, 'Content-Type 包含'),
        xh('input', {
          type: 'text',
          value: c.expect_content_type || '',
          placeholder: 'application/json（留空表示不校验）',
          oninput: (e) => patch('expect_content_type', e.target.value)
        })
      ),
      xh(
        'div',
        { class: 'form-row full' },
        xh('label', { class: 'form-label' }, '响应头校验'),
        xh('div', { class: 'form-control' }, headerExpectTable(c, patch))
      ),
      xh(
        'div',
        { class: 'form-row' },
        xh('label', { class: 'form-label' }, '启用'),
        xh(
          'label',
          { class: 'check' },
          xh('input', {
            type: 'checkbox',
            checked: Number(c.enabled) === 1,
            onchange: (e) => patch('enabled', e.target.checked ? 1 : 0)
          }),
          '参与批量执行'
        )
      )
    ),
    xh(
      'div',
      { class: 'form-row full mt12' },
      xh('label', { class: 'form-label' }, '参数覆盖（JSON）'),
      xh('div', { class: 'form-control' }, inputArea),
      xh('div', { class: 'form-hint' }, '结构与接口执行时的 input 一致：query / path / headers / cookies / body / auth')
    ),
    xh(
      'div',
      { class: 'form-row full mt12' },
      xh('label', { class: 'form-label' }, '前置脚本'),
      xh('textarea', {
        class: 'mono-input',
        rows: 4,
        oninput: (e) => patch('pre_script', e.target.value)
      }, c.pre_script || '')
    ),
    xh(
      'div',
      { class: 'form-row full mt12' },
      xh('label', { class: 'form-label' }, '后置脚本'),
      xh('textarea', {
        class: 'mono-input',
        rows: 4,
        oninput: (e) => patch('post_script', e.target.value)
      }, c.post_script || '')
    ),
    xh(
      'div',
      { class: 'btn-row mt16' },
      xh('button', { class: 'primary small', onclick: save }, '保存用例'),
      xh(
        'button',
        {
          class: 'small',
          disabled: casesState.running,
          onclick: () => runOneCase(c)
        },
        casesState.running ? '执行中…' : '执行此用例'
      ),
      xh(
        'button',
        {
          class: 'small',
          onclick: async () => {
            if (!confirm(`删除用例「${c.name || '未命名'}」？`)) return;
            try {
              await xapi().req(
                'DELETE',
                `/projects/${st.projectId}/apis/${st.selectedId}/cases/${c.case_id}`
              );
              casesState.cases.splice(index, 1);
              casesState.activeIndex = Math.max(0, index - 1);
              xmarkClean('case');
              xtoast('用例已删除');
              window.__designRerender?.();
            } catch (err) {
              xtoast(err.message, true);
            }
          }
        },
        '删除'
      ),
      xh(
        'button',
        {
          class: 'small',
          disabled: casesState.running || casesState.cases.length === 0,
          onclick: runAllCases
        },
        '批量执行全部'
      )
    ),
    casesState.result ? caseResultView(casesState.result) : null
  );
}

function caseResultView(result) {
  const rows = (result.results || []).map((r, index) =>
    xh(
      'div',
      { class: 'case-result-item' },
      xh(
        'div',
        {
          class: 'case-result-row clickable',
          onclick: () => {
            casesState.expanded = casesState.expanded === index ? null : index;
            window.__designRerender?.();
          }
        },
        xh('span', { class: `tag ${r.passed ? 'ok' : 'err'}` }, r.passed ? '通过' : '失败'),
        xh('span', { class: 'case-name' }, r.name),
        xh('span', { class: 'hint' }, r.status_code ? `HTTP ${r.status_code}` : ''),
        xh('span', { class: 'hint' }, `${r.elapsed_ms ?? '-'} ms`),
        r.message ? xh('span', { class: 'hint' }, r.message) : null,
        xh('span', { class: 'spacer-flex' }),
        xh('span', { class: 'hint' }, casesState.expanded === index ? '收起' : '详情')
      ),
      casesState.expanded === index ? caseResultDetail(r) : null
    )
  );

  return xh(
    'div',
    { class: 'case-result mt16' },
    xh(
      'div',
      { class: 'case-result-head' },
      xh('strong', {}, '执行结果'),
      xh('span', { class: 'hint' }, `共 ${result.total} 个，通过 ${result.passed}，失败 ${result.failed}`)
    ),
    ...rows
  );
}

/** 单条用例结果的展开详情：请求 / 响应 */
function caseResultDetail(r) {
  const req = r.request || null;
  const resp = r.response || null;
  const ui = window.UiBits;

  if (!req && !resp) {
    return xh('div', { class: 'case-result-detail empty' }, r.message || '没有请求 / 响应详情');
  }

  const sections = [];

  if (req) {
    sections.push(xh('div', { class: 'section-title' }, '请求'));
    sections.push(
      xh(
        'div',
        { class: 'kv-line' },
        xh('span', { class: `method ${String(req.method || '').toUpperCase()}` }, req.method || ''),
        xh('code', { class: 'mono kv-url' }, req.url || '')
      )
    );
    if (ui) {
      sections.push(ui.headersTable(req.headers, '请求头'));
      if (req.body) sections.push(ui.collapsible('请求体', xh('pre', { class: 'code' }, req.body)));
    }
  }

  if (resp) {
    sections.push(xh('div', { class: 'section-title mt12' }, '响应'));
    if (ui) {
      sections.push(ui.statusLine({ status: resp.status, status_text: resp.status_text }));
      sections.push(ui.headersTable(resp.headers, '响应头'));
      const bodyText = resp.body || '';
      sections.push(
        ui.collapsible(
          `响应体（${bodyText.length} 字符${resp.truncated ? '，已截断' : ''}）`,
          xh('pre', { class: 'code' }, bodyText || '(空)')
        )
      );
    }
  }

  return xh('div', { class: 'case-result-detail' }, ...sections);
}

async function runOneCase(c) {
  const st = xstate();
  casesState.running = true;
  window.__designRerender?.();
  try {
    // 先保存用例
    await xapi().put(`/projects/${st.projectId}/apis/${st.selectedId}/cases/${c.case_id}`, {
      case: casesState.cases[casesState.activeIndex]
    });
    xmarkClean('case');

    const res = await xapi().post(`/projects/${st.projectId}/cases/run`, {
      target_id: st.selectedId,
      case_ids: [c.case_id]
    });
    casesState.result = res;
    casesState.expanded = res.results?.length ? 0 : null;
    xtoast(res.failed > 0 ? `用例失败` : '用例通过', res.failed > 0);
  } catch (err) {
    xtoast(err.message, true);
  } finally {
    casesState.running = false;
    window.__designRerender?.();
  }
}

async function runAllCases() {
  const st = xstate();
  const ids = casesState.cases.filter((c) => Number(c.enabled) === 1).map((c) => c.case_id);
  if (ids.length === 0) {
    xtoast('没有启用的用例', true);
    return;
  }
  casesState.running = true;
  window.__designRerender?.();
  try {
    // 先保存当前编辑的
    const current = casesState.cases[casesState.activeIndex];
    if (current) {
      await xapi().put(`/projects/${st.projectId}/apis/${st.selectedId}/cases/${current.case_id}`, {
        case: current
      });
    }
    xmarkClean('case');
    const res = await xapi().post(`/projects/${st.projectId}/cases/run`, {
      target_id: st.selectedId,
      case_ids: ids
    });
    casesState.result = res;
    casesState.expanded = null;
    xtoast(`执行完成：通过 ${res.passed}，失败 ${res.failed}`, res.failed > 0);
  } catch (err) {
    xtoast(err.message, true);
  } finally {
    casesState.running = false;
    window.__designRerender?.();
  }
}

/* ================= 一键压测 ================= */

const stressState = {
  concurrency: 1,
  mode: 'rounds',
  rounds: 1,
  durationSec: 10,
  runAssertions: true,
  running: false,
  result: null,
  progress: 0,
  // 当前结果属于哪个接口；切换接口时清空，避免串到新接口
  forTarget: null
};

function resetStress() {
  stressState.result = null;
  stressState.progress = 0;
  stressState.forTarget = null;
}

function stressPanel() {
  const st = xstate();

  if (!st?.selectedId) return xh('div', { class: 'empty' }, '请先在左侧选择一个接口');
  if (st.targetType !== 'api') return xh('div', { class: 'empty' }, '只有 HTTP 接口支持压测');

  const s = stressState;
  // 换了接口就丢掉上一个接口的压测结果
  if (s.forTarget && s.forTarget !== st.selectedId) resetStress();

  const setField = (key, value) => {
    s[key] = value;
  };

  const start = async () => {
    s.running = true;
    s.result = null;
    s.progress = 0;
    window.__designRerender?.();
    try {
      // 只保存设计域：用例 / Mock 的草稿不参与压测
      if (window.__designIsDirty?.('design')) {
        await window.__designSave?.();
      }
      const res = await xapi().post(`/projects/${st.projectId}/stress`, {
        target_id: st.selectedId,
        concurrency: s.concurrency,
        mode: s.mode,
        rounds: s.rounds,
        duration_ms: s.durationSec * 1000,
        run_assertions: s.runAssertions
      });
      s.result = res;
      s.forTarget = st.selectedId;
      s.progress = 1;
      xtoast(`压测完成：${res.total} 次，成功率 ${res.success_rate}%`, res.failed > 0);
    } catch (err) {
      xtoast(`压测失败：${err.message}`, true);
    } finally {
      s.running = false;
      window.__designRerender?.();
    }
  };

  const result = s.result;

  return xh(
    'div',
    { class: 'stress-panel' },
    xh(
      'div',
      { class: 'card' },
      xh('div', { class: 'section-title' }, '压测设置'),
      xh(
        'div',
        { class: 'form-grid' },
        xh(
          'div',
          { class: 'form-row' },
          xh('label', { class: 'form-label' }, '并发数（同时开启的工作进程数）'),
          xh('input', {
            type: 'number',
            min: '1',
            max: '200',
            value: String(s.concurrency),
            oninput: (e) => setField('concurrency', Math.max(1, Math.min(200, Number(e.target.value) || 1)))
          })
        ),
        xh(
          'div',
          { class: 'form-row' },
          xh('label', { class: 'form-label' }, '模式'),
          xh(
            'div',
            { class: 'row-gap' },
            xh(
              'label',
              { class: 'check' },
              xh('input', {
                type: 'radio',
                name: 'stress-mode',
                checked: s.mode === 'rounds',
                onchange: () => {
                  s.mode = 'rounds';
                  window.__designRerender?.();
                }
              }),
              '按轮次'
            ),
            xh(
              'label',
              { class: 'check' },
              xh('input', {
                type: 'radio',
                name: 'stress-mode',
                checked: s.mode === 'duration',
                onchange: () => {
                  s.mode = 'duration';
                  window.__designRerender?.();
                }
              }),
              '按持续时长'
            )
          )
        ),
        s.mode === 'rounds'
          ? xh(
              'div',
              { class: 'form-row' },
              xh('label', { class: 'form-label' }, '压测轮次'),
              xh('input', {
                type: 'number',
                min: '1',
                value: String(s.rounds),
                oninput: (e) => setField('rounds', Math.max(1, Number(e.target.value) || 1))
              })
            )
          : xh(
              'div',
              { class: 'form-row' },
              xh('label', { class: 'form-label' }, '持续时长（秒）'),
              xh('input', {
                type: 'number',
                min: '1',
                value: String(s.durationSec),
                oninput: (e) => setField('durationSec', Math.max(1, Number(e.target.value) || 1))
              })
            ),
        xh(
          'div',
          { class: 'form-row' },
          xh('label', { class: 'form-label' }, '执行断言与脚本'),
          xh(
            'label',
            { class: 'check' },
            xh('input', {
              type: 'checkbox',
              checked: s.runAssertions,
              onchange: (e) => setField('runAssertions', e.target.checked)
            }),
            '开启后会统计业务失败率，但影响吞吐'
          )
        )
      ),
      xh(
        'div',
        { class: 'btn-row mt16' },
        xh(
          'button',
          {
            class: 'primary',
            disabled: s.running,
            onclick: start
          },
          s.running ? '压测中…' : '压测'
        ),
        xh('span', { class: 'hint' }, '「轮次」即总请求数；并发数决定同时有多少请求在飞')
      ),
      s.running
        ? xh(
            'div',
            { class: 'stress-progress mt16' },
            xh('div', { class: 'stress-progress-bar indeterminate' }, xh('div', { class: 'stress-progress-fill' })),
            xh('div', { class: 'hint mt8' }, '压测进行中，完成后显示进度曲线')
          )
        : null
    ),

    result
      ? xh(
          'div',
          { class: 'card mt16' },
          xh('div', { class: 'section-title' }, '压测结果'),
          xh(
            'div',
            { class: 'hint', style: 'margin-bottom:8px' },
            `并发 ${result.concurrency} · ${result.mode === 'rounds' ? `轮次 ${result.rounds}` : `时长 ${Math.round((result.duration_ms || 0) / 1000)}s`} · 断言${result.run_assertions ? '已开启' : '已关闭'}`
          ),
          xh(
            'div',
            { class: 'stress-metrics' },
            metric('总请求', result.total),
            metric('成功', result.success, 'ok'),
            metric('失败', result.failed, result.failed > 0 ? 'err' : ''),
            metric('成功率', `${result.success_rate}%`, result.success_rate >= 99 ? 'ok' : 'warn'),
            metric('QPS', result.qps),
            metric('总耗时', `${result.elapsed_ms} ms`)
          ),
          progressTimelineView(result.progress_timeline),
          xh('div', { class: 'section-title mt16' }, '响应耗时'),
          xh(
            'div',
            { class: 'stress-metrics' },
            metric('最小', `${result.latency.min} ms`),
            metric('平均', `${result.latency.avg} ms`),
            metric('P50', `${result.latency.p50} ms`),
            metric('P90', `${result.latency.p90} ms`),
            metric('P95', `${result.latency.p95} ms`),
            metric('P99', `${result.latency.p99} ms`),
            metric('最大', `${result.latency.max} ms`)
          ),
          Object.keys(result.status_codes || {}).length > 0
            ? xh(
                'div',
                { class: 'mt16' },
                xh('div', { class: 'section-title' }, '状态码分布'),
                xh(
                  'div',
                  { class: 'row-gap' },
                  ...Object.entries(result.status_codes).map(([code, count]) =>
                    xh('span', { class: 'tag' }, `${code}: ${count}`)
                  )
                )
              )
            : null,
          (result.error_samples || []).length > 0
            ? xh(
                'div',
                { class: 'mt16' },
                xh(
                  'div',
                  { class: 'section-title section-title-row' },
                  '错误样本',
                  xh(
                    'button',
                    {
                      class: 'small',
                      onclick: async () => {
                        const res = await window.__consoleCopy(result.error_samples.join('\n'));
                        if (res.ok) xtoast('已复制错误样本');
                        else window.__consoleCopyFailed(res.error);
                      }
                    },
                    '复制'
                  )
                ),
                ...result.error_samples.map((e) => xh('div', { class: 'form-hint err' }, e))
              )
            : null
        )
      : null
  );
}

/** 压测进度曲线：极简 SVG 折线（done / total 随时间推进） */
function progressTimelineView(timeline) {
  if (!Array.isArray(timeline) || timeline.length < 2) return null;
  const W = 520;
  const H = 90;
  const max = Math.max(1, ...timeline.map((p) => Number(p.done) || 0));
  const points = timeline.map((p, i) => {
    const x = timeline.length === 1 ? 0 : (i / (timeline.length - 1)) * W;
    const y = H - ((Number(p.done) || 0) / max) * (H - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return xh(
    'div',
    { class: 'stress-curve mt16' },
    xh('div', { class: 'section-title' }, '进度曲线'),
    xh(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, class: 'stress-svg', preserveAspectRatio: 'none' },
      xh('polyline', { points: points.join(' '), fill: 'none', 'stroke-width': '2' })
    ),
    xh('div', { class: 'hint mt8' }, `共 ${timeline.length} 个采样点，峰值 ${max} 次`)
  );
}

function metric(label, value, cls = '') {
  return xh(
    'div',
    { class: 'stress-metric' },
    xh('span', { class: 'stress-metric-label' }, label),
    xh('span', { class: `stress-metric-value${cls ? ` ${cls}` : ''}` }, String(value))
  );
}

/* ================= Mock ================= */

const mockState = {
  loadedFor: null,
  mock: null,
  serverRunning: false,
  serverPort: null,
  startPort: 39101,
  stats: null,
  schemaText: ''
};

/** Mock 自定义响应头键值表：写到 mock.headers */
function mockHeaderTable(m, patch) {
  const entries = Object.entries(m.headers || {});
  const host = xh('div', { class: 'header-expect' });

  const commit = (next) => patch('headers', next);

  const render = () => {
    const rows = entries.map(([key, value], i) =>
      xh(
        'div',
        { class: 'header-expect-row' },
        xh('input', {
          type: 'text',
          class: 'mono-input',
          value: key,
          placeholder: 'Header 名',
          oninput: (e) => {
            const oldKey = entries[i][0];
            entries[i] = [e.target.value, entries[i][1]];
            const next = {};
            for (const [k, v] of entries) if (k) next[k] = v;
            commit(next);
            if (oldKey !== e.target.value) render();
          }
        }),
        xh('input', {
          type: 'text',
          class: 'mono-input',
          value,
          placeholder: '值',
          oninput: (e) => {
            entries[i] = [entries[i][0], e.target.value];
            const next = {};
            for (const [k, v] of entries) if (k) next[k] = v;
            commit(next);
          }
        }),
        xh(
          'button',
          {
            class: 'small danger',
            title: '删除',
            onclick: () => {
              entries.splice(i, 1);
              const next = {};
              for (const [k, v] of entries) if (k) next[k] = v;
              commit(next);
              render();
            }
          },
          '×'
        )
      )
    );

    if (entries.length === 0) rows.push(xh('div', { class: 'param-empty' }, '暂无自定义响应头'));
    rows.push(
      xh(
        'button',
        {
          class: 'small',
          onclick: () => {
            entries.push(['', '']);
            render();
          }
        },
        '+ 添加响应头'
      )
    );
    host.replaceChildren(...rows);
  };

  render();
  return host;
}

async function loadMock() {
  const st = xstate();
  if (!st?.selectedId) return;
  if (mockState.loadedFor === st.selectedId) return;
  try {
    const res = await xapi().get(`/projects/${st.projectId}/apis/${st.selectedId}/mock`);
    mockState.mock = res.mock || null;
    mockState.loadedFor = st.selectedId;
    mockState.schemaText = mockState.mock?.schema
      ? JSON.stringify(mockState.mock.schema, null, 2)
      : defaultMockSchema();
  } catch (err) {
    xtoast(err.message, true);
  }
}

function defaultMockSchema() {
  return JSON.stringify(
    {
      type: 'object',
      properties: {
        code: { type: 'integer', description: 'code' },
        msg: { type: 'string', description: 'msg' },
        data: { type: 'object', properties: {} }
      },
      APIPOST_ORDERS: ['code', 'msg', 'data'],
      APIPOST_REFS: {},
      required: []
    },
    null,
    2
  );
}

/** 浏览器侧按 schema 生成样例（与服务端 generateFromSchema 同逻辑） */
function generateFromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return null;
  const type = String(schema.type || 'object');

  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  if (type === 'object' || schema.properties) {
    const out = {};
    const props = schema.properties || {};
    const orders = Array.isArray(schema.APIPOST_ORDERS) ? schema.APIPOST_ORDERS : Object.keys(props);
    for (const key of orders) {
      const sub = props[key];
      if (!sub) continue;
      out[key] = generateFromSchema(sub, depth + 1);
    }
    return out;
  }
  if (type === 'array') return [generateFromSchema(schema.items || { type: 'string' }, depth + 1)];
  if (type === 'integer') return Math.floor(Math.random() * 1000);
  if (type === 'number') return Number((Math.random() * 1000).toFixed(2));
  if (type === 'boolean') return Math.random() > 0.5;
  if (type === 'null') return null;

  const hint = String(schema.description || '').toLowerCase();
  if (/mail/.test(hint)) return 'mock@example.com';
  if (/name/.test(hint)) return 'mock_name';
  if (/phone|tel|mobile/.test(hint)) return '13800138000';
  if (/url|link/.test(hint)) return 'https://example.com';
  if (/date|time/.test(hint)) return new Date().toISOString();
  return 'mock_string';
}

window.MockGen = { generateFromSchema };

async function loadMockServer() {
  try {
    const res = await xapi().get('/mock-server');
    mockState.serverRunning = Boolean(res.running);
    mockState.serverPort = res.port;
    mockState.stats = res.stats || null;
  } catch {
    mockState.serverRunning = false;
  }
}

function mockPanel() {
  const st = xstate();
  if (!st?.selectedId) return xh('div', { class: 'empty' }, '请先在左侧选择一个接口');
  if (st.targetType !== 'api') return xh('div', { class: 'empty' }, '只有 HTTP 接口支持 Mock');

  if (mockState.loadedFor !== st.selectedId) {
    loadMock().then(() => window.__designRerender?.());
    loadMockServer().then(() => window.__designRerender?.());
    return xh('div', { class: 'empty' }, '加载中…');
  }

  const m = mockState.mock || {
    enabled: 0,
    status: '200',
    delay_ms: 0,
    content_type: 'application/json; charset=utf-8',
    body: '',
    headers: {},
    schema: null
  };

  const patch = (key, value) => {
    mockState.mock = { ...(mockState.mock || m), [key]: value };
    xmarkDirty('mock');
    window.__designRerender?.();
  };

  const save = () => saveMockConfig();

  // Mock URL 预览
  const port = mockState.serverPort || 39101;
  const mockPath = (() => {
    const u = window.__designState?.data?.url || '';
    try {
      const parsed = new URL(u.startsWith('http') ? u : `http://x${u.startsWith('/') ? '' : '/'}${u}`);
      return parsed.pathname;
    } catch {
      return u;
    }
  })();
  const mockUrl = `http://127.0.0.1:${port}${mockPath}`;

  // 预览生成的响应：schema 优先，其次固定 body
  let previewText = '';
  let previewHint = '';
  if (mockState.schemaText.trim()) {
    try {
      const schema = JSON.parse(mockState.schemaText);
      previewText = JSON.stringify(window.MockGen?.generateFromSchema?.(schema) ?? {}, null, 2);
      previewHint = '按数据结构随机生成';
    } catch {
      previewText = '(数据结构有语法错误)';
      previewHint = '数据结构有语法错误';
    }
  } else if (String(mockState.mock?.body || '').trim()) {
    previewText = String(mockState.mock.body);
    previewHint = '固定响应体原文';
  }

  return xh(
    'div',
    { class: 'mock-panel' },
    xh(
      'div',
      { class: 'notice info' },
      xh('span', {}, 'ℹ'),
      xh(
        'div',
        {},
        xh('div', {}, `本地 Mock 地址：`, xh('code', { class: 'mono' }, mockUrl)),
        xh(
          'div',
          { class: 'hint mt8' },
          mockState.serverRunning
            ? `Mock 服务运行中（端口 ${mockState.serverPort}）`
            : 'Mock 服务未启动，点下方「启动 Mock 服务」'
        ),
        mockState.serverRunning && mockState.stats
          ? xh(
              'div',
              { class: 'hint mt8' },
              `命中 ${mockState.stats.hits ?? 0} 次 · 已启用接口 ${mockState.stats.mock_count ?? 0} 个 · 运行 ${Math.round((mockState.stats.uptime_ms || 0) / 1000)}s`
            )
          : null
      )
    ),

    xh(
      'div',
      { class: 'btn-row' },
      xh('span', { class: 'hint' }, '端口'),
      xh('input', {
        type: 'number',
        class: 'mock-port-input',
        min: '1',
        max: '65535',
        value: String(mockState.startPort || 39101),
        oninput: (e) => {
          mockState.startPort = Math.max(1, Math.min(65535, Number(e.target.value) || 39101));
        }
      }),
      xh(
        'button',
        {
          class: 'small',
          onclick: async () => {
            try {
              const res = await xapi().post('/mock-server/start', { port: mockState.startPort || 39101 });
              mockState.serverRunning = true;
              mockState.serverPort = res.port;
              xtoast(`Mock 服务已启动，端口 ${res.port}`);
              await loadMockServer();
              window.__designRerender?.();
            } catch (err) {
              xtoast(err.message, true);
            }
          }
        },
        mockState.serverRunning ? '重启 Mock 服务' : '启动 Mock 服务'
      ),
      mockState.serverRunning
        ? xh(
            'button',
            {
              class: 'small danger',
              onclick: async () => {
                try {
                  await xapi().post('/mock-server/stop', {});
                  mockState.serverRunning = false;
                  mockState.stats = null;
                  xtoast('Mock 服务已停止');
                  window.__designRerender?.();
                } catch (err) {
                  xtoast(err.message, true);
                }
              }
            },
            '停止'
          )
        : null,
      xh(
        'button',
        {
          class: 'small',
          onclick: async () => {
            const res = await window.__consoleCopy(mockUrl);
            if (res.ok) xtoast('已复制 Mock 地址');
            else window.__consoleCopyFailed(res.error);
          }
        },
        '复制地址'
      ),
      xh(
        'button',
        {
          class: 'small',
          disabled: !mockState.serverRunning,
          onclick: async () => {
            await loadMockServer();
            window.__designRerender?.();
          }
        },
        '刷新统计'
      )
    ),

    xh(
      'div',
      { class: 'card mt16' },
      xh(
        'div',
        { class: 'form-grid' },
        xh(
          'div',
          { class: 'form-row' },
          xh('label', { class: 'form-label' }, '启用 Mock'),
          xh(
            'label',
            { class: 'check' },
            xh('input', {
              type: 'checkbox',
              checked: Number(m.enabled) === 1,
              onchange: (e) => patch('enabled', e.target.checked ? 1 : 0)
            }),
            '开启后该接口会响应 Mock 请求'
          )
        ),
        xh(
          'div',
          { class: 'form-row' },
          xh('label', { class: 'form-label' }, '状态码'),
          xh('input', {
            type: 'text',
            value: String(m.status || '200'),
            oninput: (e) => {
              mockState.mock = { ...mockState.mock, status: e.target.value };
              xmarkDirty('mock');
            }
          })
        ),
        xh(
          'div',
          { class: 'form-row' },
          xh('label', { class: 'form-label' }, 'Content-Type'),
          xh('input', {
            type: 'text',
            value: String(m.content_type || 'application/json; charset=utf-8'),
            placeholder: 'application/json; charset=utf-8',
            oninput: (e) => {
              mockState.mock = { ...mockState.mock, content_type: e.target.value };
              xmarkDirty('mock');
            }
          }),
          xh('div', { class: 'form-hint' }, '使用固定响应体时生效；按数据结构生成时固定为 JSON')
        ),
        xh(
          'div',
          { class: 'form-row' },
          xh('label', { class: 'form-label' }, '延迟（毫秒）'),
          xh('input', {
            type: 'number',
            min: '0',
            max: '60000',
            value: String(m.delay_ms || 0),
            oninput: (e) => {
              mockState.mock = { ...mockState.mock, delay_ms: Number(e.target.value) || 0 };
              xmarkDirty('mock');
            }
          }),
          xh('div', { class: 'form-hint' }, '模拟慢接口')
        )
      ),
      xh(
        'div',
        { class: 'form-row full mt12' },
        xh('label', { class: 'form-label' }, '固定响应体'),
        xh(
          'div',
          { class: 'form-control' },
          xh('textarea', {
            class: 'mono-input',
            rows: 6,
            placeholder: '数据结构为空时使用这段原文响应',
            oninput: (e) => {
              mockState.mock = { ...mockState.mock, body: e.target.value };
              xmarkDirty('mock');
            }
          }, String(m.body || '')),
          xh('div', { class: 'form-hint' }, '数据结构非空时以数据结构为准，此处内容被忽略')
        )
      ),
      xh(
        'div',
        { class: 'form-row full mt12' },
        xh('label', { class: 'form-label' }, '自定义响应头'),
        xh('div', { class: 'form-control' }, mockHeaderTable(m, patch))
      )
    ),

    xh(
      'div',
      { class: 'mock-split mt16' },
      xh(
        'div',
        { class: 'mock-col' },
        xh('div', { class: 'section-title' }, '数据结构（JSON Schema）'),
        xh('textarea', {
          class: 'mono-input mock-schema',
          rows: 16,
          oninput: (e) => {
            mockState.schemaText = e.target.value;
            xmarkDirty('mock');
          }
        }, mockState.schemaText),
        xh('div', { class: 'form-hint' }, '按此结构生成随机 Mock 数据；支持 type / properties / APIPOST_ORDERS')
      ),
      xh(
        'div',
        { class: 'mock-col' },
        xh('div', { class: 'section-title' }, 'Mock 返回预览'),
        previewHint ? xh('div', { class: 'form-hint' }, previewHint) : null,
        xh('pre', { class: 'code mock-preview' }, previewText || '(空)')
      )
    ),

    xh(
      'div',
      { class: 'btn-row mt16' },
      xh('button', { class: 'primary small', onclick: save }, '保存 Mock 配置')
    )
  );
}

/* ---------------- 挂载 ---------------- */

window.ApiExtra = {
  cases: casesPanel,
  stress: stressPanel,
  mock: mockPanel,
  saveCase: saveActiveCase,
  saveMock: saveMockConfig,
  resetCases: () => {
    casesState.loadedFor = null;
    casesState.cases = [];
    casesState.result = null;
    casesState.expanded = null;
    casesState.activeIndex = 0;
  },
  resetMock: () => {
    mockState.loadedFor = null;
    mockState.mock = null;
    mockState.schemaText = '';
  },
  resetStress
};
