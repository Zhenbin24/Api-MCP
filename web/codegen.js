/**
 * 把一次请求详情生成常见语言的调用代码。
 *
 * 输入形状与 curl-build.js 完全一致（live_detail.request 的结构）：
 *   { method, url, headers: {}, body_mode, body }
 * 这样调试面板里「复制为 cURL」与「生成代码」可以共用同一份数据源。
 *
 * 既可在浏览器（<script type="module">）使用，也可被 Node 直接 import 做单测。
 */

/** 这些 body 模式没法用代码片段原样表达，生成时只留说明 */
const OPAQUE_BODY_MODES = new Set(['binary', 'form-data']);

/** 支持的语言 */
export const LANGUAGES = [
  ['curl', 'cURL'],
  ['fetch', 'JavaScript（fetch）'],
  ['axios', 'JavaScript（axios）'],
  ['python', 'Python（requests）'],
  ['go', 'Go（net/http）'],
  ['java', 'Java（OkHttp）']
];

const LANGUAGE_LABEL = Object.fromEntries(LANGUAGES);

/** 把 headers 对象规整成 [key, value] 数组，跳过空值 */
function headerPairs(req) {
  const out = [];
  for (const [key, value] of Object.entries(req?.headers || {})) {
    if (value === undefined || value === null) continue;
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    if (!text) continue;
    out.push([String(key), text]);
  }
  return out;
}

/** 请求体文本；无法表达的模式返回空 */
function bodyText(req) {
  const mode = String(req?.body_mode || 'none');
  if (mode === 'none' || OPAQUE_BODY_MODES.has(mode)) return '';
  if (req?.body == null) return '';
  return String(req.body);
}

