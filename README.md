# Bezlo — open agent layer

Bezlo puts any web page inside a true-to-size iPhone / iPad / Android frame and lets an
**AI agent** see it and act on it: screenshots, interactive-element lists, layout
diagnostics (overflow, safe-area, touch identity), console/page errors, network mocks,
tap/type/scroll flows, device matrix runs — and `report.json` / JUnit / mp4 evidence.

This repository is the **MIT-licensed agent layer**:

- `mcp/` — MCP stdio server + CLI + session/capture engine (also on npm as [`bezlo-mcp`](https://www.npmjs.com/package/bezlo-mcp))
- `action.yml` + `examples/` — composite GitHub Action (PR screenshots + JUnit + video)
- `skill/` — the `bezlo-preview` skill for Claude Code / skills-compatible agents
- `server.json` — official MCP registry manifest
- `docs/MCP.md` — full tool reference

The **Chrome extension itself is proprietary** and lives in a separate private repo
(`extension/`, store art, brand). This repository contains no extension code, store
assets or brand artwork. The name **Bezlo** and its logo are not licensed for reuse.

## Install

```bash
# MCP (Claude Code / Claude Desktop / Cursor)
npm install -g bezlo-mcp
claude mcp add bezlo -- npx -y bezlo-mcp

# or run from a checkout
node mcp/cli.mjs --list
```

The package bundles no browser: install Chrome/Chromium (or set `RP_CHROME`). Chrome for
Testing is recommended; WebKit mode additionally needs `npx playwright install webkit`.

## Quick CLI

```bash
node mcp/cli.mjs --url http://localhost:3000 --device iphone16 --out shot.png
node mcp/cli.mjs --url http://localhost:3000 --matrix --devices iphone16,ipadpro11,px10 --out ./matrix
node mcp/cli.mjs --url http://localhost:3000 \
  --actions '[{"type":"click","text":"Sign in"},{"type":"type","selector":"#email","value":"a@b.c","submit":true}]' \
  --record --assert '[{"type":"noOverflow"},{"type":"noConsoleErrors"}]' --out after.png
```

## GitHub Action

```yaml
- uses: gba3124/bezlo@main
  id: bezlo
  with:
    url: http://localhost:3000
    device: iphone16
    steps: '[{"type":"click","text":"Sign in"}]'
    asserts: '[{"type":"noOverflow"},{"type":"noConsoleErrors"}]'
    record: 'true'
```

Artifacts: final screenshot, `report.json`, `junit.xml`, optional `mp4`/`gif`.
Outputs: `pass`, `report`, `junit`, `video`, `gif`, `screenshot`, `artifacts`.

## Engines

- **chromium** (default) — Chrome's own emulation engine (same as the extension's frames): real
  touch, mobile UA and client hints, DPR; full recording and CDP accessibility.
- **webkit** — Playwright WebKit, a Safari-flavoured approximation (not real iOS Safari; no
  recording / CDP a11y).

## License

MIT — see `LICENSE`. The Chrome extension, store assets and the Bezlo brand are not
covered by this license and are not part of this repository.
