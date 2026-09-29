# Chrome Web Store submission: Pagewright 1.0.0

Everything needed for the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), in the order the tabs appear. Rebuild the package with `npm run build:store`, and the images with `npm run store:assets` (requires `BROWSER_BIN`, see the README).

## 1. Package

Upload **`dist/pagewright-1.0.0.zip`**.

The store build is the same as the GitHub build except that `browser_evaluate` (running arbitrary JavaScript sent by the agent) is disabled, so the package runs only code it ships with.

## 2. Store listing

**Title** (taken from the manifest): `Pagewright – AI Browser Control & Scraping (MCP)`

**Summary** (taken from the manifest, 126/132 chars): `Let AI agents (Claude Code, Cursor, any MCP client) use your browser: read pages, click, screenshot, fix layouts, scrape data.`

**Category:** Developer Tools

**Language:** English

**Description** (paste as is):

```
Pagewright connects your browser to AI agents through the Model Context Protocol (MCP). Claude Code, Claude Desktop, Cursor, Windsurf, VS Code and any other MCP client can read pages, click, type and take screenshots in the browser you already use, with your existing logins.

WHAT YOUR AGENT CAN DO
• Read any page as a compact outline of headings, text and interactive elements, each with a short reference the agent can click or type into
• Take screenshots of the visible area, the full page, or a single element
• Click, type, pick options, press keys, hover, scroll, upload files and wait for content, using real input events that work with React, Vue and other modern apps
• Open, switch and close tabs, and go back, forward or reload

FIX FRONTENDS FASTER
• Layout audit: finds horizontal overflow and the element causing it, content spilling out of its container, clipped text, elements covered by others, broken or stretched images, low color contrast, tiny text and tap targets, and unlabeled buttons
• Inspect any element: box model, computed styles, and the CSS rules that apply, with file and line number
• Test mobile, tablet and desktop screen sizes
• Try a CSS fix live on the page, then check it with a screenshot before editing your code
• Read console errors and network requests

SCRAPE DATA
• Get any page as clean markdown, a list of links, tables as JSON, or metadata (title, description, OpenGraph, JSON-LD)
• Extract repeated items (products, listings, search results) into structured records
• Follow "next page" buttons and infinite scroll, remove duplicates, and save to CSV or JSON
• See the API requests a page makes and read their JSON responses

PRIVATE BY DESIGN
• Connects only to a server on your own computer (127.0.0.1). Websites cannot connect to it.
• No analytics, no tracking, no accounts. The developer receives none of your data.
• Controlled tabs show Chrome's debugging notice, and you can release any tab from the popup.

SETUP (about a minute)
1. Install Node.js 18 or newer.
2. Run: npx -y github:zamansheikh/browser-mcp setup
   This installs the local MCP server and registers it with Claude Code. For other apps it prints the configuration to paste.
3. Restart your AI app and ask it to run browser_status.

Pagewright is open source (MIT): https://github.com/zamansheikh/browser-mcp

Note: pages built into the browser (chrome:// pages and the Chrome Web Store) cannot be controlled. That is a Chrome restriction.
```

**Graphic assets** (all in `store/images/`):

| Field | File |
|---|---|
| Store icon (128×128) | `store-icon-128.png` |
| Screenshots (1280×800, in this order) | `screenshot-1-hero.jpg`, `screenshot-2-layout.jpg`, `screenshot-3-scraping.jpg`, `screenshot-4-setup.jpg` |
| Small promo tile (440×280) | `promo-small-440x280.jpg` |
| Marquee promo tile (1400×560, optional) | `promo-marquee-1400x560.jpg` |

**Official URL:** leave empty (it needs a site verified in Search Console).
**Homepage URL:** `https://github.com/zamansheikh/browser-mcp`
**Support URL:** `https://github.com/zamansheikh/browser-mcp/issues`
**Mature content:** No

## 3. Privacy

**Single purpose description:**

```
Pagewright lets an AI application running on the user's own computer (an MCP client such as Claude Code or Cursor) read and operate the user's browser tabs: reading page content, taking screenshots, clicking and typing, inspecting layout and styles for web development, and extracting data from pages. It communicates only with a local server on 127.0.0.1 that the user installs and runs.
```

**Permission justifications:**

- **debugger**
  ```
  Required to carry out the user's AI agent commands in the tab it controls: read the page structure, capture screenshots, dispatch real mouse and keyboard input, emulate screen sizes for responsive testing, look up the CSS rules that style an element, and read console messages and network requests for debugging. The extension attaches only when the local agent sends a command, Chrome shows its debugging notice on those tabs, and the user can release any tab from the popup.
  ```
- **tabs**
  ```
  Used to list, open, switch to and close tabs when the user's agent asks, to report each tab's URL and title back to the agent, and to detect when a page has finished loading after navigation.
  ```
- **storage**
  ```
  Stores a single setting: the port number of the local MCP server, which the user can change in the popup.
  ```
- **alarms**
  ```
  Wakes the service worker every 30 seconds to retry connecting to the local server when it is not running yet, so the extension connects without the user having to click anything.
  ```
- **Host permissions:** none are requested.

**Are you using remote code?** No, I am not using remote code.

For the reviewer, if asked: all JavaScript that runs in pages is bundled in the package (`page-lib.js`). The local server sends only command names and JSON parameters. The only feature that evaluated agent-provided JavaScript is disabled in this build (`build-config.js`).

**Data usage.** Tick these data types. The extension reads them from controlled tabs and passes them to the user's own local server:
- ☑ Website content
- ☑ Web history (URLs of controlled tabs and their network requests)

Leave all other types unticked.

Tick all three certifications:
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** `https://github.com/zamansheikh/browser-mcp/blob/main/PRIVACY.md`

## 4. Test instructions (for the reviewer)

No login is needed. Paste into "Additional instructions":

```
Pagewright needs its companion local server, which is open source. To test without any AI app:
1. Install Node.js 18+ (https://nodejs.org) and git.
2. With Chrome open and Pagewright installed, run in a terminal:
   npx -y github:zamansheikh/browser-mcp check
3. The command waits for the extension, opens https://example.com in a background tab, reads the page structure, prints it, and closes the tab. The extension icon shows "ON" while connected, and the popup lists the controlled tab.
To test with an AI app, run "npx -y github:zamansheikh/browser-mcp setup" and follow the printed steps.
Source: https://github.com/zamansheikh/browser-mcp
```

## 5. Distribution

- **Payment:** Free
- **Visibility:** Public. Choose "Unlisted" if you want to try it with friends first.
- **Regions:** All regions

## After you submit

1. The dashboard shows the **item ID** (32 letters) as soon as the draft is created. Send it to me so the installer and README can link to the store page and pin connections to that ID.
2. Review usually takes a few days. The `debugger` permission can make it longer.
3. For each update: bump `version` in both `extension/manifest.json` and `package.json`, run `npm run build:store`, and upload the new zip.