/** 判断是否适合当 JSON 处理（仅用于生成更易读的代码，不影响语义） */
function isJsonBody(req) {
  const mode = String(req?.body_mode || '');
  if (mode !== 'json') return false;
  const text = bodyText(req);
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 各语言生成器 ---------------- */

function buildFetch(req, { indent = 2 } = {}) {
  const sp = ' '.repeat(indent);
  const lines = [];
  const headers = headerPairs(req);
  const method = String(req?.method || 'GET').toUpperCase();
  const body = bodyText(req);
  const json = isJsonBody(req);

  const options = [];
  options.push(`${sp}method: '${method}'`);

  if (headers.length > 0) {
    const headerLines = headers.map(([k, v]) => `${sp}${sp}'${escapeSingle(k)}': '${escapeSingle(v)}'`);
    options.push(`${sp}headers: {\n${headerLines.join(',\n')}\n${sp}}`);
  }

  if (body) {
    if (json) {
      options.push(`${sp}body: JSON.stringify(${indentAfterFirstLine(prettyJsonForJs(body, indent), sp)})`);
    } else {
      options.push(`${sp}body: ${templateLiteral(body)}`);
    }
  }

  lines.push(`const res = await fetch('${escapeSingle(String(req?.url || ''))}', {`);
  lines.push(options.join(',\n'));
  lines.push('});');
  lines.push('');
  lines.push('const data = await res.json();');
  lines.push('console.log(res.status, data);');

  return { code: lines.join('\n'), warnings: [] };
}

function buildAxios(req, { indent = 2 } = {}) {
  const sp = ' '.repeat(indent);
  const lines = [];
  const headers = headerPairs(req);
  const method = String(req?.method || 'GET').toUpperCase();
  const body = bodyText(req);
  const json = isJsonBody(req);

  const config = [];
  if (headers.length > 0) {
    const headerLines = headers.map(([k, v]) => `${sp}${sp}'${escapeSingle(k)}': '${escapeSingle(v)}'`);
    config.push(`${sp}headers: {\n${headerLines.join(',\n')}\n${sp}}`);
  }
  config.push(`${sp}method: '${method}'`);
  config.push(`${sp}url: '${escapeSingle(String(req?.url || ''))}'`);
  if (body) {
    config.push(`${sp}data: ${indentAfterFirstLine(json ? prettyJsonForJs(body, indent) : templateLiteral(body), sp)}`);
  }

  lines.push(`import axios from 'axios';`);
  lines.push('');
  lines.push('const res = await axios({');
  lines.push(config.join(',\n'));
  lines.push('});');
  lines.push('');
  lines.push('console.log(res.status, res.data);');

  return { code: lines.join('\n'), warnings: [] };
}

function buildPython(req, { indent = 4 } = {}) {
  const sp = ' '.repeat(indent);
  const lines = [];
  const headers = headerPairs(req);
  const method = String(req?.method || 'GET').toUpperCase();
  const body = bodyText(req);
  const json = isJsonBody(req);

  lines.push('import requests');
  lines.push('');
  lines.push(`url = "${escapeDouble(String(req?.url || ''))}"`);

  if (headers.length > 0) {
    const headerLines = headers.map(([k, v]) => `${sp}"${escapeDouble(k)}": "${escapeDouble(v)}"`);
    lines.push(`headers = {\n${headerLines.join(',\n')}\n}`);
  }

  const callArgs = ['url'];
  if (headers.length > 0) callArgs.push('headers=headers');

  if (body) {
    if (json) {
      lines.push(`payload = ${pythonJson(body, indent)}`);
      callArgs.push('json=payload');
    } else {
      lines.push(`payload = ${pyString(body)}`);
      callArgs.push('data=payload');
    }
  }

  lines.push('');
  lines.push(`res = requests.${method.toLowerCase()}(${callArgs.join(', ')})`);
  lines.push('');
  lines.push('print(res.status_code, res.text)');

  return { code: lines.join('\n'), warnings: [] };
}

function buildGo(req, { indent = 1 } = {}) {
  const sp = '\t'.repeat(indent);
  const lines = [];
  const headers = headerPairs(req);
  const method = String(req?.method || 'GET').toUpperCase();
  const body = bodyText(req);

  lines.push('package main');
  lines.push('');
  lines.push('import (');
  lines.push('\t"fmt"');
  lines.push('\t"io"');
  lines.push('\t"net/http"');
  if (body) lines.push('\t"strings"');
  lines.push(')');
  lines.push('');
  lines.push('func main() {');

  if (body) {
    lines.push(`${sp}payload := strings.NewReader(${goString(body)})`);
    lines.push(`${sp}req, err := http.NewRequest("${method}", "${escapeDouble(String(req?.url || ''))}", payload)`);
  } else {
    lines.push(`${sp}req, err := http.NewRequest("${method}", "${escapeDouble(String(req?.url || ''))}", nil)`);
  }
  lines.push(`${sp}if err != nil {`);
  lines.push(`${sp}${sp}panic(err)`);
  lines.push(`${sp}}`);

  for (const [k, v] of headers) {
    lines.push(`${sp}req.Header.Set("${escapeDouble(k)}", "${escapeDouble(v)}")`);
  }

  lines.push('');
  lines.push(`${sp}client := &http.Client{}`);
  lines.push(`${sp}res, err := client.Do(req)`);
  lines.push(`${sp}if err != nil {`);
  lines.push(`${sp}${sp}panic(err)`);
  lines.push(`${sp}}`);
  lines.push(`${sp}defer res.Body.Close()`);
  lines.push('');
  lines.push(`${sp}data, _ := io.ReadAll(res.Body)`);
  lines.push(`${sp}fmt.Println(res.StatusCode, string(data))`);
  lines.push('}');

  return { code: lines.join('\n'), warnings: [] };
}

function buildJava(req, { indent = 2 } = {}) {
  const sp = ' '.repeat(indent);
  const lines = [];
  const headers = headerPairs(req);
  const method = String(req?.method || 'GET').toUpperCase();
  const body = bodyText(req);
  const json = isJsonBody(req);

  lines.push('import okhttp3.*;');
  lines.push('');
  lines.push('OkHttpClient client = new OkHttpClient();');
  lines.push('');

  if (body) {
    const media = json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    lines.push(`MediaType mediaType = MediaType.parse("${media}");`);
    lines.push(`RequestBody body = RequestBody.create(${javaString(body)}, mediaType);`);
  } else {
    lines.push('RequestBody body = null;');
  }

  lines.push('');
  lines.push('Request request = new Request.Builder()');
  lines.push(`${sp}.url("${escapeDouble(String(req?.url || ''))}")`);
  // HTTP 方法的差异用 method + body 表达，GET/HEAD 不允许带 body
  if (body) {
    lines.push(`${sp}.method("${method}", body)`);
  } else if (method === 'GET') {
    lines.push(`${sp}.get()`);
  } else {
    lines.push(`${sp}.method("${method}", null)`);
  }
  for (const [k, v] of headers) {
    lines.push(`${sp}.addHeader("${escapeDouble(k)}", "${escapeDouble(v)}")`);
  }
  lines.push(`${sp}.build();`);
  lines.push('');
  lines.push('try (Response response = client.newCall(request).execute()) {');
  lines.push(`${sp}System.out.println(response.code() + " " + response.body().string());`);
  lines.push('}');

  return { code: lines.join('\n'), warnings: [] };
}

/* ---------------- 字符串转义工具 ---------------- */

function escapeSingle(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n');
}

function escapeDouble(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

function javaString(text) {
  const oneLine = String(text ?? '').replace(/\r?\n/g, '\n');
  return `"${oneLine
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;
}

function goString(text) {
  return `\`${String(text ?? '').replace(/`/g, '` + "`" + `')}\``;
}

