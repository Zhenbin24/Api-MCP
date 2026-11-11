/* 环境与变量：环境管理（含多 host 服务）/ 全局参数 / 全局变量
 * 挂在 window.ApiEnvvars 上，由 app.js 的侧栏「环境与变量」调用。 */

const EV_TABS = [
  ['env', '环境'],
  ['params', '全局参数'],
  ['vars', '全局变量']
];

const evState = {
  projectId: null,
  tab: 'env',
  activeEnvId: '',
  data: null, // { current_env_id, environments[], shared_servers[], global_vars[] }
  params: null,
  vars: null,
  dirty: { params: false, vars: false, env: false },
  loading: false
};

/* ---------------- 基础工具 ---------------- */

function evEl(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'value') node.value = v ?? '';
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

function evApi() {
  return window.__consoleApi || null;
}

function evToast(msg, isErr) {
  window.__consoleToast?.(msg, isErr);
}

function evProjectId() {
  const st = window.__consoleState;
  if (!evState.projectId && st) {
    evState.projectId = st.currentProjectId || st.designProjectId || st.projects?.[0]?.project_id || null;
  }
  return evState.projectId;
}

function evMark(scope, value = true) {
  evState.dirty[scope] = value;
  const badge = document.querySelector(`[data-ev-dirty="${scope}"]`);
  if (badge) badge.style.display = value ? '' : 'none';
}

/* ---------------- 数据加载 ---------------- */

async function loadEnvBundle(projectId) {
  const res = await evApi().get(`/projects/${projectId}/environments`);
  evState.data = res;
  evState.data.shared_servers = res.shared_servers || [];
  const current = res.current_env_id || res.environments?.[0]?.env_id || '';
  if (!evState.activeEnvId || !res.environments.some((e) => e.env_id === evState.activeEnvId)) {
    evState.activeEnvId = current || res.environments?.[0]?.env_id || '';
  }
  return res;
}

async function loadGlobalParams(projectId) {
  const res = await evApi().get(`/projects/${projectId}/global-params`);
  evState.params = res.params;
  return res.params;
}

async function loadGlobalVars(projectId) {
  const res = await evApi().get(`/projects/${projectId}/global-vars`);
  evState.vars = res.variables || [];
  return evState.vars;
}

async function loadAll(force = false) {
  const projectId = evProjectId();
  if (!projectId) return;
  if (evState.loading) return;
  evState.loading = true;
  try {
    await Promise.all([loadEnvBundle(projectId), loadGlobalParams(projectId), loadGlobalVars(projectId)]);
    if (force) evState.dirty = { params: false, vars: false, env: false };
  } catch (err) {
    evToast(err.message, true);
  } finally {
    evState.loading = false;
  }
}

/* ---------------- 通用小组件 ---------------- */

function evInput(value, onInput, { placeholder = '', mono = false, type = 'text', width = '' } = {}) {
  return evEl('input', {
    type,
    class: mono ? 'mono-input' : '',
    style: width ? `width:${width}` : '',
    value: value ?? '',
    placeholder,
    oninput: (e) => onInput(e.target.value)
  });
}

function evCard(title, ...children) {
  return evEl(
    'div',
    { class: 'section' },
    title ? evEl('div', { class: 'section-title' }, title) : null,
    ...children
  );
}

function evHint(text, cls = '') {
  return evEl('div', { class: `hint ${cls}`.trim() }, text);
}

function evDirtyBadge(scope) {
  return evEl('span', {
    class: 'tag warn',
    'data-ev-dirty': scope,
    style: evState.dirty[scope] ? '' : 'display:none'
  }, '未保存');
}

/* ---------------- 页签 1：环境 ---------------- */

