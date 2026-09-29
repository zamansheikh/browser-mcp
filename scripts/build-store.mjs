// Packs extension/ into dist/pagewright-<version>.zip for the Chrome Web Store,
// after checking the manifest against store limits.
import { readFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync, cpSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ext = join(root, 'extension');
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const problems = [];
if (manifest.version !== pkg.version) problems.push(`manifest version ${manifest.version} != package.json ${pkg.version}`);
if (manifest.name.length > 75) problems.push(`name is ${manifest.name.length} chars (max 75)`);
if (manifest.description.length > 132) problems.push(`description is ${manifest.description.length} chars (max 132)`);
for (const f of Object.values(manifest.icons)) if (!existsSync(join(ext, f))) problems.push(`missing icon ${f}`);
if (problems.length) { console.error('Not packing:\n  ' + problems.join('\n  ')); process.exit(1); }

const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n.startsWith('.')) continue; statSync(p).isDirectory() ? walk(p) : files.push(relative(ext, p)); } };
walk(ext);

// Stage a copy with the store build config (no arbitrary code evaluation).
const stage = join(root, 'dist', 'stage');
rmSync(stage, { recursive: true, force: true });
cpSync(ext, stage, { recursive: true, filter: (p) => !p.split(/[\\/]/).pop().startsWith('.') });
writeFileSync(join(stage, 'build-config.js'), "export const BUILD = { channel: 'chrome-web-store', allowEvaluate: false };\n");

const out = join(root, 'dist', `pagewright-${manifest.version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-X', '-q', out, ...files], { cwd: stage });
rmSync(stage, { recursive: true, force: true });
console.log(`${out}\n${files.length} files: ${files.join(', ')}`);
