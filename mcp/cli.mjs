#!/usr/bin/env node
// Bezlo MCP — CLI (same engine as the MCP server, for skills / scripts).
//
//   node mcp/cli.mjs --list
//   node mcp/cli.mjs --url https://example.com --device iphone16 --out shot.png
//   node mcp/cli.mjs --url http://localhost:3000 --device "iPhone 15 Pro" --full-page --dark --json
//   node mcp/cli.mjs --url https://example.com --device ipadpro11 --inspect
//
// Outputs a JSON summary on stdout (--json) or a short human line; image bytes go
// to --out (default: ./.bezlo/<device>-<timestamp>.png).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { capturePage, inspectPage, captureMatrix, ENGINES } from './capture.mjs';
import { runFlow } from './session.mjs';
import { devices } from './devices.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === '--url') out.url = take();
    else if (a === '--device' || a === '-d') out.device = take();
    else if (a === '--out' || a === '-o') out.out = take();
    else if (a === '--wait') out.waitMs = Number(take());
    else if (a === '--selector') out.selector = take();
    else if (a === '--actions') out.actions = take();
    else if (a === '--engine') out.engine = take();
    else if (a === '--matrix') out.matrix = true;
    else if (a === '--devices') out.devices = take();
    else if (a === '--record') out.record = true;
    else if (a === '--assert') out.asserts = take();
    else if (a === '--scroll') out.scrollY = Number(take());
    else if (a === '--full-page') out.fullPage = true;
    else if (a === '--dark') out.darkMode = true;
    else if (a === '--inspect') out.inspect = true;
    else if (a === '--json') out.json = true;
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.engine && !ENGINES.includes(args.engine)) {
  console.error(`--engine must be one of ${ENGINES.join(', ')}`);
  process.exit(2);
}
if (args.help || (!args.list && !args.url)) {
  console.log(`usage: node mcp/cli.mjs --url <http(s) URL> [--device iphone16] [--engine chromium|webkit] [--out shot.png] [--full-page] [--dark] [--json] [--inspect]
       node mcp/cli.mjs --url <URL> --actions '[{"type":"click","text":"Next"},{"type":"type","selector":"#q","value":"hi","submit":true}]' --out final.png
       node mcp/cli.mjs --url <URL> --matrix --devices iphone16,ipadpro11,px10 --out dir/
       node mcp/cli.mjs --url <URL> --actions '[…]' --record --assert '[{"type":"noOverflow"}]' --out final.png
       node mcp/cli.mjs --list`);
  process.exit(args.help ? 0 : 2);
}

try {
  if (args.list) {
    console.log(JSON.stringify({ count: devices.length, devices }, null, 2));
    process.exit(0);
  }
  if (args.actions) {
    let actions;
    try { actions = JSON.parse(args.actions); } catch (e) { throw new Error('--actions must be a JSON array: ' + e.message); }
    if (!Array.isArray(actions)) throw new Error('--actions must be a JSON array');
    let asserts = [];
    if (args.asserts) {
      try { asserts = JSON.parse(args.asserts); } catch (e) { throw new Error('--assert must be a JSON array: ' + e.message); }
      if (!Array.isArray(asserts)) throw new Error('--assert must be a JSON array');
    }
    const out = args.out || path.join(process.cwd(), '.bezlo', `flow-${Date.now()}.png`);
    const run = await runFlow({
      url: args.url,
      device: args.device || 'iphone16',
      steps: actions,
      screenshots: 'final',
      record: Boolean(args.record),
      asserts,
      engine: args.engine || 'chromium',
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(run.final.screenshot.base64, 'base64'));
    const summary = {
      pass: run.pass,
      device: run.final.device,
      url: run.final.layout.finalUrl,
      savedTo: out,
      actions: run.steps.map((x) => x.action),
      asserts: run.asserts,
      errors: run.steps.flatMap((x) => x.errors || []),
      files: run.files,
      video: run.video,
      gif: run.gif,
      report: run.reportFile,
      junit: run.junitFile,
    };
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`${run.pass ? 'PASS' : 'FAIL'}  ${actions.map((a) => a.type).join(' → ')}  (${summary.savedTo})`);
      if (run.asserts) console.log(`asserts: ${run.asserts.results.map((r) => `${r.type}=${r.pass ? 'ok' : 'FAIL'}`).join(', ')}`);
      if (run.video) console.log(`video: ${run.video}${run.gif ? '\ngif: ' + run.gif : ''}`);
      console.log(`report: ${run.reportFile}\njunit: ${run.junitFile}`);
    }
    process.exit(run.pass ? 0 : 1);
  }
  if (args.matrix) {
    const devices = String(args.devices || 'iphone16,ipadpro11,px10').split(',').map((d) => d.trim()).filter(Boolean);
    const dir = args.out || path.join(process.cwd(), '.bezlo', `matrix-${Date.now()}`);
    const items = await captureMatrix({
      url: args.url,
      devices,
      fullPage: Boolean(args.fullPage),
      waitMs: Number.isFinite(args.waitMs) ? args.waitMs : 800,
      selector: args.selector || '',
      engine: args.engine || 'chromium',
    });
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    const summary = [];
    for (const item of items) {
      const file = path.join(dir, `${item.device.id}.png`);
      fs.writeFileSync(file, item.png);
      files.push(file);
      summary.push({ device: item.device, file, layout: item.meta.layout });
    }
    const out = { count: items.length, dir, files, devices: summary };
    console.log(args.json ? JSON.stringify(out, null, 2) : `saved ${items.length} screenshots to ${dir}: ${files.map((f) => path.basename(f)).join(', ')}`);
    process.exit(0);
  }
  const opts = {
    url: args.url,
    device: args.device || 'iphone16',
    fullPage: Boolean(args.fullPage),
    waitMs: Number.isFinite(args.waitMs) ? args.waitMs : 1200,
    selector: args.selector || '',
    darkMode: Boolean(args.darkMode),
    scrollY: Number.isFinite(args.scrollY) ? args.scrollY : 0,
    engine: args.engine || 'chromium',
  };
  if (args.inspect) {
    const meta = await inspectPage(opts);
    console.log(JSON.stringify(meta, null, 2));
    process.exit(0);
  }
  const { png, meta } = await capturePage(opts);
  const out = args.out || path.join(process.cwd(), '.bezlo', `${meta.device.id}-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  const summary = { ...meta, savedTo: out };
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    const l = meta.layout;
    console.log(`saved ${out} (${png.length} bytes)`);
    console.log(`${meta.device.name} ${meta.device.width}x${meta.device.height} @${meta.device.dpr}x  ` +
      `viewport=${l.viewport.width}x${l.viewport.height}  overflowX=${l.overflowX}  safeAreaTop=${l.safeArea.top}`);
    if (l.overflowX && l.overflowOffenders.length) {
      console.log('overflow offenders: ' + l.overflowOffenders.map((o) => `${o.tag}${o.id ? '#' + o.id : ''}${o.cls ? '.' + o.cls.split(' ')[0] : ''} right=${o.right}`).join(', '));
    }
  }
} catch (e) {
  console.error(`error: ${e && e.message ? e.message : e}`);
  process.exit(1);
}