function envPane() {
  const bundle = evState.data || { environments: [], shared_servers: [] };
  const envs = bundle.environments || [];
  const active = envs.find((e) => e.env_id === evState.activeEnvId) || envs[0] || null;
  const projectId = evProjectId();

  const envRows = envs.map((env) =>
    evEl(
      'tr',
      { class: env.env_id === active?.env_id ? 'active' : '' },
      evEl(
        'td',
        {},
        evEl(
          'div',
          { class: 'ellipsis' },
          evEl('span', { class: 'mono' }, env.name || env.env_id),
          env.is_current ? evEl('span', { class: 'tag ok', style: 'margin-left:6px' }, '当前') : null
        )
      ),
      evEl('td', { class: 'mono small' }, env.base_url || evEl('span', { class: 'hint' }, '（未设置）')),
      evEl(
        'td',
        {},
        evEl(
          'div',
          { class: 'row-actions' },
          env.is_current
            ? null
            : evEl(
                'button',
                {
                  class: 'small',
                  onclick: async () => {
                    try {
                      await evApi().post(`/projects/${projectId}/environments/current`, { environment_id: env.env_id });
                      await loadEnvBundle(projectId);
                      evToast(`已切换到「${env.name}」`);
                      renderAll();
                    } catch (err) {
                      evToast(err.message, true);
                    }
                  }
                },
                '设为当前'
              ),
          evEl(
            'button',
            {
              class: 'small',
              onclick: () => pickEnv(env.env_id)
            },
            '编辑'
          ),
          String(env.env_id) === '1'
            ? null
            : evEl(
                'button',
                {
                  class: 'small danger',
                  onclick: async () => {
                    if (!confirm(`确定删除环境「${env.name}」？该环境的变量也会一并删除。`)) return;
                    try {
                      await evApi().req('DELETE', `/projects/${projectId}/environments/${env.env_id}`);
                      if (evState.activeEnvId === env.env_id) evState.activeEnvId = '';
                      await loadEnvBundle(projectId);
                      evToast('环境已删除');
                      renderAll();
                    } catch (err) {
                      evToast(err.message, true);
                    }
                  }
                },
                '删除'
              )
        )
      )
    )
  );

  const newEnvRow = evEl(
    'div',
    { class: 'btn-row' },
    evEl(
      'button',
      {
        class: 'primary small',
        onclick: async () => {
          const name = prompt('环境名称（例如：预发 / 生产）');
          if (!name || !String(name).trim()) return;
          try {
            const created = await evApi().post(`/projects/${projectId}/environments`, { name: String(name).trim() });
            evState.activeEnvId = created.environment.env_id;
            await loadEnvBundle(projectId);
            evToast('环境已创建');
            renderAll();
          } catch (err) {
            evToast(err.message, true);
          }
        }
      },
      '+ 新建环境'
    )
  );

  return evEl(
    'div',
    {},
    evCard(
      '环境列表',
      evHint('切换当前环境后，接口调试与「发送」都会使用该环境的服务地址与变量。'),
      evEl(
        'table',
        { class: 'table' },
        evEl('thead', {}, evEl('tr', {}, evEl('th', {}, '名称'), evEl('th', {}, '前置 URL'), evEl('th', { style: 'width:220px' }, '操作'))),
        evEl('tbody', {}, ...envRows)
      ),
      newEnvRow
    ),
    active ? envDetailPane(active) : evEl('div', { class: 'empty' }, '还没有环境')
  );
}

