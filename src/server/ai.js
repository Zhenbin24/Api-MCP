/**
 * AI 辅助：OpenAI 兼容的 chat/completions 客户端 + 三个业务能力。
 *
 * 设计取舍：
 * - 只依赖 fetch，不引入 SDK，可接 OpenAI / DeepSeek / 通义 / Ollama 等任何兼容实现
 * - 强约束模型输出严格 JSON（response_format: json_object），解析失败明确报错而不是塞默认值
 * - api_key 绝不出现在日志、错误信息或返回值里
 */

/** 统一的可读错误 */
export class AiError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

/** 读取并校验 AI 配置，缺少关键项时给出可直接照做的提示 */
export function assertAiReady(config) {
  const ai = config?.ai || {};
  if (!ai.enabled) {
    throw new AiError('AI 功能未启用。请到「外观设置 → AI 设置」打开开关并填入 API Key。');
  }
  if (!ai.api_key) {
    throw new AiError('尚未配置 API Key。请到「外观设置 → AI 设置」填入后重试。');
  }
  const base = String(ai.base_url || '').trim();
  if (!base) {
    throw new AiError('尚未配置 API 地址（base_url）。例如 https://api.openai.com/v1 或本地 Ollama 的 http://127.0.0.1:11434/v1');
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new AiError('API 地址必须以 http:// 或 https:// 开头');
  }
  if (!ai.model) {
    throw new AiError('尚未配置模型名，例如 gpt-4o-mini / deepseek-chat');
  }
  return ai;
}

/** 把 base_url 拼成 chat/completions 端点（容忍用户已经写了 /chat/completions） */
function completionsUrl(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

/**
 * 调用 chat/completions 并返回解析后的 JSON 对象。
 * @param {object} config 完整配置（含 ai）
 * @param {Array} messages OpenAI 格式的消息数组
 * @param {{json?: boolean}} opts
 */
export async function chatJson(config, messages, { json = true } = {}) {
  const ai = assertAiReady(config);
  const url = completionsUrl(ai.base_url);
  const timeoutMs = Math.max(5000, Math.min(300000, Number(ai.timeout_ms) || 60000));

  const payload = {
    model: ai.model,
    messages,
    temperature: 0.2,
    ...(json ? { response_format: { type: 'json_object' } } : {})
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.api_key}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
    });
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new AiError(`请求 AI 服务超时（>${Math.round(timeoutMs / 1000)}s）。可调大超时或在设置里换更快的模型。`);
    }
    // 网络层错误（DNS / 拒绝连接 / TLS）——不回显 api_key
    throw new AiError(`无法连接 AI 服务：${err?.message || String(err)}。请检查 API 地址与网络。`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const brief = text.slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new AiError(`AI 服务鉴权失败（${res.status}）。请检查 API Key 是否正确、是否有该模型的权限。`);
    }
    if (res.status === 429) {
      throw new AiError('AI 服务限流或额度不足（429）。请稍后重试或检查账户余额。');
    }
    if (res.status === 404) {
      throw new AiError(`AI 接口不存在（404）。请确认 base_url 是否写对了（例如是否该带 /v1）。`);
    }
    throw new AiError(`AI 服务返回 ${res.status}：${brief || '无响应内容'}`);
  }

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new AiError('AI 返回内容为空，请重试或更换模型。');
  }

  return parseJsonContent(content);
}

/** 从模型输出里抽 JSON（容忍 ```json 包裹与前后废话） */
function parseJsonContent(content) {
  const text = String(content).trim();

  const direct = tryParse(text);
  if (direct.ok) return direct.value;

  // 去掉 markdown 代码围栏
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = tryParse(fenced[1].trim());
    if (inner.ok) return inner.value;
  }

  // 退一步：截取第一个 { 到最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = tryParse(text.slice(start, end + 1));
    if (sliced.ok) return sliced.value;
  }

  throw new AiError(`AI 返回的不是合法 JSON，无法解析。原始内容片段：${text.slice(0, 200)}`);
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

