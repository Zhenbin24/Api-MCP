import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icoPath = path.join(root, 'build', 'icon.ico');
const pngPath = path.join(root, 'build', 'icon.png');
const webIconPath = path.join(root, 'web', 'icon.png');

const EXPECTED_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** 确保图标存在（CI 上可能没跑过 gen-icon） */
function ensureIcon() {
  if (!fs.existsSync(icoPath)) {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-icon.mjs')], { cwd: root, stdio: 'ignore' });
  }
}

function readIco() {
  ensureIcon();
  const buf = fs.readFileSync(icoPath);
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    entries.push({
      width: buf[base] === 0 ? 256 : buf[base],
      height: buf[base + 1] === 0 ? 256 : buf[base + 1],
      bytes: buf.readUInt32LE(base + 8),
      offset: buf.readUInt32LE(base + 12)
    });
  }
  return { buf, reserved, type, count, entries };
}

test('图标：ICO 内嵌 9 档尺寸且顺序正确', () => {
  const { reserved, type, count, entries } = readIco();
  assert.equal(reserved, 0);
  assert.equal(type, 1, 'type 1 表示 ICO');
  assert.equal(count, EXPECTED_SIZES.length);
  assert.deepEqual(entries.map((e) => e.width), EXPECTED_SIZES);
  assert.deepEqual(entries.map((e) => e.height), EXPECTED_SIZES);
});

test('图标：每个目录项的偏移与长度都落在文件内', () => {
  const { buf, entries } = readIco();
  for (const entry of entries) {
    assert.ok(entry.offset >= 6 + 16 * entries.length, `${entry.width}px 偏移不应落在目录区`);
    assert.ok(entry.bytes > 0, `${entry.width}px 长度应为正`);
    assert.ok(entry.offset + entry.bytes <= buf.length, `${entry.width}px 数据不应越界`);
  }
});

test('图标：小尺寸是 32bpp DIB，大尺寸是 PNG，且声明尺寸与实际一致', () => {
  const { buf, entries } = readIco();
  for (const entry of entries) {
    const data = buf.subarray(entry.offset, entry.offset + entry.bytes);
    const isPng = data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG';

    if (entry.width >= 128) {
      assert.ok(isPng, `${entry.width}px 应为 PNG 编码`);
      const pngWidth = data.readUInt32BE(16);
      const pngHeight = data.readUInt32BE(20);
      assert.equal(pngWidth, entry.width);
      assert.equal(pngHeight, entry.height);
    } else {
      assert.ok(!isPng, `${entry.width}px 应为 DIB 编码`);
      const biSize = data.readUInt32LE(0);
      const biWidth = data.readInt32LE(4);
      const biHeight = data.readInt32LE(8);
      const bitCount = data.readUInt16LE(14);
      assert.equal(biSize, 40);
      assert.equal(biWidth, entry.width);
      assert.equal(biHeight, entry.height * 2, 'biHeight 含 XOR + AND 两张图');
      assert.equal(bitCount, 32);
    }
  }
});

test('图标：build/icon.png 与 web/icon.png 一致且尺寸为 256', () => {
  ensureIcon();
  assert.ok(fs.existsSync(pngPath), 'build/icon.png 应存在');
  assert.ok(fs.existsSync(webIconPath), 'web/icon.png 应存在');

  const a = fs.readFileSync(pngPath);
  const b = fs.readFileSync(webIconPath);
  assert.ok(a.equals(b), 'web/icon.png 应与 build/icon.png 完全一致');
  assert.equal(a.readUInt32BE(16), 256);
  assert.equal(a.readUInt32BE(20), 256);
});
