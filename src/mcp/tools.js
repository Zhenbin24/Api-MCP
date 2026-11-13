import fs from 'node:fs';
import path from 'node:path';
import { openProject } from '../store/target.js';
import {
  listProjects as storeListProjects,
  getProject,
  assertProject,
  createProject as storeCreateProject,
  deleteProjectDir
} from '../store/projects.js';
import {
  listApis,
  ensureApiFile,
  deleteApis,
  findApiItem,
  buildApiTree,
  TARGET_TYPE
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
  sharedServers,
  readCurrentEnvId,
  writeCurrentEnvId
} from '../store/envs.js';
import { createFlow, updateFlow, listFlows, getFlow, deleteFlow, assertFlow, buildStep } from '../store/flows.js';
import { listRuns, getRun, assertRun } from '../store/runs.js';
import { readGlobalParams, writeGlobalParams } from '../store/globals.js';
import { parseOpenApi } from '../openapi/convert.js';
import { applyImportItems, buildScriptMap, normalizeCoverMode, assertFolderId } from '../io/apply.js';
import { importIntoProject } from '../io/import.js';
import { exportProject } from '../io/export.js';
import { runApi, runFlow } from '../exec/runner.js';

/** 工具执行上下文 */
export class ToolContext {
  constructor({ dataRoot, config }) {
    this.dataRoot = dataRoot;
    this.config = config || {};
  }

