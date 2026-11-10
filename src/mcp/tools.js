import fs from 'node:fs';
import path from 'node:path';
import { openShadow } from '../store/shadow.js';
import {
  listProjects as storeListProjects,
  getProject,
  assertProject,
  createProject as storeCreateProject,
  deleteProjectDir
} from '../store/projects.js';
import {
  listApis,
  listApiItems,
  readApiFile,
  ensureApiFile,
  createApiOrFolder,
  deleteApis,
  findApiItem,
  readApiIndex,
  writeApiIndex,
  writeApiFile,
  buildApiTree,
  collectDescendantApiIds,
  TARGET_TYPE,
  buildEmptyAuth,
  buildBlankBody
} from '../store/apis.js';
import {
  listEnvironments,
  shapeEnv,
  createEnvironment,
  updateEnvironment,
  deleteEnvironment,
  assertEnv,
  createEnvironmentServer,
  updateEnvironmentServer,
  deleteEnvironmentServer,
  listEnvironmentServers,
  getEnvironmentVariables,
  upsertEnvVariable,
  deleteEnvVariable,
  getGlobalVariables,
  upsertGlobalVariable,
  deleteGlobalVariable,
  sharedServers
} from '../store/envs.js';
import { createFlow, updateFlow, listFlows, getFlow, deleteFlow, assertFlow, buildStep } from '../store/flows.js';
import { listRuns, getRun, assertRun } from '../store/runs.js';
import { pullProject, pushProject, diffProject, SYNC_STATE, isPulled } from '../sync/index.js';
import { parseOpenApi } from '../openapi/convert.js';
import { runApi, runFlow } from '../exec/runner.js';
import { hexId } from '../util/ids.js';

/** 工具执行上下文 */
export class ToolContext {
  constructor({ officialRoot, shadowRoot, config }) {
    this.officialRoot = officialRoot;
    this.shadowRoot = shadowRoot;
    this.config = config || {};
  }

  target(projectId) {
    return openShadow({ shadowRoot: this.shadowRoot, projectId });
  }

  allowedProjects() {
    return Array.isArray(this.config.allowed_project_ids) ? this.config.allowed_project_ids : null;
  }

  /** 服务总开关：enabled === false 时任何调用都应被拒绝（HTTP 与 stdio 一致） */
  assertEnabled() {
    if (this.config.enabled === false) {
      throw new Error('MCP 服务已停用。请在 MCP 控制台的「总览」中开启服务后重试。');
    }
    return true;
  }

  assertAllowed(projectId) {
    this.assertEnabled();
    const allowed = this.allowedProjects();
    if (allowed && allowed.length > 0 && !allowed.includes(projectId)) {
      throw new Error(`项目未授权访问：${projectId}。请在 MCP 控制台勾选该项目。`);
    }
    assertProject(this.officialRoot, projectId);
    if (!isPulled(this.shadowRoot, projectId)) {
      pullProject(this.officialRoot, this.shadowRoot, projectId, { force: true });
    }
    return this.target(projectId);
  }

  /**
   * 写操作守卫：在授权校验之上再检查「允许写入项目」。
   * 覆盖接口、环境、变量、执行计划定义的增删改。
   */
  assertWritable(projectId) {
    const target = this.assertAllowed(projectId);
    if (this.config.allow_write === false) {
      throw new Error(
        '当前为只读模式，拒绝写入。请在 MCP 控制台的「接入配置」中开启「允许写入项目」后重试。'
      );
    }
    return target;
  }

  /**
   * 执行守卫：单独受「允许执行」控制，与写入权限解耦。
   * 执行不改项目定义，只产生一次请求与一条运行记录。
   */
  assertExecutable(projectId) {
    const target = this.assertAllowed(projectId);
    if (this.config.allow_execute === false) {
      throw new Error(
        '接口执行已关闭。请在 MCP 控制台的「接入配置」中开启「允许执行接口」后重试。'
      );
    }
    return target;
  }

