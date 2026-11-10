#!/usr/bin/env node
/** 把 web/ 下的静态资源内联成 JS 模块（开发与打包共用） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['index.html', 'theme.css', 'style.css', 'app.js', 'design.js', 'extra.js', 'recent.js', 'curl-parse.js'];

const out = {};
for (const name of files) {
  out[name] = fs.readFileSync(path.join(root, 'web', name), 'utf8');
}

const module = `// 自动生成（scripts/gen-assets.mjs），请勿手改
export const WEB_ASSETS = ${JSON.stringify(out)};
`;

fs.writeFileSync(path.join(root, 'src', 'server', 'web-assets.generated.js'), module);
console.log(`[assets] 内联 ${files.length} 个文件，${(module.length / 1024).toFixed(1)} KB`);
