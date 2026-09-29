# Contributing to Pagewright

Thanks for helping. Every contribution counts: a clear bug report, a docs fix, a new audit rule or a whole new tool.

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [How a tool call flows](#how-a-tool-call-flows)
- [Adding a tool](#adding-a-tool)
- [Testing](#testing)
- [Style](#style)
- [Pull requests](#pull-requests)
- [Releasing](#releasing-maintainers)

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug.** Use the [bug template](https://github.com/zamansheikh/browser-mcp/issues/new?template=bug_report.yml). The most useful reports include the tool call, what happened, and the page (or a minimal HTML file) that reproduces it.
- **Improve an existing tool.** For example: a layout issue the audit misses, a snapshot that reads badly on some site, or a scraping case that fails.
- **Add a tool.** Please open an issue first so we can agree on its name and parameters. The [guide below](#adding-a-tool) walks through it.
- **Docs and examples.** Better wording, setup notes for more AI apps, or example prompts.
- **Triage.** Reproducing someone else's bug report is a real help.

New here? Look for [`good first issue`](https://github.com/zamansheikh/browser-mcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## Development setup

You need Node.js 18+ and a Chromium browser.

```bash
git clone https://github.com/zamansheikh/browser-mcp
cd browser-mcp
npm install
```

1. Load `extension/` in `chrome://extensions` (Developer mode → **Load unpacked**).
2. Point your AI app at your clone: `claude mcp add browser-dev -- node /path/to/browser-mcp/server/index.js`.
3. Run `node server/index.js check` to confirm the extension connects.

**After changing code:**

| You changed | Do this |
|---|---|
| `server/*` | Restart your AI app's MCP server, or start a new session. |
| `extension/*` | Click the reload icon on the extension card in `chrome://extensions`. |
| `extension/page-lib.js` | Reload the extension **and** bump `PAGE_LIB_VERSION`, so already-open pages get the new code. |
| A tool's description or parameters | Run `npm run docs` and commit `docs/TOOLS.md`. |

## Project layout

```
server/
  index.js       MCP server entry (stdio); also the `setup` and `check` commands
  tools.js       every MCP tool: name, description, JSON schema, handler
  bridge.js      WebSocket hub/relay between MCP servers and the extension
  setup.js       the installer (npx … setup)
  check.js       self-test that needs no AI app (npx … check)
extension/
  manifest.json  Manifest V3
  background.js  service worker: connection, CDP helpers, METHODS (one per command)
  page-lib.js    runs inside pages: snapshot, audit, inspect, extract, markdown
  popup.*        the toolbar popup
  build-config.js  build flags (the store build disables browser_evaluate)
scripts/         docs generator, store package, store images, demo GIF, icons
test/
  smoke.mjs      fast checks without a browser (npm test)
  e2e.mjs        full test in a real browser against test/fixture
  fixture/       a small site with planted layout bugs and scrapeable data
store/           Chrome Web Store listing, demo shop, images
docs/            generated tool reference, demo GIF
```

## How a tool call flows

```
AI app ──MCP (stdio)──▶ server/tools.js handler
                          └─ bridge.call('click', params)
                               ──WebSocket──▶ extension/background.js METHODS.click
                                                ├─ page(tabId, 'point', …)   → page-lib.js runs in the tab
                                                └─ cdp(tabId, 'Input.dispatchMouseEvent', …)
```

- **`server/tools.js`** defines what the agent sees and formats results (text, JSON or images). Keep logic here thin, except when orchestrating several commands, as `browser_scrape` does.
- **`extension/background.js`** `METHODS` do the browser work with the DevTools protocol (`cdp(...)`) and Chrome APIs.
- **`extension/page-lib.js`** is one self-contained function that gets serialized into the page, so it can't import anything or reference code outside itself. Call it from `background.js` with `page(tabId, 'functionName', args)`. Arguments and results must be JSON.

## Adding a tool

Say we're adding `browser_pdf`, which saves the page as a PDF.

**1. Do the work in the extension.** Add a method to `METHODS` in `extension/background.js`:

```js
async pdf({ tabId, landscape = false }) {
  const tab = await resolveTab(tabId);
  await attach(tab.id);
  const { data } = await cdp(tab.id, 'Page.printToPDF', { landscape, printBackground: true });
  return { tabId: tab.id, data };
},
```

If you need to read or change the DOM, add a function to `page-lib.js`, export it in the `window.__browserMcp` object at the bottom, and call it with `page(tab.id, 'yourFunction', args)`.

**2. Expose it to agents.** Add an entry to `TOOLS` in `server/tools.js`:

```js
{
  name: 'browser_pdf',
  description: 'Save the current page as a PDF file.',
  inputSchema: {
    type: 'object',
    properties: { tabId, landscape: { type: 'boolean' }, savePath: { type: 'string' } },
    required: ['savePath'],
  },
  async handler(a, { bridge }) {
    const r = await bridge.call('pdf', a);
    return text(`Saved PDF to ${await save(a.savePath, Buffer.from(r.data, 'base64'))}`);
  },
},
```

Write the description for an AI reader: say what the tool does, when to use it instead of a similar tool, and what it returns. Agents choose tools from these descriptions.

**3. Document it.** Add the name to a group in `scripts/gen-docs.mjs`, then run `npm run docs`.

**4. Test it.** Add a case to `test/e2e.mjs`. If it needs special page content, add that to `test/fixture/`.

**5. Update `CHANGELOG.md`** under "Unreleased".

## Testing

```bash
npm test              # smoke test + docs up to date; no browser (runs in CI)
npm run check-syntax  # syntax check of every file, including page-lib serialization
npm run test:e2e      # the full suite in a real browser
```

**End-to-end tests** need a Chromium build that allows `--load-extension`. Branded Chrome and Brave 137+ ignore that flag, so use Chrome for Testing:

```bash
npx @puppeteer/browsers install chrome@stable --path ~/.cache/cft
# macOS
BROWSER_BIN="$(ls -d ~/.cache/cft/chrome/*/chrome-mac-*/Google\ Chrome\ for\ Testing.app)/Contents/MacOS/Google Chrome for Testing" npm run test:e2e
# Linux (add xvfb-run on a headless machine)
BROWSER_BIN="$(ls ~/.cache/cft/chrome/*/chrome-linux64/chrome)" npm run test:e2e
```

The e2e test opens its own browser with a throwaway profile. It never touches your normal browser.

## Style

- Plain modern JavaScript (ES modules), no build step, and only two runtime dependencies. Please don't add a dependency without discussing it first.
- Match the surrounding code: 2-space indent, single quotes, semicolons, short focused functions.
- Error messages are read by AI agents. Say what went wrong **and what to do next**, for example "Ref e12 not found — take a new browser_snapshot".
- Keep tool output compact. Agents pay for every token.
- Anything that runs in pages (`page-lib.js`) must not change the page unless that is the tool's purpose: no extra DOM attributes, no global listeners.

## Pull requests

1. Fork, and create a branch from `main`.
2. Keep each PR focused on one change. Small PRs get reviewed faster.
3. Run `npm test`, plus `npm run test:e2e` if you touched the extension.
4. Fill in the PR template, and include before/after output for behavior changes.
5. Use clear commit messages in the imperative mood ("Add browser_pdf tool").

CI runs the smoke tests on Node 18, 20 and 22, and the full browser suite on Linux.

## Releasing (maintainers)

1. Bump `version` in `package.json` **and** `extension/manifest.json`; `npm test` checks that they match.
2. Move the "Unreleased" notes in `CHANGELOG.md` under the new version.
3. Run `npm run build:store` and upload `dist/pagewright-<version>.zip` to the Chrome Web Store.
4. Tag the release (`git tag v1.2.3 && git push --tags`) and create a GitHub release with the changelog notes.

Store listing rules learned the hard way: never name other products (such as other AI apps) in the store summary, description or images. That counts as keyword spam and gets the listing rejected.