function envDetailPane(env) {
  const projectId = evProjectId();

  const varRows = (env.variables || []).map((v, index) =>
    evEl(
      'tr',
      {},
      evEl('td', {}, evInput(v.key, (val) => {
        env.variables[index].key = val;
        evMark('env');
      }, { mono: true, placeholder: 'key' })),
      evEl('td', {}, evInput(v.value, (val) => {
        env.variables[index].value = val;
        evMark('env');
      }, { mono: true, placeholder: 'value' })),
      evEl('td', {}, evInput(v.current_value, (val) => {
        env.variables[index].current_value = val;
        evMark('env');
      }, { mono: true, placeholder: '运行时值' })),
      evEl('td', {}, evInput(v.description, (val) => {
        env.variables[index].description = val;
        evMark('env');
      }, { placeholder: '说明' })),
      evEl(
        'td',
        {},
        evEl(
          'button',
          {
            class: 'small danger',
            onclick: () => {
              env.variables.splice(index, 1);
              evMark('env');
              renderAll();
            }
          },
          '删除'
        )
      )
    )
  );

  const addVarBtn = evEl(
    'button',
    {
      class: 'small',
      onclick: () => {
        env.variables = env.variables || [];
        env.variables.push({ key: '', value: '', current_value: '', description: '' });
        evMark('env');
        renderAll();
      }
    },
    '+ 添加变量'
  );

  const saveVarsBtn = evEl(
    'button',
    {
      class: 'primary small',
      onclick: async () => {
        try {
          const variables = (env.variables || []).filter((v) => String(v.key || '').trim());
          const res = await evApi().put(`/projects/${projectId}/environments/${env.env_id}/variables`, { variables });
          env.variables = res.variables || [];
          evMark('env', false);
          evToast('环境变量已保存');
          await loadEnvBundle(projectId);
          renderAll();
        } catch (err) {
          evToast(err.message, true);
        }
      }
    },
    '保存变量'
  );

  // 多 host 服务：行 = 共享服务，值 = 当前环境下的地址
  const shared = evState.data?.shared_servers || [];
  const serverRows = shared.map((s) => {
    const own = (env.servers || []).find((x) => String(x.server_id) === String(s.server_id));
    return evEl(
      'tr',
      {},
      evEl(
        'td',
        {},
        evEl('span', { class: 'mono' }, s.name || s.server_id),
        String(s.server_id) === '1' ? evEl('span', { class: 'tag', style: 'margin-left:6px' }, '默认') : null
      ),
      evEl('td', {}, evInput(own?.base_url || '', async (val) => {
        try {
          await evApi().put(`/projects/${projectId}/servers/${s.server_id}`, {
            environment_id: env.env_id,
            base_url: val
          });
          if (own) own.base_url = val;
          if (String(s.server_id) === '1') env.base_url = val;
          evToast('服务地址已更新');
        } catch (err) {
          evToast(err.message, true);
        }
      }, { mono: true, placeholder: 'http://...' })),
      evEl(
        'td',
        {},
        String(s.server_id) === '1'
          ? evEl('span', { class: 'hint' }, '不可删除')
          : evEl(
              'button',
              {
                class: 'small danger',
                onclick: async () => {
                  if (!confirm(`确定删除服务「${s.name}」？所有环境中该服务的地址都会移除。`)) return;
                  try {
                    await evApi().req('DELETE', `/projects/${projectId}/servers/${s.server_id}`);
                    await loadEnvBundle(projectId);
                    evToast('服务已删除');
                    renderAll();
                  } catch (err) {
                    evToast(err.message, true);
                  }
                }
              },
              '删除服务'
            )
      )
    );
  });

  const addServerBtn = evEl(
    'button',
    {
      class: 'small',
      onclick: async () => {
        const name = prompt('服务名称（例如：用户服务）');
        if (!name || !String(name).trim()) return;
        try {
          await evApi().post(`/projects/${projectId}/servers`, {
            name: String(name).trim(),
            environment_id: env.env_id
          });
          await loadEnvBundle(projectId);
          evToast('服务已创建，可为其填写各环境地址');
          renderAll();
        } catch (err) {
          evToast(err.message, true);
        }
      }
    },
    '+ 新建服务'
  );

  return evEl(
    'div',
    {},
    evCard(
      `「${env.name}」的环境变量`,
      evDirtyBadge('env'),
      evEl(
        'table',
        { class: 'table' },
        evEl(
          'thead',
          {},
          evEl(
            'tr',
            {},
            evEl('th', {}, 'Key'),
            evEl('th', {}, '默认值'),
            evEl('th', {}, '当前值'),
            evEl('th', {}, '说明'),
            evEl('th', { style: 'width:70px' }, '')
          )
        ),
        evEl('tbody', {}, ...varRows)
      ),
      evEl('div', { class: 'btn-row' }, addVarBtn, saveVarsBtn),
      evHint('请求里用 {{变量名}} 引用。「当前值」优先于默认值，脚本写入的也是当前值。')
    ),
    evCard(
      '多 host 服务（前置 URL）',
      evHint('同一个环境下接口分散在多个服务时，可为每个服务配置地址，再把目录指向对应服务。'),
      evEl(
        'table',
        { class: 'table' },
        evEl('thead', {}, evEl('tr', {}, evEl('th', {}, '服务'), evEl('th', {}, `「${env.name}」下的地址`), evEl('th', { style: 'width:110px' }, ''))),
        evEl('tbody', {}, ...serverRows)
      ),
      evEl('div', { class: 'btn-row' }, addServerBtn)
    )
  );
}

