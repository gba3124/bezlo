# Bezlo MCP — let agents use the device simulator directly

Bezlo's device presets + layout knowledge, exposed as a **CLI** and an **MCP server**, so an
LLM/agent can render a URL on a real device preset, get a PNG it can actually see, and get layout
diagnostics (horizontal overflow, safe-area insets, touch identity) — without a human driving the
extension UI.

```
agent ──MCP tools──▶ bezlo server ──Playwright/CFT──▶ page at 393×852 @3x
   ◀── image + {overflow, offenders, safeArea, media, viewport} ──┘
```

## Quick start

```bash
cd /path/to/real-phone   # this repo folder (still named real-phone)

# 1) CLI (works in any agent/skill/script)
node mcp/cli.mjs --url https://example.com --device iphone16 --out shot.png
node mcp/cli.mjs --url http://localhost:3000 --device "iPad Pro 11" --full-page --json
node mcp/cli.mjs --list

# 2) MCP server (Claude Code / Claude Desktop / Cursor …)
claude mcp add bezlo -- node "$PWD/mcp/server.mjs"
```

Tools exposed over MCP stdio:

| tool | args | returns |
|---|---|---|
| `list_devices` | `category?` | preset list (id/name/width/height/dpr/os) |
| `capture_page` | `url`, `device?`, `fullPage?`, `waitMs?`, `selector?`, `darkMode?`, `scrollY?` | text metadata + `image/png` content block |
| `inspect_page` | same minus image | layout diagnostics only |
| `session_start` | `url`, `device?`, `darkMode?`, `waitMs?`, `selector?` | first observation: image + elements + layout + errors |
| `session_observe` | `sessionId` | fresh observation (no action) |
| `session_act` | `sessionId`, `action` | performs one action and returns the new observation |
| `session_end` | `sessionId` | closes the session |
| `capture_matrix` | `url`, `devices[]`, `fullPage?`, `waitMs?` | one screenshot + layout per device (1–6 devices) |
| `session_assert` | `sessionId`, `checks[]` | structured pass/fail checks on a live session |
| `run_flow` | `url`, `device?`, `steps[]`, `screenshots?`, `record?`, `asserts[]` | executes a whole flow in one call; step report + final image + report.json/JUnit + optional video/gif |
| `session_route` | `sessionId`, `pattern`, `response` | mock a network response (status/json/body/abort) |
| `session_route_clear` | `sessionId` | remove all mocks |

### v0.2 — see **and** act

An observation contains:

- **screenshot** (viewport, device pixels) as an MCP image block
- **elements**: up to 80 visible interactive elements, each `{ref, tag, role, name, selector, rect, inViewport, disabled, href, inputType, value}` — `ref` is `e1…eN` for the latest observation
- **layout**: overflow, offenders, safe-area, media features, scroll position, screen/viewport
- **errors**: console errors / page errors / dialogs since the previous observation
- **action**: the result of the last action (ok / clicked / typed / error)

`session_act.action` supports:

| type | fields |
|---|---|
| `click` | `index` (preferred), or `text`, `selector`, `role`+`name`, or `x`+`y` |
| `type` | `index` \| `selector` \| `text` (label), `value`, `submit?` |
| `scroll` | `dy` |
| `press` | `key` |
| `goto` | `url`, `waitMs?`, `selector?` |
| `back` / `reload` / `wait` | `ms` for wait |

Click-by-text prefers a real `button`/`link` over a `<label>` with the same word, so form
labels don't swallow the click. Sessions expire after 10 minutes idle; max 3 open at once.

### v0.3 — test-grade observations & one-call flows

- **Network**: each observation reports failed requests and HTTP ≥ 400 (`kind: failed|http`, url, status).
- **Accessibility**: a compact AX list (`role`, `name`, `depth`) from CDP — better than pixels for "is the
  button labeled?" questions.
- **Shadow DOM**: elements inside open shadow roots are collected with a `shadowHost` selector and are
  clickable/typable; same-origin iframe content is listed (actions there are not wired yet).
