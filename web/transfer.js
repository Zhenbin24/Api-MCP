/* 导入导出：把外部接口文档导入项目，或把项目导出成 OpenAPI / Postman。
 * 挂在 window.ApiTransfer 上，由 app.js 的侧栏「导入导出」调用。 */

const tr = {
  projectId: null,
  /* 导入表单 */
  importFormat: 'auto',
  importCoverMode: 'url_and_folder',
  importFolderId: '0',
  importBasePath: false,
  importPayload: '',
  importFileName: '',
  importPreview: null,
  importBusy: false,
  importError: null,
  /* 导出表单 */
  exportFormat: 'openapi',
  exportBusy: false,
  /* 目录树（导入目标目录下拉用） */
  tree: []
};

const IMPORT_FORMATS = [
  ['auto', '自动识别'],
  ['openapi', 'OpenAPI 3.x'],
  ['swagger', 'Swagger 2.0'],
  ['postman', 'Postman Collection v2.1'],
  ['har', 'HAR'],
  ['curl', 'cURL']
];

const COVER_MODES = [
  ['url_and_folder', '同目录同方法同 URL 覆盖（推荐）'],
  ['url', '跨目录同方法同 URL 覆盖'],
  ['ignore', '已存在则跳过'],
  ['both', '一律新建（允许重复）'],
  ['clear', '先清空目标目录再导入']
];

const EXPORT_FORMATS = [
  ['openapi', 'OpenAPI 3.0 (JSON)'],
  ['openapi_yaml', 'OpenAPI 3.0 (YAML)'],
  ['postman', 'Postman Collection v2.1']
];

/* ---------------- 基础工具 ---------------- */

