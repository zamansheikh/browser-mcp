# Security policy

Pagewright lets AI agents control a real browser, so security reports matter a lot to us.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub instead: go to the [Security tab](https://github.com/zamansheikh/browser-mcp/security/advisories/new) and click **Report a vulnerability**.

Please include:

- what an attacker can do, and under which conditions (for example "a web page can …" or "another local user can …")
- steps or a proof of concept that reproduces it
- the Pagewright version, browser and operating system

You'll get a reply within a few days. We'll keep you updated while we work on a fix, and credit you in the release notes if you'd like.

## Supported versions

Security fixes go into the latest release. Please update before reporting.

## In scope

Especially important:

- a website, or any origin other than the local server, being able to send commands to the extension or read what it returns
- anything that bypasses the local-only design, such as the hub being reachable from another machine
- the extension acting on tabs without a command from a connected agent
- the Chrome Web Store build running code that is not in its package

Not in scope: what a connected AI agent chooses to do. Agents have the access you give them, by design, so only connect agents you trust.
