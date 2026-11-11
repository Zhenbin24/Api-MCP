#!/usr/bin/env node
/**
 * 零依赖生成应用图标：build/icon.ico（多尺寸）+ build/icon.png（256×256）
 *
 * 关键点：
 * - 9 档尺寸（16/20/24/32/40/48/64/128/256）全部内嵌，每档**独立渲染**，
 *   不再「画 256 再缩」——那会把字标糊成半透明灰边。
 * - 字标用几何笔画（A：两斜线 + 一横；P：一竖 + 半环），按尺寸调整笔画宽度
 *   并对齐像素栅格，16px 下依然锐利。
 * - 小尺寸用 32bpp BMP(DIB) 编码（Windows 传统格式最稳），大尺寸用 PNG。
 *
 * 产物：
 *   build/icon.ico  多尺寸 ICO
 *   build/icon.png  256×256 PNG（网页 / 文档用）
 *   web/icon.png    与 build/icon.png 一致，供 /favicon.png 使用
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
const webDir = path.join(root, 'web');

/** 内嵌尺寸，升序 */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
/** >= 该尺寸用 PNG 编码，其余用 BMP(DIB) */
const PNG_MIN_SIZE = 128;
/** 每档超采样倍数（只在软件层绘制时用） */
const SS = 4;

const BG = [0x8a, 0x6b, 0x3b, 0xff]; // --color-primary
const FG = [0xfa, 0xf5, 0xea, 0xff]; // --bg-page

/* ---------------- 绘制 ---------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 点到线段的距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = clamp01(t);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 圆角矩形内部判定（size 为逻辑坐标边长） */
function insideRoundedRect(x, y, size, radius) {
  const dx = Math.min(x, size - x);
  const dy = Math.min(y, size - y);
  if (dx < 0 || dy < 0) return false;
  if (dx >= radius || dy >= radius) return true;
  const cx = radius - dx;
  const cy = radius - dy;
  return cx * cx + cy * cy <= radius * radius;
}

/**
 * 画一张 size×size 的 RGBA 图。
 * 逻辑坐标按 size 规划，内部乘 SS 超采样。
 */
function drawIcon(size) {
  const ss = size <= 32 ? SS * 2 : SS;
  const W = size * ss;
  const H = size * ss;
  const px = new Uint8Array(W * H * 4);

  const setPx = (x, y, color) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = color[0];
    px[i + 1] = color[1];
    px[i + 2] = color[2];
    px[i + 3] = color[3];
  };

  // 圆角矩形底
  const radius = size * 0.22;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const lx = (x + 0.5) / ss;
      const ly = (y + 0.5) / ss;
      if (insideRoundedRect(lx, ly, size, radius)) setPx(x, y, BG);
    }
  }

  // 字标几何量：按尺寸换算，笔画随尺寸收窄，小尺寸加大占位
  const small = size <= 24;
  const boxW = size * (small ? 0.74 : 0.62);
  const boxH = size * (small ? 0.60 : 0.48);
  const boxX = (size - boxW) / 2;
  const boxY = (size - boxH) / 2;
  const gx = (t) => boxX + t * boxW;
  const gy = (t) => boxY + t * boxH;
  const stroke = Math.max(small ? 1.7 : 1.35, size * (small ? 0.125 : 0.075));
  const half = stroke / 2;

  // A：两斜线 + 中横（端点按横线高度精确取，保证连上）
  const aLeftBottom = gx(0.02);
  const aApex = gx(0.24);
  const aRightBottom = gx(0.46);
  const aTop = gy(0.0);
  const aBottom = gy(1.0);
  const barY = gy(0.66);
  const barT = (barY - aBottom) / (aTop - aBottom);
  const barX0 = aLeftBottom + barT * (aApex - aLeftBottom);
  const barX1 = aApex + barT * (aRightBottom - aApex);

  // P：竖 + 半环
  const pStemX = gx(0.66);
  const pTop = gy(0.0);
  const pBottom = gy(1.0);
  const bowlR = boxW * (small ? 0.21 : 0.18);
  const bowlCx = pStemX;
  const bowlCy = pTop + bowlR;

  const arcSamples = 48;

  const hitGlyph = (lx, ly) => {
    // A：左斜 / 右斜
    if (distToSegment(lx, ly, aLeftBottom, aBottom, aApex, aTop) <= half) return true;
    if (distToSegment(lx, ly, aApex, aTop, aRightBottom, aBottom) <= half) return true;
    // A：中横
    if (distToSegment(lx, ly, barX0, barY, barX1, barY) <= half) return true;
    // P：竖
    if (Math.abs(lx - pStemX) <= half && ly >= pTop - half && ly <= pBottom + half) return true;
    // P：半环（从顶部顺时针到中段）
    let prevX = bowlCx;
    let prevY = bowlCy - bowlR;
    for (let i = 1; i <= arcSamples; i += 1) {
      const angle = -Math.PI / 2 + (Math.PI * i) / arcSamples;
      const cx = bowlCx + Math.cos(angle) * bowlR;
      const cy = bowlCy + Math.sin(angle) * bowlR;
      if (distToSegment(lx, ly, prevX, prevY, cx, cy) <= half) return true;
      prevX = cx;
      prevY = cy;
    }
    return false;
  };

  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const lx = (x + 0.5) / ss;
      const ly = (y + 0.5) / ss;
      if (hitGlyph(lx, ly)) setPx(x, y, FG);
    }
  }

  // 降采样（盒式平均），保留 alpha 平滑
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const i = ((y * ss + sy) * W + (x * ss + sx)) * 4;
          const alpha = px[i + 3] / 255;
          r += px[i] * alpha;
          g += px[i + 1] * alpha;
          b += px[i + 2] * alpha;
          a += px[i + 3];
        }
      }
      const n = ss * ss;
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

