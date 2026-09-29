# Browser MCP

Let any AI agent (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code Copilot, anything that speaks MCP) **see and control your real browser**: read pages, click and type, take screenshots, debug layouts, and scrape data. It uses your normal Chrome/Brave/Edge profile, so logged-in sites work.

```
 AI agent ──stdio──▶ browser-mcp server ──WebSocket (127.0.0.1:18800)──▶ extension ──DevTools protocol──▶ tabs
 AI agent ──stdio──▶ browser-mcp server ──┘ (extra agents share the first server as a hub)
```

## Install

You need [Node.js 18+](https://nodejs.org), [git](https://git-scm.com), and Chrome, Brave, Edge or another Chromium browser.

**1. Run the installer:**

```bash
npx -y github:zamansheikh/browser-mcp setup
```

This installs Browser MCP into `~/.browser-mcp`. If [Claude Code](https://claude.com/claude-code) is installed, it also registers the server there for all projects. Otherwise it prints the config to paste into your AI app. It then opens the extension folder.

**2. Load the extension (one time):**

1. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `~/.browser-mcp/extension`, the folder the installer printed and opened.
4. Pin the extension. Its icon shows **ON** while an agent is connected.

**3. Restart your AI app** (MCP servers only load at startup) and ask it: *"run browser_status"*.

To update, run the setup command again, then click the reload icon on the extension card in `chrome://extensions`.

<details>
<summary>Manual setup (other AI apps, or running from a clone)</summary>

```bash
git clone https://github.com/zamansheikh/browser-mcp && cd browser-mcp && npm install
```

Load `extension/` with **Load unpacked** as above, then add the server to your app using absolute paths.

Claude Code:

```bash
claude mcp add browser -s user -- node /ABSOLUTE/PATH/browser-mcp/server/index.js
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows), Cursor (`~/.cursor/mcp.json`), and most other clients:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/browser-mcp/server/index.js"]
    }
  }
}
```

</details>

## What the agent can do

| Area | Tools |
|---|---|
| Tabs and navigation | `browser_tabs` (list/new/select/close), `browser_navigate` (URL, back, forward, reload) |
| See the page | `browser_snapshot`: compact tree of the page with `[ref=eN]` handles. `browser_screenshot`: viewport, full page, or one element |
| Interact | `browser_click`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_hover`, `browser_scroll`, `browser_wait_for`, `browser_upload_file`, `browser_handle_dialogs`, `browser_evaluate` |
| Fix frontends | `browser_audit_layout`, `browser_inspect`, `browser_set_viewport`, `browser_inject_css`, `browser_console`, `browser_network` |
| Scrape | `browser_get_content` (markdown/text/html/links/tables/meta), `browser_extract`, `browser_scrape` (pagination and infinite scroll, JSON/CSV output), `browser_network_body` |

Clicks and typing are real input events sent through the DevTools protocol, not synthetic JavaScript events. They work with React/Vue/Svelte apps, and a click that would land on a covering modal fails with an explanation instead of silently hitting the wrong element.

### Fixing a frontend

Example prompts for Claude Code while your dev server runs:

> Open localhost:3000, audit the layout at mobile, tablet and desktop, and fix what you find in the source.

The agent will typically:

1. `browser_set_viewport {preset: "mobile"}`, then `browser_audit_layout`. This finds horizontal overflow and **the element causing it**, content sticking out of its container, clipped text, elements covered by others, broken/stretched/oversized images, low contrast, tiny text and tap targets, unlabeled controls, console errors, and failed requests.
2. `browser_inspect {ref}` returns the box model, the computed styles that matter, and **the CSS rules that apply, with file:line**, so it knows which rule to edit.
3. `browser_inject_css` tries the fix live, then `browser_screenshot` and a re-run of the audit confirm it.
4. The agent edits the real source file, reloads, and verifies.

### Scraping

> Scrape all products from https://example.com/shop, following the "Next" button, into products.csv with name, price and URL.

```json
browser_scrape {
  "url": "https://example.com/shop",
  "itemSelector": ".product-card",
  "fields": {
    "name": "h2",
    "price": { "selector": ".price", "type": "number" },
    "url": "a@href",
    "image": "img@src",
    "tags": { "selector": ".tag", "all": true }
  },
  "nextSelector": "a[rel=next]",
  "maxPages": 20,
  "savePath": "products.csv"
}
```

Field specs: `"css selector"`, `"selector@attribute"`, `"."` for the item itself, or `{selector, attr, all, type: "number", regex}`.
For infinite-scroll feeds use `infiniteScroll: 10`. For sites backed by a JSON API, `browser_network {type: "xhr,fetch"}` followed by `browser_network_body` returns the raw data, which is often cleaner than the HTML.

Scrape responsibly: respect sites' terms and robots rules, and keep `delayMs` reasonable.

### Selectors and refs

Take a `browser_snapshot` first. Every interactive element gets a ref:

```
- form:
  - textbox "Email" [type=email] [value=""] [ref=e9]
  - combobox "Plan" [selected="Free"] [options=["Free","Pro"]] [ref=e10]
  - button "Sign up" [ref=e12]
```

Pass `ref: "e12"` to click, type, inspect, or screenshot that element. Refs survive re-snapshots and last until the element is removed or the page navigates. Anywhere a ref is accepted you can also pass `selector`: CSS, `text=Sign in`, `text="Exact text"`, or `xpath=//button`. Selectors also search open shadow DOM.

## Multiple agents

Every agent session starts its own `browser-mcp` process. The first one owns port 18800 and becomes the **hub**; the extension connects to it, and later processes relay through it. If the hub's agent exits, another process takes over within about a second. All agents share the same browser. Each tool accepts `tabId`, and `browser_tabs {action: "new"}` gives an agent its own tab.

## Configuration

| Env var | Default | |
|---|---|---|
| `BROWSER_MCP_PORT` | `18800` | Must match the port in the extension popup |
| `BROWSER_MCP_CONNECT_TIMEOUT` | `20000` | ms a call waits for the extension to connect |
| `BROWSER_MCP_EXTENSION_IDS` | any | Comma-separated extension IDs allowed to connect |

## Security

- The WebSocket listens on `127.0.0.1` only.
- The `/extension` endpoint only accepts `chrome-extension://` origins. The `/agent` endpoint rejects any request carrying an `Origin` header, so a website cannot connect to it and drive your browser. Set `BROWSER_MCP_EXTENSION_IDS` to pin the exact extension.
- An agent with this server can do anything you can do in your browser, on sites where you are logged in. Only connect agents you trust, and watch what they do. The browser shows a "started debugging this browser" bar on every tab under control. Use **Release** in the popup, or close the bar, to take a tab back.
- `alert`/`confirm` dialogs are auto-accepted so pages don't freeze the agent (`browser_handle_dialogs` changes this). Each one is logged to `browser_console`.

## Limitations

- Browser pages (`chrome://…`, the Web Store, other extensions' pages) can't be controlled. That is a Chrome restriction.
- Cross-origin iframes are not traversed by the snapshot. Same-origin iframes are.
- Screenshots bring the tab to the front, because background tabs don't paint.
- Console and network capture start when an agent first touches a tab. Reload to capture a page's initial load.
- Only one debugger client can attach per tab while DevTools is open on that tab in some browser versions. Close DevTools if attaching fails.

## Development

```
server/index.js      MCP server (stdio)
server/bridge.js     WebSocket hub / relay to the extension
server/tools.js      tool definitions and scraping orchestration
extension/           Manifest V3 extension (service worker, popup)
extension/page-lib.js  code injected into pages: snapshot, audit, inspect, extract, markdown
test/e2e.mjs         end-to-end test against test/fixture
```

Run the end-to-end test. It needs a browser build that still honors `--load-extension`, which branded Chrome/Brave 137+ no longer do, so use Chrome for Testing:

```bash
npx @puppeteer/browsers install chrome@stable --path /tmp/cft
BROWSER_BIN="/tmp/cft/chrome/<version>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" npm run test:e2e
```

After editing extension files, click the reload icon on the extension card in `chrome://extensions`.