function trEl(tag, attrs = {}, ...children) {
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

function trToast(message, isError) {
  if (window.__consoleToast) window.__consoleToast(message, isError);
}

function trApi() {
  return window.__consoleApi;
}

function trProjectId() {
  const consoleState = window.__consoleState;
  return tr.projectId || consoleState?.currentProjectId || '';
}

function trProjectName(projectId) {
  const projects = window.__consoleState?.projects || [];
  return projects.find((p) => p.project_id === projectId)?.name || projectId;
}

/** 折叠说明卡片，复用环境与变量页的 .ev-doc 样式 */
function trDoc(title, paragraphs) {
  const blocks = paragraphs.map((p) => {
    if (typeof p === 'string') return trEl('p', {}, p);
    if (Array.isArray(p)) return trEl('ul', {}, ...p.map((li) => trEl('li', {}, li)));
    return trEl('p', {}, String(p));
  });
  return trEl(
    'details',
    { class: 'ev-doc', open: true },
    trEl('summary', {}, title),
    trEl('div', { class: 'ev-doc-body' }, ...blocks)
  );
}

/* ---------------- 数据 ---------------- */

async function loadTree(projectId) {
  if (!projectId) {
    tr.tree = [];
    return;
  }
  try {
    const res = await trApi().get(`/projects/${projectId}/tree`);
    tr.tree = res?.tree || [];
  } catch {
    tr.tree = [];
  }
}

/** 把树摊平成「带缩进的目录选项」，只保留目录 */
function folderOptions(nodes, depth = 0) {
  const out = [];
  for (const node of nodes || []) {
    if (node.target_type === 'folder') {
      out.push({ id: node.target_id, label: `${'　'.repeat(depth)}${depth > 0 ? '└ ' : ''}${node.name}` });
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      out.push(...folderOptions(node.children, node.target_type === 'folder' ? depth + 1 : depth));
    }
  }
  return out;
}

/* ---------------- 渲染：导入 ---------------- */

function importPane() {
  const projectId = trProjectId();
  const noProject = !projectId;
  const folders = folderOptions(tr.tree);

  const formatSelect = trEl(
    'select',
    {
      class: 'topbar-select',
      onchange: (e) => {
        tr.importFormat = e.target.value;
        tr.importPreview = null;
        tr.importError = null;
        renderAll();
      }
    },
    ...IMPORT_FORMATS.map(([value, label]) =>
      trEl('option', { value, selected: tr.importFormat === value }, label)
    )
  );

  const coverSelect = trEl(
    'select',
    {
      class: 'topbar-select',
      onchange: (e) => {
        tr.importCoverMode = e.target.value;
      }
    },
    ...COVER_MODES.map(([value, label]) =>
      trEl('option', { value, selected: tr.importCoverMode === value }, label)
    )
  );

  const folderSelect = trEl(
    'select',
    {
      class: 'topbar-select',
      disabled: noProject,
      onchange: (e) => {
        tr.importFolderId = e.target.value;
      }
    },
    trEl('option', { value: '0', selected: tr.importFolderId === '0' }, '项目根目录'),
    ...folders.map((f) => trEl('option', { value: f.id, selected: tr.importFolderId === f.id }, f.label))
  );

  const basePathBox = trEl(
    'label',
    { class: 'tr-check' },
    trEl('input', {
      type: 'checkbox',
      checked: tr.importBasePath,
      onchange: (e) => {
        tr.importBasePath = e.target.checked;
      }
    }),
    '把 OpenAPI servers[0].url 拼到每个接口 URL 前（仅 OpenAPI / Swagger）'
  );

  const textarea = trEl('textarea', {
    class: 'tr-textarea',
    rows: 12,
    placeholder: '把 cURL 命令、OpenAPI / Swagger 的 JSON 或 YAML、Postman Collection、HAR 文件内容粘贴到这里……',
    spellcheck: 'false',
    oninput: (e) => {
      tr.importPayload = e.target.value;
    }
  });
  textarea.value = tr.importPayload;

  const fileInput = trEl('input', {
    type: 'file',
    accept: '.json,.yaml,.yml,.har,.txt,.sh',
    class: 'tr-file',
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        tr.importPayload = text;
        tr.importFileName = file.name;
        tr.importPreview = null;
        tr.importError = null;
        renderAll();
        trToast(`已读取 ${file.name}（${Math.round(file.size / 1024)} KB）`);
      } catch (err) {
        trToast(`读取文件失败：${err.message}`, true);
      }
    }
  });

  const previewBtn = trEl(
    'button',
    {
      class: 'small',
      disabled: tr.importBusy,
      onclick: () => doPreview()
    },
    tr.importBusy ? '解析中…' : '解析预览'
  );

  const importBtn = trEl(
    'button',
    {
      class: 'primary small',
      disabled: noProject || tr.importBusy || !tr.importPreview,
      title: noProject ? '请先在「总览」页新建项目' : tr.importPreview ? '按上面的设置导入' : '先点「解析预览」确认内容',
      onclick: () => doImport()
    },
    '确认导入'
  );

  const clearBtn = trEl(
    'button',
    {
      class: 'small',
      disabled: tr.importBusy,
      onclick: () => {
        tr.importPayload = '';
        tr.importFileName = '';
        tr.importPreview = null;
        tr.importError = null;
        renderAll();
      }
    },
    '清空'
  );

  return trEl(
    'div',
    { class: 'card' },
    trEl('div', { class: 'section-title' }, '导入'),
    trEl(
      'div',
      { class: 'hint' },
      '支持 OpenAPI 3.x、Swagger 2.0、Postman Collection v2.1、HAR 与 cURL。导入前可以先预览，确认接口数量与目录结构。'
    ),

    trEl(
      'div',
      { class: 'tr-grid' },
      trEl('div', { class: 'tr-field' }, trEl('span', { class: 'tr-label' }, '格式'), formatSelect),
      trEl('div', { class: 'tr-field' }, trEl('span', { class: 'tr-label' }, '目标目录'), folderSelect)
    ),
    trEl('div', { class: 'tr-field' }, trEl('span', { class: 'tr-label' }, '同名接口'), coverSelect),
    basePathBox,

    trEl(
      'div',
      { class: 'tr-actions' },
      trEl('span', { class: 'tr-label' }, '选择文件'),
      fileInput,
      tr.importFileName ? trEl('span', { class: 'hint' }, `当前：${tr.importFileName}`) : null
    ),

    trEl('div', { class: 'tr-label' }, '或直接粘贴内容'),
    textarea,

    trEl('div', { class: 'tr-actions' }, previewBtn, importBtn, clearBtn),

    tr.importError ? trEl('div', { class: 'notice err' }, trEl('span', {}, '⚠'), trEl('div', {}, tr.importError)) : null,

    tr.importPreview ? previewCard(tr.importPreview) : null,

    trDoc('导入说明', [
      '格式识别：选「自动识别」时会根据内容判断（有 swagger 字段是 Swagger 2.0，有 openapi 字段是 OpenAPI 3.x，有 info.schema + item 是 Postman，有 log.entries 是 HAR，以 curl 开头是 cURL）。',
      '同名判定：默认按「同目录 + 同方法 + 同 URL」视为同一个接口并覆盖；只想按 URL 判定就选「跨目录同方法同 URL 覆盖」。',
      'cURL 支持三种方言：bash（行尾 \\ 续行）、CMD（行尾 ^ 续行）、PowerShell（反引号续行 / curl.exe）。',
      ['变量占位符 {{name}} 会原样保留，导入后需要在「环境与变量」里补上定义才会生效。', 'Swagger 2.0 会自动升级成 OpenAPI 3.0 再导入，definitions 转成 components.schemas。']
    ])
  );
}

