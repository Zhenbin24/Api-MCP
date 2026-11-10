import { TOOLS, findTool } from './schemas.js';
import { callTool } from './tools.js';

export const PROTOCOL_VERSION = '2024-11-05';
export const SERVER_INFO = { name: 'apipost-offline', version: '1.0.0' };

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function err(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function toolTextResult(payload, isError = false) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

/**
 * 处理一条 JSON-RPC 消息。
 * @returns {Promise<object|null>} 需要回写的响应；通知类返回 null
 */
export async function handleMessage(message, ctx) {
  if (!message || typeof message !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const { id, method, params } = message;

  if (!method) {
    if (hasId) return err(id, -32600, 'Invalid Request');
    return null;
  }

  switch (method) {
    case 'initialize': {
      if (!hasId) return null;
      return ok(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: SERVER_INFO,
        instructions:
          'API MCP 服务。所有写操作落在影子工作区，需在控制台手动推送到 API 单机版。'
      });
    }

    case 'notifications/initialized':
    case 'initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return null;

    case 'ping':
      return hasId ? ok(id, {}) : null;

    case 'tools/list':
      return hasId ? ok(id, { tools: TOOLS }) : null;

    case 'tools/call': {
      if (!hasId) return null;
      const name = params?.name;
      const args = params?.arguments || {};
      if (!findTool(name)) {
        return ok(id, toolTextResult(`未知工具：${name}`, true));
      }
      try {
        const result = await callTool(name, args, ctx);
        return ok(id, toolTextResult(result));
      } catch (error) {
        const message0 = error?.message || String(error);
        const detail = error?.entries
          ? `\n${JSON.stringify(error.entries, null, 2)}`
          : '';
        return ok(id, toolTextResult(`${message0}${detail}`, true));
      }
    }

    case 'resources/list':
      return hasId ? ok(id, { resources: [] }) : null;

    case 'resources/templates/list':
      return hasId ? ok(id, { resourceTemplates: [] }) : null;

    case 'prompts/list':
      return hasId ? ok(id, { prompts: [] }) : null;

    case 'completion/complete':
      return hasId ? ok(id, { completion: { values: [], total: 0, hasMore: false } }) : null;

    case 'logging/setLevel':
      return hasId ? ok(id, {}) : null;

    default:
      if (!hasId) return null;
      return err(id, -32601, `Method not found: ${method}`);
  }
}

export { toolTextResult };