  target(projectId) {
    return openProject({ dataRoot: this.dataRoot, projectId });
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
    assertProject(this.dataRoot, projectId);
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

export function apimcp_list_projects(ctx) {
  ctx.assertEnabled();
  const allowed = ctx.allowedProjects();
  const projects = storeListProjects(ctx.dataRoot).filter(
    (p) => !allowed || allowed.length === 0 || allowed.includes(p.project_id)
  );
  return {
    projects: projects.map((p) => ({ ...p })),
    data_root: ctx.dataRoot
  };
}

export function apimcp_create_project(ctx, args) {
  ctx.assertWritableNoProject();
  const created = storeCreateProject(ctx.dataRoot, {
    name: args.name,
    intro: args.description,
    storagePath: args.storage_path
  });

  const allowed = ctx.config.allowed_project_ids;
  if (Array.isArray(allowed) && !allowed.includes(created.project_id)) {
    allowed.push(created.project_id);
  }

  return {
    ...created,
    message: `项目「${created.name}」已创建并加入 MCP 授权，可以继续同步接口或创建执行计划。`
  };
}

/* ------------------------- API ------------------------- */

export function apimcp_list_apis(ctx, args) {
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

export function apimcp_get_api_detail(ctx, args) {
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
        : `该对象类型是 ${item.target_type}，只能读取详情；apimcp_execute_api 仅支持 HTTP 接口。`
  };
}

export function apimcp_delete_apis(ctx, args) {
  if (args.confirm !== true) throw new Error('删除接口必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  const ids = Array.isArray(args.target_ids) ? args.target_ids : [];
  if (ids.length === 0) throw new Error('缺少 target_ids');
  const result = deleteApis(target, ids);
  return { ...result, deleted_count: result.deleted_ids.length };
}

export function apimcp_sync_openapi(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const coverMode = normalizeCoverMode(args.api_cover_mode);
  const folderId = assertFolderId(target, args.folder_id);

  const parsed = parseOpenApi(args.openapi, {
    basePath: Boolean(args.base_path),
    hostPath: Boolean(args.host_path)
  });
  if (parsed.items.length === 0) throw new Error('OpenAPI 中没有可导入的接口');

  const results = applyImportItems(target, {
    projectId: args.project_id,
    items: parsed.items,
    folderId,
    coverMode,
    scriptMap: buildScriptMap(args.api_scripts)
  });

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

export async function apimcp_execute_api(ctx, args) {
  ctx.assertExecutable(args.project_id);
  const preferred = ctx.config.preferred_env?.[args.project_id];
  return runApi({
    dataRoot: ctx.dataRoot,
    projectId: args.project_id,
    targetId: args.target_id,
    input: args.input || {},
    envId: args.environment_id,
    preferredEnvId: preferred,
    source: 'mcp'
  });
}

export async function apimcp_execute_flow(ctx, args) {
  ctx.assertExecutable(args.project_id);
  const preferred = ctx.config.preferred_env?.[args.project_id];
  return runFlow({
    dataRoot: ctx.dataRoot,
    projectId: args.project_id,
    flowId: args.flow_id,
    envId: args.environment_id,
    preferredEnvId: preferred,
    source: 'mcp'
  });
}

/* ------------------------- 环境 ------------------------- */

export function apimcp_list_environments(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const envs = listEnvironments(target);
  const preferred = ctx.config.preferred_env?.[args.project_id];
  const remembered = readCurrentEnvId(target);
  const current =
    envs.find((e) => e.env_id === remembered) ||
    envs.find((e) => e.env_id === preferred) ||
    envs.find((e) => String(e.env_id) === '1') ||
    envs[0];
  return {
    project_id: args.project_id,
    current_env_id: current?.env_id || '',
    environments: envs.map((e) => shapeEnv(e, current?.env_id))
  };
}

export function apimcp_switch_environment(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const env = assertEnv(target, args.environment_id);
  writeCurrentEnvId(target, env.env_id);
  // 同步到配置文件，便于 stdio 端参考
  ctx.config.preferred_env = { ...(ctx.config.preferred_env || {}), [args.project_id]: env.env_id };
  return {
    project_id: args.project_id,
    current_env_id: env.env_id,
    name: env.name || env.env_id,
    note: '已记录为该项目当前环境，后续执行（含 AI 调用）默认使用该环境，直到再次切换。'
  };
}

export function apimcp_create_environment(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const env = createEnvironment(target, { name: args.name, baseUrl: args.base_url });
  return {
    environment: shapeEnv(env, env.env_id),
    env_id: env.env_id,
    switch_prompt: `环境「${env.name}」已创建，是否切换为当前环境？`
  };
}

export function apimcp_update_environment(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const env = updateEnvironment(target, args.environment_id, {
    name: args.name,
    baseUrl: args.base_url
  });
  return { environment: shapeEnv(env, env.env_id) };
}

export function apimcp_delete_environment(ctx, args) {
  if (args.confirm !== true) throw new Error('删除环境必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteEnvironment(target, args.environment_id);
}

export function apimcp_list_environment_servers(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  return { project_id: args.project_id, ...listEnvironmentServers(target, args.environment_id) };
}

export function apimcp_create_environment_server(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const created = createEnvironmentServer(target, {
    name: args.name,
    envId: args.environment_id,
    baseUrl: args.base_url
  });
  return { server: created };
}

export function apimcp_update_environment_server(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const updated = updateEnvironmentServer(target, {
    serverId: args.server_id,
    name: args.name,
    envId: args.environment_id,
    baseUrl: args.base_url
  });
  return { server: updated };
}

export function apimcp_delete_environment_server(ctx, args) {
  if (args.confirm !== true) throw new Error('删除服务必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteEnvironmentServer(target, args.server_id);
}

/* ------------------------- 变量 ------------------------- */

export function apimcp_get_environment_variables(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  return { project_id: args.project_id, ...getEnvironmentVariables(target, args.environment_id) };
}

export function apimcp_upsert_environment_variable(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  return upsertEnvVariable(target, {
    envId: args.environment_id,
    key: args.key,
    value: args.value,
    currentValue: args.current_value,
    description: args.description
  });
}

export function apimcp_delete_environment_variable(ctx, args) {
  if (args.confirm !== true) throw new Error('删除环境变量必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteEnvVariable(target, { envId: args.environment_id, key: args.key });
}

export function apimcp_get_global_variables(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  return { project_id: args.project_id, ...getGlobalVariables(target) };
}
export function apimcp_upsert_global_variable(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  return upsertGlobalVariable(target, {
    key: args.key,
    value: args.value,
    currentValue: args.current_value,
    description: args.description
  });
}

export function apimcp_delete_global_variable(ctx, args) {
  if (args.confirm !== true) throw new Error('删除全局变量必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteGlobalVariable(target, { key: args.key });
}

/* ------------------------- 全局参数 ------------------------- */

export function apimcp_get_global_params(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  return {
    project_id: args.project_id,
    params: readGlobalParams(target),
    note: '全局参数对项目下所有接口生效；接口自身同名参数优先，目录参数介于两者之间。全局 Body 仅支持 none / form-data / urlencoded。'
  };
}

export function apimcp_update_global_params(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  const patch = {};
  for (const key of ['header', 'query', 'cookie', 'body', 'auth', 'pre_tasks', 'post_tasks']) {
    if (key in args) patch[key] = args[key];
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('没有可更新的内容：请至少传入 header / query / cookie / body / auth / pre_tasks / post_tasks 之一');
  }
  const params = writeGlobalParams(target, patch);
  return {
    project_id: args.project_id,
    params,
    updated_sections: Object.keys(patch),
    note: '全局参数已保存到项目数据目录。'
  };
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

export function apimcp_create_execution_flow(ctx, args) {
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

export function apimcp_update_execution_flow(ctx, args) {
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

export function apimcp_list_execution_flows(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  return { project_id: args.project_id, flows: listFlows(target) };
}

export function apimcp_get_execution_flow(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const flow = assertFlow(target, args.flow_id);
  return { project_id: args.project_id, flow };
}

export function apimcp_delete_execution_flow(ctx, args) {
  if (args.confirm !== true) throw new Error('删除执行计划必须显式传入 confirm: true');
  const target = ctx.assertWritable(args.project_id);
  return deleteFlow(target, args.flow_id);
}

export function apimcp_list_execution_runs(ctx, args) {
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

export function apimcp_get_execution_result(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const run = assertRun(target, args.run_id);
  return { project_id: args.project_id, run };
}

/* ------------------------- 导入 / 导出 ------------------------- */

export function apimcp_import_project(ctx, args) {
  const target = ctx.assertWritable(args.project_id);
  if (!args.payload) throw new Error('缺少 payload：请传入待导入的文档内容');
  return importIntoProject(target, {
    projectId: args.project_id,
    format: args.format || 'auto',
    payload: args.payload,
    folderId: args.folder_id || '0',
    coverMode: args.api_cover_mode || 'url_and_folder',
    basePath: Boolean(args.base_path)
  });
}

export function apimcp_export_project(ctx, args) {
  const target = ctx.assertAllowed(args.project_id);
  const result = exportProject(target, {
    projectId: args.project_id,
    format: args.format || 'openapi'
  });
  return {
    project_id: args.project_id,
    format: result.format,
    filename: result.filename,
    mime: result.mime,
    content: result.content
  };
}

/* ------------------------- 分发 ------------------------- */

const HANDLERS = {
  apimcp_list_projects,
  apimcp_create_project,
  apimcp_list_apis,
  apimcp_get_api_detail,
  apimcp_sync_openapi,
  apimcp_delete_apis,
  apimcp_execute_api,
  apimcp_list_environments,
  apimcp_switch_environment,
  apimcp_create_environment,
  apimcp_update_environment,
  apimcp_delete_environment,
  apimcp_list_environment_servers,
  apimcp_create_environment_server,
  apimcp_update_environment_server,
  apimcp_delete_environment_server,
  apimcp_get_environment_variables,
  apimcp_upsert_environment_variable,
  apimcp_delete_environment_variable,
  apimcp_get_global_variables,
  apimcp_upsert_global_variable,
  apimcp_delete_global_variable,
  apimcp_get_global_params,
  apimcp_update_global_params,
  apimcp_create_execution_flow,
  apimcp_update_execution_flow,
  apimcp_list_execution_flows,
  apimcp_get_execution_flow,
  apimcp_delete_execution_flow,
  apimcp_execute_flow,
  apimcp_list_execution_runs,
  apimcp_get_execution_result,
  apimcp_import_project,
  apimcp_export_project
};

export const HANDLER_NAMES = Object.keys(HANDLERS);

export async function callTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`未知工具：${name}`);
  return handler(ctx, args || {});
}
