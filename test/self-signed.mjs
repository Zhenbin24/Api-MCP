/** 自签证书生成器：优先 openssl，其次用 node:crypto 手写 DER，最后返回 null */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 尝试 openssl */
function viaOpenSSL() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(dir, 'key.pem'),
        '-out', path.join(dir, 'cert.pem'),
        '-days', '1',
        '-subj', '/CN=127.0.0.1'
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    return {
      key: fs.readFileSync(path.join(dir, 'key.pem')),
      cert: fs.readFileSync(path.join(dir, 'cert.pem'))
    };
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/* ---------------- 最小 DER 编码器 ---------------- */

function derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}

const seq = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const int = (buf) => der(0x02, buf);
const bitStr = (buf) => der(0x03, Buffer.concat([Buffer.from([0]), buf]));
const octStr = (buf) => der(0x04, buf);
const nullTag = () => Buffer.from([0x05, 0x00]);
const utf8 = (s) => der(0x0c, Buffer.from(s, 'utf8'));
const bool = (v) => der(0x01, Buffer.from([v ? 0xff : 0x00]));

/** OID 编码 */
function oid(str) {
  const parts = str.split('.').map(Number);
  const first = parts[0] * 40 + parts[1];
  const bytes = [first];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let n = part >> 7;
    while (n > 0) {
      stack.unshift(0x80 | (n & 0x7f));
      n >>= 7;
    }
    bytes.push(...stack);
  }
  return der(0x06, Buffer.from(bytes));
}

const OID = {
  sha256WithRSA: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  rsaEncryption: '1.2.840.113549.1.1.1',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  extKeyUsage: '2.5.29.37',
  subjectKeyId: '2.5.29.14',
  keyUsage: '2.5.29.15'
};

/** UTCTime */
function utcTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yy = pad(date.getUTCFullYear() % 100);
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  return der(0x17, Buffer.from(`${yy}${rest}`, 'ascii'));
}

/** 用 node:crypto 生成自签证书 */
function viaNodeCrypto() {
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const name = seq(set(seq(oid(OID.commonName), utf8('127.0.0.1'))));
    const issuer = name;

    const now = new Date();
    const validity = seq(utcTime(new Date(now.getTime() - 86400000)), utcTime(new Date(now.getTime() + 86400000 * 30)));

    // SAN: IP 127.0.0.1 + DNS localhost
    const sanIp = der(0x87, Buffer.from([127, 0, 0, 1]));
    const sanDns = der(0x82, Buffer.from('localhost', 'ascii'));
    const san = seq(sanIp, sanDns);

    const extensions = seq(
      // basicConstraints: CA:FALSE
      seq(oid(OID.basicConstraints), bool(true), octStr(seq())),
      // keyUsage: digitalSignature + keyEncipherment
      seq(oid(OID.keyUsage), bool(true), octStr(der(0x03, Buffer.from([0x05, 0xa0])))),
      // extKeyUsage: serverAuth
      seq(oid(OID.extKeyUsage), octStr(seq(oid('1.3.6.1.5.5.7.3.1')))),
      // subjectAltName
      seq(oid(OID.subjectAltName), octStr(san))
    );

    const signatureAlgorithm = seq(oid(OID.sha256WithRSA), nullTag());
    const spki = der(0x30, publicKey); // 已是 SPKI，补上外层 SEQUENCE 的 tag 需要重组

    // publicKey 是完整 SPKI（含 30 头），直接用
    const subjectPublicKeyInfo = publicKey;

    const tbs = seq(
      der(0xa0, int(Buffer.from([2]))), // version v3
      int(crypto.randomBytes(8)),
      signatureAlgorithm,
      issuer,
      validity,
      name,
      subjectPublicKeyInfo,
      der(0xa3, extensions)
    );

    const signer = crypto.createSign('sha256');
    signer.update(tbs);
    const signature = signer.sign(privateKey);

    const cert = seq(tbs, signatureAlgorithm, bitStr(signature));
    const pem = derToPem(cert, 'CERTIFICATE');

    return { key: privateKey, cert: pem };
  } catch {
    return null;
  }
}

function derToPem(buf, label) {
  const b64 = buf.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * 获取自签证书（供 http2 测试使用）。
 * @returns {{key: string|Buffer, cert: string}|null}
 */
export function getSelfSignedCert() {
  return viaOpenSSL() || viaNodeCrypto();
}