- **`capture_matrix`**: same URL on 1–6 devices in one call — iPhone/iPad/Android side by side.
- **`session_assert`**: checks `visible` / `text`(contains) / `inputValue`(equals) / `urlIncludes` /
  `noOverflow` / `noConsoleErrors` / `elementCount`(min) → returns `{pass, results[]}`.
- **`run_flow`**: open + N actions + optional per-step screenshots + final image; each step reports
  action result, URL, title, errors, network.

### v0.4 — iframes, mocks, recording, CI reports

- **iframes**: elements inside frames are collected via Chrome DevTools frames (same-origin and cross-origin;
  an element carries `frameUrl`/`frameIndex`) and actions resolve back to the right frame.
- **Network mocks**: `session_route` (glob + status/json/body/abort) and `session_route_clear`; use it to test
  empty/error/loading states without a backend.
- **Recording**: `run_flow {record:true}` → CDP screencast → `session-*.mp4` + `flow.gif` (homebrew ffmpeg;
  no Playwright ffmpeg dependency).
- **CI reports**: every `run_flow` writes `outDir/report.json` (steps, asserts, pass, files) and
  `outDir/junit.xml`; `pass` is false if any action failed or any assert failed.
- **Assertions in flows**: `run_flow {asserts:[…]}` evaluates checks after the last step and folds them into
  the pass/fail + JUnit output.

CLI equivalents:

```bash
# matrix
node mcp/cli.mjs --url http://localhost:3000 --matrix --devices iphone16,ipadpro11,px10 --out /tmp/matrix
```

CLI equivalent (single device actions):

```bash
node mcp/cli.mjs --url http://localhost:3000 --device iphone16 \
  --actions '[{"type":"click","text":"Sign in"},{"type":"type","selector":"#password","value":"secret","submit":true}]' \
  --out /tmp/after-signin.png --json
```

`capture_page` metadata includes:

- `device` (preset), `screenshot` (bytes, pixel size), `savedTo`
- `layout.viewport/screen/devicePixelRatio/language/platform/maxTouchPoints`
- `layout.media` (`hover:none`, `pointer:coarse`, `prefers-dark`)
- `layout.safeArea` (`env(safe-area-inset-top/left)` probe)
- `layout.overflowX` + `layout.overflowOffenders` (tag/id/class/right, up to 8)

## Engines: chromium (default) and webkit

Every capture/session/flow accepts `engine`:

- **chromium** (default) — Chrome for Testing, the same emulation engine the extension's
  device frames use. Full mobile identity (touch/DPR/UA), CDP a11y trees and screen recording.
- **webkit** — Playwright WebKit, a **Safari-flavoured approximation** for CSS/feature checks
  (`engine:"webkit"` in MCP tools, `--engine webkit` in the CLI, `engine: webkit` in the action).
  It is still not real iOS Safari; a11y trees and video recording are Chromium-only (sessions
  report a `recordNote` instead of silently skipping).

```bash
node mcp/cli.mjs --url https://example.com --device iphone16 --engine webkit --out wk.png
node mcp/cli.mjs --url https://example.com --matrix --devices iphone16,ipadpro11 --engine webkit --out wk-matrix
```

## Why this exists

- **The extension is human-driven.** Agents can't click its UI; they *can* call an MCP server.
- **One source of truth.** Device presets and UA identities are imported from
  `extension/stage/devices.js` / `extension/stage/ua.js` — the same data the simulator renders.
- **A screenshot is the highest-bandwidth signal** for an agent checking a layout; the numeric
  diagnostics tell it *why* something is wrong (which element overflows, by how much).

## Skills

`skill/SKILL.md` is a portable skill (Claude Code / any skills-compatible agent) that teaches an
agent when to use the CLI and how to interpret the output. Copy it to `~/.claude/skills/bezlo/`
or reference it from a repo-local skill.

## Limitations (honest)

