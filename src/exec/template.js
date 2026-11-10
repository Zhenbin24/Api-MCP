/**
 * 变量模板：{{key}} 替换。
 * 取值优先级：环境 current_value > 环境 value > 全局 current_value > 全局 value
 * 内置函数：{{$timestamp}} {{$timestampMs}} {{$randomInt}} {{$uuid}} {{$isoDate}}
 */
import crypto from 'node:crypto';

const BUILTIN = {
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $timestampMs: () => String(Date.now()),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
  $uuid: () => crypto.randomUUID(),
  $isoDate: () => new Date().toISOString(),
  $guid: () => crypto.randomUUID()
};

export function createVariableScope({ envVars = {}, envRuntime = {}, globalVars = {}, globalRuntime = {} } = {}) {
  const flat = new Map();
  // 先写优先级低的，后来者不覆盖已有值 => 最高优先级的先写入
  const put = (key, val) => {
    if (key == null) return;
    if (flat.has(String(key))) return; // 已由更高优先级写入
    if (val === undefined || val === null) return;
    flat.set(String(key), typeof val === 'string' ? val : typeof val === 'object' ? JSON.stringify(val) : String(val));
  };

  const pickValue = (v) => {
    if (v && typeof v === 'object') {
      if (v.current_value !== undefined && v.current_value !== null && v.current_value !== '') return v.current_value;
      if (v.value !== undefined) return v.value;
      return undefined;
    }
    return v;
  };

  // 优先级（高 -> 低）：环境 current_value > 环境 value > 全局 current_value > 全局 value
  for (const [k, v] of Object.entries(envRuntime || {})) put(k, v?.value ?? v);
  for (const [k, v] of Object.entries(envVars || {})) put(k, pickValue(v));
  for (const [k, v] of Object.entries(globalRuntime || {})) put(k, v?.value ?? v);
  for (const [k, v] of Object.entries(globalVars || {})) put(k, v?.value ?? v);

  return {
    get(key) {
      const name = String(key).trim();
      if (name.startsWith('$') && BUILTIN[name]) return BUILTIN[name]();
      if (flat.has(name)) return flat.get(name);
      return undefined;
    },
    set(key, value) {
      flat.set(String(key), typeof value === 'string' ? value : JSON.stringify(value));
    },
    toObject() {
      return Object.fromEntries(flat);
    },
    has(key) {
      return flat.has(String(key));
    }
  };
}

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** 单次替换（保留未命中的占位符原样） */
export function renderTemplate(input, scope, { keepUnknown = true, depth = 0 } = {}) {
  if (input == null) return input;
  if (typeof input !== 'string') {
    if (Array.isArray(input)) return input.map((v) => renderTemplate(v, scope, { keepUnknown, depth }));
    if (typeof input === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(input)) out[k] = renderTemplate(v, scope, { keepUnknown, depth });
      return out;
    }
    return input;
  }
  if (input.indexOf('{{') < 0) return input;

  const replaced = input.replace(TOKEN_RE, (whole, name) => {
    const value = scope.get(name);
    if (value === undefined) return keepUnknown ? whole : '';
    return value;
  });

  // 变量值里可能还含有 {{...}}，最多递归 5 层防死循环
  if (replaced !== input && replaced.includes('{{') && depth < 5) {
    return renderTemplate(replaced, scope, { keepUnknown, depth: depth + 1 });
  }
  return replaced;
}

/** 递归替换对象里所有字符串（用于 headers/query/body） */
export function renderDeep(value, scope, opts) {
  return renderTemplate(value, scope, opts);
}

export function hasTemplate(str) {
  return typeof str === 'string' && /\{\{[^{}]+\}\}/.test(str);
}

export const VARIABLE_PRIORITY_NOTE = '环境 current_value > 环境 value > 全局 current_value > 全局 value';
