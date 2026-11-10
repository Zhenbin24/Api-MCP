import path from 'node:path';
import fs from 'node:fs';
import {
  ensureDir,
  exists,
  isDir,
  readJson,
  removeDir,
  sha256,
  writeJsonAtomic
} from '../util/fsx.js';
import { hexId } from '../util/ids.js';
import {
  dataDir,
  envFilePath,
  envsDir,
  envsIndexPath,
  globalParamsPath,
  localDir,
  localMetaPath,
  localProjectDir,
  localTeamsPath,
  projectDir,
  projectMetaPath,
  projectsIndexPath,
  apisDir,
  apisIndexPath,
  settingsDir,
  globalVarsPath,
  executionsDir,
  flowsDir,
  runsDir,
  officialMtime
} from './paths.js';

export const DEFAULT_GLOBAL_PARAMS = {
  auth: {
    asap: { alg: '', aud: '', claims: '', exp: '', iss: '', kid: '', privateKey: '', sub: '' },
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
      addTokenTo: '',
      algorithm: '',
      header: '',
      headerPrefix: '',
      isSecretBase64Encoded: false,
      payload: '',
      queryParamKey: '',
      secret: ''
    },
    kv: { in: '', key: '', value: '' },
    ntlm: { disableRetryRequest: false, entity: '', password: '', username: '', workstation: '' },
    oauth1: {
      addEmptyParamsToSign: false,
      addParamsToHeader: false,
      callback: '',
      consumerKey: '',
      consumerSecret: '',
      disableHeaderEncoding: false,
      includeBodyHash: false,
      nonce: '',
      realm: '',
      signatureMethod: '',
      timestamp: '',
      token: '',
      tokenSecret: '',
      verifier: '',
      version: ''
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
    type: 'noauth'
  },
  body: { parameter: [] },
  cookie: { parameter: [] },
  header: { parameter: [] },
  post_tasks: [],
  pre_tasks: [],
  query: { parameter: [] }
};

export const DEFAULT_MARKS = [
  { color: '#2857FF', is_default_mark: 1, is_sys_default: 1, mark_id: '1', name: '开发中' },
  { color: '#26CEA4', is_default_mark: -1, is_sys_default: 1, mark_id: '2', name: '已完成' },
  { color: '#FFC01E', is_default_mark: -1, is_sys_default: 1, mark_id: '3', name: '需修改' },
  { color: '#FF2200', is_default_mark: -1, is_sys_default: 1, mark_id: '4', name: '已废弃' }
];

export function listProjects(root) {
  const index = readJson(projectsIndexPath(root), []);
  if (!Array.isArray(index)) return [];
  return index
    .filter((item) => item && item.project_id)
    .map((item) => {
      const meta = readJson(projectMetaPath(root, item.project_id), null);
      return {
        project_id: item.project_id,
        name: meta?.name || item.name || item.project_id,
        intro: meta?.intro || '',
        path: item.path || projectDir(root, item.project_id),
        team_id: meta?.team_id || '',
        created_at: item.created_at || meta?.created_at || '',
        updated_at: meta?.updated_at || item.created_at || ''
      };
    });
}

export function getProject(root, projectId) {
  const projects = listProjects(root);
  return projects.find((p) => p.project_id === projectId) || null;
}

export function assertProject(root, projectId) {
  if (!projectId) throw new Error('缺少 project_id');
  const project = getProject(root, projectId);
  if (!project) {
    throw new Error(`项目不存在或未登记：${projectId}。请先用 apipost_list_projects 查询可用项目。`);
  }
  return project;
}

export function readProjectMeta(root, projectId) {
  return readJson(projectMetaPath(root, projectId), null);
}

export function listTeams(root) {
  const teams = readJson(localTeamsPath(root), []);
  return Array.isArray(teams) ? teams : [];
}

export function readLocalMeta(root) {
  return readJson(localMetaPath(root), null);
}

function writeProjectsIndex(root, index) {
  writeJsonAtomic(projectsIndexPath(root), index);
}

