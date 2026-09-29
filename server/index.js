#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Bridge } from './bridge.js';
import { TOOLS } from './tools.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (process.argv[2] === 'check') {
  const { check } = await import('./check.js');
  process.exit(await check(process.argv.slice(3)));
}

if (process.argv[2] === 'setup') {
  const { setup } = await import('./setup.js');
  setup(process.argv.slice(3));
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`browser-mcp ${pkg.version} — MCP server that controls your browser through the Pagewright extension.

Usage:
  browser-mcp            speak MCP over stdio (launch it from your agent's MCP config)
  browser-mcp setup      install to ~/.browser-mcp, register with Claude Code, show extension steps
                         [--no-claude] [--no-open]
  browser-mcp check      verify the extension connects and can read a page (no AI app needed)

Options:
  --port PORT                  WebSocket port (overrides BROWSER_MCP_PORT)

Environment:
  BROWSER_MCP_PORT             WebSocket port shared with the extension (default 18800)
  BROWSER_MCP_CONNECT_TIMEOUT  ms to wait for the extension before failing a call (default 20000)
  BROWSER_MCP_EXTENSION_IDS    comma-separated extension ids allowed to connect (default: any extension)`);
  process.exit(0);
}

const portIndex = process.argv.indexOf('--port');
const bridge = new Bridge({
  port: Number(portIndex === -1 ? process.env.BROWSER_MCP_PORT : process.argv[portIndex + 1]) || 18800,
  connectTimeout: Number(process.env.BROWSER_MCP_CONNECT_TIMEOUT) || 20000,
  extensionIds: (process.env.BROWSER_MCP_EXTENSION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
});
bridge.start();

const INSTRUCTIONS = `Controls the user's real browser (Chrome/Brave/Edge) via an extension — their logins and cookies are available, so act carefully and never submit purchases, posts or messages unless asked.

Typical loop: browser_navigate → browser_snapshot (find elements; each has a [ref=eN]) → browser_click / browser_type with ref → browser_snapshot again to confirm.
See the page: browser_screenshot (viewport, fullPage, or one element).
Fix a frontend: browser_audit_layout finds overflow, overlap, clipped text, contrast and image problems; browser_inspect shows box model, computed styles and the CSS rules (file:line) that apply; browser_set_viewport tests mobile/tablet; browser_inject_css tries a fix live before you edit source; browser_console and browser_network show errors.
Scrape: browser_get_content (markdown/links/tables/meta) for one page; browser_extract for repeated items; browser_scrape for pagination/infinite scroll with CSV/JSON output; browser_network + browser_network_body to read the JSON APIs a page uses.
Refs stay valid until the page navigates or the element is removed; take a new snapshot if a ref is not found.`;

const server = new Server({ name: 'browser-mcp', version: pkg.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
const byName = new Map(TOOLS.map((t) => [t.name, t]));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const tool = byName.get(req.params.name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }], isError: true };
  const token = req.params._meta?.progressToken;
  const progress = token === undefined ? undefined : (done, total, message) =>
    extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: done, total, message } }).catch(() => {});
  try {
    return await tool.handler(req.params.arguments || {}, { bridge, progress });
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());

const shutdown = () => { bridge.close(); process.exit(0); };
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
