// Bezlo MCP — browser engine layer.
//
// Two engines share one device-preset model:
//   chromium (default) — Chrome for Testing; the same engine the extension's
//                        device frames use. Full emulation (touch/DPR/mobile UA).
//   webkit            — Playwright WebKit; a Safari-flavoured approximation for
//                        CSS/feature checks. NOT real iOS Safari.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const ROOT = path.resolve(HERE, '..');
export const ENGINES = ['chromium', 'webkit'];

export function findChrome() {
  if (process.env.RP_CHROME) return process.env.RP_CHROME;
  const base = path.join(ROOT, '.browsers', 'chrome');
  try {
    for (const entry of fs.readdirSync(base)) {
      const exe = path.join(base, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    /* not installed here */
  }
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    // Windows
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.PROGRAMFILES || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.PROGRAMFILES || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error('no Chrome found: install Chrome/Chromium or set RP_CHROME to its executable');
}

/** Playwright browsers (WebKit) live in the repo; point Playwright at them. */
export function ensurePlaywrightBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const p = path.join(ROOT, '.browsers', 'playwright');
  if (fs.existsSync(p)) process.env.PLAYWRIGHT_BROWSERS_PATH = p;
  return process.env.PLAYWRIGHT_BROWSERS_PATH || '';
}

export function webkitAvailable() {
  try {
    ensurePlaywrightBrowsersPath();
    // eslint-disable-next-line no-undef
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a browser context for one device preset.
 * @returns {Promise<{context, close, engine, profile?}>}
 */
export async function openEngine({ engine = 'chromium', preset, ua = {}, darkMode = false } = {}) {
  if (!ENGINES.includes(engine)) throw new Error(`engine must be one of ${ENGINES.join(', ')}`);
  ensurePlaywrightBrowsersPath();
  const pw = await import('playwright-core');
  if (engine === 'webkit') {
    const { webkit } = pw;
    let executablePath = undefined;
    try { executablePath = webkit.executablePath(); } catch { /* resolved by Playwright cache */ }
    const browser = await webkit.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({
      viewport: { width: preset.w, height: preset.h },
      deviceScaleFactor: preset.dpr,
      userAgent: ua.userAgent,
      hasTouch: true,
      colorScheme: darkMode ? 'dark' : 'light',
    });
    return {
      engine,
      context,
      close: async () => {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-mcp-'));
  const { chromium } = pw;
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: findChrome(),
    headless: true,
    viewport: { width: preset.w, height: preset.h },
    deviceScaleFactor: preset.dpr,
    userAgent: ua.userAgent,
    hasTouch: true,
    isMobile: preset.ua === 'ios' || preset.ua === 'android',
    colorScheme: darkMode ? 'dark' : 'light',
    args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio'],
  });
  return {
    engine,
    context,
    profile,
    close: async () => {
      await context.close().catch(() => {});
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
