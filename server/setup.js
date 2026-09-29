// `browser-mcp setup`: installs a stable copy under ~/.browser-mcp (npx caches
// are temporary), registers it with Claude Code when available, and prints the
// remaining manual step: loading the extension in the browser.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('..', import.meta.url));
const isWin = platform() === 'win32';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', shell: isWin, ...opts });
}

export function setup(argv) {
  const home = process.env.BROWSER_MCP_HOME || join(homedir(), '.browser-mcp');
  const skipClaude = argv.includes('--no-claude');
  const say = (s = '') => console.log(s);

  say(`Installing Pagewright (browser-mcp) into ${home}`);
  if (src.replace(/[\\/]$/, '') !== home.replace(/[\\/]$/, '')) {
    mkdirSync(home, { recursive: true });
    for (const part of ['server', 'extension']) {
      rmSync(join(home, part), { recursive: true, force: true });
      cpSync(join(src, part), join(home, part), { recursive: true });
    }
    for (const f of ['package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
      if (existsSync(join(src, f))) cpSync(join(src, f), join(home, f));
    }
    say('  installing dependencies…');
    const npm = run(isWin ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: home });
    if (npm.status !== 0) {
      console.error(npm.stderr || npm.stdout);
      console.error('npm install failed; fix the error above and run setup again.');
      process.exit(1);
    }
  }

  const entry = join(home, 'server', 'index.js');
  const node = process.execPath;
  say('  ✓ files installed\n');

  let claudeDone = false;
  if (!skipClaude && run('claude', ['--version']).status === 0) {
    run('claude', ['mcp', 'remove', 'browser', '-s', 'user']);
    const add = run('claude', ['mcp', 'add', 'browser', '-s', 'user', '--', node, entry]);
    claudeDone = add.status === 0;
    say(claudeDone ? '  ✓ registered with Claude Code as "browser" (all projects)\n' : `  ! could not register with Claude Code: ${(add.stderr || add.stdout).trim()}\n`);
  }

  const ext = join(home, 'extension');
  say('Next: load the browser extension (one time)');
  say('  1. Open chrome://extensions  (Brave: brave://extensions, Edge: edge://extensions)');
  say('  2. Turn on "Developer mode" (top right)');
  say('  3. Click "Load unpacked" and choose this folder:');
  say(`       ${ext}`);
  say('  4. Pin the extension; its icon shows ON while an agent is connected.\n');

  if (!claudeDone) {
    say('Then add this MCP server to your AI app:');
    say(`  Claude Code:  claude mcp add browser -s user -- "${node}" "${entry}"`);
    say('  Claude Desktop / Cursor / others (mcpServers in the app\'s config JSON):');
    say(JSON.stringify({ mcpServers: { browser: { command: node, args: [entry] } } }, null, 2).replace(/^/gm, '    '));
    say();
  }
  say('Finally restart your AI app (MCP servers load at startup) and ask it to run browser_status.');
  say('To update later, run the same setup command again.');

  // Open the folder so it is easy to pick in the "Load unpacked" dialog.
  if (!argv.includes('--no-open')) {
    const opener = isWin ? 'explorer' : platform() === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [ext], { stdio: 'ignore' });
  }
}
