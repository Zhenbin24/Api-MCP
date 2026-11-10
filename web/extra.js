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

/* ================= 接口用例 ================= */

const casesState = {
  loadedFor: null,
  cases: [],
  activeIndex: 0,
  running: false,
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

function caseEditor(c) {
  const st = xstate();
  const index = casesState.activeIndex;

  const patch = (key, value) => {
    const target = casesState.cases[index];
    if (!target) return;
    target[key] = value;
    window.__designMarkDirty?.();
  };

  const save = async () => {
    try {
      const res = await xapi().put(
        `/projects/${st.projectId}/apis/${st.selectedId}/cases/${c.case_id}`,
        { case: casesState.cases[index] }
      );
      casesState.cases[index] = res.case;
      window.__designMarkDirty?.();
      xtoast('用例已保存');
    } catch (err) {
      xtoast(err.message, true);
    }
  };

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
  const rows = (result.results || []).map((r) =>
    xh(
      'div',
      { class: 'case-result-row' },
      xh('span', { class: `tag ${r.passed ? 'ok' : 'err'}` }, r.passed ? '通过' : '失败'),
      xh('span', { class: 'case-name' }, r.name),
      xh('span', { class: 'hint' }, r.status_code ? `HTTP ${r.status_code}` : ''),
      xh('span', { class: 'hint' }, `${r.elapsed_ms ?? '-'} ms`),
      r.message ? xh('span', { class: 'hint' }, r.message) : null
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

async function runOneCase(c) {
  const st = xstate();
  casesState.running = true;
  window.__designRerender?.();
  try {
    // 先保存用例
    await xapi().put(`/projects/${st.projectId}/apis/${st.selectedId}/cases/${c.case_id}`, {
      case: casesState.cases[casesState.activeIndex]
    });

    const res = await xapi().post(`/projects/${st.projectId}/cases/run`, {
      target_id: st.selectedId,
      case_ids: [c.case_id]
    });
    casesState.result = res;
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
    const res = await xapi().post(`/projects/${st.projectId}/cases/run`, {
      target_id: st.selectedId,
      case_ids: ids
    });
    casesState.result = res;
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
  progress: 0
};

function stressPanel() {
  const st = xstate();

  if (!st?.selectedId) return xh('div', { class: 'empty' }, '请先在左侧选择一个接口');
  if (st.targetType !== 'api') return xh('div', { class: 'empty' }, '只有 HTTP 接口支持压测');

  const s = stressState;

  const setField = (key, value) => {
    s[key] = value;
  };

  const start = async () => {
    s.running = true;
    s.result = null;
    s.progress = 0;
    window.__designRerender?.();
    try {
      // 有未保存改动时先保存
      if (window.__designState?.dirty) {
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
      )
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
                xh('div', { class: 'section-title' }, '错误样本'),
                ...result.error_samples.map((e) => xh('div', { class: 'form-hint err' }, e))
              )
            : null
        )
      : null
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
  schemaText: ''
};

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
    schema: null
  };

  const patch = (key, value) => {
    mockState.mock = { ...(mockState.mock || m), [key]: value };
    window.__designMarkDirty?.();
    window.__designRerender?.();
  };

  const save = async () => {
    try {
      let schema = null;
      if (mockState.schemaText.trim()) {
        try {
          schema = JSON.parse(mockState.schemaText);
        } catch (err) {
          xtoast(`数据结构 JSON 语法错误：${err.message}`, true);
          return;
        }
      }
      const res = await xapi().put(`/projects/${st.projectId}/apis/${st.selectedId}/mock`, {
        ...mockState.mock,
        schema
      });
      mockState.mock = res.mock;
      xtoast('Mock 配置已保存');
    } catch (err) {
      xtoast(err.message, true);
    }
  };

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

  // 预览生成的响应
  let previewText = '';
  if (mockState.schemaText.trim()) {
    try {
      const schema = JSON.parse(mockState.schemaText);
      previewText = JSON.stringify(window.MockGen?.generateFromSchema?.(schema) ?? {}, null, 2);
    } catch {
      previewText = '(数据结构有语法错误)';
    }
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
        )
      )
    ),

    xh(
      'div',
      { class: 'btn-row' },
      xh(
        'button',
        {
          class: 'small',
          onclick: async () => {
            try {
              const res = await xapi().post('/mock-server/start', { port: 39101 });
              mockState.serverRunning = true;
              mockState.serverPort = res.port;
              xtoast(`Mock 服务已启动，端口 ${res.port}`);
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
          onclick: () => {
            navigator.clipboard
              .writeText(mockUrl)
              .then(() => xtoast('已复制 Mock 地址'))
              .catch(() => xtoast('复制失败', true));
          }
        },
        '复制地址'
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
            }
          })
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
            }
          }),
          xh('div', { class: 'form-hint' }, '模拟慢接口')
        )
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
            window.__designMarkDirty?.();
          }
        }, mockState.schemaText),
        xh('div', { class: 'form-hint' }, '按此结构生成随机 Mock 数据；支持 type / properties / APIPOST_ORDERS')
      ),
      xh(
        'div',
        { class: 'mock-col' },
        xh('div', { class: 'section-title' }, 'Mock 返回预览'),
        xh('pre', { class: 'code mock-preview' }, previewText)
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
  resetCases: () => {
    casesState.loadedFor = null;
    casesState.cases = [];
    casesState.result = null;
  },
  resetMock: () => {
    mockState.loadedFor = null;
    mockState.mock = null;
  }
};
