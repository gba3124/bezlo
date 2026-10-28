#!/usr/bin/env node
// Bezlo MCP — stdio MCP server (zero dependencies).
//
// MCP stdio transport: newline-delimited JSON-RPC 2.0 messages on stdin/stdout.
// Tools:
//   list_devices  — the device presets (id, name, size, dpr)
//   capture_page  — screenshot a URL at a device preset + layout diagnostics
//   inspect_page  — layout diagnostics only (no image; lighter for quick checks)
//
// Wire into an MCP client (Claude Code / Claude Desktop / Cursor):
//   claude mcp add bezlo -- node /path/to/real-phone/mcp/server.mjs
//
// Env: RP_CHROME (browser executable), RP_OUT_DIR (where screenshots are saved).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { capturePage, inspectPage, captureMatrix } from './capture.mjs';
import { devices } from './devices.mjs';
import { startSession, observe, act, endSession, endAllSessions, listSessions, getSession, assertChecks, runFlow, addRoute, clearRoutes } from './session.mjs';

const NAME = 'bezlo';
const VERSION = '0.1.2';
const OUT_DIR = process.env.RP_OUT_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), 'out');

const tools = [
  {
    name: 'list_sessions',
    description: 'List open interactive sessions (id, url, device).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_devices',
    description: 'List the Bezlo device presets (iPhone, Android, iPad, desktop) with width/height/dpr. Pass an optional category to filter.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['iphone', 'android', 'tablet', 'desktop'], description: 'Optional category filter' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'capture_page',
    description:
      'Render a URL in Chrome for Testing with a real device preset (viewport, DPR, mobile UA/touch) and return a PNG screenshot plus layout diagnostics ' +
      '(horizontal overflow + offending elements, safe-area insets, media features, viewport/screen sizes). Use it to check mobile/web layouts, responsive bugs, and before/after fixes.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to render' },
        device: { type: 'string', description: 'Device id or name, e.g. iphone16, "iPhone 15 Pro", ipadpro11, px10 (default iphone16)' },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default: viewport only)' },
        waitMs: { type: 'number', description: 'Extra wait after load before capture (default 1200)' },
        selector: { type: 'string', description: 'Wait for this CSS selector before capture' },
        darkMode: { type: 'boolean', description: 'Render with prefers-color-scheme: dark' },
        scrollY: { type: 'number', description: 'Scroll to this Y offset before capture' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_matrix',
    description: 'Capture the same URL on several device presets in one call (matrix). Returns each device screenshot + layout; use it to compare iPhone/iPad/Android side by side.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        devices: { type: 'array', items: { type: 'string' }, description: 'Device ids/names (1–6), e.g. ["iphone16","ipadpro11","px10"]' },
        fullPage: { type: 'boolean' },
        waitMs: { type: 'number' },
        selector: { type: 'string' },
        engine: { type: 'string', enum: ['chromium', 'webkit'] },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_assert',
    description: 'Assert checks against an open session and return pass/fail per check. Checks: visible, text (contains), inputValue (equals), urlIncludes, noOverflow, noConsoleErrors, elementCount (min). Use after actions to verify a flow.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['visible', 'text', 'inputValue', 'urlIncludes', 'noOverflow', 'noConsoleErrors', 'elementCount'] },
              index: { type: 'number' },
              selector: { type: 'string' },
              text: { type: 'string' },
              role: { type: 'string' },
              name: { type: 'string' },
              contains: { type: 'string' },
              equals: { type: 'string' },
              value: { type: 'string' },
              min: { type: 'number' },
            },
            required: ['type'],
            additionalProperties: true,
          },
        },
      },
      required: ['sessionId', 'checks'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_flow',
    description: 'Open a session, execute a list of actions in one call, and return a compact step report plus the final screenshot (optionally a screenshot per step). Use it to run a whole test flow: sign in, open a drawer, submit a form — then inspect the report.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        device: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' }, description: 'Action objects, same schema as session_act action' },
        screenshots: { type: 'string', enum: ['final', 'all', 'none'], description: 'Save final only (default), every step, or none' },
        record: { type: 'boolean', description: 'Record a webm video of the flow (and a gif when ffmpeg is available)' },
        engine: { type: 'string', enum: ['chromium', 'webkit'], description: 'Chromium (default) records video; webkit is a Safari-flavoured approximation' },
        asserts: {
          type: 'array',
          description: 'Assertions evaluated after the last step (same schema as session_assert checks)',
          items: { type: 'object' },
        },
      },
      required: ['url', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_route',
    description: 'Mock a network response for an open session (Playwright route). Give a URL pattern/glob and {status, json|body|contentType|headers} or {abort:true}. Use it to test error states without a real backend.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        pattern: { type: 'string', description: 'URL glob, e.g. **/api/items or **/missing.png' },
        response: {
          type: 'object',
          properties: {
            status: { type: 'number' },
            json: { type: 'object' },
            body: { type: 'string' },
            contentType: { type: 'string' },
            headers: { type: 'object' },
            abort: { type: ['boolean', 'string'] },
          },
          additionalProperties: true,
        },
      },
      required: ['sessionId', 'pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_route_clear',
    description: 'Remove all network mocks from a session.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
  },
  {
    name: 'session_start',
    description:
      'Open an interactive device session on a URL (iPhone/Android/iPad preset). Returns the first observation: screenshot, labeled interactive elements (refs e1..eN with selector/role/name/rect), layout diagnostics, and console/page errors. Use session_act to tap/type/scroll, then read the fresh observation it returns.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        device: { type: 'string', description: 'Device id or name (default iphone16)' },
        darkMode: { type: 'boolean' },
        waitMs: { type: 'number', description: 'Wait after load before the first observation (default 800)' },
        selector: { type: 'string', description: 'Wait for this selector before observing' },
        engine: { type: 'string', enum: ['chromium', 'webkit'], description: 'webkit gives a Safari-flavoured approximation (no recording/CDP a11y)' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_observe',
    description: 'Re-observe an open session: fresh screenshot, interactive element list, layout diagnostics, scroll position, and any console/page errors since the last call.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
  },
  {
    name: 'session_act',
    description:
      'Perform one action in a session and return the new observation (screenshot + elements + errors). Actions: click (index | text | selector | role+name | x+y), type (target + value + submit?), scroll (dy?), press (key), goto (url), back, reload, wait (ms). Prefer the `index` of an element from the latest observation.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['click', 'type', 'scroll', 'press', 'goto', 'back', 'reload', 'wait'] },
            index: { type: 'number', description: 'Element index from the latest observation (1-based)' },
            text: { type: 'string', description: 'Visible text to match (click target or input label)' },
            selector: { type: 'string' },
            role: { type: 'string' },
            name: { type: 'string' },
            value: { type: 'string', description: 'Text for type' },
            submit: { type: 'boolean', description: 'Press Enter after typing' },
            dy: { type: 'number', description: 'Scroll delta in CSS px' },
            key: { type: 'string' },
            url: { type: 'string' },
            ms: { type: 'number' },
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['type'],
          additionalProperties: true,
        },
      },
      required: ['sessionId', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_end',
    description: 'Close an interactive session and its browser.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'], additionalProperties: false },
  },
  {
    name: 'inspect_page',
    description: 'Same device-preset render as capture_page but returns only layout diagnostics (no image) — cheaper for quick overflow/safe-area checks.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        device: { type: 'string' },
        waitMs: { type: 'number' },
        selector: { type: 'string' },
        darkMode: { type: 'boolean' },
        scrollY: { type: 'number' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

function text(s) {
  return { type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) };
}

function savePng(png, device) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${device}.png`);
  fs.writeFileSync(file, png);
  return file;
}

function obsBlocks(obs, extra = {}) {
  const { screenshot, ...meta } = obs;
  return {
    content: [
      text({ ...meta, ...extra, screenshot: screenshot ? { mimeType: screenshot.mimeType, bytes: screenshot.bytes } : undefined }),
      ...(screenshot ? [{ type: 'image', data: screenshot.base64, mimeType: screenshot.mimeType }] : []),
    ],
  };
}

async function callTool(name, args = {}) {
  if (name === 'capture_matrix') {
    const items = await captureMatrix(args);
    const content = [{ type: 'text', text: JSON.stringify({ count: items.length, devices: items.map((i) => ({ device: i.device, layout: i.meta.layout, screenshot: { bytes: i.png.length } })) }, null, 2) }];
    for (const i of items) content.push({ type: 'image', data: i.png.toString('base64'), mimeType: 'image/png' });
    return { content };
  }
  if (name === 'session_route') {
    const s = getSession(args.sessionId);
    return { content: [text(await addRoute(s, { pattern: args.pattern, response: args.response || {} }))] };
  }
  if (name === 'session_route_clear') {
    const s = getSession(args.sessionId);
    return { content: [text(await clearRoutes(s))] };
  }
  if (name === 'session_assert') {
    const s = getSession(args.sessionId);
    return { content: [text(await assertChecks(s, args.checks || []))] };
  }
  if (name === 'run_flow') {
    const out = await runFlow(args);
    const { screenshot, ...finalMeta } = out.final;
    const report = {
      pass: out.pass,
      steps: out.steps,
      asserts: out.asserts,
      files: out.files,
      video: out.video,
      gif: out.gif,
      reportFile: out.reportFile,
      junitFile: out.junitFile,
      final: { ...finalMeta, device: out.final.device, layout: out.final.layout, elements: out.final.elements.slice(0, 40), a11y: out.final.a11y },
      outDir: out.outDir,
    };
    return { content: [text(report), { type: 'image', data: screenshot.base64, mimeType: screenshot.mimeType }] };
  }
  if (name === 'session_start') {
    const out = await startSession(args);
    return obsBlocks(out);
  }
  if (name === 'session_observe') {
    const s = getSession(args.sessionId);
    return obsBlocks(await observe(s));
  }
  if (name === 'session_act') {
    const s = getSession(args.sessionId);
    const out = await act(s, args.action || {});
    return obsBlocks(out);
  }
  if (name === 'session_end') {
    return { content: [text(await endSession(args.sessionId))] };
  }
  if (name === 'list_sessions') {
    return { content: [text({ sessions: listSessions() })] };
  }
  if (name === 'list_devices') {
    const list = args.category ? devices.filter((d) => d.category === args.category) : devices;
    return { content: [text({ count: list.length, devices: list })] };
  }
  if (name === 'capture_page' || name === 'inspect_page') {
    if (name === 'inspect_page') {
      const meta = await inspectPage(args);
      return { content: [text(meta)] };
    }
    const { png, meta } = await capturePage(args);
    const file = savePng(png, meta.device.id);
    return {
      content: [
        text({ ...meta, savedTo: file }),
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ],
    };
  }
  throw new Error(`unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------
let buf = '';
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return; // notification, no id
  if (method === 'ping') {
    if (id !== undefined) reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await callTool(name, args);
      reply(id, result);
    } catch (e) {
      reply(id, { isError: true, content: [text(`Error: ${e && e.message ? e.message : e}`)] });
    }
    return;
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, -32700, 'parse error');
      continue;
    }
    void handle(msg);
  }
});
process.stdin.on('end', () => { void endAllSessions().finally(() => process.exit(0)); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { void endAllSessions().finally(() => process.exit(0)); });
