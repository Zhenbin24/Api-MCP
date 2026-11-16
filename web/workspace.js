/* 接口工作区：上方请求构建区 + 下方常驻响应区（挂在 window.ApiWorkspace 上，由 design.js 调用）
 *
 * 布局对齐 Apipost：请求区（Method/URL/协议/发送 + 顶部信息区 + 8 个请求页签）
 * 与常驻响应区上下分栏，中间横向拖拽条调整高度。
 *
 * 依赖 design.js 通过 window.ApiDesign 导出的表单/渲染组件；本文件不重复实现它们。
 */
(() => {
'use strict';

const SPLIT_KEY = 'apipost_ws_split_h';
const SPLIT_MIN = 25;
const SPLIT_MAX = 75;
const SPLIT_DEFAULT = 60;

/* ---------------- 通用工具 ---------------- */

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

function A() {
  return window.ApiDesign;
}

function st() {
  return window.ApiDesign?.state;
}

function toast(msg, isErr) {
  window.__consoleToast?.(msg, isErr);
}

function hint(text) {
  return h('div', { class: 'form-hint' }, text);
}

function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '-';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

/* ---------------- 响应缓存（仅内存，刷新即清空） ---------------- */

const responseCache = new Map();

function setResponse(targetId, envelope) {
  if (!targetId) return;
  if (envelope == null) responseCache.delete(targetId);
  else responseCache.set(targetId, envelope);
}

function getResponse(targetId) {
  return targetId ? responseCache.get(targetId) || null : null;
}

function clearResponse(targetId) {
  responseCache.delete(targetId);
}

/* ================= 请求页签 ================= */

const REQ_TABS = [
  ['header', 'Header'],
  ['query', 'Query'],
  ['path', 'Path'],
  ['body', 'Body'],
  ['auth', '认证'],
  ['cookie', 'Cookie'],
  ['pre', '预执行操作'],
  ['post', '后执行操作']
];

/** 常用 Header 名：下拉选中后追加一行空值参数 */
const COMMON_HEADERS = [
  'Content-Type',
  'Authorization',
  'Accept',
  'Accept-Language',
  'Accept-Encoding',
  'User-Agent',
  'Referer',
  'Origin',
  'X-Request-Id',
  'X-Trace-Id',
  'Cache-Control'
];

/** 后端 applyAuth 目前能真正执行的鉴权类型 */

function ensureParamHolder(holder) {
  if (!holder) return { parameter: [] };
  if (!Array.isArray(holder.parameter)) holder.parameter = [];
  return holder;
}

/* ---------------- 请求页签：Header ---------------- */

function tabHeader(d) {
  const D = A();
  const req = d.request;
  ensureParamHolder(req.header);

  const picker = h(
    'select',
    {
      class: 'ws-header-picker',
      onchange: (e) => {
        const key = e.target.value;
        e.target.value = '';
        if (!key) return;
        const list = req.header.parameter;
        const exists = list.some((p) => p && String(p.key || '').toLowerCase() === key.toLowerCase());
        if (exists) {
          toast(`已存在 ${key}`);
          return;
        }
        list.push({
          description: '',
          field_type: 'String',
          is_checked: 1,
          key,
          not_null: -1,
          param_id: `p_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
          value: ''
        });
        D.markDirty();
        D.rerenderPane();
      }
    },
    h('option', { value: '' }, '+ 常用 Header'),
    ...COMMON_HEADERS.map((name) => h('option', { value: name }, name))
  );

  return h(
    'div',
    { class: 'param-sections' },
    h('div', { class: 'ws-row-inline' }, picker),
    D.paramSection('Header 参数', req.header, 'header'),
    hint('参数值支持 {{变量名}}；常用名可直接从下拉追加，名称可手改')
  );
}

/* ---------------- 请求页签：Query ---------------- */

function tabQuery(d) {
  const D = A();
  const req = d.request;
  ensureParamHolder(req.query);
  if (req.query.query_add_equal === undefined) req.query.query_add_equal = 1;

  const equalToggle = h(
    'label',
    { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: Number(req.query.query_add_equal) !== 0,
      onchange: (e) => {
        req.query.query_add_equal = e.target.checked ? 1 : 0;
        D.markDirty();
      }
    }),
    '空值参数也拼上 "="'
  );

  return h(
    'div',
    { class: 'param-sections' },
    D.paramSection('Query 参数', req.query, 'query'),
    h('div', { class: 'ws-row-inline' }, equalToggle),
    hint('参数会自动拼接到 URL；与 URL 里已有的 query 同名时以参数表为准')
  );
}

/* ---------------- 请求页签：Body ---------------- */

function tabBodyTab(d) {
  const D = A();
  return h('div', {}, D.tabBody(d.request.body));
}

/* ---------------- 请求页签：Path ---------------- */

function tabPath(d) {
  const D = A();
  const req = d.request;
  ensureParamHolder(req.restful);
  return h(
    'div',
    { class: 'param-sections' },
    D.paramSection('Path 参数', req.restful, 'restful'),
    hint('接口 URL 里的 {id} 与 :id 两种写法都会在这里同步为路径参数，发送时按值替换')
  );
}

/* ---------------- 请求页签：认证 ---------------- */

function tabAuthTab(d) {
  const D = A();
  return h('div', {}, D.tabAuth(d.request));
}

/* ---------------- 请求页签：Cookie ---------------- */

function tabCookie(d) {
  const D = A();
  const req = d.request;
  ensureParamHolder(req.cookie);

  const headerCookie = (req.header?.parameter || []).find(
    (p) => p && String(p.key || '').trim().toLowerCase() === 'cookie'
  );

  const conflict = headerCookie
    ? h(
        'div',
        { class: 'notice warn ws-cookie-conflict' },
        h('span', {}, '!'),
        h(
          'div',
          {},
          h('div', {}, 'Header 里已有 Cookie 请求头，发送时以 Header 为准，下面的 Cookie 表不会生效。'),
          h(
            'div',
            { class: 'btn-row mt8' },
            h(
              'button',
              {
                class: 'small',
                onclick: () => {
                  const list = req.header.parameter;
                  const index = list.indexOf(headerCookie);
                  if (index >= 0) list.splice(index, 1);
                  D.markDirty();
                  D.rerenderPane();
                  toast('已删除 Header 里的 Cookie');
                }
              },
              '删掉 Header Cookie'
            ),
            h(
              'button',
              {
                class: 'small',
                onclick: () => {
                  const raw = String(headerCookie.value || '');
                  const existing = new Set(
                    req.cookie.parameter.map((p) => String(p.key || '').trim()).filter(Boolean)
                  );
                  let added = 0;
                  for (const part of raw.split(';')) {
                    const text = part.trim();
                    if (!text) continue;
                    const eq = text.indexOf('=');
                    const key = (eq < 0 ? text : text.slice(0, eq)).trim();
                    const value = eq < 0 ? '' : text.slice(eq + 1).trim();
                    if (!key || existing.has(key)) continue;
                    req.cookie.parameter.push({
                      description: '',
                      field_type: 'String',
                      is_checked: 1,
                      key,
                      not_null: -1,
                      param_id: `p_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
                      value
                    });
                    existing.add(key);
                    added += 1;
                  }
                  // 「迁」是移动：迁完把 Header 里的 Cookie 删掉，冲突随之消失
                  const index = req.header.parameter.indexOf(headerCookie);
                  if (index >= 0) req.header.parameter.splice(index, 1);
                  D.markDirty();
                  D.rerenderPane();
                  toast(
                    added > 0
                      ? `已从 Header 迁入 ${added} 条 Cookie，并移除 Header 里的 Cookie`
                      : 'Header 里的 Cookie 已移除（内容已存在或为空）'
                  );
                }
              },
              '迁到 Cookie 表'
            )
          )
        )
      )
    : null;

  return h(
    'div',
    { class: 'param-sections' },
    conflict,
    D.paramSection('Cookie 参数', req.cookie, 'cookie'),
    hint('按 key-value 填写，发送时拼成 Cookie 请求头；值支持 {{变量名}}')
  );
}