/* ---------------- 能力一：解析导入 ---------------- */

const PARSE_SCHEMA_HINT = `{
  "items": [
    {
      "name": "接口名（简洁，取自路径或描述）",
      "method": "GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS",
      "url": "完整请求 URL，缺域名时保留相对路径",
      "summary": "一句话说明",
      "query": [{ "key": "", "value": "", "description": "" }],
      "headers": [{ "key": "", "value": "", "description": "" }],
      "path": [{ "key": "", "value": "", "description": "" }],
      "body_mode": "none|json|raw|urlencoded|form-data",
      "body": "请求体原文（json 模式给合法 JSON 字符串）"
    }
  ],
  "notes": ["无法确定的地方给出的提示"]
}`;

/**
 * 把任意文本 / 请求代码解析成接口定义。
 * @returns {Promise<{items: Array, warnings: string[]}>}
 */
export async function parseImportWithAi(config, { text, hint = '' }) {
  const raw = String(text || '').trim();
  if (!raw) throw new AiError('请先粘贴要解析的内容');
  if (raw.length > 60000) throw new AiError('内容过长（超过 60000 字符），请分段解析');

  const messages = [
    {
      role: 'system',
      content:
        '你是接口文档解析器。用户会粘贴任意形式的接口信息（自然语言描述、Java/Go/.NET/Python 请求代码、cURL、Swagger 片段、网页复制的文本等）。' +
        '请从中提取出所有可调用的 HTTP 接口，严格按给定 JSON schema 输出，不要输出任何解释性文字。' +
        '无法确定的字段留空字符串，不要编造 URL 与参数值。'
    },
    {
      role: 'user',
      content:
        `${hint ? `补充说明：${hint}\n\n` : ''}请按以下 schema 输出 JSON：\n${PARSE_SCHEMA_HINT}\n\n待解析内容：\n\`\`\`\n${raw}\n\`\`\``
    }
  ];

  const parsed = await chatJson(config, messages);
  const items = normalizeParsedItems(parsed);
  if (items.length === 0) {
    throw new AiError('AI 没有从内容里识别出任何接口，请补充更多信息（尤其是请求地址）');
  }
  return { items, warnings: Array.isArray(parsed?.notes) ? parsed.notes.map(String) : [] };
}

/** 把模型输出规整成与 cURL 导入一致的 item 形状 */
function normalizeParsedItems(parsed) {
  const list = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const url = String(raw.url || '').trim();
    if (!url) continue;
    const method = String(raw.method || 'GET').toUpperCase();
    const params = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((p) => p && String(p.key || '').trim())
        .map((p, index) => ({
          description: String(p.description || ''),
          field_type: 'String',
          is_checked: 1,
          key: String(p.key),
          not_null: -1,
          param_id: `ai_${Date.now().toString(16)}_${index}`,
          value: p.value === undefined || p.value === null ? '' : String(p.value)
        }));

    const bodyMode = String(raw.body_mode || 'none').toLowerCase();
    const body = raw.body == null ? '' : String(raw.body);

    out.push({
      name: String(raw.name || url).slice(0, 120),
      method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method) ? method : 'GET',
      url,
      summary: String(raw.summary || ''),
      description: String(raw.summary || ''),
      folderPath: [],
      tags: [],
      request: {
        auth: { type: 'noauth' },
        body: {
          binary: null,
          mode: ['none', 'json', 'raw', 'urlencoded', 'form-data'].includes(bodyMode) ? bodyMode : 'none',
          parameter: params(raw.body_params),
          raw: body,
          raw_parameter: [],
          raw_schema: { type: 'object' }
        },
        cookie: { parameter: [] },
        header: { parameter: params(raw.headers) },
        post_tasks: [],
        pre_tasks: [],
        query: { parameter: params(raw.query), query_add_equal: 1 },
        restful: { parameter: params(raw.path) }
      },
      response: null
    });
  }
  return out;
}

/* ---------------- 能力二：起草接口 ---------------- */

