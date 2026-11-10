#!/usr/bin/env node
/**
 * 零依赖生成桌面端图标：build/icon.ico（256×256 PNG 压缩 ICO）
 *
 * - 底色取控制台主题主色 #8a6b3b，白色 "AP" 字标
 * - 4 倍超采样后降采样，得到平滑边缘
 * - PNG 编码使用内置 zlib，ICO 容器直接内嵌 PNG（Windows 10+ 支持）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');

const SIZE = 256;
const SS = 4; // 超采样倍数
const BG = [0x8a, 0x6b, 0x3b, 0xff]; // --color-primary
const FG = [0xfa, 0xf5, 0xea, 0xff]; // --bg-page

/** 5×7 点阵字形 */
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000']
};

function drawIcon(size) {
  const W = size * SS;
  const H = size * SS;
  const px = new Uint8Array(W * H * 4); // RGBA

  const setPx = (x, y, color) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = color[0];
    px[i + 1] = color[1];
    px[i + 2] = color[2];
    px[i + 3] = color[3];
  };

  // 圆角矩形底
  const radius = Math.round(W * 0.22);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const dx = Math.min(x, W - 1 - x);
      const dy = Math.min(y, H - 1 - y);
      let inside = true;
      if (dx < radius && dy < radius) {
        const cx = radius - dx;
        const cy = radius - dy;
        inside = cx * cx + cy * cy <= radius * radius;
      }
      if (inside) setPx(x, y, BG);
    }
  }

  // "AP" 字标
  const letters = ['A', 'P'];
  const cols = letters.length * 5 + (letters.length - 1); // 5 列 + 1 列间距
  const rows = 7;
  const unit = Math.floor((W * 0.62) / cols);
  const textW = unit * cols;
  const textH = unit * rows;
  const originX = Math.round((W - textW) / 2);
  const originY = Math.round((H - textH) / 2);

  letters.forEach((letter, li) => {
    const glyph = GLYPHS[letter];
    const baseX = originX + li * (5 + 1) * unit;
    glyph.forEach((line, row) => {
      for (let col = 0; col < line.length; col += 1) {
        if (line[col] !== '1') continue;
        const x0 = baseX + col * unit;
        const y0 = originY + row * unit;
        for (let y = y0; y < y0 + unit; y += 1) {
          for (let x = x0; x < x0 + unit; x += 1) setPx(x, y, FG);
        }
      }
    });
  });

  // 降采样（盒式平均），保留 alpha 平滑
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const alpha = px[i + 3] / 255;
          r += px[i] * alpha;
          g += px[i + 1] * alpha;
          b += px[i + 2] * alpha;
          a += px[i + 3];
        }
      }
      const n = SS * SS;
      const alphaAvg = a / n;
      const i = (y * size + x) * 4;
      const factor = alphaAvg > 0 ? 255 / alphaAvg / n : 0;
      out[i] = Math.round(r * factor);
      out[i + 1] = Math.round(g * factor);
      out[i + 2] = Math.round(b * factor);
      out[i + 3] = Math.round(alphaAvg);
    }
  }
  return out;
}

/* ---------- PNG 编码 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前置 filter 字节 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function encodeIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 表示 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuffer.length, 8); // bytesInRes
  entry.writeUInt32LE(6 + 16, 12); // imageOffset

  return Buffer.concat([header, entry, pngBuffer]);
}

function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  const rgba = drawIcon(SIZE);
  const png = encodePng(rgba, SIZE);
  const ico = encodeIco(png, SIZE);

  fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log(
    `[icon] build/icon.ico (${SIZE}x${SIZE}, ${(ico.length / 1024).toFixed(1)} KB) / build/icon.png`
  );
}

main();
