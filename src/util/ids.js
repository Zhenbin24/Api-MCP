import crypto from 'node:crypto';

const HEX = '0123456789abcdef';

function randHex(n) {
  const buf = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i += 1) out += HEX[buf[i] & 0x0f];
  return out;
}

/**
 * 官方 target_id / env_id 形如 2503d48ffac005：14 位小写十六进制。
 * 用「毫秒时间戳 hex(11 位) + 3 位随机」拼出同长度、单调递增的 id。
 */
export function hexId(existing = null) {
  const base = Date.now().toString(16).slice(-11).padStart(11, '0');
  for (let i = 0; i < 50; i += 1) {
    const id = base + randHex(3);
    if (!existing || !existing.has(id)) return id;
  }
  return base + randHex(3);
}

export function flowId() {
  return `flow_${Date.now()}`;
}

export function runId() {
  return `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function stepId() {
  return `step_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function paramId() {
  return Date.now().toString(16) + crypto.randomBytes(4).toString('hex');
}

export function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function uuid() {
  return crypto.randomUUID();
}
