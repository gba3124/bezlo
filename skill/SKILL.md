---
name: bezlo-preview
description: Render a URL in Bezlo's device presets (iPhone/Android/iPad/desktop) to check mobile layouts, responsive bugs, safe-area/notch handling and horizontal overflow. Use when verifying a web UI on mobile sizes, debugging "it's broken on iPhone/iPad", comparing before/after a CSS fix, or when a task needs a real device-sized screenshot. Works offline against localhost. Chrome emulation, not Safari.
---

# Bezlo preview

Use this skill when you need to **see** a web page at real device sizes or diagnose a mobile layout
problem, without a human opening a browser and resizing it.

## Setup

Repository: `~/Desktop/Project/extensions/real-phone` — the repo folder keeps its original name; the product is **Bezlo**. This skill assumes that path; adapt if moved.

```bash
cd ~/Desktop/Project/extensions/real-phone

# device catalog
node mcp/cli.mjs --list

# one screenshot + diagnostics
node mcp/cli.mjs --url http://localhost:3000 --device iphone16 --out /tmp/shot.png --json
```

The CLI uses Chrome for Testing from the repo's `.browsers/` (or `RP_CHROME`). It works headless and
against localhost.

## When to use

- The user reports a layout bug on iPhone/iPad/Android ("top bar is covered", "sidebar sometimes
  doesn't open", "it's cut off on mobile").
- You changed CSS and want to check 2–3 device sizes before claiming a fix.
- You need a screenshot for a report/PR description at device resolution.
- You need to confirm a page has **no horizontal overflow** at 393/430/820 px.

## Workflow

1. `node mcp/cli.mjs --list` → pick a device id (e.g. `ip16`, `ip15pm`, `ipadpro11`, `px10`).
2. Capture **before** state (if you have a baseline) and note `layout.overflowX`,
   `layout.overflowOffenders`, `layout.safeArea`.
3. Make the change.
4. Capture again at the same device; compare the JSON and look at the PNG (open it with the image
   viewer/read tool).
5. Report: device, viewport, before/after overflow offenders, and the screenshot path.

Engine: default `chromium` (the extension's engine). Add `--engine webkit` for a Safari-flavoured
render when the task is about CSS support / Safari layout, but say clearly it is *not* real iOS Safari.
WebKit sessions don't record video or expose the CDP a11y tree.

Useful flags:

```bash
--full-page        # whole scrollable page
--dark             # prefers-color-scheme: dark
--scroll 600       # scroll before capture
--selector "#app"  # wait for an element before capture
--inspect          # JSON only, no image (cheaper)
```

## Interpreting the output

- `layout.overflowX === true` → the page scrolls horizontally on that device; `overflowOffenders`
  names the elements past the device width (right edge in CSS px). This is the most common mobile
  layout bug; fix the offender's width/max-width or a fixed-position element.
- `layout.safeArea.top > 0` → the page sees a non-zero top inset (`env(safe-area-inset-top)`).
  In plain Chrome headless this is usually `0` (there is no notch around the viewport) — do not
  conclude "safe-area is fine" from a 0 in this CLI; use the extension's framed simulator or a real
  device for that.
- `layout.media['pointer:coarse']` / `hover:none` → the page sees a touch device. If a UI component
  only appears on hover, it is effectively unreachable on this device — a real bug to report.
- `layout.viewport` vs `device.width`: Chrome mobile emulation can widen the layout viewport to fit
  wide content; that's why the CLI compares overflow against the **device width** (`referenceWidth`).

## Caveats to state in your report

- Chrome emulation ≠ Safari/iOS: rendering and iOS-specific behaviours are approximations.
- No interaction yet (tap/scroll/type) — this skill renders and waits only.
- Dynamic SPAs: use `--selector` or `--wait` before trusting the screenshot.

## Interacting (v0.2): see → act → see

When the task needs a flow (open a menu, sign in, submit a form), don't stop at one screenshot:

1. `session_start` (MCP) or `--actions` (CLI) to open the page at the device.
2. Read the observation's `elements` list. Prefer clicking by **index** (`e3`) from the *latest*
   observation; fall back to `text` when the element is clearly labeled. Re-observe after every
   action — the returned observation is fresh.
3. After each action check: did the screenshot change? Are there `errors` (console/page)? Did the
   URL change? Then decide the next action.
4. End the session (`session_end`) when done; sessions expire after 10 idle minutes.

MCP example flow:

> `session_start {url: "http://localhost:3000", device: "iphone16"}`
> → elements show a "Sign in" button
> `session_act {sessionId, action: {type: "click", index: 2}}`
> → observation: drawer opened (or error)
> `session_act {sessionId, action: {type: "type", selector: "#email", value: "a@b.c", submit: true}}`
> → new observation; check errors + screenshot

Limitations to state: clicks are Chromium touch/mouse emulation (not Safari), no network mocking yet,
dialogs are auto-dismissed and reported as errors, and each action is one user gesture (no drag/gesture
chains yet).

## Verification & faster loops (v0.3)

- **Matrix**: `capture_matrix {url, devices:["iphone16","ipadpro11","px10"]}` → compare layouts in one call
  (same overflow offenders? which device breaks first?).
- **Assert instead of eyeballing**: after actions call `session_assert` with explicit checks, e.g.
  `[{type:"visible", text:"Save"},{type:"text", selector:"#toast", contains:"Saved"},{type:"noOverflow"},{type:"noConsoleErrors"}]`
  — report the structured pass/fail, not "looks fine".
- **One-call flows**: `run_flow {url, device, steps:[…], screenshots:"all"}` returns a step report (action
  result, URL, errors, network) + final image; use it for regression checks and PR evidence.
- **Network failures** are in every observation (`network[]`); mention 4xx/5xx/failed requests in your report.
- **A11y**: `a11y.nodes` gives role+name — prefer asserting on roles/names over pixels.
- **Shadow DOM**: elements from open shadow roots appear with `shadowHost` and are clickable; same-origin
  iframe content is listed but not yet actionable.

## Mocks, recording, CI (v0.4)

- **Test error/empty states without a backend**: `session_route {sessionId, pattern:"**/api/items", response:{status:500,json:{error:"boom"}}}`
  then reload/act, observe, `session_route_clear`.
- **iframes**: elements from frames show `frameUrl`; pass their index like any other element (actions resolve per frame).
- **Evidence for a PR**: `run_flow {…, record:true, assert:[…]}` returns `video` (mp4), `gif`, `reportFile`
  (JSON) and `junitFile` (JUnit XML). Attach these to the report instead of prose.
- **One-call regression**: steps + asserts + screenshots in `run_flow`; treat `pass:true` as the gate.

## CI (v0.5)

If the repo uses the Bezlo composite action (`gba3124/bezlo@main`), the same flow can run in a
workflow with `url / device / steps / asserts / record` and produces `report.json`, `junit.xml`, a final
screenshot and an optional mp4/gif. Point the user at `examples/ai-test.yml` and treat
`steps.<id>.outputs.pass` as the gate.

## MCP alternative

If the agent has MCP tools configured (`claude mcp add bezlo -- node …/mcp/server.mjs`), prefer
the `capture_page` tool: it returns the image as an MCP image content block plus the same metadata.