function pickEnv(envId) {
  evState.activeEnvId = envId;
  renderAll();
}

/* ---------------- 页签 2：全局参数 ---------------- */

function paramsPane() {
  const projectId = evProjectId();
  const params = evState.params;
  if (!params) return evEl('div', { class: 'empty' }, '加载中…');

  // 保证结构
  for (const key of ['header', 'query', 'cookie']) {
    params[key] = params[key] || { parameter: [] };
    if (!Array.isArray(params[key].parameter)) params[key].parameter = [];
  }
  params.body = params.body || { mode: 'none', parameter: [] };
  params.auth = params.auth || { type: 'noauth' };
  params.pre_tasks = Array.isArray(params.pre_tasks) ? params.pre_tasks : [];
  params.post_tasks = Array.isArray(params.post_tasks) ? params.post_tasks : [];

  const body = params.body;
  const bodyMode = String(body.mode || 'none');
  const isForm = ['form-data', 'urlencoded'].includes(bodyMode);

  const save = async () => {
    try {
      const res = await evApi().put(`/projects/${projectId}/global-params`, { params });
      evState.params = res.params;
      evMark('params', false);
      evToast('全局参数已保存');
      renderAll();
    } catch (err) {
      evToast(err.message, true);
    }
  };

  return evEl(
    'div',
    {},
    evCard(
      '全局参数',
      evDirtyBadge('params'),
      evHint('全局参数对项目下每个接口生效，按「全局 → 目录 → 接口」继承，接口自身同名参数优先。'),
      evEl(
        'div',
        { class: 'envvars-grid' },
        // Header
        evEl(
          'div',
          { class: 'param-section' },
          evEl('div', { class: 'param-section-title' }, 'Header 参数', evEl('span', { class: 'tab-badge' }, params.header.parameter.length)),
          window.ApiDesign.paramTable(params.header.parameter, (next) => {
            params.header.parameter = next;
            evMark('params');
          })
        ),
        // Query
        evEl(
          'div',
          { class: 'param-section' },
          evEl('div', { class: 'param-section-title' }, 'Query 参数', evEl('span', { class: 'tab-badge' }, params.query.parameter.length)),
          window.ApiDesign.paramTable(params.query.parameter, (next) => {
            params.query.parameter = next;
            evMark('params');
          })
        ),
        // Cookie
        evEl(
          'div',
          { class: 'param-section' },
          evEl('div', { class: 'param-section-title' }, 'Cookie 参数', evEl('span', { class: 'tab-badge' }, params.cookie.parameter.length)),
          window.ApiDesign.paramTable(params.cookie.parameter, (next) => {
            params.cookie.parameter = next;
            evMark('params');
          })
        )
      ),
      evEl(
        'div',
        { class: 'form-grid mt16' },
        window.ApiDesign.field(
          'Body 类型',
          window.ApiDesign.select(
            [
              ['none', '不使用'],
              ['form-data', 'form-data'],
              ['urlencoded', 'urlencoded']
            ],
            bodyMode,
            (v) => {
              params.body.mode = v;
              if (['form-data', 'urlencoded'].includes(v) && !Array.isArray(params.body.parameter)) {
                params.body.parameter = [];
              }
              evMark('params');
              renderAll();
            }
          ),
          '全局 Body 仅支持 form-data 与 urlencoded（官方限制）'
        )
      ),
      isForm
        ? evEl(
            'div',
            { class: 'form-row full mt12' },
            evEl('label', { class: 'form-label' }, bodyMode === 'form-data' ? 'Form 字段' : 'URL Encoded 字段'),
            evEl(
              'div',
              { class: 'form-control' },
              window.ApiDesign.paramTable(body.parameter || [], (next) => {
                params.body.parameter = next;
                evMark('params');
              }, { withFileType: true })
            )
          )
        : null,
      evEl(
        'div',
        { class: 'form-grid mt16' },
        window.ApiDesign.field(
          '鉴权',
          window.ApiDesign.select(
            [
              ['noauth', '无鉴权'],
              ['inherit', '不覆盖（沿用接口/目录）']
            ].concat([
              ['bearer', 'Bearer Token'],
              ['basic', 'Basic Auth'],
              ['kv', 'API Key'],
              ['oauth2', 'OAuth2（静态 Token）']
            ]),
            String(params.auth.type || 'noauth'),
            (v) => {
              params.auth.type = v;
              evMark('params');
              renderAll();
            }
          )
        )
      ),
      params.auth.type === 'bearer'
        ? window.ApiDesign.field(
            'Token',
            window.ApiDesign.input(params.auth.bearer?.key || '', (v) => {
              params.auth.bearer = { ...(params.auth.bearer || {}), key: v };
              evMark('params');
            }, { placeholder: '{{token}}' })
          )
        : null,
      params.auth.type === 'basic'
        ? evEl(
            'div',
            { class: 'form-grid' },
            window.ApiDesign.field('用户名', window.ApiDesign.input(params.auth.basic?.username || '', (v) => {
              params.auth.basic = { ...(params.auth.basic || {}), username: v };
              evMark('params');
            })),
            window.ApiDesign.field('密码', window.ApiDesign.input(params.auth.basic?.password || '', (v) => {
              params.auth.basic = { ...(params.auth.basic || {}), password: v };
              evMark('params');
            }, { type: 'password' }))
          )
        : null,
      params.auth.type === 'kv'
        ? evEl(
            'div',
            { class: 'form-grid' },
            window.ApiDesign.field('位置', window.ApiDesign.select([['header', 'Header'], ['query', 'Query']], params.auth.kv?.in || 'header', (v) => {
              params.auth.kv = { ...(params.auth.kv || {}), in: v };
              evMark('params');
            })),
            window.ApiDesign.field('Key', window.ApiDesign.input(params.auth.kv?.key || '', (v) => {
              params.auth.kv = { ...(params.auth.kv || {}), key: v };
              evMark('params');
            }, { placeholder: 'X-API-Key' })),
            window.ApiDesign.field('Value', window.ApiDesign.input(params.auth.kv?.value || '', (v) => {
              params.auth.kv = { ...(params.auth.kv || {}), value: v };
              evMark('params');
            }, { placeholder: '{{apiKey}}' }))
          )
        : null,
      params.auth.type === 'oauth2'
        ? evEl(
            'div',
            { class: 'form-grid' },
            window.ApiDesign.field('Access Token', window.ApiDesign.input(params.auth.oauth2?.access_token || '', (v) => {
              params.auth.oauth2 = { ...(params.auth.oauth2 || {}), access_token: v };
              evMark('params');
            }, { placeholder: '{{accessToken}}' })),
            window.ApiDesign.field('添加到', window.ApiDesign.select([['header', 'Header'], ['query', 'Query']], params.auth.oauth2?.addTokenTo || 'header', (v) => {
              params.auth.oauth2 = { ...(params.auth.oauth2 || {}), addTokenTo: v };
              evMark('params');
            })),
            window.ApiDesign.field('前缀', window.ApiDesign.input(params.auth.oauth2?.headerPrefix || 'Bearer', (v) => {
              params.auth.oauth2 = { ...(params.auth.oauth2 || {}), headerPrefix: v };
              evMark('params');
            }))
          )
        : null,
      evEl(
        'div',
        { class: 'form-row full mt16' },
        evEl('label', { class: 'form-label' }, '前置脚本'),
        evEl(
          'div',
          { class: 'form-control' },
          window.ApiDesign.textarea(window.ApiDesign.scriptSource(params.pre_tasks), (v) => {
            params.pre_tasks = window.ApiDesign.setScriptSource(params.pre_tasks, v);
            evMark('params');
          }, { rows: 6, placeholder: '// 每个接口发送前执行，例如：\napt.environment.set("token", "xxx");' })
        )
      ),
      evEl(
        'div',
        { class: 'form-row full' },
        evEl('label', { class: 'form-label' }, '后置脚本'),
        evEl(
          'div',
          { class: 'form-control' },
          window.ApiDesign.textarea(window.ApiDesign.scriptSource(params.post_tasks), (v) => {
            params.post_tasks = window.ApiDesign.setScriptSource(params.post_tasks, v);
            evMark('params');
          }, { rows: 6, placeholder: '// 响应返回后执行（接口自带脚本之后）' })
        )
      ),
      evEl('div', { class: 'btn-row mt16' },
        evEl('button', { class: 'primary small', onclick: save }, '保存全局参数'),
        evEl('button', {
          class: 'small',
          onclick: async () => {
            if (!confirm('放弃未保存的修改并重新加载？')) return;
            await loadGlobalParams(projectId);
            evMark('params', false);
            renderAll();
          }
        }, '重新加载')
      ),
      evHint('保存后直接写入 API 单机版，重新进入项目即可看到。')
    )
  );
}

