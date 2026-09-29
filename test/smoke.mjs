// Fast checks that need no browser: the server starts, speaks MCP, and every
// tool definition is well formed. Run with `npm test`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [root + 'server/index.js'],
  // A port nothing else uses, and a short wait so the call below fails fast.
  env: { ...process.env, BROWSER_MCP_PORT: '18999', BROWSER_MCP_CONNECT_TIMEOUT: '500' },
  stderr: 'ignore',
}));

let n = 0;
const ok = (msg) => { n++; console.log(`ok ${n} - ${msg}`); };

const { tools } = await client.listTools();
assert.ok(tools.length >= 20, 'expected the full tool set');
ok(`lists ${tools.length} tools`);

const names = new Set();
for (const t of tools) {
  assert.match(t.name, /^browser_[a-z_]+$/, `bad tool name ${t.name}`);
  assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
  names.add(t.name);
  assert.ok(t.description && t.description.length > 20, `${t.name} needs a description`);
  assert.equal(t.inputSchema.type, 'object', `${t.name} schema must be an object`);
  for (const r of t.inputSchema.required || []) assert.ok(r in t.inputSchema.properties, `${t.name} requires unknown ${r}`);
}
ok('tool names, descriptions and schemas are valid');

const s = await client.callTool({ name: 'browser_status', arguments: {} });
const status = JSON.parse(s.content[0].text);
assert.equal(status.mode, 'hub');
ok('browser_status works without a browser');

const r = await client.callTool({ name: 'browser_snapshot', arguments: {} });
assert.ok(r.isError && /not connected/.test(r.content[0].text), 'expected a helpful not-connected error');
ok('tools fail with a helpful error when no browser is connected');

const manifest = JSON.parse(readFileSync(root + 'extension/manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
assert.equal(manifest.version, pkg.version, 'extension and package versions must match');
ok(`versions match (${pkg.version})`);

await client.close();
console.log(`\n${n} passed`);