const DRAFT_SCHEMA_HINT = `{
  "name": "接口名",
  "method": "GET|POST|PUT|DELETE|PATCH",
  "url": "请求地址（可用 {{base}} 开头表示相对项目服务地址）",
  "summary": "一句话说明用途",
  "description": "更详细的使用说明，可多行",
  "query": [{ "key": "", "value": "", "description": "", "required": false }],
  "headers": [{ "key": "", "value": "", "description": "" }],
  "body_mode": "none|json|urlencoded|form-data",
  "body_json": "body_mode 为 json 时的示例请求体（合法 JSON 对象，不是字符串）",
  "response_example": "成功响应的示例 JSON 对象",
  "notes": ["需要人工确认的点"]
}`;

/**
 * 按一句需求起草一版接口定义。
 * @returns {Promise<object>} 可直接塞进编辑器的 api data 片段
 */
export async function draftApiWithAi(config, { description, projectName = '', existingNames = [] }) {
  const desc = String(description || '').trim();
  if (!desc) throw new AiError('请先描述你想要什么接口');
  if (desc.length > 4000) throw new AiError('描述过长（超过 4000 字），请精简后再试');

  const messages = [
    {
      role: 'system',
      content:
        '你是资深后端接口设计助手。根据用户的一句话需求，设计一个符合 RESTful 习惯的 HTTP 接口。' +
        '严格按给定 JSON schema 输出，不要输出解释性文字。' +
        'url 优先用 {{base}} 开头表示相对项目服务地址；参数值给贴合业务的示例；' +
        'response_example 要包含真实的业务字段，不要只给空对象。'
    },
    {
      role: 'user',
      content:
        `${projectName ? `所属项目：${projectName}\n` : ''}` +
        `${existingNames.length > 0 ? `项目里已有的接口名（避免重名）：${existingNames.slice(0, 40).join('、')}\n` : ''}` +
        `需求：${desc}\n\n请按以下 schema 输出 JSON：\n${DRAFT_SCHEMA_HINT}`
    }
  ];

  const parsed = await chatJson(config, messages);
  return normalizeDraft(parsed);
}

/** 把起草结果转成与控制台编辑器一致的形状 */
function normalizeDraft(parsed) {
  const params = (arr, withRequired = false) =>
    (Array.isArray(arr) ? arr : [])
      .filter((p) => p && String(p.key || '').trim())
      .map((p, index) => ({
        description: String(p.description || ''),
        field_type: 'String',
        is_checked: 1,
        key: String(p.key),
        not_null: withRequired && p.required ? 1 : -1,
        param_id: `ai_${Date.now().toString(16)}_${index}`,
        value: p.value === undefined || p.value === null ? '' : String(p.value)
      }));

  const bodyMode = String(parsed?.body_mode || 'none').toLowerCase();
  let raw = '';
  if (bodyMode === 'json') {
    const bodyJson = parsed?.body_json;
    raw = typeof bodyJson === 'string' ? bodyJson : JSON.stringify(bodyJson ?? {}, null, 2);
    // 保证是合法 JSON，否则退化成空对象
    try {
      JSON.parse(raw);
    } catch {
      raw = '{}';
    }
  } else if (parsed?.body_json) {
    raw = typeof parsed.body_json === 'string' ? parsed.body_json : JSON.stringify(parsed.body_json, null, 2);
  }

  const respRaw =
    parsed?.response_example === undefined || parsed.response_example === null
      ? ''
      : typeof parsed.response_example === 'string'
        ? parsed.response_example
        : JSON.stringify(parsed.response_example, null, 2);

  return {
    name: String(parsed?.name || '新接口').slice(0, 120),
    method: String(parsed?.method || 'GET').toUpperCase(),
    url: String(parsed?.url || ''),
    description: [String(parsed?.summary || ''), String(parsed?.description || '')].filter(Boolean).join('\n\n'),
    query: params(parsed?.query, true),
    headers: params(parsed?.headers),
    body_mode: ['none', 'json', 'urlencoded', 'form-data'].includes(bodyMode) ? bodyMode : 'none',
    body_raw: raw,
    response_raw: respRaw,
    notes: Array.isArray(parsed?.notes) ? parsed.notes.map(String) : []
  };
}