- **Chrome's emulation engine, not Safari.** Viewport/DPR/UA/touch are emulated; WebKit rendering and
  iOS-only behaviour (safe-area in a real notch, rubber-banding, Safari quirks) stay approximations.
  The extension's framed simulator shows device frames; the CLI reports `safe-area` as the page sees it
  (Chrome headless = 0 because there is no notch around the viewport).
- **No interaction yet** (v2): tap/scroll typing/video capture. Today it renders and waits.
- Needs Chrome/Chrome for Testing (`.browsers/` bundled in this repo, or `RP_CHROME`).
- **Distribution**: npm package `bezlo-mcp` (bins: `bezlo-mcp` = MCP server, `bezlo` = CLI), MCP registry
  name `io.github.gba3124/bezlo-mcp`, GitHub Action `gba3124/bezlo@main`. See `PUBLISHING.md`.
- Not published to npm yet; the MCP server is local-path only.

## Roadmap

0. **v0.4 — iframes/mocks/recording/CI (done)**: frame actions, route mocks, mp4+gif via screencast,
   report.json + JUnit.
1. **v0.2 — interaction (done)**: tap/type/scroll/press/goto + observations with elements & errors.
1. **v0.3 — test-grade observation (done)**: network failures, a11y snapshot, shadow DOM, matrix, asserts,
   one-call `run_flow`.
2. **v0.4 — iframes + video + network mocking**: same-origin iframe actions, step screenshots as a video/GIF,
   mocked responses, WebKit pass.
3. **v0.5 — distribution**: npm package, MCP registry, skill marketplace, CI reporter (JSON+JUnit).
4. **Later — hosted/cloud devices**, multi-session parallel matrix.

### Legacy notes (v0.2 planning) `tap`, `scroll`, `type`, `press` tools (Playwright) so an agent can walk a
   flow, not just look at one screen.
2. **v0.3 — before/after**: `compare(url, {fixRef})` returning side-by-side + overflow diff; great
   for regression checks in PRs.
3. **v0.4 — WebKit pass**: optional Playwright WebKit engine for a Safari-flavoured render (still not
   real iOS, but closer for CSS support).
4. **Distribution**: npm package + MCP registry listing + skill marketplace; free v1 for adoption,
   Pro later for batch/CI/cloud devices.


---

## Extension panel (AI 測試)

The extension ships an options page (`ai/ai.html`, `options_ui.open_in_tab: true`) aimed at
developers: it explains the MCP/Claude Code setup, the CLI commands (matrix / actions / record /
assert), the full tool list, and the honest limitations (Chrome emulation, local-only). The toolbar
popup has a small **AI** button that opens it. It makes **no external requests**.

Quick path: `chrome://extensions` → Bezlo → Details → Extension options → *AI testing*.

## GitHub Actions

`action.yml` at the repo root is a composite action: it installs Node 22 + Playwright Chromium, maps
`RP_CHROME`, runs one flow, and uploads artifacts.

```yaml
- uses: gba3124/bezlo@main
  id: bezlo
  with:
    url: http://localhost:3000
    device: iphone16
    steps: |
      [{"type":"click","text":"Sign in"},
       {"type":"type","selector":"#email","value":"qa@example.com","submit":true}]
    asserts: |
      [{"type":"noOverflow"},{"type":"noConsoleErrors"}]
    record: 'true'
```

Outputs: `pass`, `report` (report.json), `junit` (JUnit XML), `video` (mp4), `gif`, `screenshot`
(final.png), `artifacts` (directory, default `bezlo-artifacts`). The upload step publishes it as the
`bezlo-ai-test` artifact. The action also writes a markdown table to
`$GITHUB_STEP_SUMMARY`. See `examples/ai-test.yml` for a full PR workflow (dev server + comment).

Locally you can simulate the action exactly:

```bash
GITHUB_WORKSPACE=/tmp/bezlo GITHUB_OUTPUT=/tmp/bezlo/out.txt \
INPUT_URL=http://localhost:3000 INPUT_STEPS='[{"type":"click","text":"Sign in"}]' \
INPUT_ASSERTS='[{"type":"noOverflow"}]' node mcp/action-run.mjs
```
