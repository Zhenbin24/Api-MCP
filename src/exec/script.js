/**
 * 前后置脚本沙箱：实现官方文档中的 apt.* 门面（含 pm.* 别名）。
 * 约束：无 require / process / fetch / 文件系统；同步部分有 timeout，异步部分有总时限。
 */
import vm from 'node:vm';

const DEFAULT_TIMEOUT_MS = 5000;

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
    this.isAssertion = true;
  }
}

/* ---------------- 简易断言库 ---------------- */

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(a[k], b[k]));
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function assert(cond, message, negated) {
  if (negated ? cond : !cond) {
    throw new AssertionError(message);
  }
}

function createExpect(value, negate = false) {
  const assertFn = (cond, msg, negatedMsg) => {
    const text = negate ? negatedMsg : msg;
    assert(cond, text, negate);
  };

  const api = {
    get not() {
      return createExpect(value, !negate);
    },
    get to() {
      return api;
    },
    get be() {
      return api;
    },
    get been() {
      return api;
    },
    get is() {
      return api;
    },
    get that() {
      return api;
    },
    get have() {
      return api;
    },
    get has() {
      return api;
    },
    get and() {
      return api;
    },
    equal(expected) {
      assertFn(
        value === expected || deepEqual(value, expected),
        `期望 ${describe(value)} 等于 ${describe(expected)}`,
        `期望 ${describe(value)} 不等于 ${describe(expected)}`
      );
      return api;
    },
    equals(expected) {
      return api.equal(expected);
    },
    eql(expected) {
      assertFn(
        deepEqual(value, expected),
        `期望 ${describe(value)} 深度等于 ${describe(expected)}`,
        `期望 ${describe(value)} 深度不等于 ${describe(expected)}`
      );
      return api;
    },
    above(n) {
      assertFn(Number(value) > Number(n), `期望 ${describe(value)} > ${n}`, `期望 ${describe(value)} <= ${n}`);
      return api;
    },
    greaterThan(n) {
      return api.above(n);
    },
    below(n) {
      assertFn(Number(value) < Number(n), `期望 ${describe(value)} < ${n}`, `期望 ${describe(value)} >= ${n}`);
      return api;
    },
    lessThan(n) {
      return api.below(n);
    },
    least(n) {
      assertFn(Number(value) >= Number(n), `期望 ${describe(value)} >= ${n}`, `期望 ${describe(value)} < ${n}`);
      return api;
    },
    most(n) {
      assertFn(Number(value) <= Number(n), `期望 ${describe(value)} <= ${n}`, `期望 ${describe(value)} > ${n}`);
      return api;
    },
    include(expected) {
      let ok = false;
      if (typeof value === 'string') ok = value.includes(String(expected));
      else if (Array.isArray(value)) ok = value.some((v) => v === expected || deepEqual(v, expected));
      else if (value && typeof value === 'object') ok = expected in value;
      assertFn(ok, `期望 ${describe(value)} 包含 ${describe(expected)}`, `期望 ${describe(value)} 不包含 ${describe(expected)}`);
      return api;
    },
    contains(expected) {
      return api.include(expected);
    },
    match(re) {
      const rx = re instanceof RegExp ? re : new RegExp(String(re));
      assertFn(rx.test(String(value)), `期望 ${describe(value)} 匹配 ${rx}`, `期望 ${describe(value)} 不匹配 ${rx}`);
      return api;
    },
    property(name, ...rest) {
      const has = value != null && typeof value === 'object' && name in value;
      assertFn(has, `期望对象包含属性 ${String(name)}`, `期望对象不含属性 ${String(name)}`);
      if (rest.length > 0 && has) value[name];
      if (rest.length > 0) {
        const compare = createExpect(value[name], negate);
        compare.equal(rest[0]);
      }
      return api;
    },
    lengthOf(n) {
      const len = value?.length ?? value?.size;
      assertFn(Number(len) === Number(n), `期望长度 ${n}，实际 ${len}`, `期望长度不等于 ${n}`);
      return api;
    },
    ok() {
      assertFn(Boolean(value), `期望 ${describe(value)} 为真值`, `期望 ${describe(value)} 为假值`);
      return api;
    },
    empty() {
      const isEmpty =
        value == null ||
        (typeof value === 'string' && value.length === 0) ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && Object.keys(value).length === 0);
      assertFn(isEmpty, `期望 ${describe(value)} 为空`, `期望 ${describe(value)} 不为空`);
      return api;
    },
    a(type) {
      const t = String(type).toLowerCase();
      const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      const ok = t === 'array' ? actual === 'array' : t === 'object' ? actual === 'object' : actual === t;
      assertFn(ok, `期望类型 ${t}，实际 ${actual}`, `期望类型不为 ${t}`);
      return api;
    },
    an(type) {
      return api.a(type);
    },
    true() {
      assertFn(value === true, `期望为 true，实际 ${describe(value)}`, `期望不为 true`);
      return api;
    },
    false() {
      assertFn(value === false, `期望为 false，实际 ${describe(value)}`, `期望不为 false`);
      return api;
    },
    null() {
      assertFn(value === null, `期望为 null，实际 ${describe(value)}`, `期望不为 null`);
      return api;
    },
    undefined() {
      assertFn(value === undefined, `期望为 undefined，实际 ${describe(value)}`, `期望不为 undefined`);
      return api;
    },
    exist() {
      assertFn(value != null, `期望存在，实际 ${describe(value)}`, `期望不存在`);
      return api;
    }
  };

  return api;
}