/* ---------------- 能力三：生成测试用例 ---------------- */

const CASES_SCHEMA_HINT = `{
  "cases": [
    {
      "name": "用例名，例如「正常创建」「缺少必填字段」",
      "enabled": true,
      "input": {
        "query": { "参数名": "值" },
        "headers": { "Header 名": "值" },
        "path": { "路径参数": "值" },
        "body": {}
      },
      "expect": {
        "code": "200",
        "content_type": "json",
        "verify_message": "为什么这样断言"
      }
    }
  ],
  "notes": ["需要人工确认的点"]
}`;

/**
 * 基于接口定义生成测试用例草稿。
 * 只返回结果，不落库——是否保存由用户在界面上确认。
 */
export async function generateCasesWithAi(config, { apiDetail, apiName = '', count = 4 }) {
  const detail = apiDetail || {};
  const n = Math.max(1, Math.min(10, Number(count) || 4));

  // 只喂必要信息，避免把整份快照（可能很大）塞给模型
  const brief = {
    name: apiDetail?.name || apiName,
    method: apiDetail?.method || 'GET',
    url: apiDetail?.url || '',
    description: detail.description || '',
    query: (detail.request?.query?.parameter || []).map((p) => ({ key: p.key, description: p.description, value: p.value })),
    headers: (detail.request?.header?.parameter || []).map((p) => ({ key: p.key, description: p.description })),
    path: (detail.request?.restful?.parameter || []).map((p) => ({ key: p.key, description: p.description })),
    body_mode: detail.request?.body?.mode || 'none',
    body: detail.request?.body?.raw || '',
    response_example: detail.response?.example?.[0]?.raw || ''
  };

  const messages = [
    {
      role: 'system',
      content:
        '你是接口测试工程师。根据接口定义设计测试用例，覆盖正常流程、边界值与异常输入。' +
        '严格按给定 JSON schema 输出，不要输出解释性文字。' +
        'input 里只写需要覆盖的字段，不要重复接口默认值；断言以期望状态码为主。'
    },
    {
      role: 'user',
      content: `接口定义：\n${JSON.stringify(brief, null, 2)}\n\n请生成 ${n} 条用例，按以下 schema 输出 JSON：\n${CASES_SCHEMA_HINT}`
    }
  ];

  const parsed = await chatJson(config, messages);
  const list = Array.isArray(parsed?.cases) ? parsed.cases : [];
  if (list.length === 0) throw new AiError('AI 没有生成任何用例，请重试');

  const cases = list.slice(0, 10).map((raw, index) => ({
    case_id: `ai_${Date.now().toString(16)}_${index}`,
    name: String(raw?.name || `用例 ${index + 1}`).slice(0, 120),
    enabled: raw?.enabled === false ? -1 : 1,
    // 与服务端用例结构对齐，前端保存时直接用
    input: {
      query: raw?.input?.query && typeof raw.input.query === 'object' ? raw.input.query : {},
      headers: raw?.input?.headers && typeof raw.input.headers === 'object' ? raw.input.headers : {},
      path: raw?.input?.path && typeof raw.input.path === 'object' ? raw.input.path : {},
      body: raw?.input?.body ?? undefined
    },
    expect: {
      code: String(raw?.expect?.code ?? '200'),
      content_type: String(raw?.expect?.content_type || 'json'),
      name: String(raw?.name || `用例 ${index + 1}`),
      is_default: -1,
      verify_type: 'code',
      schema: { type: 'object', properties: {} }
    },
    expect_headers: {},
    pre_script: '',
    post_script: ''
  }));

  return {
    cases,
    warnings: Array.isArray(parsed?.notes) ? parsed.notes.map(String) : []
  };
}
