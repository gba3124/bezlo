// Bezlo MCP — capture core.
//
// Renders a URL with the chosen device preset applied (viewport, devicePixelRatio,
// UA identity) and returns a real screenshot plus layout diagnostics an agent can
// reason about (horizontal overflow, touch identity, safe-area insets).
//
// Two engines (see engine.mjs): chromium (default, the extension's own engine) and
// webkit (a Safari-flavoured approximation — not real iOS Safari).
import path from 'node:path';
import { DEVICES, byId } from './lib/devices.mjs';
import { uaOverride } from './lib/ua.mjs';
import { resolveDevice } from './devices.mjs';
import { ROOT, findChrome, openEngine, ENGINES } from './engine.mjs';

export { ROOT, findChrome, ENGINES };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{png: Buffer, meta: object}>}
 */
export async function capturePage({
  url,
  device = 'iphone16',
  fullPage = false,
  waitMs = 1200,
  selector = '',
  darkMode = false,
  scrollY = 0,
  engine = 'chromium',
} = {}) {
  if (!url || !/^https?:\/\//.test(String(url))) throw new Error('url must start with http:// or https://');
  const preset = resolveDevice(device);
  const ua = uaOverride(preset);
  const { context, close, engine: engineUsed } = await openEngine({ engine, preset, ua, darkMode });
  const page = await context.newPage();
  try {
    if (selector) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector(selector, { timeout: 20000 });
    } else {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(async () => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      });
    }
    if (waitMs > 0) await sleep(waitMs);
    if (scrollY > 0) {
      await page.evaluate((y) => window.scrollTo(0, y), scrollY);
      await sleep(150);
    }
    const meta = await page.evaluate((refWidth) => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;padding-top:env(safe-area-inset-top);padding-left:env(safe-area-inset-left);';
      document.documentElement.appendChild(probe);
      const cs = getComputedStyle(probe);
      const safeTop = parseFloat(cs.paddingTop) || 0;
      const safeLeft = parseFloat(cs.paddingLeft) || 0;
      probe.remove();
      const doc = document.documentElement;
      // With mobile emulation Chrome can widen the layout viewport to fit wide
      // content (visual-viewport shrink), so compare against the DEVICE width
      // (the preset), not window.innerWidth.
      const referenceWidth = refWidth || window.screen.width || window.innerWidth;
      const overflowX = doc.scrollWidth > referenceWidth + 1;
      const offenders = [];
      if (overflowX) {
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > referenceWidth + 1) {
            offenders.push({
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              cls: typeof el.className === 'string' ? el.className.slice(0, 80) : undefined,
              right: Math.round(r.right),
            });
            if (offenders.length >= 8) break;
          }
        }
      }
      return {
        title: document.title,
        finalUrl: location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        screen: { width: window.screen.width, height: window.screen.height },
        devicePixelRatio: window.devicePixelRatio,
        language: navigator.language,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
        touch: 'ontouchstart' in window,
        media: {
          'hover:none': window.matchMedia('(hover: none)').matches,
          'pointer:coarse': window.matchMedia('(pointer: coarse)').matches,
          'prefers-dark': window.matchMedia('(prefers-color-scheme: dark)').matches,
        },
        safeArea: { top: safeTop, left: safeLeft },
        overflowX,
        overflowOffenders: offenders,
        referenceWidth,
        document: {
          scrollWidth: doc.scrollWidth,
          scrollHeight: doc.scrollHeight,
          bodyWidth: document.body ? Math.round(document.body.getBoundingClientRect().width) : null,
        },
      };
    }, preset.w);
    const png = await page.screenshot({ fullPage: Boolean(fullPage) });
    return {
      png,
      meta: {
        engine: engineUsed,
      device: { id: preset.id, name: preset.name, width: preset.w, height: preset.h, dpr: preset.dpr, os: preset.os },
        url,
        capturedAt: new Date().toISOString(),
        screenshot: { fullPage: Boolean(fullPage), bytes: png.length, pixelSize: { width: preset.w * preset.dpr, height: preset.h * preset.dpr } },
        layout: meta,
      },
    };
  } finally {
    await close().catch(() => {});
  }
}

/** Capture the same URL across several device presets (matrix). */
export async function captureMatrix({ url, devices = ['iphone16', 'ipadpro11', 'px10'], fullPage = false, waitMs = 800, selector = '', engine = 'chromium' } = {}) {
  const list = (Array.isArray(devices) ? devices : String(devices || '').split(',')).map((d) => String(d).trim()).filter(Boolean);
  if (!list.length) throw new Error('matrix needs at least one device');
  if (list.length > 6) throw new Error('matrix accepts at most 6 devices per call');
  const out = [];
  for (const device of list) {
    const { png, meta } = await capturePage({ url, device, fullPage, waitMs, selector, engine });
    out.push({ device: meta.device, png, meta });
  }
  return out;
}

/** Lightweight: layout diagnostics only (no screenshot). */
export async function inspectPage(opts = {}) {
  const { png, meta } = await capturePage({ ...opts, fullPage: false });
  return { ...meta, pngBytes: png.length };
}

export { DEVICES, byId };