  /** 不需要具体项目的写操作（如 create_project）也要过服务开关与写入权限 */
  assertWritableNoProject() {
    this.assertEnabled();
    if (this.config.allow_write === false) {
      throw new Error(
        '当前为只读模式，拒绝写入。请在 MCP 控制台的「接入配置」中开启「允许写入项目」后重试。'
      );
    }
    return true;
  }
}

/* ------------------------- 项目 ------------------------- */

function syncStatusOf(ctx, projectId) {
  try {
    if (!isPulled(ctx.shadowRoot, projectId)) return { state: SYNC_STATE.NOT_PULLED, changed_files: 0 };
    const diff = diffProject(ctx.officialRoot, ctx.shadowRoot, projectId);
    return { state: diff.state, changed_files: diff.entries.length };
  } catch {
    return { state: 'unknown', changed_files: 0 };
  }
}

export function apipost_list_projects(ctx) {
  ctx.assertEnabled();
  const allowed = ctx.allowedProjects();
  const projects = storeListProjects(ctx.officialRoot).filter(
    (p) => !allowed || allowed.length === 0 || allowed.includes(p.project_id)
  );
  return {
    projects: projects.map((p) => ({
      ...p,
      sync: syncStatusOf(ctx, p.project_id)
    })),
    data_root: ctx.officialRoot,
    shadow_root: ctx.shadowRoot
  };
}

export function apipost_create_project(ctx, args) {
  ctx.assertWritableNoProject();
  const created = storeCreateProject(ctx.officialRoot, {
    name: args.name,
    intro: args.description,
    storagePath: args.storage_path
  });

  // 新项目目录不存在覆盖风险，随后立即拉取影子
  pullProject(ctx.officialRoot, ctx.shadowRoot, created.project_id, { force: true });

  const allowed = ctx.config.allowed_project_ids;
  if (Array.isArray(allowed) && !allowed.includes(created.project_id)) {
    allowed.push(created.project_id);
  }

  return {
    ...created,
    pulled: true,
    message: `项目「${created.name}」已创建并加入 MCP 授权，可以继续同步接口或创建执行计划。`
  };
}

/* ------------------------- API ------------------------- */

export function apipost_list_apis(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const items = listApis(target, { parentId: args.parent_id, keyword: args.keyword });
  return {
    project_id: args.project_id,
    total: items.length,
    items,
    tree: args.parent_id || args.keyword ? undefined : buildApiTree(target).map(stripChildren)
  };
}

function stripChildren(node) {
  return {
    target_id: node.target_id,
    target_type: node.target_type,
    name: node.name,
    method: node.method,
    url: node.url,
    parent_id: node.parent_id,
    children: (node.children || []).map(stripChildren)
  };
}

export function apipost_get_api_detail(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const item = findApiItem(target, args.target_id);
  if (!item) throw new Error(`接口不存在：${args.target_id}`);
  const file = ensureApiFile(target, args.target_id);
  if (!file) throw new Error(`接口定义文件缺失：${args.target_id}`);

  const data = file.data || {};
  const builtinPre = (data.request?.pre_tasks || []).map((t) => t?.data).filter(Boolean);
  const builtinPost = (data.request?.post_tasks || []).map((t) => t?.data).filter(Boolean);

  return {
    project_id: args.project_id,
    target_id: args.target_id,
    target_type: item.target_type,
    index: {
      name: item.name,
      method: item.method,
      url: item.url,
      parent_id: item.parent_id,
      sort: item.sort,
      mark_id: item.mark_id
    },
    detail: data,
    builtin_pre_scripts: builtinPre,
    builtin_post_scripts: builtinPost,
    note:
      item.target_type === TARGET_TYPE.API
        ? undefined
        : `该对象类型是 ${item.target_type}，只能读取详情；apipost_execute_api 仅支持 HTTP 接口。`
  };
}