/* ---------------- 页签 3：全局变量 ---------------- */

function varsPane() {
  const projectId = evProjectId();
  const list = evState.vars || [];

  const rows = list.map((v, index) =>
    evEl(
      'tr',
      {},
      evEl('td', {}, evInput(v.key, (val) => {
        list[index].key = val;
        evMark('vars');
      }, { mono: true, placeholder: 'key' })),
      evEl('td', {}, evInput(v.value, (val) => {
        list[index].value = val;
        evMark('vars');
      }, { mono: true, placeholder: 'value' })),
      evEl('td', {}, evInput(v.current_value, (val) => {
        list[index].current_value = val;
        evMark('vars');
      }, { mono: true, placeholder: '运行时值' })),
      evEl('td', {}, evInput(v.description, (val) => {
        list[index].description = val;
        evMark('vars');
      }, { placeholder: '说明' })),
      evEl(
        'td',
        {},
        evEl(
          'button',
          {
            class: 'small danger',
            onclick: async () => {
              if (!v.key) {
                list.splice(index, 1);
                renderAll();
                return;
              }
              if (!confirm(`确定删除全局变量「${v.key}」？`)) return;
              try {
                await evApi().req('DELETE', `/projects/${projectId}/global-vars/${encodeURIComponent(v.key)}`);
                await loadGlobalVars(projectId);
                evMark('vars', false);
                evToast('全局变量已删除');
                renderAll();
              } catch (err) {
                evToast(err.message, true);
              }
            }
          },
          '删除'
        )
      )
    )
  );

  const save = async () => {
    try {
      for (const item of list) {
        const key = String(item.key || '').trim();
        if (!key) continue;
        await evApi().post(`/projects/${projectId}/global-vars`, {
          key,
          value: item.value ?? '',
          current_value: item.current_value ?? '',
          description: item.description ?? ''
        });
      }
      await loadGlobalVars(projectId);
      evMark('vars', false);
      evToast('全局变量已保存');
      renderAll();
    } catch (err) {
      evToast(err.message, true);
    }
  };

  return evEl(
    'div',
    {},
    evCard(
      '全局变量',
      evDirtyBadge('vars'),
      evHint('全局变量对整个项目生效，但优先级低于环境变量：同名时以环境变量的值为准。'),
      evEl(
        'table',
        { class: 'table' },
        evEl(
          'thead',
          {},
          evEl(
            'tr',
            {},
            evEl('th', {}, 'Key'),
            evEl('th', {}, '默认值'),
            evEl('th', {}, '当前值'),
            evEl('th', {}, '说明'),
            evEl('th', { style: 'width:70px' }, '')
          )
        ),
        evEl('tbody', {}, ...rows)
      ),
      evEl(
        'div',
        { class: 'btn-row' },
        evEl(
          'button',
          {
            class: 'small',
            onclick: () => {
              evState.vars = evState.vars || [];
              evState.vars.push({ key: '', value: '', current_value: '', description: '' });
              evMark('vars');
              renderAll();
            }
          },
          '+ 添加变量'
        ),
        evEl('button', { class: 'primary small', onclick: save }, '保存全局变量')
      )
    )
  );
}

