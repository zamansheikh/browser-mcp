// Syntax-checks every JavaScript file, including the extension's page code
// (which must stay self-contained because it is serialized into pages).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
for (const dir of ['server', 'extension', 'scripts', 'test']) {
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.m?js$/.test(n)) files.push(p); } };
  walk(join(root, dir));
}
for (const f of files) execFileSync(process.execPath, ['--check', f]);
const { pageLib } = await import(join(root, 'extension/page-lib.js'));
new Function(`return (${pageLib.toString()})`)();
console.log(`syntax ok: ${files.length} files, page-lib serializes`);
