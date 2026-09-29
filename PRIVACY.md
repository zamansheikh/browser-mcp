# Pagewright privacy policy

_Effective September 29, 2026_

Pagewright is a browser extension that lets an AI application running on your own computer (for example Claude Code, Claude Desktop or Cursor) read and control your browser tabs through the open-source `browser-mcp` server. This policy covers the extension and the `browser-mcp` server published at https://github.com/zamansheikh/browser-mcp.

## Summary

- The developer of Pagewright does not collect, receive, store, sell or share any of your data.
- The extension has no analytics, no tracking, no advertising, and no accounts.
- The extension only connects to a server on your own computer (`127.0.0.1`). It never connects to any remote server.

## What the extension handles

When an AI application you have connected sends a command, the extension may read the following from the tab being controlled, and pass it to the `browser-mcp` server on your computer:

- page content: text, links, form fields, page structure and styles
- screenshots of the page
- the tab's URL and title
- console messages and network request details (URLs, status codes, and response bodies on request) for pages the agent has opened or interacted with

Nothing is read until you run an AI application with the `browser-mcp` server and it sends a command. Tabs under control show Chrome's "started debugging this browser" notice. You can release any tab from the extension's popup at any time.

## Where the data goes

Data goes only to the `browser-mcp` server running on your computer at `ws://127.0.0.1` (port 18800 by default). The server hands it to the AI application you connected it to. That application, and any AI service it uses, handles the data under its own privacy policy. Only connect AI applications you trust.

The server rejects connections from websites, so web pages cannot use it to read or control your browser.

## Storage

- `chrome.storage.local` stores one setting: the port number of the local server.
- Console messages and network request details for controlled tabs are kept in memory only. They are discarded when the browser or the extension restarts.
- The `browser-mcp` server writes files only when your AI application asks it to (for example, saving a screenshot or scraped data to a path you chose).

## Permissions

| Permission | Why it is needed |
|---|---|
| `debugger` | To read page content, take screenshots, send real clicks and key presses, emulate screen sizes, and show console/network activity in the tabs your AI application controls. |
| `tabs` | To list, open, switch and close tabs when your AI application asks, and to know when a page has finished loading. |
| `storage` | To remember the local server port you set in the popup. |
| `alarms` | To periodically retry connecting to the local server while it is not running. |

## Children

Pagewright is a developer tool and is not directed at children under 13.

## Changes

Changes to this policy will be published in this file, with a new effective date. The history of this file is public on GitHub.

## Contact

Please open an issue at https://github.com/zamansheikh/browser-mcp/issues.

The use of information received by the extension complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.