export function createProject(root, { name, intro = '', storagePath = null } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('缺少项目名称 name');
  if (trimmed.length > 64) throw new Error('项目名称不能超过 64 个字符');
  if (String(intro || '').length > 1024) throw new Error('项目描述不能超过 1024 个字符');

  if (!isDir(root)) throw new Error(`Apipost 单机版数据目录不存在：${root}`);

  const existingIds = new Set(listProjects(root).map((p) => p.project_id));
  const projectId = hexId(existingIds);
  const now = new Date().toISOString();

  let parentDir;
  if (storagePath) {
    const resolved = path.resolve(String(storagePath));
    if (!exists(resolved) || !isDir(resolved)) {
      throw new Error(`storage_path 不是已存在的目录：${resolved}`);
    }
    parentDir = resolved;
  } else {
    parentDir = dataDir(root);
  }
  ensureDir(parentDir);
  const dir = path.join(parentDir, projectId);
  if (exists(dir)) throw new Error(`目标目录已存在，拒绝覆盖：${dir}`);

  const localMeta = readLocalMeta(root) || {};
  const teams = listTeams(root);
  const teamId = localMeta.default_team_id || teams[0]?.team_id || hexId(new Set());

  const skeleton = buildProjectSkeleton({ projectId, teamId, name: trimmed, intro, now });
  writeSkeleton(dir, skeleton);

  // 登记到官方索引
  const index = readJson(projectsIndexPath(root), []);
  const list = Array.isArray(index) ? index : [];
  list.push({ project_id: projectId, path: dir, created_at: now });
  writeProjectsIndex(root, list);

  return {
    project_id: projectId,
    name: trimmed,
    intro,
    path: dir,
    team_id: teamId,
    created_at: now
  };
}

function buildProjectSkeleton({ projectId, teamId, name, intro, now }) {
  return {
    'project.json': {
      created_at: now,
      intro: intro || '',
      logo: '',
      name,
      project_id: projectId,
      team_id: teamId,
      updated_at: now
    },
    'apis/index.json': { items: [], project_id: projectId },
    'envs/index.json': {
      items: [{ env_id: '1', name: '默认环境', sort: 1000, updated_at: now }],
      project_id: projectId
    },
    'envs/1.json': {
      created_at: now,
      env_id: '1',
      env_var_list: {},
      is_private: -1,
      name: '默认环境',
      project_id: projectId,
      server_list: [{ name: 'default', server_id: '1', sort: 1000, uri: '' }],
      sort: 1000,
      updated_at: now
    },
    'global_vars.json': {},
    'global_params.json': structuredClone(DEFAULT_GLOBAL_PARAMS),
    'settings/marks.json': DEFAULT_MARKS.map((m) => ({ ...m, project_id: projectId })),
    'settings/mock_inner_rules.json': { project_id: projectId, rules: [] },
    'executions/flows/index.json': { version: 2, updated_at: now, records: [] },
    'executions/runs/index.json': { version: 2, updated_at: now, records: [] }
  };
}

function writeSkeleton(dir, files) {
  ensureDir(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel.split('/').join(path.sep));
    writeJsonAtomic(abs, content);
  }
}

export function projectDirs(root, projectId) {
  const dir = projectDir(root, projectId);
  return {
    root: dir,
    apis: apisDir(root, projectId),
    envs: envsDir(root, projectId),
    settings: settingsDir(root, projectId),
    executions: executionsDir(root, projectId),
    flows: flowsDir(root, projectId),
    runs: runsDir(root, projectId),
    local: localProjectDir(root, projectId)
  };
}

export function ensureProjectDirs(root, projectId) {
  const dirs = projectDirs(root, projectId);
  for (const d of Object.values(dirs)) ensureDir(d);
  return dirs;
}

export function deleteProjectDir(root, projectId) {
  if (!/^[\w-]{1,64}$/.test(String(projectId || ''))) throw new Error('非法 project_id');
  const dir = projectDir(root, projectId);
  if (!exists(dir)) return false;
  removeDir(dir);

  const index = readJson(projectsIndexPath(root), []);
  const list = Array.isArray(index) ? index.filter((p) => p.project_id !== projectId) : [];
  writeProjectsIndex(root, list);
  removeDir(localProjectDir(root, projectId));
  return true;
}

/** 项目指纹：用于判断官方数据是否被外部改动 */
export function projectFingerprint(root, projectId) {
  const dir = projectDir(root, projectId);
  if (!isDir(dir)) return null;
  const parts = [projectId, String(officialMtime(root))];
  try {
    const st = fs.statSync(projectMetaPath(root, projectId));
    parts.push(String(st.mtimeMs));
  } catch {}
  return sha256(parts.join('|'));
}

export function readGlobalParams(root, projectId) {
  const params = readJson(globalParamsPath(root, projectId), null);
  return params || structuredClone(DEFAULT_GLOBAL_PARAMS);
}

export function writeGlobalParams(root, projectId, params) {
  writeJsonAtomic(globalParamsPath(root, projectId), params);
  return params;
}

export function ensureGlobalVars(root, projectId) {
  const file = globalVarsPath(root, projectId);
  if (!exists(file)) writeJsonAtomic(file, {});
  return readJson(file, {});
}

export function readMarks(root, projectId) {
  return readJson(path.join(settingsDir(root, projectId), 'marks.json'), DEFAULT_MARKS) || DEFAULT_MARKS;
}

export function localDirExists(root) {
  return isDir(localDir(root));
}

export function officialProjectPath(root, projectId) {
  return projectDir(root, projectId);
}