/* ---------------- Cookie Jar ---------------- */

function createCookieJar() {
  const store = new Map();

  const parseSetCookie = (raw, hostname) => {
    const parts = String(raw).split(';').map((p) => p.trim());
    const [pair, ...attrs] = parts;
    const idx = pair.indexOf('=');
    if (idx < 0) return null;
    const cookie = {
      name: pair.slice(0, idx),
      value: pair.slice(idx + 1),
      domain: hostname,
      path: '/',
      expires: null,
      secure: false,
      httpOnly: false
    };
    for (const attr of attrs) {
      const [k, ...v] = attr.split('=');
      const key = k.trim().toLowerCase();
      const val = v.join('=').trim();
      if (key === 'domain') cookie.domain = val;
      else if (key === 'path') cookie.path = val;
      else if (key === 'expires') cookie.expires = val;
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'httponly') cookie.httpOnly = true;
    }
    return cookie;
  };

  return {
    setFromResponse(rawCookies, hostname) {
      for (const raw of rawCookies || []) {
        const cookie = parseSetCookie(raw, hostname);
        if (!cookie) continue;
        store.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie);
      }
    },
    get list() {
      return [...store.values()];
    },
    header() {
      return [...store.values()].map((c) => `${c.name}=${c.value}`).join('; ');
    },
    jar() {
      return [...store.values()].map((c) => ({ ...c }));
    },
    toObject() {
      const out = {};
      for (const c of store.values()) out[c.name] = c.value;
      return out;
    },
    clear() {
      store.clear();
    }
  };
}

/* ---------------- 主入口 ---------------- */

/**
 * 执行一段脚本。
 * @param {string} source 脚本源码
 * @param {object} ctx 运行上下文
 * @param {object} ctx.variables 变量作用域 (createVariableScope)
 * @param {object} ctx.request  可变请求对象 { method, url, headers, query, body, cookies }
 * @param {object} ctx.response 响应对象 { status, headers, bodyText, bodyJson }
 * @param {object} ctx.envInfo  { envName, baseUrl }
 * @param {object} ctx.cookieJar
 * @param {number} ctx.timeoutMs
 * @returns {Promise<{assertions, console, error, variables}>}
 */