/* ---------------- 请求页签：预执行 / 后执行 ---------------- */

const PRE_CHEATSHEET = [
  ['apt.environment.get(key)', '读取环境变量'],
  ['apt.environment.set(key, value)', '写入环境变量（后续可用 {{key}} 引用）'],
  ['apt.globals.get / set', '全局变量读写'],
  ['apt.setRequestHeader(k, v)', '改写请求头'],
  ['apt.setRequestQuery(k, v)', '改写查询参数'],
  ['apt.setRequestBody(body)', '改写请求体'],
  ['console.log(...)', '写入执行日志']
];

const POST_CHEATSHEET = [
  ['apt.response.json()', '把响应解析为 JSON'],
  ['apt.response.text()', '响应原始文本'],
  ['apt.test(name, fn)', '注册断言'],
  ['apt.expect(v).to.equal(x)', '断言链式 API'],
  ['apt.environment.set(key, value)', '把响应里的值写回环境变量'],
  ['console.log(...)', '写入执行日志']
];

function cheatsheet(rows) {
  return h(
    'div',
    { class: 'cheatsheet' },
    h('div', { class: 'param-section-title' }, 'apt API 速查'),
    ...rows.map(([code, desc]) => h('div', { class: 'cheatsheet-row' }, h('code', {}, code), h('span', {}, desc)))
  );
}