function previewCard(preview) {
  return trEl(
    'div',
    { class: 'tr-preview' },
    trEl(
      'div',
      { class: 'tr-preview-head' },
      trEl('span', { class: 'tag ok' }, preview.format_label || preview.format),
      trEl('span', { class: 'hint' }, preview.title || ''),
      trEl('span', { class: 'spacer-flex' }),
      trEl('span', { class: 'tag' }, `${preview.api_count} 个接口`),
      trEl('span', { class: 'tag' }, `${preview.folder_count} 个目录`),
      preview.models?.length > 0 ? trEl('span', { class: 'tag' }, `${preview.models.length} 个模型`) : null
    ),
    preview.warnings?.length > 0
      ? trEl(
          'div',
          { class: 'notice warn' },
          trEl('span', {}, '!'),
          trEl(
            'div',
            {},
            `${preview.warnings.length} 条提示`,
            trEl('ul', { class: 'tr-warn-list' }, ...preview.warnings.slice(0, 10).map((w) => trEl('li', {}, w))),
            preview.warnings.length > 10 ? trEl('div', { class: 'hint' }, `还有 ${preview.warnings.length - 10} 条…`) : null
          )
        )
      : null,
    trEl(
      'table',
      { class: 'tr-table' },
      trEl('thead', {}, trEl('tr', {}, trEl('th', {}, '方法'), trEl('th', {}, '目录'), trEl('th', {}, '名称'), trEl('th', {}, 'URL'))),
      trEl(
        'tbody',
        {},
        ...(preview.sample || []).map((row) =>
          trEl(
            'tr',
            {},
            trEl('td', {}, trEl('span', { class: 'tag' }, row.method)),
            trEl('td', { class: 'hint' }, row.folder || '-'),
            trEl('td', {}, row.name || '-'),
            trEl('td', { class: 'mono tr-url' }, row.url || '-')
          )
        )
      )
    ),
    preview.truncated ? trEl('div', { class: 'hint mt8' }, '仅展示前 50 条，导入时会处理全部接口。') : null
  );
}

/* ---------------- 渲染：导出 ---------------- */

function exportPane() {
  const projectId = trProjectId();
  const noProject = !projectId;

  const formatSelect = trEl(
    'select',
    {
      class: 'topbar-select',
      onchange: (e) => {
        tr.exportFormat = e.target.value;
      }
    },
    ...EXPORT_FORMATS.map(([value, label]) =>
      trEl('option', { value, selected: tr.exportFormat === value }, label)
    )
  );

  const downloadBtn = trEl(
    'button',
    {
      class: 'primary small',
      disabled: noProject || tr.exportBusy,
      title: noProject ? '请先在「总览」页新建项目' : '下载导出文件',
      onclick: () => doExport()
    },
    tr.exportBusy ? '导出中…' : '下载'
  );

  const copyBtn = trEl(
    'button',
    {
      class: 'small',
      disabled: noProject || tr.exportBusy,
      onclick: () => doExportCopy()
    },
    '复制到剪贴板'
  );

  return trEl(
    'div',
    { class: 'card' },
    trEl('div', { class: 'section-title' }, '导出'),
    trEl(
      'div',
      { class: 'hint' },
      noProject
        ? '还没有项目。请先到「总览」页点「新建项目」创建。'
        : `把「${trProjectName(projectId)}」导出成通用格式，便于迁移或分享给其他人。`
    ),
    trEl(
      'div',
      { class: 'tr-grid' },
      trEl('div', { class: 'tr-field' }, trEl('span', { class: 'tr-label' }, '格式'), formatSelect)
    ),
    trEl('div', { class: 'tr-actions' }, downloadBtn, copyBtn),
    trDoc('导出说明', [
      '只导出 HTTP 接口；目录层级会转成 OpenAPI 的 tags 或 Postman 的嵌套目录，导入回去能还原结构。',
      'OpenAPI 里的 servers[0] 取当前环境的默认服务地址（server_id=1），导出后可以换环境再导一次拿到不同 baseURL 的版本。',
      ['接口鉴权（Bearer / Basic / API Key / OAuth2）、Body（JSON / urlencoded / form-data）、响应示例都会带出去。', '文档、执行计划、执行历史不在导出范围内。']
    ])
  );
}

