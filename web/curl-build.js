/**
 * 把一次请求详情拼成 curl 命令。
 *
 * 支持两种方言：
 *  - cmd   Windows CMD：参数用 "..." 包裹，内部 " 写成 ""（CMD 的标准规则），^ 续行
 *  - bash  bash / zsh / Git Bash：参数用 '...' 包裹，内部 ' 写成 '\''，\ 续行
 *
 * 既可在浏览器（<script type="module">）使用，也可被 Node 直接 import 做单测。
 */

/** 这些 body 模式的内容可以直接当 --data-raw 用 */
const TEXT_BODY_MODES = new Set([
  'json',
  'raw',
  'xml',
  'html',
  'javascript',
  'plain',
  'text',
  'graphql',
  'urlencoded',
  'msgpack'
]);

/** 这些模式没法用一行 curl 表达，生成时只加说明不发数据 */
const OPAQUE_BODY_MODES = new Set(['binary', 'form-data']);

/**
 * 按运行环境给出默认方言。
 * @param {string} [platform] 便于测试注入
 */
export function defaultDialect(platform = globalThis.navigator?.platform || '') {
  return /win/i.test(String(platform)) ? 'cmd' : 'bash';
}

/** CMD 参数包裹：内部双引号翻倍 */
export function quoteCmd(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

/** Bash 参数包裹：单引号内不能再出现单引号，用 '\'' 拼出来 */
export function quoteBash(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/**
 * JSON body 压成一行：换行在 CMD 的单行参数里没法表达，
 * 而 JSON 的空白不改变语义，压缩是等价的。
 */
function compactJson(text) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return null;
  }
}

/** 非 JSON 文本体：把换行压成空格，并在 warnings 里留痕 */
function flattenText(text) {
  return String(text).replace(/\r\n?|\n/g, ' ');
}

/**
 * 生成 curl 命令。
 *
 * @param {object} req 请求详情（live_detail.request 的结构）
 * @param {object} [options]
 * @param {'cmd'|'bash'} [options.dialect]
 * @returns {{text: string, dialect: string, warnings: string[]}}
 */
export function buildCurl(req, { dialect } = {}) {
  const useCmd = (dialect || defaultDialect()) === 'cmd';
  const quote = useCmd ? quoteCmd : quoteBash;
  const lineJoin = useCmd ? ' ^\n  ' : ' \\\n  ';
  const warnings = [];

  const method = String(req?.method || 'GET').toUpperCase();
  const url = String(req?.url || '');

  const parts = [`curl -X ${method} ${quote(url)}`];

  for (const [key, value] of Object.entries(req?.headers || {})) {
    if (value === undefined || value === null) continue;
    const single = Array.isArray(value) ? value.join(', ') : String(value);
    parts.push(`-H ${quote(`${key}: ${single}`)}`);
  }

  const bodyMode = String(req?.body_mode || 'none');
  const body = req?.body == null ? '' : String(req.body);

  if (bodyMode !== 'none' && body !== '') {
    if (OPAQUE_BODY_MODES.has(bodyMode)) {
      // 二进制 / 表单没法从文本还原，宁可不说也不发假数据
      warnings.push(`body 为 ${bodyMode} 模式，无法生成 curl，请改用其它方式重放`);
    } else if (TEXT_BODY_MODES.has(bodyMode)) {
      if (!useCmd) {
        parts.push(`--data-raw ${quote(body)}`);
      } else if (/[\r\n]/.test(body)) {
        const compact = bodyMode === 'json' ? compactJson(body) : null;
        if (compact) {
          parts.push(`--data-raw ${quote(compact)}`);
        } else {
          parts.push(`--data-raw ${quote(flattenText(body))}`);
          warnings.push('body 里的换行已压成空格（CMD 单行参数放不下换行）');
        }
      } else {
        parts.push(`--data-raw ${quote(body)}`);
      }
    } else {
      parts.push(`--data-raw ${quote(body)}`);
    }
  }

  return {
    text: parts.join(lineJoin),
    dialect: useCmd ? 'cmd' : 'bash',
    warnings
  };
}

/* ---------------- 浏览器挂载 ---------------- */

if (typeof window !== 'undefined') {
  window.CurlBuild = {
    buildCurl,
    defaultDialect,
    quoteCmd,
    quoteBash
  };
}