function scriptBlock({ title, tasks, onChange, placeholder, note, rows = 10, sheet = PRE_CHEATSHEET }) {
  const D = A();
  return h(
    'div',
    { class: 'param-section' },
    h('div', { class: 'param-section-title' }, title),
    h(
      'div',
      { class: 'form-control' },
      D.textarea(
        D.scriptSource(tasks),
        (v) => {
          onChange(D.setScriptSource(tasks, v));
        },
        { rows, placeholder }
      ),
      note ? hint(note) : null
    ),
    cheatsheet(sheet)
  );
}

function tabPre(d) {
  const D = A();
  const req = d.request;
  if (!Array.isArray(req.pre_tasks)) req.pre_tasks = [];
  return h(
    'div',
    { class: 'param-sections' },
    scriptBlock({
      title: '前置脚本',
      tasks: req.pre_tasks,
      onChange: (next) => {
        req.pre_tasks = next;
        D.markDirty();
      },
      placeholder: '// 发送请求前执行，例如：\napt.environment.set("token", "xxx");',
      note: '发送前执行；可用 apt.* 改写请求与变量',
      sheet: PRE_CHEATSHEET
    })
  );
}

function tabPost(d) {
  const D = A();
  const req = d.request;
  if (!Array.isArray(req.post_tasks)) req.post_tasks = [];

  return h(
    'div',
    { class: 'param-sections' },
    migrateBanner(d, () => D.markDirty()),
    h(
      'div',
      { class: 'param-section' },
      h('div', { class: 'param-section-title' }, '断言', h('span', { class: 'tab-badge' }, assertList(req.post_tasks).length)),
      assertEditor(req.post_tasks, () => D.markDirty()),
      hint('发送后先跑脚本（可能写入变量），再按顺序判定断言；任一断言失败会把该次执行标记为失败')
    ),
    scriptBlock({
      title: '后置脚本',
      tasks: req.post_tasks,
      onChange: (next) => {
        req.post_tasks = next;
        D.markDirty();
      },
      placeholder: '// 收到响应后执行，例如：\napt.test("状态码 200", () => apt.expect(apt.response.code()).to.equal(200));',
      note: '收到响应后执行；脚本里的 apt.test 与上面的断言表会合并展示',
      sheet: POST_CHEATSHEET
    })
  );
}

function reqTabBody(tab, d) {
  switch (tab) {
    case 'header':
      return tabHeader(d);
    case 'query':
      return tabQuery(d);
    case 'body':
      return tabBodyTab(d);
    case 'path':
      return tabPath(d);
    case 'auth':
      return tabAuthTab(d);
    case 'cookie':
      return tabCookie(d);
    case 'pre':
      return tabPre(d);
    case 'post':
      return tabPost(d);
    default:
      return tabHeader(d);
  }
}

/** 页签徽标计数：与 Apipost 一样只在有内容时显示 */
function tabCount(key, d) {
  const req = d?.request || {};
  if (key === 'body') {
    const body = req.body || {};
    const mode = String(body.mode || 'none');
    if (mode === 'none') return 0;
    if (mode === 'form-data' || mode === 'urlencoded') {
      return (body.parameter || []).filter((p) => p && p.key && Number(p.is_checked) !== -1).length;
    }
    return 1;
  }
  const holder =
    key === 'header' ? req.header : key === 'query' ? req.query : key === 'path' ? req.restful : null;
  if (!holder) return 0;
  return (holder.parameter || []).filter((p) => p && p.key && Number(p.is_checked) !== -1).length;
}

function reqTabs(active, onChange, d) {
  return h(
    'div',
    { class: 'tabs ws-tabs' },
    ...REQ_TABS.map(([key, label]) => {
      const count = tabCount(key, d);
      return h(
        'div',
        {
          class: `tab${active === key ? ' active' : ''}`,
          onclick: () => onChange(key)
        },
        label,
        count > 0 ? h('span', { class: 'tab-badge' }, count) : null
      );
    })
  );
}

/* ================= 可视化断言 ================= */

const ASSERT_SOURCES = [
  ['status_code', '响应码', ''],
  ['elapsed_time', '响应时间（ms）', ''],
  ['content_type', 'Content-Type', ''],
  ['response_header', 'Response Header', 'Header 名'],
  ['response_cookie', 'Response Cookie', 'Cookie 名'],
  ['response_json', 'Response JSON', 'JSONPath，如 $.code'],
  ['response_text', 'Response Text', ''],
  ['response_xml', 'Response XML', '标签路径，如 /root/name'],
  ['response_schema', 'Response Schema', 'default 或示例 ID'],
  ['var', '临时变量', '变量名'],
  ['env_var', '环境变量', '变量名'],
  ['global_var', '全局变量', '变量名']
];

