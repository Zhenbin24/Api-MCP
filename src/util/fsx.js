import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readText(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

export function readJson(file, fallback = null) {
  const text = readText(file);
  if (text == null || text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 原子写：同目录 tmp + rename，Windows 上 rename 会覆盖已存在文件。 */
export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
  return file;
}

export function writeJsonAtomic(file, data) {
  return writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function removeFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function sha256File(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

export function fileSignature(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

export function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** 递归列出目录下所有文件的相对路径（posix 分隔符）。 */
export function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const name of listDir(dir)) {
    const abs = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listFilesRecursive(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

export function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return dest;
}

/** 阻止路径穿越：把 rel 解析到 root 之下，越界则抛错。 */
export function safeJoin(root, rel) {
  const target = path.resolve(root, rel);
  const normRoot = path.resolve(root);
  if (target !== normRoot && !target.startsWith(normRoot + path.sep)) {
    throw new Error(`路径越界: ${rel}`);
  }
  return target;
}

export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

export function toNative(p) {
  return String(p).split('/').join(path.sep);
}