/* ---------------- PNG 编码 ---------------- */

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

/* ---------------- BMP(DIB) 编码（ICO 内的 32bpp 位图） ---------------- */

function encodeDib(rgba, size) {
  const headerSize = 40;
  const pixelBytes = size * size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const maskBytes = maskRowBytes * size;

  const buf = Buffer.alloc(headerSize + pixelBytes + maskBytes);

  buf.writeUInt32LE(headerSize, 0); // biSize
  buf.writeInt32LE(size, 4); // biWidth
  buf.writeInt32LE(size * 2, 8); // biHeight（XOR + AND 两张图）
  buf.writeUInt16LE(1, 12); // biPlanes
  buf.writeUInt16LE(32, 14); // biBitCount
  buf.writeUInt32LE(0, 16); // biCompression = BI_RGB
  buf.writeUInt32LE(pixelBytes, 20); // biSizeImage
  buf.writeInt32LE(0, 24);
  buf.writeInt32LE(0, 28);
  buf.writeUInt32LE(0, 32);
  buf.writeUInt32LE(0, 36);

  // 像素自下而上、BGRA
  let offset = headerSize;
  for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      buf[offset] = rgba[i + 2]; // B
      buf[offset + 1] = rgba[i + 1]; // G
      buf[offset + 2] = rgba[i]; // R
      buf[offset + 3] = rgba[i + 3]; // A
      offset += 4;
    }
  }

  // AND 掩码：alpha 为 0 的像素置 1（自下而上）
  const maskStart = headerSize + pixelBytes;
  for (let y = 0; y < size; y += 1) {
    const srcY = size - 1 - y;
    const rowBase = maskStart + y * maskRowBytes;
    for (let x = 0; x < size; x += 1) {
      const alpha = rgba[((srcY * size) + x) * 4 + 3];
      if (alpha === 0) {
        buf[rowBase + (x >> 3)] |= 1 << (7 - (x & 7));
      }
    }
  }

  return buf;
}

/* ---------------- ICO 容器 ---------------- */

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((entry, i) => {
    const base = i * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size; // bWidth
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size; // bHeight
    directory[base + 2] = 0; // colorCount
    directory[base + 3] = 0; // reserved
    directory.writeUInt16LE(1, base + 4); // planes
    directory.writeUInt16LE(32, base + 6); // bitCount
    directory.writeUInt32LE(entry.data.length, base + 8); // bytesInRes
    directory.writeUInt32LE(offset, base + 12); // imageOffset
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.data)]);
}

/* ---------------- 入口 ---------------- */

function main() {
  fs.mkdirSync(buildDir, { recursive: true });

  const entries = SIZES.map((size) => {
    const rgba = drawIcon(size);
    const data = size >= PNG_MIN_SIZE ? encodePng(rgba, size) : encodeDib(rgba, size);
    return { size, data };
  });

  const ico = encodeIco(entries);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

  // 网页 / 文档用的大图
  const png256 = encodePng(drawIcon(256), 256);
  fs.writeFileSync(path.join(buildDir, 'icon.png'), png256);
  try {
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, 'icon.png'), png256);
  } catch {}

  const detail = entries.map((e) => `${e.size}`).join('/');
  console.log(
    `[icon] build/icon.ico（${SIZES.length} 档：${detail}，${(ico.length / 1024).toFixed(1)} KB）/ build/icon.png + web/icon.png`
  );
}

main();