const ASSERT_CONDITIONS = [
  ['equal', '等于'],
  ['not_equal', '不等于'],
  ['include', '包含'],
  ['not_include', '不包含'],
  ['regex', '正则匹配'],
  ['gt', '大于'],
  ['lt', '小于'],
  ['gte', '大于等于'],
  ['lte', '小于等于'],
  ['length_equal', '长度等于'],
  ['exists', '存在'],
  ['empty', '为空'],
  ['type_is', '类型为'],
  ['schema_match', '结构匹配']
];

/** 不需要比较值的条件 */
const NO_VALUE_CONDITIONS = new Set(['exists', 'empty', 'schema_match']);

function assertList(tasks) {
  return (tasks || []).filter((t) => t && t.type === 'assert');
}

function assertLabel(a) {
  const src = ASSERT_SOURCES.find(([k]) => k === a?.data?.source);
  const cond = ASSERT_CONDITIONS.find(([k]) => k === a?.data?.condition);
  const name = String(a?.name || '').trim();
  if (name) return name;
  const expr = String(a?.data?.expression || '').trim();
  return `${src ? src[1] : a?.data?.source || '断言'}${expr ? ` ${expr}` : ''} ${cond ? cond[1] : ''}`.trim();
}

function newAssertTask(index) {
  return {
    id: `as_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
    type: 'assert',
    name: `断言${index}`,
    enabled: 1,
    data: { source: 'status_code', expression: '', condition: 'equal', value: '200', description: '' }
  };
}

/**
 * 可视化断言编辑表。
 * 断言任务与自定义脚本共用 request.post_tasks：脚本执行器只认 type === 'customScript'，
 * 因此这里的 type === 'assert' 不会被误当脚本执行。
 */
function assertEditor(postTasks, onChange) {
  const host = h('div', { class: 'assert-editor' });

  const commit = (nextAsserts) => {
    const keep = postTasks.filter((t) => !(t && t.type === 'assert'));
    postTasks.length = 0;
    postTasks.push(...keep, ...nextAsserts);
    onChange();
  };

  const render = () => {
    const asserts = assertList(postTasks);
    const nodes = [];

    if (asserts.length === 0) {
      nodes.push(h('div', { class: 'param-empty' }, '还没有断言'));
    }

    asserts.forEach((task, index) => {
      task.data = task.data || { source: 'status_code', expression: '', condition: 'equal', value: '' };
      const data = task.data;
      const needsValue = !NO_VALUE_CONDITIONS.has(String(data.condition || 'equal'));
      const meta = ASSERT_SOURCES.find(([k]) => k === data.source) || ASSERT_SOURCES[0];

      nodes.push(
        h(
          'div',
          { class: 'assert-row' },
          h('input', {
            type: 'checkbox',
            title: '启用该断言',
            checked: Number(task.enabled) !== -1,
            onchange: (e) => {
              task.enabled = e.target.checked ? 1 : -1;
              commit(assertList(postTasks));
            }
          }),
          h(
            'select',
            {
              class: 'assert-source',
              onchange: (e) => {
                data.source = e.target.value;
                if (data.source === 'response_schema' && !data.expression) data.expression = 'default';
                commit(assertList(postTasks));
                render();
              }
            },
            ...ASSERT_SOURCES.map(([key, label]) =>
              h('option', { value: key, ...(key === data.source ? { selected: true } : {}) }, label)
            )
          ),
          h('input', {
            type: 'text',
            class: 'mono-input assert-expression',
            value: data.expression || '',
            placeholder: meta[2] || '无需表达式',
            disabled: !meta[2],
            oninput: (e) => {
              data.expression = e.target.value;
              commit(assertList(postTasks));
            }
          }),
          h(
            'select',
            {
              class: 'assert-condition',
              onchange: (e) => {
                data.condition = e.target.value;
                commit(assertList(postTasks));
                render();
              }
            },
            ...ASSERT_CONDITIONS.map(([key, label]) =>
              h('option', { value: key, ...(key === data.condition ? { selected: true } : {}) }, label)
            )
          ),
          h('input', {
            type: 'text',
            class: 'mono-input assert-value',
            value: data.value ?? '',
            placeholder: needsValue ? '比较值' : '不需要比较值',
            disabled: !needsValue,
            oninput: (e) => {
              data.value = e.target.value;
              commit(assertList(postTasks));
            }
          }),
          h('input', {
            type: 'text',
            class: 'assert-description',
            value: data.description || '',
            placeholder: '说明（可选）',
            oninput: (e) => {
              data.description = e.target.value;
              commit(assertList(postTasks));
            }
          }),
          h(
            'button',
            {
              class: 'small danger',
              title: '删除',
              onclick: () => {
                const next = assertList(postTasks).filter((t) => t !== task);
                commit(next);
                render();
              }
            },
            '×'
          )
        )
      );
    });

    nodes.push(
      h(
        'button',
        {
          class: 'small param-add',
          onclick: () => {
            commit([...assertList(postTasks), newAssertTask(assertList(postTasks).length + 1)]);
            render();
          }
        },
        '+ 添加断言'
      )
    );

    host.replaceChildren(...nodes);
  };

  render();
  return host;
}

/* --------- 旧期望校验 → 断言 的显式迁移 --------- */

/**
 * 旧接口的 response.is_check_result + example[].expect 校验路径保持原样，
 * 这里只提供显式迁移入口，避免静默改变既有接口的校验行为。
 */
function migrateBanner(d, markDirty) {
  const resp = d.response || {};
  if (Number(resp.is_check_result) !== 1) return null;

  const examples = Array.isArray(resp.example) ? resp.example : [];
  const pick = examples.find((e) => Number(e?.expect?.is_default) === 1) || examples[0];
  const expect = pick?.expect || null;
  if (!expect) return null;

  return h(
    'div',
    { class: 'notice info ws-migrate' },
    h('span', {}, 'i'),
    h(
      'div',
      {},
      h('div', {}, '当前「期望」页的结构校验仍在生效（状态码 / Content-Type / 响应头 / Schema）。'),
      h('div', { class: 'hint mt8' }, '迁移为断言后，校验规则会集中在本页签，可在表里继续编辑。'),
      h(
        'div',
        { class: 'btn-row mt8' },
        h(
          'button',
          {
            class: 'small primary',
            onclick: () => {
              const exists = assertList(d.request?.post_tasks || []);
              const base = exists.length;
              const added = [];

              const push = (source, expression, condition, value, description) => {
                added.push({
                  id: `as_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
                  type: 'assert',
                  name: description,
                  enabled: 1,
                  data: { source, expression, condition, value, description }
                });
              };

              if (expect.code && String(expect.code).trim()) {
                push('status_code', '', 'equal', String(expect.code).trim().split(/[,|\s]+/)[0], '状态码校验');
              }
              if (expect.content_type && String(expect.content_type).trim()) {
                push('content_type', '', 'include', String(expect.content_type).trim(), 'Content-Type 校验');
              }
              for (const [key, value] of Object.entries(expect.headers || {})) {
                if (!key) continue;
                push('response_header', String(key), 'include', String(value ?? ''), `响应头校验（${key}）`);
              }
              if (expect.schema && typeof expect.schema === 'object' && Object.keys(expect.schema).length > 0) {
                push('response_schema', 'default', 'schema_match', '', '响应结构校验');
              }

              if (added.length === 0) {
                toast('这条期望没有可迁移的校验规则', true);
                return;
              }

              d.request.post_tasks = [...(d.request.post_tasks || []), ...added];
              d.response.is_check_result = -1;
              markDirty();
              A().rerenderPane();
              toast(`已迁移 ${added.length} 条断言${base > 0 ? `（原有 ${base} 条保留）` : ''}`);
            }
          },
          '迁移为断言'
        ),
        h(
          'span',
          { class: 'hint' },
          `${[expect.code ? '状态码' : '', expect.content_type ? 'Content-Type' : '', Object.keys(expect.headers || {}).length ? '响应头' : '', expect.schema ? 'Schema' : ''].filter(Boolean).join(' / ') || '无规则'}`
        )
      )
    )
  );
}

