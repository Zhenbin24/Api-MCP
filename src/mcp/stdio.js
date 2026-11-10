import readline from 'node:readline';
import { handleMessage } from './protocol.js';

/** stdio JSON-RPC 桥：逐行读 stdin、逐行写 stdout。 */
export function startStdioServer(ctx, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let queue = Promise.resolve();

  const write = (obj) => {
    output.write(`${JSON.stringify(obj)}\n`);
  };

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return; // 非法 JSON 忽略（与官方一致）
    }

    queue = queue
      .then(async () => {
        const response = await handleMessage(message, ctx);
        if (response) write(response);
      })
      .catch((error) => {
        if (Object.prototype.hasOwnProperty.call(message, 'id')) {
          write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: error?.message || 'Internal error' }
          });
        }
      });
  });

  rl.on('close', () => {
    queue.finally(() => process.exit(0));
  });

  return { close: () => rl.close() };
}
