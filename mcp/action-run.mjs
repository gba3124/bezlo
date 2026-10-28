#!/usr/bin/env node
// Bezlo — GitHub Action runner.
//
// Reads INPUT_* environment variables (set by action.yml), runs one AI-authored
// flow with device emulation, writes artifacts (screenshot, report.json, JUnit,
// optional mp4/gif) and GitHub outputs/summary. Exit code = flow pass/fail.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runFlow } from './session.mjs';

const env = process.env;
const json = (v, fallback) => {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { throw new Error(`invalid JSON input: ${String(v).slice(0, 120)}`); }
};

const url = env.INPUT_URL;
if (!url) {
  console.error('input "url" is required');
  process.exit(2);
}
const device = env.INPUT_DEVICE || 'iphone16';
const engine = env.INPUT_ENGINE || 'chromium';
const steps = json(env.INPUT_STEPS, []);
const asserts = json(env.INPUT_ASSERTS, []);
const record = String(env.INPUT_RECORD || 'false').toLowerCase() === 'true';
const screenshots = env.INPUT_SCREENSHOTS || 'final';
const workspace = env.GITHUB_WORKSPACE || process.cwd();
const outDir = path.join(workspace, env.INPUT_OUTPUT_DIR || 'bezlo-artifacts');

const run = await runFlow({ url, device, steps, asserts, record, screenshots, outDir, engine });

// final screenshot has a stable name
const finalPng = path.join(outDir, 'final.png');
fs.writeFileSync(finalPng, Buffer.from(run.final.screenshot.base64, 'base64'));

const outputs = {
  pass: String(run.pass),
  report: run.reportFile,
  junit: run.junitFile,
  video: run.video || '',
  gif: run.gif || '',
  screenshot: finalPng,
  artifacts: outDir,
};
const outFile = env.GITHUB_OUTPUT;
if (outFile) {
  fs.appendFileSync(outFile, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}

// step summary for the workflow run page
const summary = [
  `## Bezlo AI test — ${run.pass ? 'PASS' : 'FAIL'}`,
  '',
  `- engine: **${engine}**`,
  `- device: **${run.final.device.name}** (${run.final.device.width}×${run.final.device.height} @${run.final.device.dpr}x)`,
  `- url: ${run.final.layout.finalUrl}`,
  `- steps: ${run.steps.length} · assertions: ${run.asserts ? run.asserts.results.length : 0}`,
  '',
  '| step | action | ok | url |',
  '|---|---|---|---|',
  ...run.steps.map((s) => `| ${s.step} | ${s.action.type} | ${s.action.ok ? '✅' : '❌'} | ${s.url} |`),
  ...(run.asserts ? ['', '| assert | pass | detail |', '|---|---|---|', ...run.asserts.results.map((a) => `| ${a.type} | ${a.pass ? '✅' : '❌'} | ${String(a.detail || '').replace(/\|/g, '\\|').slice(0, 120)} |`)] : []),
  '',
  `artifacts: \`${outDir}\``,
];
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
console.log(JSON.stringify({ pass: run.pass, engine, steps: run.steps.map((s) => ({ step: s.step, type: s.action.type, ok: s.action.ok })), asserts: run.asserts, files: run.files, video: run.video, gif: run.gif, report: run.reportFile, junit: run.junitFile, outDir }, null, 2));
process.exit(run.pass ? 0 : 1);