/* ================= 响应区 ================= */

const RESP_TABS = [
  ['body', '实时响应'],
  ['headers', '响应头'],
  ['cookies', 'Cookie'],
  ['example', '响应示例'],
  ['request', '实际请求'],
  ['console', '控制台']
];

/** Apipost 的 8 段耗时：前 7 段并列，Done 是总计 */
const TIMING_SEGMENTS = [
  ['request_ms', 'Request', '发出请求'],
  ['socket_ms', 'Socket', '分配套接字'],
  ['lookup_ms', 'Lookup', 'DNS 查询'],
  ['connect_ms', 'Connect', 'TCP 建连'],
  ['tls_ms', 'SecureConnect', 'TLS 握手'],
  ['waiting_ms', 'Response', '等待首字节'],
  ['download_ms', 'End', '下载响应体']
];

function timingBreakdown(timings, elapsed) {
  const hasDetail = timings && typeof timings === 'object';
  const total = Number(hasDetail ? timings.total_ms : elapsed) || 0;
  const rows = [];

  if (hasDetail) {
    const sum = TIMING_SEGMENTS.reduce((acc, [key]) => acc + (Number(timings[key]) || 0), 0);
    const base = Math.max(total, sum, 1);
    for (const [key, label, desc] of TIMING_SEGMENTS) {
      const value = Number(timings[key]) || 0;
      if (value <= 0 && key === 'tls_ms') continue;
      const pct = Math.max(0, Math.min(100, (value / base) * 100));
      rows.push(
        h(
          'div',
          { class: 'timing-row', title: `${label} · ${desc}` },
          h('span', { class: 'timing-label' }, label),
          h('span', { class: 'timing-track' }, h('span', { class: 'timing-bar', style: `width:${pct.toFixed(1)}%` })),
          h('span', { class: 'timing-value mono' }, fmtMs(value))
        )
      );
    }
    rows.push(
      h(
        'div',
        { class: 'timing-row timing-total' },
        h('span', { class: 'timing-label' }, 'Done'),
        h('span', { class: 'timing-track' }),
        h('span', { class: 'timing-value mono' }, fmtMs(total))
      )
    );
  } else {
    rows.push(
      h(
        'div',
        { class: 'timing-row timing-total' },
        h('span', { class: 'timing-label' }, 'Done'),
        h('span', { class: 'timing-track' }),
        h('span', { class: 'timing-value mono' }, fmtMs(total))
      )
    );
    rows.push(h('div', { class: 'form-hint' }, '该请求未采集分阶段耗时（HTTP/2 或历史记录）'));
  }

  if (hasDetail && Number(timings.redirects) > 0) {
    rows.unshift(h('div', { class: 'form-hint' }, `经过 ${timings.redirects} 次跳转，耗时已累计`));
  }

  return h('div', { class: 'timing-breakdown' }, ...rows);
}