/* ---------------- 动作 ---------------- */

async function doPreview() {
  const payload = tr.importPayload.trim();
  if (!payload) {
    tr.importError = '请先粘贴内容或选择文件';
    renderAll();
    return;
  }
  tr.importBusy = true;
  tr.importError = null;
  renderAll();
  try {
    const res = await trApi().post('/import/preview', {
      format: tr.importFormat,
      payload,
      base_path: tr.importBasePath
    });
    tr.importPreview = res;
  } catch (err) {
    tr.importPreview = null;
    tr.importError = err.message;
  } finally {
    tr.importBusy = false;
    renderAll();
  }
}

async function doImport() {
  const projectId = trProjectId();
  if (!projectId) {
    trToast('请先在「总览」页新建项目', true);
    return;
  }
  const payload = tr.importPayload.trim();
  if (!payload) {
    tr.importError = '请先粘贴内容或选择文件';
    renderAll();
    return;
  }
  const count = tr.importPreview?.api_count ?? 0;
  if (count > 0 && !confirm(`即将导入 ${count} 个接口到「${trProjectName(projectId)}」，继续？`)) return;

  tr.importBusy = true;
  tr.importError = null;
  renderAll();
  try {
    const res = await trApi().post(`/projects/${projectId}/import`, {
      format: tr.importFormat,
      payload,
      folder_id: tr.importFolderId,
      api_cover_mode: tr.importCoverMode,
      base_path: tr.importBasePath
    });
    const s = res.summary || {};
    trToast(`导入完成：新建 ${s.created || 0}，更新 ${s.updated || 0}，跳过 ${s.skipped || 0}`);
    tr.importPreview = null;
    tr.importPayload = '';
    tr.importFileName = '';
    // 目录树可能新增了目录，刷新一下
    await loadTree(projectId);
    window.__consoleRender?.();
  } catch (err) {
    tr.importError = err.message;
    trToast(`导入失败：${err.message}`, true);
  } finally {
    tr.importBusy = false;
    renderAll();
  }
}

/** 拼下载地址：token 走 query，浏览器才能直接下载 */
async function doExport() {
  const projectId = trProjectId();
  if (!projectId) return;
  tr.exportBusy = true;
  renderAll();
  try {
    // 先取一次内容，确认能导出（失败就报错而不是下载到一个错误页）
    const res = await trApi().get(`/projects/${projectId}/export?format=${encodeURIComponent(tr.exportFormat)}`);
    const uiToken = new URLSearchParams(location.search).get('ui') || '';
    const href = `/api/projects/${projectId}/export?format=${encodeURIComponent(tr.exportFormat)}&ui=${encodeURIComponent(uiToken)}`;
    const link = document.createElement('a');
    link.href = href;
    link.download = res.filename || 'export';
    document.body.append(link);
    link.click();
    link.remove();
    trToast(`已导出 ${res.filename}`);
  } catch (err) {
    trToast(`导出失败：${err.message}`, true);
  } finally {
    tr.exportBusy = false;
    renderAll();
  }
}

async function doExportCopy() {
  const projectId = trProjectId();
  if (!projectId) return;
  tr.exportBusy = true;
  renderAll();
  try {
    const res = await trApi().get(`/projects/${projectId}/export?format=${encodeURIComponent(tr.exportFormat)}`);
    if (window.__consoleCopy) await window.__consoleCopy(res.content);
    else await navigator.clipboard.writeText(res.content);
    trToast(`已复制 ${res.filename} 的内容`);
  } catch (err) {
    trToast(`复制失败：${err.message}`, true);
  } finally {
    tr.exportBusy = false;
    renderAll();
  }
}

/* ---------------- 视图 ---------------- */

let trHost = null;

function renderAll() {
  if (!trHost) return;
  trHost.innerHTML = '';
  trHost.append(trEl('div', { class: 'tr-layout' }, importPane(), exportPane()));
}

window.ApiTransfer = {
  /** app.js 顶栏切换项目时同步 */
  state: tr,
  view() {
    trHost = trEl('div', { id: 'transfer-root' });
    const projectId = trProjectId();
    tr.projectId = projectId;
    setTimeout(async () => {
      await loadTree(projectId);
      renderAll();
    }, 0);
    return trHost;
  },
  /** 切换项目时外部调用 */
  async reload() {
    const projectId = trProjectId();
    tr.projectId = projectId;
    tr.importPreview = null;
    tr.importFolderId = '0';
    await loadTree(projectId);
    renderAll();
  }
};