export function apipost_delete_apis(ctx, args) {
  if (args.confirm !== true) throw new Error('删除接口必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  const ids = Array.isArray(args.target_ids) ? args.target_ids : [];
  if (ids.length === 0) throw new Error('缺少 target_ids');
  const result = deleteApis(target, ids);
  return { ...result, deleted_count: result.deleted_ids.length };
}

export function apipost_sync_openapi(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const coverMode = args.api_cover_mode || 'url_and_folder';
  const allowedModes = ['url_and_folder', 'url', 'ignore', 'both', 'clear'];
  if (!allowedModes.includes(coverMode)) {
    throw new Error(`api_cover_mode 无效：${coverMode}，可选 ${allowedModes.join('/')}`);
  }

  const folderId = String(args.folder_id || '0');
  if (folderId !== '0') {
    const folder = findApiItem(target, folderId);
    if (!folder || folder.target_type !== TARGET_TYPE.FOLDER) {
      throw new Error('未找到指定的导入目录，请检查 folder_id 是否为项目内目录的 target_id');
    }
  }

  const parsed = parseOpenApi(args.openapi, {
    basePath: Boolean(args.base_path),
    hostPath: Boolean(args.host_path)
  });
  if (parsed.items.length === 0) throw new Error('OpenAPI 中没有可导入的接口');

  // api_scripts: method+url -> scripts
  const scriptMap = new Map();
  for (const item of args.api_scripts || []) {
    if (!item || typeof item !== 'object') continue;
    const method = String(item.method || '').toUpperCase();
    const url = String(item.url || '');
    if (!method || !url) continue;
    scriptMap.set(`${method}_${url}`, item);
  }

  const index = readApiIndex(target);
  const now = new Date().toISOString();

  // 覆盖模式：clear 需要先清空目标目录
  if (coverMode === 'clear') {
    const toDelete = folderId === '0' ? index.items.map((i) => i.target_id) : collectDescendantApiIds(target, folderId);
    if (folderId !== '0') {
      // 目录本身保留，清空其子项
      const children = index.items.filter((i) => i.parent_id === folderId).map((i) => i.target_id);
      toDelete.push(...children);
    }
    deleteApis(target, toDelete);
    // 重新读取索引
    const fresh = readApiIndex(target);
    index.items = fresh.items;
  }

  const folderCache = new Map();

  const ensureFolderPath = (names) => {
    if (!names || names.length === 0) return folderId;
    let parentId = folderId;
    for (const name of names) {
      const key = `${parentId}/${name}`;
      if (folderCache.has(key)) {
        parentId = folderCache.get(key);
        continue;
      }
      let existing = index.items.find(
        (i) => i.target_type === TARGET_TYPE.FOLDER && i.parent_id === parentId && i.name === name
      );
      if (!existing) {
        const created = createApiOrFolder(target, { name, parentId, targetType: TARGET_TYPE.FOLDER });
        const refreshed = readApiIndex(target);
        index.items = refreshed.items;
        existing = index.items.find((i) => i.target_id === created.target_id);
      }
      folderCache.set(key, existing.target_id);
      parentId = existing.target_id;
    }
    return parentId;
  };

  const results = { created: [], updated: [], skipped: [], deleted: [] };

  for (const item of parsed.items) {
    const parentId = ensureFolderPath(item.folderPath);
    const method = item.method;
    const url = item.url;

    const sameUrlAndFolder = index.items.find(
      (i) =>
        i.target_type === TARGET_TYPE.API &&
        String(i.method || '').toUpperCase() === method &&
        i.url === url &&
        i.parent_id === parentId
    );
    const sameUrl = index.items.find(
      (i) => i.target_type === TARGET_TYPE.API && String(i.method || '').toUpperCase() === method && i.url === url
    );

    const scripts = scriptMap.get(`${method}_${url}`) || scriptMap.get(`${method}_${item.url}`);
    const preTask = scripts?.pre_script
      ? { name: '', type: 'customScript', data: String(scripts.pre_script), enabled: 1, id: `${Date.now()}p` }
      : null;
    const postTask = scripts?.post_script
      ? { name: '', type: 'customScript', data: String(scripts.post_script), enabled: 1, id: `${Date.now()}q` }
      : null;

    const buildDetail = (targetId, existingData) => ({
      ...(existingData || {}),
      attribute_info: existingData?.attribute_info || {},
      description: item.description || existingData?.description || '',
      is_locked: -1,
      mark_id: existingData?.mark_id || '1',
      method,
      name: item.name,
      parent_id: parentId,
      project_id: args.project_id,
      protocol: 'http/1.1',
      request: {
        auth: existingData?.request?.auth || buildEmptyAuth(),
        body: item.request.body || buildBlankBody(),
        cookie: item.request.cookie,
        header: item.request.header,
        post_tasks: postTask
          ? [...(existingData?.request?.post_tasks || []).filter((t) => t?.id !== postTask.id), postTask]
          : existingData?.request?.post_tasks || [],
        pre_tasks: preTask
          ? [...(existingData?.request?.pre_tasks || []).filter((t) => t?.id !== preTask.id), preTask]
          : existingData?.request?.pre_tasks || [],
        query: item.request.query,
        restful: item.request.restful
      },
      response: item.response,
      sort: existingData?.sort ?? 1000,
      status: 1,
      tags: item.tags,
      target_id: targetId,
      target_type: TARGET_TYPE.API,
      url,
      version: (existingData?.version || 1) + 1
    });

    if (coverMode === 'ignore') {
      if (sameUrl) {
        results.skipped.push({ method, url, reason: '已存在相同方法和 URL' });
        continue;
      }
    } else if (coverMode === 'url_and_folder') {
      if (sameUrlAndFolder) {
        const existingFile = readApiFile(target, sameUrlAndFolder.target_id);
        writeApiFile(target, sameUrlAndFolder.target_id, buildDetail(sameUrlAndFolder.target_id, existingFile?.data), {
          ...sameUrlAndFolder,
          name: item.name,
          updated_at: now
        });
        index.items = readApiIndex(target).items;
        results.updated.push({ target_id: sameUrlAndFolder.target_id, method, url });
        continue;
      }
    } else if (coverMode === 'url') {
      if (sameUrl) {
        const existingFile = readApiFile(target, sameUrl.target_id);
        writeApiFile(target, sameUrl.target_id, buildDetail(sameUrl.target_id, existingFile?.data), {
          ...sameUrl,
          name: item.name,
          updated_at: now
        });
        index.items = readApiIndex(target).items;
        results.updated.push({ target_id: sameUrl.target_id, method, url });
        continue;
      }
    }
    // both / clear / 未命中 -> 新建

    const created = createApiOrFolder(target, {
      name: item.name,
      parentId,
      targetType: TARGET_TYPE.API,
      method,
      url,
      detail: {
        ...item,
        request: {
          ...item.request,
          pre_tasks: preTask ? [preTask] : [],
          post_tasks: postTask ? [postTask] : []
        }
      }
    });
    index.items = readApiIndex(target).items;
    results.created.push({ target_id: created.target_id, method, url });
  }

  return {
    project_id: args.project_id,
    cover_mode: coverMode,
    folder_id: folderId,
    summary: {
      created: results.created.length,
      updated: results.updated.length,
      skipped: results.skipped.length
    },
    created: results.created,
    updated: results.updated,
    skipped: results.skipped,
    models: Object.keys(parsed.schemas)
  };
}

/* ------------------------- 执行 ------------------------- */

export async function apipost_execute_api(ctx, args) {
  ctx.assertExecutable(args.project_id);
  const preferred = ctx.config.preferred_env?.[args.project_id];
  return runApi({
    shadowRoot: ctx.shadowRoot,
    projectId: args.project_id,
    targetId: args.target_id,
    input: args.input || {},
    envId: args.environment_id,
    preferredEnvId: preferred,
    source: 'mcp'
  });
}

export async function apipost_execute_flow(ctx, args) {
  ctx.assertExecutable(args.project_id);
  const preferred = ctx.config.preferred_env?.[args.project_id];
  return runFlow({
    shadowRoot: ctx.shadowRoot,
    projectId: args.project_id,
    flowId: args.flow_id,
    envId: args.environment_id,
    preferredEnvId: preferred,
    source: 'mcp'
  });
}

/* ------------------------- 环境 ------------------------- */

export function apipost_list_environments(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const envs = listEnvironments(target);
  const preferred = ctx.config.preferred_env?.[args.project_id];
  const current =
    envs.find((e) => e.env_id === preferred) || envs.find((e) => String(e.env_id) === '1') || envs[0];
  return {
    project_id: args.project_id,
    current_env_id: current?.env_id || '',
    environments: envs.map((e) => shapeEnv(e, current?.env_id))
  };
}

export function apipost_switch_environment(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const env = assertEnv(target, args.environment_id);
  return {
    project_id: args.project_id,
    current_env_id: env.env_id,
    name: env.name || env.env_id,
    note: '已记录为该项目下次执行使用的默认环境。'
  };
}

export function apipost_create_environment(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const env = createEnvironment(target, { name: args.name, baseUrl: args.base_url });
  return {
    environment: shapeEnv(env, env.env_id),
    env_id: env.env_id,
    switch_prompt: `环境「${env.name}」已创建，是否切换为当前环境？`
  };
}

export function apipost_update_environment(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const env = updateEnvironment(target, args.environment_id, {
    name: args.name,
    baseUrl: args.base_url
  });
  return { environment: shapeEnv(env, env.env_id) };
}

export function apipost_delete_environment(ctx, args) {
  if (args.confirm !== true) throw new Error('删除环境必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteEnvironment(target, args.environment_id);
}

export function apipost_list_environment_servers(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  return { project_id: args.project_id, ...listEnvironmentServers(target, args.environment_id) };
}

export function apipost_create_environment_server(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const created = createEnvironmentServer(target, {
    name: args.name,
    envId: args.environment_id,
    baseUrl: args.base_url
  });
  return { server: created };
}

export function apipost_update_environment_server(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const updated = updateEnvironmentServer(target, {
    serverId: args.server_id,
    name: args.name,
    envId: args.environment_id,
    baseUrl: args.base_url
  });
  return { server: updated };
}

export function apipost_delete_environment_server(ctx, args) {
  if (args.confirm !== true) throw new Error('删除服务必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteEnvironmentServer(target, args.server_id);
}

/* ------------------------- 变量 ------------------------- */

export function apipost_get_environment_variables(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  return { project_id: args.project_id, ...getEnvironmentVariables(target, args.environment_id) };
}

export function apipost_upsert_environment_variable(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  return upsertEnvVariable(target, {
    envId: args.environment_id,
    key: args.key,
    value: args.value,
    currentValue: args.current_value,
    description: args.description
  });
}

export function apipost_delete_environment_variable(ctx, args) {
  if (args.confirm !== true) throw new Error('删除环境变量必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteEnvVariable(target, { envId: args.environment_id, key: args.key });
}

export function apipost_get_global_variables(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  return { project_id: args.project_id, ...getGlobalVariables(target) };
}

export function apipost_upsert_global_variable(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  return upsertGlobalVariable(target, {
    key: args.key,
    value: args.value,
    currentValue: args.current_value,
    description: args.description
  });
}

export function apipost_delete_global_variable(ctx, args) {
  if (args.confirm !== true) throw new Error('删除全局变量必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteGlobalVariable(target, { key: args.key });
}

/* ------------------------- 执行计划 ------------------------- */

function buildStepsFromArgs(target, steps, { existingSteps = null } = {}) {
  const out = [];
  const existingMap = new Map((existingSteps || []).map((s) => [s.step_id, s]));

  for (const raw of steps || []) {
    if (!raw || typeof raw !== 'object') continue;
    const targetId = raw.target_id;
    if (!targetId) throw new Error('每个步骤都必须提供 target_id');

    const item = findApiItem(target, targetId);
    if (!item) throw new Error(`接口不存在：${targetId}`);
    if (item.target_type !== TARGET_TYPE.API) {
      throw new Error(`执行计划仅支持 HTTP 接口：${item.name || targetId} 的类型是 ${item.target_type}`);
    }

    const reuseId = raw.step_id && existingMap.has(raw.step_id) ? raw.step_id : null;
    if (reuseId) {
      const existing = existingMap.get(reuseId);
      // 已有步骤沿用快照（官方语义：只有新增接口才固化最新详情）
      out.push({
        ...existing,
        target_id: targetId,
        input: raw.input !== undefined ? structuredClone(raw.input) : existing.input,
        ...(raw.pre_script !== undefined ? { pre_script: String(raw.pre_script) } : {}),
        ...(raw.post_script !== undefined ? { post_script: String(raw.post_script) } : {})
      });
      continue;
    }

    const file = ensureApiFile(target, targetId);
    if (!file?.data) throw new Error(`接口定义文件缺失：${targetId}`);
    out.push(
      buildStep({
        targetId,
        apiSnapshot: file.data,
        input: raw.input || {},
        preScript: raw.pre_script,
        postScript: raw.post_script
      })
    );
  }

  if (out.length === 0) throw new Error('执行计划至少需要一个 HTTP 接口步骤');
  const ids = out.map((s) => s.step_id);
  if (new Set(ids).size !== ids.length) throw new Error('执行计划中存在重复的步骤标识');
  return out;
}

export function apipost_create_execution_flow(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const steps = buildStepsFromArgs(target, args.steps);
  const flow = createFlow(target, {
    name: args.name,
    description: args.description,
    environmentId: args.environment_id,
    steps,
    source: 'mcp'
  });
  return {
    flow_id: flow.flow_id,
    name: flow.name,
    environment_id: flow.environment_id,
    step_count: flow.steps.length,
    message: `执行计划「${flow.name}」已创建，可以执行`
  };
}

export function apipost_update_execution_flow(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const current = assertFlow(target, args.flow_id);
  const steps = args.steps !== undefined ? buildStepsFromArgs(target, args.steps, { existingSteps: current.steps }) : undefined;
  const flow = updateFlow(target, args.flow_id, {
    name: args.name,
    description: args.description,
    ...(args.environment_id !== undefined ? { environmentId: args.environment_id } : {}),
    steps
  });
  return {
    flow_id: flow.flow_id,
    name: flow.name,
    environment_id: flow.environment_id,
    step_count: flow.steps.length,
    message: '执行计划已更新，可以直接执行'
  };
}

export function apipost_list_execution_flows(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  return { project_id: args.project_id, flows: listFlows(target) };
}

export function apipost_get_execution_flow(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const flow = assertFlow(target, args.flow_id);
  return { project_id: args.project_id, flow };
}

export function apipost_delete_execution_flow(ctx, args) {
  if (args.confirm !== true) throw new Error('删除执行计划必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteFlow(target, args.flow_id);
}

export function apipost_list_execution_runs(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const result = listRuns(target, {
    scope: args.scope,
    source: args.source,
    status: args.status,
    flowId: args.flow_id,
    limit: args.limit
  });
  return { project_id: args.project_id, ...result };
}

export function apipost_get_execution_result(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const run = assertRun(target, args.run_id);
  return { project_id: args.project_id, run };
}

/* ------------------------- 分发 ------------------------- */

const HANDLERS = {
  apipost_list_projects,
  apipost_create_project,
  apipost_list_apis,
  apipost_get_api_detail,
  apipost_sync_openapi,
  apipost_delete_apis,
  apipost_execute_api,
  apipost_list_environments,
  apipost_switch_environment,
  apipost_create_environment,
  apipost_update_environment,
  apipost_delete_environment,
  apipost_list_environment_servers,
  apipost_create_environment_server,
  apipost_update_environment_server,
  apipost_delete_environment_server,
  apipost_get_environment_variables,
  apipost_upsert_environment_variable,
  apipost_delete_environment_variable,
  apipost_get_global_variables,
  apipost_upsert_global_variable,
  apipost_delete_global_variable,
  apipost_create_execution_flow,
  apipost_update_execution_flow,
  apipost_list_execution_flows,
  apipost_get_execution_flow,
  apipost_delete_execution_flow,
  apipost_execute_flow,
  apipost_list_execution_runs,
  apipost_get_execution_result
};

export const HANDLER_NAMES = Object.keys(HANDLERS);

export async function callTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`未知工具：${name}`);
  return handler(ctx, args || {});
}