function emptyState() {
  return h(
    'div',
    { class: 'debug-empty' },
    h('div', {}, '还没有响应'),
    h('div', { class: 'hint' }, '点上方「发送」按钮，响应会显示在这里')
  );
}

function errorState(message) {
  return h('div', { class: 'debug-error' }, `发送失败：${message}`);
}

function assertRowView(a) {
  const hasCompare = a.expected !== undefined || a.actual !== undefined;
  return h(
    'div',
    { class: 'assert-result-row' },
    h('span', { class: `tag ${a.passed ? 'ok' : 'err'}` }, a.passed ? '通过' : '失败'),
    h('span', { class: 'assert-result-name' }, a.name || a.expression || '断言'),
    hasCompare
      ? h(
          'span',
          { class: 'assert-actual mono' },
          `期望 ${a.expected === undefined ? '-' : JSON.stringify(a.expected)}`,
          ' → ',
          `实际 ${a.actual === undefined ? '-' : JSON.stringify(a.actual)}`
        )
      : null,
    !a.passed && a.message ? h('span', { class: 'hint' }, a.message) : null
  );
}

function requestDetailPane(req) {
  const Ui = window.UiBits;
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
          Ui.kvTable(query)
        )
      : null,
    h('div', { class: 'kv-block mt12' }, Ui.headersTable(headers, '请求头')),
    bodyMode !== 'none'
      ? h(
          'div',
          { class: 'kv-block mt12' },
          Ui.collapsible(`请求体（${bodyMode}）`, h('pre', { class: 'code' }, req.body || '(空)'), { open: true })
        )
      : null
  );
}

