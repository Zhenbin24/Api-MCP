import { hexId, paramId } from '../util/ids.js';

export const TARGET_TYPE = {
  API: 'api',
  FOLDER: 'folder',
  DOC: 'doc',
  SSE: 'sse'
};

const API_INDEX_REL = 'project/apis/index.json';

function indexPath(target) {
  return API_INDEX_REL;
}

export function readApiIndex(target) {
  const index = target.readJson(indexPath(target), null);
  if (!index || !Array.isArray(index.items)) {
    return { project_id: target.projectId, items: [] };
  }
  return index;
}

export function writeApiIndex(target, index) {
  target.writeJson(indexPath(target), {
    project_id: target.projectId,
    items: index.items || []
  });
  return index;
}

export function listApiItems(target) {
  return readApiIndex(target).items;
}

/** 目录树 + 关键词过滤，返回扁平列表（父在前，子在后）。 */
export function listApis(target, { parentId, keyword } = {}) {
  const items = listApiItems(target);
  const kw = String(keyword || '').trim().toLowerCase();
  const matches = (item) => {
    if (parentId != null && parentId !== '') {
      if (String(item.parent_id || '0') !== String(parentId)) return false;
    }
    if (kw) {
      const hay = `${item.name || ''} ${item.url || ''} ${item.method || ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  };
  const filtered = items.filter(matches);
  return filtered
    .slice()
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map(shapeIndexItem);
}

export function shapeIndexItem(item) {
  return {
    target_id: item.target_id,
    target_type: item.target_type,
    name: item.name || '',
    method: String(item.method || '').toUpperCase(),
    url: item.url || '',
    parent_id: item.parent_id || '0',
    sort: item.sort ?? 0,
    status: item.status ?? 1,
    mark_id: item.mark_id || '',
    version: item.version ?? 1,
    created_at: item.created_at || '',
    updated_at: item.updated_at || ''
  };
}

export function findApiItem(target, targetId) {
  return listApiItems(target).find((item) => item.target_id === targetId) || null;
}

export function apiRelPath(targetId) {
  return `project/apis/${targetId}.json`;
}

export function readApiFile(target, targetId) {
  return target.readJson(apiRelPath(targetId), null);
}

export function writeApiFile(target, targetId, data, indexItem) {
  const now = target.now();
  const existing = readApiFile(target, targetId);
  const payload = {
    created_at: existing?.created_at || now,
    data: { ...data, target_id: targetId, project_id: target.projectId },
    is_exampled: existing?.is_exampled ?? 0,
    mark_id: indexItem?.mark_id ?? data.mark_id ?? '',
    method: indexItem?.method ?? data.method ?? '',
    name: indexItem?.name ?? data.name ?? '',
    parent_id: indexItem?.parent_id ?? data.parent_id ?? '0',
    project_id: target.projectId,
    sort: indexItem?.sort ?? data.sort ?? 1000,
    status: indexItem?.status ?? 1,
    target_id: targetId,
    target_type: indexItem?.target_type ?? data.target_type ?? TARGET_TYPE.API,
    updated_at: now,
    url: indexItem?.url ?? data.url ?? '',
    version: (existing?.version ?? 0) + 1
  };
  target.writeJson(apiRelPath(targetId), payload);
  return payload;
}

export function nextSort(items, parentId) {
  const siblings = items.filter((i) => String(i.parent_id || '0') === String(parentId || '0'));
  if (siblings.length === 0) return 1000;
  return Math.max(...siblings.map((s) => Number(s.sort) || 0)) + 1000;
}

export function createApiOrFolder(target, { name, parentId = '0', targetType = TARGET_TYPE.API, method = 'GET', url = '', detail = null }) {
  const index = readApiIndex(target);
  const ids = new Set(index.items.map((i) => i.target_id));
  const targetId = hexId(ids);
  const now = target.now();
  const sort = nextSort(index.items, parentId);
  const upper = String(method || 'GET').toUpperCase();

  if (targetType === TARGET_TYPE.FOLDER) {
    const folderDoc = buildFolderDoc(target.projectId, { targetId, name, parentId, sort });
    writeApiFile(target, targetId, folderDoc, {
      target_id: targetId,
      target_type: TARGET_TYPE.FOLDER,
      name,
      method: '',
      url: '',
      parent_id: parentId,
      sort,
      status: 1,
      mark_id: '',
      version: 1
    });
  } else if (targetType === TARGET_TYPE.DOC) {
    const doc = buildDoc(target.projectId, { targetId, name, parentId, sort, content: detail?.content || '' });
    writeApiFile(target, targetId, doc, {
      target_id: targetId,
      target_type: TARGET_TYPE.DOC,
      name,
      method: '',
      url: '',
      parent_id: parentId,
      sort,
      status: 1,
      mark_id: '',
      version: 1
    });
  } else {
    const apiDoc = buildApiDoc(target.projectId, { targetId, name, parentId, sort, method: upper, url, detail });
    writeApiFile(target, targetId, apiDoc, {
      target_id: targetId,
      target_type: TARGET_TYPE.API,
      name,
      method: upper,
      url,
      parent_id: parentId,
      sort,
      status: 1,
      mark_id: '1',
      version: 1
    });
  }

  index.items.push({
    created_at: now,
    is_exampled: 0,
    mark_id: targetType === TARGET_TYPE.API ? '1' : '',
    method: targetType === TARGET_TYPE.API ? upper : '',
    name,
    parent_id: parentId,
    project_id: target.projectId,
    sort,
    status: 1,
    target_id: targetId,
    target_type: targetType,
    updated_at: now,
    url: targetType === TARGET_TYPE.API ? url : '',
    version: 1
  });
  writeApiIndex(target, index);
  return { target_id: targetId, target_type: targetType, name, parent_id: parentId, sort, method: upper, url };
}

export function updateApiIndexItem(target, targetId, patch) {
  const index = readApiIndex(target);
  const item = index.items.find((i) => i.target_id === targetId);
  if (!item) return null;
  Object.assign(item, patch, { updated_at: target.now() });
  writeApiIndex(target, index);
  return item;
}

function descendants(items, id) {
  const out = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parent_id && out.has(item.parent_id) && !out.has(item.target_id)) {
        out.add(item.target_id);
        changed = true;
      }
    }
  }
  return out;
}

export function deleteApis(target, targetIds) {
  const index = readApiIndex(target);
  const all = new Set();
  for (const id of targetIds) {
    for (const tid of descendants(index.items, id)) all.add(tid);
  }
  const removed = [];
  for (const id of all) {
    if (target.remove(apiRelPath(id))) removed.push(id);
  }
  index.items = index.items.filter((i) => !all.has(i.target_id));
  writeApiIndex(target, index);
  return { deleted_ids: removed, requested_ids: targetIds };
}

export function buildEmptyAuth() {
  return {
    asap: { alg: 'HS256', aud: '', claims: '', exp: '', iss: '', kid: '', privateKey: '', sub: '' },
    awsv4: {
      accessKey: '',
      addAuthDataToQuery: false,
      region: '',
      secretKey: '',
      service: '',
      sessionToken: ''
    },
    basic: { password: '', username: '' },
    bearer: { key: '' },
    digest: {
      algorithm: '',
      cnonce: '',
      nc: '',
      nonce: '',
      opaque: '',
      password: '',
      qop: '',
      realm: '',
      username: ''
    },
    edgegrid: {
      accessToken: '',
      baseURi: '',
      clientSecret: '',
      clientToken: '',
      headersToSign: '',
      nonce: '',
      timestamp: ''
    },
    hawk: {
      algorithm: '',
      authId: '',
      authKey: '',
      default: '',
      delegation: '',
      extraData: '',
      includePayloadHash: false,
      nonce: '',
      timestamp: '',
      user: ''
    },
    jwt: {
      addTokenTo: 'header',
      algorithm: 'HS256',
      header: '',
      headerPrefix: 'Bearer',
      isSecretBase64Encoded: false,
      payload: '',
      queryParamKey: 'token',
      secret: ''
    },
    kv: { in: 'header', key: '', value: '' },
    ntlm: { disableRetryRequest: false, entity: '', password: '', username: '', workstation: '' },
    oauth1: {
      addEmptyParamsToSign: true,
      addParamsToHeader: false,
      callback: '',
      consumerKey: '',
      consumerSecret: '',
      disableHeaderEncoding: false,
      includeBodyHash: true,
      nonce: '',
      realm: '',
      signatureMethod: 'HMAC-SHA1',
      timestamp: '',
      token: '',
      tokenSecret: '',
      verifier: '',
      version: '1.0'
    },
    oauth2: {
      accessTokenUrl: '',
      access_token: '',
      addTokenTo: 'header',
      authRequestParams: [],
      authUrl: '',
      challengeAlgorithm: 'S256',
      clientId: '',
      clientSecret: '',
      client_authentication: 'header',
      code_verifier: 'Bearer',
      grant_type: 'authorization_code',
      headerPrefix: 'Bearer',
      password: '',
      redirect_uri: '',
      refreshRequestParams: [],
      refreshTokenUrl: '',
      scope: '',
      state: '',
      tokenRequestParams: [],
      username: ''
    },
    type: 'inherit'
  };
}

export function buildBlankBody(mode = 'none') {
  return {
    binary: null,
    mode,
    parameter: [],
    raw: '',
    raw_parameter: [],
    raw_schema: { type: 'object' }
  };
}

export function makeParameter({ key = '', value = '', fieldType = 'String', description = '', checked = 1, notNull = -1 } = {}) {
  return {
    description,
    field_type: fieldType,
    is_checked: checked,
    key,
    not_null: notNull,
    param_id: paramId(),
    value
  };
}

function buildApiDoc(projectId, { targetId, name, parentId, sort, method, url, detail }) {
  return {
    attribute_info: {},
    description: detail?.description || '',
    is_locked: -1,
    mark_id: '1',
    method,
    name,
    parent_id: parentId,
    project_id: projectId,
    protocol: 'http/1.1',
    request: {
      auth: detail?.request?.auth || buildEmptyAuth(),
      body: detail?.request?.body || buildBlankBody(),
      cookie: { parameter: detail?.request?.cookie?.parameter || [] },
      header: { parameter: detail?.request?.header?.parameter || [] },
      post_tasks: detail?.request?.post_tasks || [],
      pre_tasks: detail?.request?.pre_tasks || [],
      query: { parameter: detail?.request?.query?.parameter || [], query_add_equal: 1 },
      restful: { parameter: detail?.request?.restful?.parameter || [] }
    },
    response:
      detail?.response || {
        example: [
          {
            example_id: '1',
            expect: {
              code: '200',
              content_type: 'json',
              is_default: 1,
              mock: '',
              name: '成功',
              schema: { properties: {}, type: 'object' },
              verify_type: 'schema'
            },
            raw: '{\n\t\n}',
            raw_parameter: []
          }
        ],
        is_check_result: 1
      },
    sort,
    status: 1,
    tags: [],
    target_id: targetId,
    target_type: TARGET_TYPE.API,
    url,
    version: 1
  };
}

function buildFolderDoc(projectId, { targetId, name, parentId, sort }) {
  return {
    description: '',
    name,
    parent_id: parentId,
    project_id: projectId,
    request: {
      auth: buildEmptyAuth(),
      body: { parameter: [] },
      cookie: { parameter: [] },
      header: { parameter: [] },
      post_tasks: [],
      pre_tasks: [],
      query: { parameter: [] },
      restful: { parameter: [] }
    },
    server_id: '0',
    sort,
    status: 1,
    target_id: targetId,
    target_type: TARGET_TYPE.FOLDER,
    version: 1
  };
}

function buildDoc(projectId, { targetId, name, parentId, sort, content }) {
  return {
    content,
    description: '',
    is_locked: -1,
    mark_id: '',
    name,
    parent_id: parentId,
    project_id: projectId,
    sort,
    status: 1,
    target_id: targetId,
    target_type: TARGET_TYPE.DOC,
    tags: [],
    version: 1
  };
}

/** 把索引里已存在但文件缺失的接口补一个空壳（容错） */
export function ensureApiFile(target, targetId) {
  if (target.exists(apiRelPath(targetId))) return readApiFile(target, targetId);
  const item = findApiItem(target, targetId);
  if (!item) return null;
  const doc =
    item.target_type === TARGET_TYPE.FOLDER
      ? buildFolderDoc(target.projectId, { targetId, name: item.name, parentId: item.parent_id, sort: item.sort })
      : buildApiDoc(target.projectId, {
          targetId,
          name: item.name,
          parentId: item.parent_id,
          sort: item.sort,
          method: item.method || 'GET',
          url: item.url || ''
        });
  return writeApiFile(target, targetId, doc, item);
}

export function countApis(target) {
  const items = listApiItems(target);
  return {
    total: items.length,
    api: items.filter((i) => i.target_type === TARGET_TYPE.API).length,
    folder: items.filter((i) => i.target_type === TARGET_TYPE.FOLDER).length,
    doc: items.filter((i) => i.target_type === TARGET_TYPE.DOC).length,
    sse: items.filter((i) => i.target_type === TARGET_TYPE.SSE).length
  };
}

export function buildApiTree(target) {
  const items = listApiItems(target);
  const byParent = new Map();
  for (const item of items) {
    const pid = item.parent_id || '0';
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(item);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  const build = (pid, depth) => {
    const nodes = byParent.get(pid) || [];
    return nodes.map((item) => ({
      ...shapeIndexItem(item),
      depth,
      children: item.target_type === TARGET_TYPE.FOLDER ? build(item.target_id, depth + 1) : []
    }));
  };
  return build('0', 0);
}

export function collectDescendantApiIds(target, folderId) {
  const items = listApiItems(target);
  const ids = descendants(items, folderId);
  return items.filter((i) => ids.has(i.target_id) && i.target_type === TARGET_TYPE.API).map((i) => i.target_id);
}

export function apiFileExists(target, targetId) {
  return target.exists(apiRelPath(targetId));
}

export function ensureApisDir(target) {
  target.ensureDir('project/apis');
  if (!target.exists(API_INDEX_REL)) {
    writeApiIndex(target, { project_id: target.projectId, items: [] });
  }
  if (!isDir(target.abs('project/apis'))) {
    ensureDir(target.abs('project/apis'));
    if (!exists(target.abs(API_INDEX_REL))) {
      writeFileAtomic(target.abs(API_INDEX_REL), JSON.stringify({ project_id: target.projectId, items: [] }, null, 2));
    }
  }
  return true;
}