/* ---------------- 页面外壳 ---------------- */

function renderAll() {
  const host = document.getElementById('envvars-root');
  if (!host) return;
  host.replaceChildren(buildPage());
}

function buildPage() {
  const st = window.__consoleState;
  const projects = st?.projects || [];
  const projectId = evProjectId();

  const projectSelect = evEl(
    'select',
    {
      class: 'design-project-select',
      onchange: async (e) => {
        evState.projectId = e.target.value;
        if (st) st.currentProjectId = e.target.value;
        evState.activeEnvId = '';
        await loadAll(true);
        renderAll();
      }
    },
    ...projects.map((p) =>
      evEl('option', { value: p.project_id, ...(p.project_id === projectId ? { selected: true } : {}) }, p.name)
    )
  );

  const tabBar = evEl(
    'div',
    { class: 'tabs' },
    ...EV_TABS.map(([key, label]) =>
      evEl(
        'button',
        {
          class: `tab${evState.tab === key ? ' active' : ''}`,
          onclick: () => {
            if (evState.tab === key) return;
            evState.tab = key;
            renderAll();
          }
        },
        label
      )
    )
  );

  let pane;
  if (!projectId) pane = evEl('div', { class: 'empty' }, '还没有项目');
  else if (evState.tab === 'env') pane = envPane();
  else if (evState.tab === 'params') pane = paramsPane();
  else pane = varsPane();

  return evEl(
    'div',
    {},
    evEl('h1', { class: 'page-title' }, '环境与变量'),
    evEl(
      'p',
      { class: 'page-sub' },
      '环境（含多 host 服务）、全局参数与全局变量；改动直接写入 API 单机版'
    ),
    evEl(
      'div',
      { class: 'envvars-head' },
      evEl('span', { class: 'hint' }, '项目'),
      projectSelect
    ),
    tabBar,
    evEl('div', { class: 'envvars-body' }, pane)
  );
}

async function mount() {
  const host = document.getElementById('envvars-root');
  if (host) return; // 已挂载
  const root = evEl('div', { id: 'envvars-root' }, evEl('div', { class: 'empty' }, '加载中…'));
  const content = document.getElementById('content');
  content.append(root);
  await loadAll(true);
  renderAll();
  return root;
}

window.ApiEnvvars = {
  /** 供 app.js 顶栏切换项目时同步 */
  state: evState,
  view() {
    const root = evEl('div', { id: 'envvars-root' }, evEl('div', { class: 'empty' }, '加载中…'));
    // 首帧后异步加载，避免阻塞渲染
    setTimeout(() => {
      loadAll(true).then(renderAll).catch((err) => evToast(err.message, true));
    }, 0);
    return root;
  },
  /** 切换项目时外部可调用 */
  async reload() {
    await loadAll(true);
    renderAll();
  }
};