function formatSize(bytes) {
  const D = A();
  if (D?.formatSize) return D.formatSize(bytes);
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function truncateUrl(url) {
  const D = A();
  if (D?.truncateUrl) return D.truncateUrl(url);
  return String(url || '');
}

function responsePane() {
  const D = A();
  const Ui = window.UiBits;
  const state = st();
  if (!state) return h('div', { class: 'empty' }, '状态未就绪');

  const envelope = getResponse(state.selectedId);
  if (!envelope) return h('div', { class: 'ws-response-inner' }, emptyState());

  // 请求未成功（没拿到 response）：只保留错误信息、发送日志与实际请求。
  // 实时响应 / 响应头 / Cookie / 响应示例 都没有内容可看，渲染出来只会误导。
  if (envelope.error && !envelope.response) {
    const failedReq = envelope.live_detail?.request || envelope.request || null;
    const failedLogs = envelope.console || [];
    return h(
      'div',
      { class: 'ws-response-inner' },
      errorState(envelope.error),
      failedLogs.length > 0
        ? h(
            'details',
            { class: 'ws-failed-block' },
            h('summary', {}, `发送日志 ${failedLogs.length}`),
            h('pre', { class: 'code' }, failedLogs.map((c) => `[${c.level}] ${c.message}`).join('\n'))
          )
        : null,
      failedReq
        ? h(
            'details',
            { class: 'ws-failed-block', open: true },
            h('summary', {}, '实际请求'),
            requestDetailPane(failedReq)
          )
        : null
    );
  }

  const resp = envelope.response;
  if (!resp) return h('div', { class: 'ws-response-inner' }, errorState(envelope.error || '没有响应'));

  // 顶层二进制字段合并回来，供渲染与下载使用
  const view = {
    ...resp,
    content_type: resp.content_type || envelope.content_type || '',
    is_binary: resp.is_binary !== undefined ? resp.is_binary : Boolean(envelope.is_binary),
    body_base64: envelope.body_base64 || resp.body_base64 || null,
    too_large_for_base64: Boolean(envelope.too_large_for_base64 || resp.too_large_for_base64)
  };

  const status = Number(resp.status) || 0;
  const statusCls = status >= 500 ? 'err' : status >= 400 ? 'warn' : status >= 200 && status < 300 ? 'ok' : '';

  const live = envelope.live_detail || null;
  const liveReq = live?.request || envelope.request || null;
  const liveResp = live?.response || null;
  const timings = envelope.timings || liveResp?.timings || resp.timings || null;

  const timingHost = h('div', { class: 'ws-timing-slot' });
  let timingOpen = Boolean(state.wsTimingOpen);
  const renderTiming = () => {
    if (!timingOpen) {
      timingHost.replaceChildren();
      return;
    }
    timingHost.replaceChildren(timingBreakdown(timings, envelope.elapsed_ms));
  };

  const timingBtn = h(
    'button',
    {
      class: `small ws-timing-btn${timingOpen ? ' active' : ''}`,
      title: '查看各阶段耗时',
      onclick: () => {
        timingOpen = !timingOpen;
        state.wsTimingOpen = timingOpen;
        timingBtn.classList.toggle('active', timingOpen);
        renderTiming();
      }
    },
    fmtMs(envelope.elapsed_ms)
  );

  const meta = h(
    'div',
    { class: 'response-meta' },
    h('span', { class: `tag ${statusCls}` }, `${status} ${resp.status_text || ''}`.trim()),
    h('span', { class: 'hint' }, `${liveResp?.protocol || envelope.protocol || 'HTTP/1.1'}`),
    timingBtn,
    h('span', { class: 'hint' }, formatSize(resp.size || (resp.body || '').length)),
    envelope.request?.url
      ? h(
          'code',
          {
            class: 'mono hint meta-url',
            title: envelope.request.url,
            onclick: async () => {
              const res = await window.__consoleCopy?.(envelope.request.url);
              if (res?.ok) toast('已复制 URL');
              else window.__consoleCopyFailed?.(res?.error);
            }
          },
          truncateUrl(envelope.request.url)
        )
      : null,
    h('span', { class: 'spacer' }),
    h(
      'button',
      {
        class: 'small',
        onclick: async () => {
          const res = await window.__consoleCopy?.(resp.body || '');
          if (res?.ok) toast('已复制响应体');
          else window.__consoleCopyFailed?.(res?.error);
        }
      },
      '复制响应'
    ),
    h('button', { class: 'small', onclick: () => D.saveAsExample?.() }, '保存为示例'),
    h('button', { class: 'small', disabled: !liveReq, onclick: () => D.copyAsCurl?.(liveReq) }, '复制为 cURL'),
    h('button', { class: 'small', disabled: !liveReq, onclick: () => D.openCodeSnippet?.(liveReq) }, '生成代码')
  );

  // 各内部页签内容
  const bodyNode = D.buildResponseBody(view, envelope);

  const headersNode = h(
    'div',
    { class: 'headers-pane' },
    Ui.statusLine({
      protocol: liveResp?.protocol || envelope.protocol || 'HTTP/1.1',
      status: resp.status,
      status_text: resp.status_text
    }),
    Ui.headersTable(liveResp?.headers || resp.headers, '响应头'),
    liveResp?.set_cookies?.length
      ? h(
          'div',
          { class: 'kv-block mt12' },
          h('div', { class: 'kv-block-title' }, 'Set-Cookie', h('span', { class: 'hint' }, ` ${liveResp.set_cookies.length}`)),
          Ui.cookieTable(liveResp.set_cookies, { mask: state.debugMask })
        )
      : null
  );

  const reqCookies = liveReq?.cookies || {};
  const cookieHeader = (() => {
    const headers = liveReq?.headers || {};
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
    return key ? headers[key] : '';
  })();
  const cookiesNode = h(
    'div',
    { class: 'cookie-pane' },
    h('div', { class: 'kv-block-title' }, '请求带的 Cookie'),
    Object.keys(reqCookies).length > 0
      ? Ui.kvTable(reqCookies, { mask: state.debugMask, keyWidth: 180 })
      : cookieHeader
        ? h('pre', { class: 'code' }, state.debugMask ? '***' : cookieHeader)
        : h('div', { class: 'form-hint' }, '本次请求没有 Cookie'),
    h('div', { class: 'kv-block-title mt16' }, '响应下发的 Cookie'),
    Ui.cookieTable(liveResp?.set_cookies || [], { mask: state.debugMask })
  );

  const assertions = envelope.assertions || [];
  const passedCount = assertions.filter((a) => a.passed).length;
  // 断言并入「实时响应」（Apipost 的响应区没有独立断言页签）
  const assertionsBlock =
    assertions.length > 0
      ? h(
          'details',
          { class: 'ws-assert-block', open: true },
          h(
            'summary',
            {},
            `断言结果 ${passedCount}/${assertions.length}`,
            passedCount === assertions.length
              ? h('span', { class: 'tag ok' }, '全部通过')
              : h('span', { class: 'tag err' }, `${assertions.length - passedCount} 条失败`)
          ),
          h('div', { class: 'assert-results' }, ...assertions.map((a) => assertRowView(a)))
        )
      : null;

  const bodyWithAssertions = h('div', {}, bodyNode, assertionsBlock);

  const logs = envelope.console || [];
  const consoleNode = h(
    'div',
    {},
    logs.length > 0
      ? h('pre', { class: 'code' }, logs.map((c) => `[${c.level}] ${c.message}`).join('\n'))
      : h('div', { class: 'empty' }, '没有日志')
  );

  const examples = state.data?.response?.example;
  const exampleCount = Array.isArray(examples) ? examples.length : 0;

  const contentMap = {
    body: bodyWithAssertions,
    headers: headersNode,
    cookies: cookiesNode,
    example: window.__responseExamplePane?.() || h('div', { class: 'empty' }, '响应示例面板未加载'),
    console: consoleNode,
    request: requestDetailPane(liveReq)
  };

  const active = state.debugTab || 'body';

  return h(
    'div',
    { class: 'ws-response-inner' },
    meta,
    timingHost,
    h(
      'div',
      { class: 'tabs tabs-sm ws-resp-tabs' },
      ...RESP_TABS.map(([key, label]) =>
        h(
          'div',
          {
            class: `tab${active === key ? ' active' : ''}`,
            onclick: () => {
              state.debugTab = key;
              D.rerenderPane();
            }
          },
          label,
          key === 'example' && exampleCount > 0
            ? h('span', { class: 'tab-badge' }, exampleCount)
            : null
        )
      ),
      h('span', { class: 'spacer' }),
      h(
        'label',
        { class: 'check ws-mask-toggle' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(state.debugMask),
          onchange: (e) => {
            state.debugMask = e.target.checked;
            D.rerenderPane();
          }
        }),
        '隐藏敏感值'
      )
    ),
    h('div', { class: 'debug-content ws-resp-content' }, contentMap[active] || bodyWithAssertions)
  );
}

