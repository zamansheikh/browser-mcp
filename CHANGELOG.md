# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Contributor docs: contributing guide, code of conduct, security policy, issue and PR templates.
- CI: smoke tests on Node 18, 20 and 22, and the full browser suite on Linux.
- `docs/TOOLS.md`, generated from the tool definitions (`npm run docs`).
- Animated demo (`npm run demo:gif`).

## [1.0.1] - 2026-09-29

### Changed
- Chrome Web Store listing: removed third-party product names from the summary, description and images.

## [1.0.0] - 2026-09-29

### Added
- Extension renamed **Pagewright**, and prepared for the Chrome Web Store (`npm run build:store`). The store build disables `browser_evaluate`.
- `check` command: a self-test that needs no AI app.
- Several browsers can be connected: the first is active, the others wait on standby and take over in order.

### Fixed
- One browser could open two connections to the server at the same time.
- Snapshot text now keeps the page's real spacing (no more "T h i s" on pages that wrap each letter).
- Values returned from pages keep their key order, so CSV columns follow the requested field order.
- Clicks work when mobile emulation zooms the page out.
- `browser_navigate` reports the HTTP status of the page.

## [0.1.0] - 2026-09-29

### Added
- First release: an MCP server and Chromium extension with 25 tools for snapshots, screenshots, input, layout audits, CSS inspection, console and network, and scraping.
- Local hub shared by several agents, with automatic failover.
- One-command installer: `npx -y github:zamansheikh/browser-mcp setup`.

[Unreleased]: https://github.com/zamansheikh/browser-mcp/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/zamansheikh/browser-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/zamansheikh/browser-mcp/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/zamansheikh/browser-mcp/releases/tag/v0.1.0