export async function runScript(source, ctx, { timeoutMs = DEFAULT_TIMEOUT_MS, phase = 'script' } = {}) {
  const assertions = [];
  const logs = [];
  let inTest = 0;

  if (!source || !String(source).trim()) {
    return { assertions, console: logs, error: null, skipped: true };
  }

  const record = (name, fn) => {
    try {
      inTest += 1;
      fn();
      inTest -= 1;
      assertions.push({ name, passed: true, skipped: false, phase });
      return true;
    } catch (err) {
      inTest -= 1;
      assertions.push({
        name,
        passed: false,
        skipped: false,
        phase,
        message: err?.message || String(err)
      });
      throw err;
    }
  };

  const expect = (value) => {
    const chain = createExpect(value);
    // 断言失败自动登记（未包裹在 test 里时）
    return new Proxy(chain, {
      get(target, prop) {
        const original = target[prop];
        if (typeof original !== 'function') return original;
        if (!['equal', 'equals', 'eql', 'above', 'below', 'least', 'most', 'include', 'match', 'property', 'lengthOf', 'ok', 'empty', 'a', 'an', 'true', 'false', 'null', 'undefined', 'exist', 'greaterThan', 'lessThan', 'contains'].includes(String(prop))) {
          return original.bind(target);
        }
        return (...args) => {
          try {
            const result = original.apply(target, args);
            // 已在 apt.test 内部登记过就不重复记录
            if (inTest === 0) {
              assertions.push({ name: `apt.expect ${String(prop)}(${args.map(describe).join(', ')})`, passed: true, phase });
            }
            return result;
          } catch (err) {
            if (inTest === 0) {
              assertions.push({
                name: `apt.expect ${String(prop)}(${args.map(describe).join(', ')})`,
                passed: false,
                phase,
                message: err?.message || String(err)
              });
            }
            throw err;
          }
        };
      }
    });
  };

  const apt = {
    environment: {
      get: (key) => ctx.variables.get(key),
      set: (key, value) => {
        ctx.variables.set(key, value);
        ctx.persist?.('environment', key, value);
      },
      unset: (key) => ctx.variables.set(key, ''),
      delete: (key) => ctx.variables.set(key, ''),
      clear: () => {
        for (const key of Object.keys(ctx.variables.toObject())) ctx.variables.set(key, '');
      },
      getCollection: () =>
        Object.entries(ctx.variables.toObject()).map(([key, value]) => ({ key, value })),
      toObject: () => ctx.variables.toObject(),
      getPreUrl: () => ctx.envInfo?.baseUrl || '',
      getName: () => ctx.envInfo?.envName || ''
    },
    globals: {
      get: (key) => ctx.variables.get(key),
      set: (key, value) => {
        ctx.variables.set(key, value);
        ctx.persist?.('globals', key, value);
      },
      unset: (key) => ctx.variables.set(key, ''),
      delete: (key) => ctx.variables.set(key, ''),
      clear: () => {
        for (const key of Object.keys(ctx.variables.toObject())) ctx.variables.set(key, '');
      },
      getCollection: () =>
        Object.entries(ctx.variables.toObject()).map(([key, value]) => ({ key, value })),
      toObject: () => ctx.variables.toObject()
    },
    variables: {
      get: (key) => ctx.variables.get(key),
      set: (key, value) => ctx.variables.set(key, value),
      toObject: () => ctx.variables.toObject()
    },
    iterationData: {
      toObject: () => ({})
    },
    setRequestHeader: (key, value) => {
      ctx.request.headers[key] = value == null ? '' : String(value);
    },
    removeRequestHeader: (key) => {
      for (const k of Object.keys(ctx.request.headers)) {
        if (k.toLowerCase() === String(key).toLowerCase()) delete ctx.request.headers[k];
      }
    },
    setRequestQuery: (key, value) => {
      ctx.request.query[key] = value == null ? '' : String(value);
    },
    removeRequestQuery: (key) => {
      delete ctx.request.query[key];
    },
    setRequestBody: (body) => {
      ctx.request.body = body;
      if (typeof body === 'string') {
        ctx.request.bodyMode = 'raw';
        ctx.request.bodyText = body;
      } else {
        ctx.request.bodyMode = 'json';
        ctx.request.bodyText = JSON.stringify(body, null, 2);
      }
    },
    removeRequestBody: () => {
      ctx.request.body = undefined;
      ctx.request.bodyText = '';
      ctx.request.bodyMode = 'none';
    },
    response: {
      json: () => {
        if (ctx.response?.bodyJson !== undefined) return ctx.response.bodyJson;
        try {
          return JSON.parse(ctx.response?.bodyText || '');
        } catch {
          throw new Error('响应不是合法 JSON');
        }
      },
      text: () => ctx.response?.bodyText ?? '',
      code: () => ctx.response?.status,
      status: () => ctx.response?.status,
      get headers() {
        return ctx.response?.headers || {};
      }
    },
    cookies: {
      jar: () => ctx.cookieJar?.jar() || [],
      toObject: () => ctx.cookieJar?.toObject() || {},
      clear: () => ctx.cookieJar?.clear?.()
    },
    test: (name, fn) => {
      try {
        record(String(name || 'test'), fn);
      } catch {
        // 断言失败已记录，继续执行后续断言
      }
    },
    expect,
    assert: (condition, message) => {
      const ok = Boolean(condition);
      assertions.push({ name: message || `apt.assert(${ok})`, passed: ok, phase, message: ok ? undefined : message });
      if (!ok) throw new AssertionError(message || '断言失败');
    }
  };

  const pm = {
    environment: apt.environment,
    globals: apt.globals,
    variables: apt.variables,
    response: apt.response,
    test: apt.test,
    expect
  };

  const sandboxConsole = {
    log: (...args) => logs.push({ level: 'log', message: args.map(fmt).join(' ') }),
    info: (...args) => logs.push({ level: 'info', message: args.map(fmt).join(' ') }),
    warn: (...args) => logs.push({ level: 'warn', message: args.map(fmt).join(' ') }),
    error: (...args) => logs.push({ level: 'error', message: args.map(fmt).join(' ') }),
    debug: (...args) => logs.push({ level: 'debug', message: args.map(fmt).join(' ') })
  };

  const sandbox = {
    apt,
    pm,
    console: sandboxConsole,
    require: () => {
      throw new Error('脚本沙箱禁止使用 require');
    },
    process: undefined,
    fetch: undefined,
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined
  };

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false }
  });

  const wrapped = `(async () => {\n${source}\n})()`;

  let script;
  try {
    script = new vm.Script(wrapped, { filename: 'apipost-script.js' });
  } catch (err) {
    return { assertions, console: logs, error: `脚本语法错误：${err.message}` };
  }

  let error = null;
  try {
    const promise = script.runInContext(context, { timeout: timeoutMs, displayErrors: true });
    await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`脚本执行超时（>${timeoutMs}ms）`)), timeoutMs)
      )
    ]);
  } catch (err) {
    error = err?.isAssertion ? `断言失败：${err.message}` : err?.message || String(err);
    if (err?.isAssertion) {
      assertions.push({ name: '脚本断言', passed: false, phase, message: err.message });
    }
  }

  return { assertions, console: logs, error };
}

function fmt(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 官方脚本任务结构 -> 源码数组 */
export function collectScripts(tasks = []) {
  const out = [];
  for (const task of tasks || []) {
    if (!task || typeof task !== 'object') continue;
    if (task.type !== 'customScript') continue;
    if (!task.enabled || Number(task.enabled) <= 0) continue;
    if (typeof task.data === 'string' && task.data.trim()) {
      out.push({ id: task.id, source: task.data });
    }
  }
  return out;
}

export function makeScriptTask(source) {
  return {
    name: '',
    type: 'customScript',
    data: String(source || ''),
    enabled: 1,
    id: `script_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  };
}