/* ================= 顶部信息区 ================= */

/* 接口信息区（名称 / 状态 / 目录 / 标签 / 说明）由 design.js 的 metaBar() 渲染，
 * 这里只做转调，避免两份实现漂移。 */

/* ================= 分栏骨架 ================= */

function readSplit() {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= SPLIT_MIN && n <= SPLIT_MAX) return n;
  } catch {}
  return SPLIT_DEFAULT;
}

function splitter(container) {
  const bar = h('div', { class: 'ws-splitter', title: '拖动调整高度' });

  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();

    document.body.classList.add('ws-resizing-v');

    // 纵向拖拽：按 clientY 占容器高度的百分比写 --ws-req-h
    const onMove = (ev) => {
      const pct = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 100;
      const clamped = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, pct));
      container.style.setProperty('--ws-req-h', `${clamped.toFixed(2)}%`);
      bar.dataset.pct = String(clamped.toFixed(2));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('ws-resizing-v');
      try {
        if (bar.dataset.pct) localStorage.setItem(SPLIT_KEY, bar.dataset.pct);
      } catch {}
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  return bar;
}

/**
 * 接口工作区骨架：上请求区 + 拖拽条 + 下响应区。
 * @param {object} d 已 ensureShape 过的接口数据
 */
function shell(d) {
  const D = A();
  const state = st();
  if (!d) return h('div', { class: 'empty' }, '请选择左侧接口');

  const tab = state.wsTab || 'header';

  const container = h('div', { class: 'editor-inner ws-shell' });
  container.style.setProperty('--ws-req-h', `${readSplit()}%`);

  const reqPane = h(
    'div',
    { class: 'ws-request' },
    D.modeTabs(),
    D.requestBar(),
    D.metaBar(),
    reqTabs(tab, (key) => {
      state.wsTab = key;
      D.rerenderPane();
    }, d),
    h('div', { class: 'ws-tab-content' }, reqTabBody(tab, d))
  );

  const respPane = h('div', { class: 'ws-response' }, responsePane());

  container.append(reqPane, splitter(container), respPane);

  return container;
}

/* ================= 挂载 ================= */

window.ApiWorkspace = {
  shell,
  setResponse,
  getResponse,
  clearResponse,
  responsePane,
  assertEditor,
  assertList,
  assertLabel,
  REQ_TABS,
  ASSERT_SOURCES,
  ASSERT_CONDITIONS
};

})();
