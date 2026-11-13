/**
 * 零依赖的 YAML 子集解析与序列化。
 *
 * 只覆盖 OpenAPI / Swagger / Postman 常见写法，刻意不做完整 YAML 规范：
 * - 缩进映射与序列（含 `- key: value` 的紧凑写法）
 * - 单双引号标量、内联流式 `{}` / `[]`
 * - `|` 与 `>` 块标量（含 `|-` / `|+` 之类的 chomping 标记）
 * - 注释（行首 `#`、行尾 ` #`）与文档分隔符 `---`
 *
 * 遇到无法识别的结构会抛错，由调用方提示「请改用 JSON 导入」。
 */

/* ---------------- 序列化 ---------------- */

const NEEDS_QUOTE = /^(?:$|[-?:,[\]{}#&*!|>'"%@`]|\s|\s.*|.*\s$)/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|~|-?\d+(?:\.\d+)?|\.inf|\.nan)$/i;

/** 判断一个字符串能否安全地不加引号输出 */
function isPlainSafe(str) {
  if (str === '') return false;
  if (NEEDS_QUOTE.test(str)) return false;
  if (RESERVED.test(str)) return false;
  // 冒号后跟空格、或行内出现 " #" 会被误读
  if (/:\s/.test(str) || / #/.test(str)) return false;
  if (/[\r\n\t]/.test(str)) return false;
  return true;
}

function quote(str) {
  if (isPlainSafe(str)) return str;
  // 统一用双引号，转义必要字符
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function isScalarArray(arr) {
  return arr.every((v) => v === null || typeof v !== 'object');
}

function emitValue(value, indent, lines) {
  const pad = ' '.repeat(indent);

  if (value === null || value === undefined) return 'null';

  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) return quote(String(value));
    return String(value);
  }

  if (typeof value === 'string') {
    if (value.includes('\n')) {
      // 多行用块标量，保留换行
      emitBlockString(value, indent, lines);
      return null;
    }
    return quote(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';

    // 标量数组压成一行，读起来更紧凑
    if (isScalarArray(value)) {
      const inline = value.map((v) => emitInlineScalar(v)).join(', ');
      if (inline.length <= 100) return `[${inline}]`;
    }

    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        if (Array.isArray(item)) {
          lines.push(`${pad}-`);
          emitValue(item, indent + 2, lines);
          continue;
        }
        const keys = Object.keys(item);
        if (keys.length === 0) {
          lines.push(`${pad}- {}`);
          continue;
        }
        // 第一层键接在 "- " 后面，其余缩进对齐
        const sub = [];
        emitMapping(item, indent + 2, sub);
        sub[0] = `${pad}- ${sub[0].slice(indent + 2)}`;
        lines.push(...sub);
      } else if (typeof item === 'string' && item.includes('\n')) {
        lines.push(`${pad}- |-`);
        for (const line of item.replace(/\n$/, '').split('\n')) lines.push(`${pad}  ${line}`);
      } else {
        const sub = emitValue(item, indent + 2, []);
        lines.push(`${pad}- ${sub}`);
      }
    }
    return null;
  }

  // 对象
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  emitMapping(value, indent, lines);
  return null;
}

/** 输出多行字符串为块标量；末尾带换行时用 `|`（keep），否则用 `|-`（strip） */
function emitBlockString(str, indent, lines) {
  const pad = ' '.repeat(indent);
  const endsWithNewline = str.endsWith('\n');
  lines.push(`${pad}${endsWithNewline ? '|' : '|-'}`);
  const body = endsWithNewline ? str.slice(0, -1) : str;
  for (const line of body.split('\n')) {
    lines.push(line === '' ? '' : `${pad}  ${line}`);
  }
}

/** 只用于流式数组内的标量 */
function emitInlineScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') {
    if (v.includes('\n')) return quote(v.replace(/\n/g, '\\n'));
    return quote(v);
  }
  return emitValue(v, 0, []);
}

function emitMapping(obj, indent, lines) {
  const pad = ' '.repeat(indent);
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    const label = `${pad}${quote(String(key))}:`;
    if (val !== null && typeof val === 'object') {
      if (Array.isArray(val) && val.length === 0) {
        lines.push(`${label} []`);
        continue;
      }
      if (!Array.isArray(val) && Object.keys(val).length === 0) {
        lines.push(`${label} {}`);
        continue;
      }
      const inline = Array.isArray(val) && isScalarArray(val) ? emitValue(val, 0, []) : null;
      if (inline !== null) {
        lines.push(`${label} ${inline}`);
        continue;
      }
      lines.push(label);
      emitValue(val, indent + 2, lines);
    } else if (typeof val === 'string' && val.includes('\n')) {
      lines.push(label);
      emitBlockString(val, indent + 2, lines);
    } else {
      lines.push(`${label} ${emitValue(val, 0, [])}`);
    }
  }
}

