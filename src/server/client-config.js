import os from 'node:os';
import path from 'node:path';

/** 生成各客户端配置片段（stdio 模式指向本 exe） */
export function buildClientConfigs({ command, args = [], serverName = 'apipost-offline' }) {
  const stdio = {
    command,
    args,
    env: { ELECTRON_RUN_AS_NODE: '1' }
  };
  // 我们自己打包的是原生 Node SEA，不需要 ELECTRON_RUN_AS_NODE
  const plainStdio = { command, args };

  return {
    cursor: JSON.stringify({ mcpServers: { [serverName]: plainStdio } }, null, 2),
    claude_code: JSON.stringify({ mcpServers: { [serverName]: plainStdio } }, null, 2),
    vscode: JSON.stringify(
      { servers: { [serverName]: { type: 'stdio', ...plainStdio } } },
      null,
      2
    ),
    trae: JSON.stringify({ mcpServers: { [serverName]: plainStdio } }, null, 2),
    workbuddy: JSON.stringify({ mcpServers: { [serverName]: plainStdio } }, null, 2),
    codex: [
      `[mcp_servers.${serverName}]`,
      `command = ${JSON.stringify(command)}`,
      `args = ${JSON.stringify(args)}`,
      '',
      `[mcp_servers.${serverName}.env]`,
      `# ApiPost 数据目录（可选，覆盖自动探测）`,
      `# APIPOST_DATA_ROOT = "${path.join(process.env.APPDATA || '', 'Apipost单机版').replace(/\\/g, '\\\\')}"`
    ].join('\n'),
    http: JSON.stringify(
      {
        mcpServers: {
          [serverName]: {
            type: 'http',
            url: 'http://127.0.0.1:39100/mcp',
            headers: { Authorization: 'Bearer <token>' }
          }
        }
      },
      null,
      2
    )
  };
}

export function cursorConfigPath() {
  const home = os.homedir();
  return path.join(home, '.cursor', 'mcp.json');
}