function pyString(text) {
  if (!/[\r\n'"]/.test(String(text ?? ''))) return `"${escapeDouble(text)}"`;
  // 含换行或引号时用三引号，内部双引号无需转义
  return `"""${String(text ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""`;
}

function templateLiteral(text) {
  return `\`${String(text ?? '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``;
}

/** JSON 字符串重排成 JS 字面量（单引号不合法，这里保留双引号） */
function prettyJsonForJs(text, indent) {
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed, null, indent);
  } catch {
    return templateLiteral(text);
  }
}

/**
 * 把多行代码块的后续行统一加前缀，让 JSON 字面量能嵌进
 * `body: JSON.stringify({ ... })` 这类调用里时保持对齐。
 */
function indentAfterFirstLine(text, prefix) {
  const lines = String(text ?? '').split('\n');
  if (lines.length <= 1) return text;
  return lines.map((line, i) => (i === 0 ? line : prefix + line)).join('\n');
}

/** JSON 重排成 Python 字面量（True/False/None） */
function pythonJson(text, indent) {
  try {
    const parsed = JSON.parse(text);
    const py = JSON.stringify(parsed, null, indent)
      .replace(/\btrue\b/g, 'True')
      .replace(/\bfalse\b/g, 'False')
      .replace(/\bnull\b/g, 'None');
    return py;
  } catch {
    return pyString(text);
  }
}

/* ---------------- 对外入口 ---------------- */

/**
 * 生成代码片段。
 * @param {object} req 请求详情 { method, url, headers, body_mode, body }
 * @param {{lang?: string, indent?: number}} [options]
 * @returns {{code: string, language: string, label: string, warnings: string[]}}
 */
export function buildSnippet(req, { lang = 'curl', indent } = {}) {
  const language = LANGUAGES.some(([key]) => key === lang) ? lang : 'curl';
  const label = LANGUAGE_LABEL[language] || language;
  const warnings = [];

  const mode = String(req?.body_mode || 'none');
  if (OPAQUE_BODY_MODES.has(mode)) {
    warnings.push(`body 为 ${mode} 模式，无法生成代码片段，请改用 cURL 或手工补全`);
  }
  if (!req?.url) {
    warnings.push('缺少请求 URL');
  }

  const opts = indent ? { indent } : {};
  let code = '';
  if (language === 'curl') {
    // 复用 curl-build 的实现，保证与「复制为 cURL」完全一致
    const built = globalThis.CurlBuild?.buildCurl?.(req, { dialect: 'bash' });
    if (built) {
      code = built.text;
      for (const w of built.warnings || []) warnings.push(w);
    } else {
      // curl-build 未加载时给一个最小可用版本，避免整块功能不可用
      const parts = [`curl -X ${String(req?.method || 'GET').toUpperCase()} '${escapeSingle(req?.url || '')}'`];
      for (const [k, v] of headerPairs(req)) parts.push(`-H '${escapeSingle(`${k}: ${v}`)}'`);
      const b = bodyText(req);
      if (b) parts.push(`--data-raw '${escapeSingle(b)}'`);
      code = parts.join(' \\\n  ');
    }
  } else if (language === 'fetch') {
    code = buildFetch(req, opts).code;
  } else if (language === 'axios') {
    code = buildAxios(req, opts).code;
  } else if (language === 'python') {
    code = buildPython(req, opts).code;
  } else if (language === 'go') {
    code = buildGo(req, opts).code;
  } else if (language === 'java') {
    code = buildJava(req, opts).code;
  }

  return { code, language, label, warnings };
}

/* ---------------- 浏览器挂载 ---------------- */

if (typeof window !== 'undefined') {
  window.CodeGen = { buildSnippet, LANGUAGES };
}