/**
 * JS 值 -> YAML 文本
 * @param {*} value
 * @returns {string}
 */
export function jsonToYaml(value) {
  const lines = [];
  const root = emitValue(value, 0, lines);
  if (root !== null) lines.push(root);
  return `${lines.join('\n')}\n`;
}

/* ---------------- 解析 ---------------- */

/** 去掉行尾注释（引号内的 # 不算） */
function stripComment(line) {
  let quoteChar = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoteChar) {
      if (ch === '\\' && quoteChar === '"') {
        i += 1;
        continue;
      }
      if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** 标量解析：去引号、识别 bool/null/数字 */
function parseScalar(raw) {
  let text = raw.trim();
  if (text === '') return null;

  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }

  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;

  // 数字（含负号与小数、科学计数法），但要排除日期这类含 - 的字符串
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) {
    const num = Number(text);
    if (Number.isFinite(num)) return num;
  }

  return text;
}

/** 流式解析 `[...]` / `{...}`，返回 [value, 剩余文本] */
function parseFlow(text) {
  const src = text.trim();
  if (src.startsWith('[')) {
    const end = findFlowEnd(src, '[', ']');
    if (end === -1) throw new Error(`YAML 流式序列未闭合：${src.slice(0, 40)}`);
    const inner = src.slice(1, end).trim();
    const arr = inner === '' ? [] : splitFlow(inner).map((part) => parseFlowOrScalar(part));
    return [arr, src.slice(end + 1)];
  }
  if (src.startsWith('{')) {
    const end = findFlowEnd(src, '{', '}');
    if (end === -1) throw new Error(`YAML 流式映射未闭合：${src.slice(0, 40)}`);
    const inner = src.slice(1, end).trim();
    const obj = {};
    if (inner !== '') {
      for (const part of splitFlow(inner)) {
        const idx = findTopLevelColon(part);
        if (idx === -1) {
          obj[String(parseFlowOrScalar(part))] = null;
          continue;
        }
        const key = parseFlowOrScalar(part.slice(0, idx));
        obj[String(key)] = parseFlowOrScalar(part.slice(idx + 1));
      }
    }
    return [obj, src.slice(end + 1)];
  }
  return [parseScalar(src), ''];
}

