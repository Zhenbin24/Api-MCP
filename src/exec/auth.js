/** 鉴权头/参数构造。官方支持十余种，这里覆盖常用并可明确报错其余。 */

const SUPPORTED = new Set(['noauth', 'inherit', 'basic', 'bearer', 'kv', 'oauth2', 'apikey']);

export const AUTH_TYPE_LABEL = {
  noauth: '无鉴权',
  inherit: '继承项目默认',
  basic: 'Basic Auth',
  bearer: 'Bearer Token',
  kv: 'Key-Value',
  apikey: 'API Key',
  oauth2: 'OAuth 2.0',
  awsv4: 'AWS Signature v4',
  digest: 'Digest',
  hawk: 'Hawk',
  ntlm: 'NTLM',
  oauth1: 'OAuth 1.0',
  edgegrid: 'Akamai EdgeGrid',
  asap: 'Atlassian ASAP',
  jwt: 'JWT'
};

export function isAuthSupported(type) {
  return SUPPORTED.has(String(type || 'noauth'));
}

function b64(str) {
  return Buffer.from(String(str), 'utf8').toString('base64');
}

/**
 * 根据鉴权配置产出要注入的 header / query。
 * @param {object} auth 接口的 request.auth
 * @param {object} fallbackAuth global_params.auth（auth.type === 'inherit' 时使用）
 * @returns {{ headers: Record<string,string>, query: Record<string,string>, type: string }}
 */
export function applyAuth(auth, fallbackAuth = null) {
  let conf = auth && typeof auth === 'object' ? auth : { type: 'noauth' };
  if (conf.type === 'inherit' || !conf.type) {
    const fb = fallbackAuth || {};
    conf = fb.type && fb.type !== 'inherit' ? fb : { type: 'noauth' };
  }
  const type = String(conf.type || 'noauth');

  if (type === 'noauth') return { headers: {}, query: {}, type };
  if (!SUPPORTED.has(type)) {
    throw new Error(
      `暂不支持的鉴权类型：${AUTH_TYPE_LABEL[type] || type}。当前支持 ${[...SUPPORTED]
        .map((t) => AUTH_TYPE_LABEL[t] || t)
        .join('、')}`
    );
  }

  if (type === 'basic') {
    const u = conf.basic?.username || '';
    const p = conf.basic?.password || '';
    return { headers: { Authorization: `Basic ${b64(`${u}:${p}`)}` }, query: {}, type };
  }

  if (type === 'bearer') {
    const key = conf.bearer?.key || '';
    return { headers: { Authorization: `Bearer ${key}` }, query: {}, type };
  }

  if (type === 'kv' || type === 'apikey') {
    const { key, value, in: where = 'header' } = conf.kv || {};
    if (!key) return { headers: {}, query: {}, type };
    if (String(where) === 'query') return { headers: {}, query: { [key]: value ?? '' }, type };
    return { headers: { [key]: value ?? '' }, query: {}, type };
  }

  if (type === 'oauth2') {
    const o = conf.oauth2 || {};
    const token = o.access_token || '';
    const prefix = o.headerPrefix === undefined ? 'Bearer' : o.headerPrefix;
    const headerValue = prefix ? `${prefix} ${token}`.trim() : token;
    if (String(o.addTokenTo) === 'query') {
      const qKey = o.queryParamKey || 'access_token';
      return { headers: {}, query: { [qKey]: token }, type };
    }
    return { headers: token ? { Authorization: headerValue } : {}, query: {}, type };
  }

  return { headers: {}, query: {}, type };
}

/** 把鉴权结果合入已有 header/query（已有的同名键不覆盖，除非 force） */
export function mergeAuthInto({ headers = {}, query = {} }, authResult, { force = false } = {}) {
  const lower = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(authResult.headers || {})) {
    if (!force && lower.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  for (const [k, v] of Object.entries(authResult.query || {})) {
    if (!force && k in query) continue;
    query[k] = v;
  }
  return { headers, query };
}