function findFlowEnd(src, open, close) {
  let depth = 0;
  let quoteChar = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoteChar) {
      if (ch === '\\' && quoteChar === '"') i += 1;
      else if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === '"' || ch === "'") quoteChar = ch;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitFlow(text) {
  const parts = [];
  let depth = 0;
  let quoteChar = null;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoteChar) {
      current += ch;
      if (ch === '\\' && quoteChar === '"') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function findTopLevelColon(text) {
  let quoteChar = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoteChar) {
      if (ch === '\\' && quoteChar === '"') i += 1;
      else if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === '"' || ch === "'") quoteChar = ch;
    else if (ch === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}

function parseFlowOrScalar(text) {
  const src = text.trim();
  if (src.startsWith('[') || src.startsWith('{')) return parseFlow(src)[0];
  return parseScalar(src);
}

/** 把 `key: value` 拆开；找不到顶层冒号返回 null */
function splitKeyValue(line) {
  const idx = findTopLevelColon(line);
  if (idx === -1) {
    // 允许 "key:" 这种紧贴冒号且无值的写法（例如 `foo:` 后接缩进块）
    const tight = /^([^:\s][^:]*):$/.exec(line.trim());
    if (tight) return { key: parseScalar(tight[1]), value: '', hasValue: false };
    return null;
  }
  const key = parseScalar(line.slice(0, idx));
  const value = line.slice(idx + 1);
  return { key, value, hasValue: true };
}

/**
 * YAML 文本 -> JS 值
 * @param {string} text
 * @returns {*}
 */
export function yamlToJson(text) {
  const rawLines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n');

  // 预处理：去掉注释、空行、文档分隔符；保留缩进
  const lines = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    if (/^\s*#/.test(raw)) continue;
    if (/^\s*$/.test(raw)) continue;
    if (/^---\s*$/.test(raw) || /^\.\.\.\s*$/.test(raw)) continue;
    const stripped = stripComment(raw).replace(/\s+$/, '');
    if (stripped.trim() === '') continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trimStart() });
  }

  if (lines.length === 0) return null;

  let pos = 0;

  function parseBlock(indent) {
    const first = lines[pos];
    if (!first) return null;
    if (first.indent < indent) return null;
    if (first.text.startsWith('- ') || first.text === '-') return parseSequence(first.indent);
    return parseMapping(first.indent);
  }

  function parseSequence(indent) {
    const out = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`YAML 缩进异常（第 ${pos + 1} 条有效行）：${line.text}`);
      if (!line.text.startsWith('- ') && line.text !== '-') break;

      const rest = line.text === '-' ? '' : line.text.slice(2).trim();
      pos += 1;

      if (rest === '') {
        out.push(parseBlock(indent + 1));
        continue;
      }

      // `- key: value` 紧凑写法：把余下内容当成一个缩进更深的映射
      const kv = splitKeyValue(rest);
      if (kv && kv.hasValue && !rest.startsWith('[') && !rest.startsWith('{') && !/^["']/.test(rest)) {
        // 造一个虚拟行参与解析
        const virtualIndent = indent + 2;
        lines.splice(pos, 0, { indent: virtualIndent, text: rest });
        const obj = {};
        while (pos < lines.length) {
          const cur = lines[pos];
          if (cur.indent < virtualIndent) break;
          if (cur.indent > virtualIndent) throw new Error(`YAML 缩进异常：${cur.text}`);
          if (cur.text.startsWith('- ') || cur.text === '-') break;
          const pair = splitKeyValue(cur.text);
          if (!pair) throw new Error(`YAML 无法解析的行：${cur.text}`);
          pos += 1;
          obj[String(pair.key)] = resolveValue(pair.value, virtualIndent + 2, pair.hasValue);
        }
        out.push(obj);
        continue;
      }

      out.push(resolveValue(rest, indent + 2, true));
    }
    return out;
  }

  function parseMapping(indent) {
    const out = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new Error(`YAML 缩进异常（第 ${pos + 1} 条有效行）：${line.text}`);
      if (line.text.startsWith('- ') || line.text === '-') break;

      const pair = splitKeyValue(line.text);
      if (!pair) throw new Error(`YAML 无法解析的行：${line.text}`);
      pos += 1;
      out[String(pair.key)] = resolveValue(pair.value, indent + 2, pair.hasValue);
    }
    return out;
  }

  /** 收集块标量内容；指示符已消费，从当前 pos 开始读 */
  function collectBlockScalar(indicator, childIndent) {
    const folded = indicator.startsWith('>');
    const chomp = /^[|>]([+-]?)/.exec(indicator)?.[1] || '';
    const collected = [];
    let blockIndent = null;
    while (pos < lines.length) {
      const line = lines[pos];
      if (blockIndent === null) {
        if (line.indent < childIndent) break;
        blockIndent = line.indent;
      }
      if (line.indent < blockIndent) break;
      collected.push(' '.repeat(line.indent - blockIndent) + line.text);
      pos += 1;
    }
    if (collected.length === 0) return chomp === '+' ? '\n' : '';
    const text = folded ? collected.join(' ') : collected.join('\n');
    if (chomp === '-') return text;
    return `${text}\n`;
  }

  function resolveValue(valueText, childIndent, hasValue) {
    const value = valueText.trim();

    // 块标量
    const blockMatch = /^([|>])([+-]?)\d*$/.exec(value);
    if (blockMatch) return collectBlockScalar(value, childIndent);

    if (!hasValue || value === '') {
      const next = lines[pos];
      if (!next || next.indent < childIndent) return null;
      // 下一行就是块标量指示符（`|-` / `>` 等）
      if (/^[|>][+-]?\d*$/.test(next.text)) {
        pos += 1;
        return collectBlockScalar(next.text, childIndent);
      }
      return parseBlock(next.indent);
    }

    if (value.startsWith('[') || value.startsWith('{')) return parseFlow(value)[0];

    // 行内还带内容但下一行缩进更深 -> 当作多行折行的普通标量
    const next = lines[pos];
    if (next) {
      if (next.indent > childIndent - 2 && next.indent >= childIndent) {
        // 只在不是新的 key 时拼接
        if (!splitKeyValue(next.text) && !next.text.startsWith('- ')) {
          const parts = [value];
          while (pos < lines.length && lines[pos].indent >= childIndent) {
            parts.push(lines[pos].text);
            pos += 1;
          }
          return parts.join(' ');
        }
      }
    }

    return parseScalar(value);
  }

  const result = parseBlock(lines[0].indent);
  if (pos < lines.length) {
    throw new Error(`YAML 存在多余内容：${lines[pos].text}`);
  }
  return result;
}

/**
 * 尝试把文本解析成 JSON，失败再按 YAML 解析。
 * @param {string} text
 * @returns {*}
 */
export function parseJsonOrYaml(text) {
  const src = String(text ?? '').trim();
  if (src === '') throw new Error('内容为空');
  if (src.startsWith('{') || src.startsWith('[')) {
    try {
      return JSON.parse(src);
    } catch {
      // 落到 YAML 分支再试一次（JSON 里偶有注释或单引号）
    }
  }
  try {
    return yamlToJson(src);
  } catch (err) {
    throw new Error(`解析失败，请改用 JSON 导入：${err.message}`);
  }
}
