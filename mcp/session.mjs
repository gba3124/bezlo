// Bezlo MCP — interactive session layer (v0.2: see AND act).
//
// An agent starts a session on a URL at a device preset, then observes (screenshot
// + labeled interactive elements + layout diagnostics + console/page errors) and
// acts (tap/click, type, scroll, press, goto, wait, back, reload). Every action
// returns a fresh observation, so the loop is see → act → see.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openEngine } from './engine.mjs';
import { resolveDevice } from './devices.mjs';
import { uaOverride } from './lib/ua.mjs';

const sessions = new Map();
let seq = 0;
const IDLE_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function listSessions() {
  return [...sessions.values()].map((s) => ({ sessionId: s.id, url: s.page.url(), device: s.preset.id, createdAt: s.createdAt }));
}

export async function startSession({ url, device = 'iphone16', darkMode = false, waitMs = 800, selector = '', recordVideo = false, videoDir = '', engine = 'chromium' } = {}) {
  if (!url || !/^https?:\/\//.test(String(url))) throw new Error('url must start with http:// or https://');
  if (sessions.size >= MAX_SESSIONS) throw new Error(`too many sessions (${MAX_SESSIONS}); call session_end on one first`);
  const preset = resolveDevice(device);
  const ua = uaOverride(preset);
  const vDir = videoDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rp-mcp-v-'));
  if (recordVideo) fs.mkdirSync(vDir, { recursive: true });
  const { context, close: closeEngine, profile } = await openEngine({ engine, preset, ua, darkMode });
  const page = await context.newPage();
  const id = `s${Date.now().toString(36)}${seq++}`;
  const canRecord = recordVideo && engine === 'chromium';
  const s = { id, preset, engine, context, page, profile, closeEngine, createdAt: Date.now(), updatedAt: Date.now(), errors: [], network: [], lastElements: [], lastAction: null, timer: null, cdp: null, recordVideo: canRecord, recordNote: recordVideo && !canRecord ? `recording is Chromium-only (engine=${engine})` : undefined, videoDir: vDir, videoFile: null, gifFile: null, routes: [] };
  page.on('console', (m) => { if (m.type() === 'error') s.errors.push({ type: 'console', text: m.text().slice(0, 300) }); });
  page.on('pageerror', (e) => s.errors.push({ type: 'pageerror', text: String(e && e.message ? e.message : e).slice(0, 300) }));
  page.on('requestfailed', (req) => {
    const f = req.failure();
    s.network.push({ kind: 'failed', url: req.url().slice(0, 300), resourceType: req.resourceType(), error: (f && f.errorText) || 'failed' });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) s.network.push({ kind: 'http', url: res.url().slice(0, 300), status: res.status(), resourceType: res.request().resourceType() });
  });
  page.on('dialog', async (d) => {
    s.errors.push({ type: 'dialog', text: `${d.type()}: ${d.message()}`.slice(0, 300) });
    await d.dismiss().catch(() => {});
  });
  if (canRecord) {
    try {
      s.cdp = await s.context.newCDPSession(s.page);
      s.screencastDir = path.join(vDir, `frames-${id}`);
      fs.mkdirSync(s.screencastDir, { recursive: true });
      s.frameCount = 0;
      s.cdp.on('Page.screencastFrame', async (ev) => {
        try {
          const n = String(s.frameCount++).padStart(5, '0');
          fs.writeFileSync(path.join(s.screencastDir, `frame-${n}.jpg`), Buffer.from(ev.data, 'base64'));
          await s.cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId });
        } catch { /* frame dropped */ }
      });
      await s.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: preset.w, maxHeight: preset.h, everyNthFrame: 1 });
    } catch { /* recording unavailable, continue without */ }
  }
  sessions.set(id, s);
  try {
    await navigate(s, url, { waitMs, selector });
  } catch (e) {
    await endSession(id);
    throw e;
  }
  touch(s);
  const obs = await observe(s);
  return { sessionId: id, ...obs };
}

export async function endSession(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'no such session' };
  sessions.delete(id);
  clearTimeout(s.timer);
  if (s.recordVideo) {
    try {
      await s.cdp.send('Page.stopScreencast').catch(() => {});
      await sleep(250);
      s.videoFile = renderFrames(s.screencastDir, s.videoDir, id, 'mp4');
      s.gifFile = renderFrames(s.screencastDir, s.videoDir, id, 'gif');
    } catch { /* recording best effort */ }
  }
  await s.closeEngine().catch(() => s.context.close().catch(() => {}));
  return { ok: true, sessionId: id, videoFile: s.videoFile || undefined, gifFile: s.gifFile || undefined };
}

function renderFrames(frameDir, outDir, id, kind) {
  try {
    const fsx = fs;
    const frames = fsx.existsSync(frameDir) ? fsx.readdirSync(frameDir).filter((f) => f.endsWith('.jpg')).sort() : [];
    if (frames.length < 2) return null;
    const out = path.join(outDir, `session-${id}.${kind}`);
    if (kind === 'gif') {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '8', '-i', path.join(frameDir, 'frame-%05d.jpg'),
        '-vf', 'fps=10,scale=480:-1:flags=lanczos', out], { timeout: 60000 });
    } else {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '8', '-i', path.join(frameDir, 'frame-%05d.jpg'),
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { timeout: 60000 });
    }
    return out;
  } catch {
    return null;
  }
}

export async function endAllSessions() {
  for (const id of [...sessions.keys()]) await endSession(id);
}

function touch(s) {
  s.updatedAt = Date.now();
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { void endSession(s.id); }, IDLE_MS);
  s.timer.unref?.();
}

async function navigate(s, url, { waitMs = 800, selector = '' } = {}) {
  const page = s.page;
  if (selector) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector(selector, { timeout: 20000 });
  } else {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    });
  }
  if (waitMs > 0) await sleep(waitMs);
}

// ---- in-page collectors ----------------------------------------------------
function collectLayoutFn(refWidth) {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;padding-top:env(safe-area-inset-top);padding-left:env(safe-area-inset-left);';
  document.documentElement.appendChild(probe);
  const cs = getComputedStyle(probe);
  const safeTop = parseFloat(cs.paddingTop) || 0;
  const safeLeft = parseFloat(cs.paddingLeft) || 0;
  probe.remove();
  const doc = document.documentElement;
  const referenceWidth = refWidth || window.screen.width || window.innerWidth;
  const overflowX = doc.scrollWidth > referenceWidth + 1;
  const offenders = [];
  if (overflowX) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > referenceWidth + 1) {
        offenders.push({ tag: el.tagName.toLowerCase(), id: el.id || undefined, cls: typeof el.className === 'string' ? el.className.slice(0, 80) : undefined, right: Math.round(r.right) });
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
    maxTouchPoints: navigator.maxTouchPoints,
    media: { 'hover:none': matchMedia('(hover: none)').matches, 'pointer:coarse': matchMedia('(pointer: coarse)').matches, 'prefers-dark': matchMedia('(prefers-color-scheme: dark)').matches },
    safeArea: { top: safeTop, left: safeLeft },
    overflowX,
    overflowOffenders: offenders,
    referenceWidth,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY), maxY: Math.max(0, doc.scrollHeight - window.innerHeight) },
    document: { scrollWidth: doc.scrollWidth, scrollHeight: doc.scrollHeight },
  };
}

function collectElementsFn() {
  const SEL = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="switch"],[contenteditable="true"],[onclick]';
  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    return r.bottom > -4 && r.top < window.innerHeight + 4 && r.right > -4 && r.left < window.innerWidth + 4;
  };
  const cssPath = (el) => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.id) { parts[0] = `#${CSS.escape(node.id)}`; break; }
      node = parent;
    }
    return parts.join(' > ');
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label') || '';
    if (aria) return aria.trim().slice(0, 90);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const lab = el.labels && el.labels[0] ? (el.labels[0].innerText || '').trim() : '';
      if (lab) return lab.slice(0, 90);
      return (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().slice(0, 90);
    }
    const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt) return txt.slice(0, 90);
    return (el.getAttribute('title') || el.getAttribute('alt') || '').trim().slice(0, 90);
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.getAttribute('href') ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['checkbox', 'radio', 'range', 'submit', 'button'].includes(t) ? (t === 'submit' ? 'button' : t) : 'textbox';
    }
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return 'generic';
  };
  const hostSelectorOf = (root) => {
    // Find the shadow host element for a ShadowRoot (walk up through hosts).
    let node = root && root.host ? root.host : null;
    let path = null;
    while (node && node.nodeType === 1) {
      const p = cssPath(node);
      path = p;
      node = node.getRootNode && node.getRootNode() !== document ? node.getRootNode().host : null;
    }
    return path;
  };
  const out = [];
  const seen = new Set();
  const roots = [document];
  // Collect open shadow roots (and same-origin iframes) with a bounded BFS.
  for (let i = 0; i < roots.length && i < 25; i++) {
    const root = roots[i];
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  const candidates = [];
  for (const root of roots) for (const el of root.querySelectorAll(SEL)) candidates.push({ el, root });
  for (const { el, root } of candidates) {
    if (seen.has(el) || out.length >= 80) continue;
    seen.add(el);
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const shadowHost = root !== document && root.host ? hostSelectorOf(root) : undefined;
    const frameUrl = root !== document && root.defaultView && root.defaultView !== window ? (() => { try { return root.defaultView.location.href; } catch { return undefined; } })() : undefined;
    out.push({
      ref: `e${out.length + 1}`,
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el),
      selector: cssPath(el),
      shadowHost: shadowHost || undefined,
      frameUrl: frameUrl || undefined,
      inViewport: r.top >= -2 && r.bottom <= window.innerHeight + 2,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      href: el.tagName === 'A' && el.getAttribute('href') ? new URL(el.getAttribute('href'), location.href).href : undefined,
      inputType: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined,
      value: el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password' ? undefined : (el.value != null && el.tagName === 'INPUT' ? String(el.value).slice(0, 60) : undefined),
    });
  }
  return out;
}

async function collectA11y(s) {
  try {
    if (!s.cdp) s.cdp = await s.context.newCDPSession(s.page);
    const { nodes } = await s.cdp.send('Accessibility.getFullAXTree', {});
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const depthOf = (n) => {
      let d = 0;
      let cur = n;
      while (cur && cur.parentId && byId.has(cur.parentId) && d < 20) { cur = byId.get(cur.parentId); d++; }
      return d;
    };
    const interesting = [];
    for (const n of nodes) {
      if (n.ignored) continue;
      const role = n.role && n.role.value;
      const name = n.name && n.name.value;
      if (!role || role === 'generic' || role === 'none' || role === 'InlineTextBox') continue;
      if (!name && !['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'tab', 'switch', 'heading'].includes(role)) continue;
      interesting.push({ role, name: String(name || '').slice(0, 80), depth: depthOf(n) });
      if (interesting.length >= 120) break;
    }
    return { nodes: interesting, count: interesting.length };
  } catch {
    return { nodes: [], count: 0, note: 'a11y unavailable' };
  }
}

async function collectFrameElements(s) {
  const out = [];
  const frames = s.page.frames();
  const urlCount = new Map();
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    let els = [];
    try {
      els = await frame.evaluate(collectElementsFn);
    } catch {
      continue; // detached
    }
    const url = frame.url();
    const idx = urlCount.get(url) || 0;
    urlCount.set(url, idx + 1);
    for (const e of els) out.push({ ...e, frameUrl: url, frameIndex: idx });
    if (out.length >= 80) break;
  }
  return out.slice(0, 80);
}

export async function observe(s) {
  touch(s);
  const page = s.page;
  const [layout, mainElements, frameElements, a11y] = await Promise.all([
    page.evaluate(collectLayoutFn, s.preset.w),
    page.evaluate(collectElementsFn),
    collectFrameElements(s),
    collectA11y(s),
  ]);
  const elements = [...mainElements, ...frameElements].map((e, i) => ({ ...e, ref: `e${i + 1}` }));
  const frames = page.frames().map((f) => ({ url: f.url(), main: f === page.mainFrame() }));
  s.lastElements = elements;
  const png = await page.screenshot({ fullPage: false });
  const errors = s.errors.splice(0);
  const network = s.network.splice(0);
  return {
    engine: s.engine,
    recordNote: s.recordNote,
    device: { id: s.preset.id, name: s.preset.name, width: s.preset.w, height: s.preset.h, dpr: s.preset.dpr, os: s.preset.os },
    layout,
    elements,
    frames,
    a11y,
    action: s.lastAction,
    errors,
    network,
    screenshot: { mimeType: 'image/png', bytes: png.length, base64: png.toString('base64') },
  };
}

async function observeWithRetry(s, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      return await observe(s);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // Transient: navigation replaced the context, or the page was busy long
      // enough for evaluate/screenshot to time out. Page closed is fatal.
      const transient = /Execution context was destroyed|navigat|Timeout|timed out/i.test(msg) && !/Target (page )?closed|has been closed/i.test(msg);
      if (transient && i < tries - 1) {
        await sleep(450 + i * 400);
        continue;
      }
      throw e;
    }
  }
}

async function retryOnce(fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/Timeout|timed out|not visible|not found|detached/i.test(msg)) throw e;
    await sleep(300);
    return fn();
  }
}

// ---- actions ---------------------------------------------------------------
async function resolve(s, a) {
  const page = s.page;
  if (Number.isInteger(a.index) && s.lastElements[a.index - 1]) {
    const e = s.lastElements[a.index - 1];
    return { by: 'index', selector: e.selector, shadowHost: e.shadowHost, frameUrl: e.frameUrl, frameIndex: e.frameIndex, name: e.name };
  }
  if (a.frameUrl) return { by: 'selector', selector: a.selector, frameUrl: a.frameUrl, frameIndex: a.frameIndex || 0, shadowHost: a.shadowHost };
  if (a.selector) return { by: 'selector', selector: a.selector };
  if (a.text) return { by: 'text', text: a.text };
  if (a.role) return { by: 'role', role: a.role, name: a.name || '' };
  return null;
}

function frameFor(s, target) {
  if (!target.frameUrl) return null;
  const matches = s.page.frames().filter((f) => f.url() === target.frameUrl);
  return matches[target.frameIndex || 0] || matches[0] || null;
}

async function locatorFor(s, target) {
  const page = s.page;
  if (!target) return null;
  const frame = frameFor(s, target);
  const root = frame || page;
  if (target.shadowHost && target.selector) return root.locator(target.shadowHost).locator(target.selector).first();
  if (target.by === 'index' || target.by === 'selector') return root.locator(target.selector).first();
  if (target.by === 'text') return page.getByText(target.text, { exact: false }).first();
  if (target.by === 'role') return page.getByRole(target.role, target.name ? { name: target.name, exact: false } : {}).first();
  return null;
}

async function clickTargetLocator(s, target) {
  const page = s.page;
  if (!target) return null;
  if (target.by !== 'text') return locatorFor(s, target);
  // Prefer a real button/link over a <label> with the same word.
  for (const cand of [
    page.getByRole('button', { name: target.text, exact: false }),
    page.getByRole('link', { name: target.text, exact: false }),
    page.getByText(target.text, { exact: false }),
  ]) {
    const c = cand.first();
    if (await c.boundingBox().catch(() => null)) return c;
  }
  return null;
}

export async function act(s, action = {}) {
  touch(s);
  const page = s.page;
  const type = action.type || 'click';
  const result = { ok: true, type };
  try {
    if (type === 'click') {
      const target = await resolve(s, action);
      if (target) {
        // Click by visible text: prefer a real button/link over a <label> that
        // merely contains the same word (a label click does not submit).
        const loc = await clickTargetLocator(s, target);
        const box = loc ? await loc.boundingBox().catch(() => null) : null;
        if (!box) throw new Error('element not found or not visible; call session_observe and retry with a fresh index');
        await retryOnce(async () => {
          const fresh = await clickTargetLocator(s, target);
          if (!fresh) throw new Error('element not found or not visible');
          await fresh.tap({ timeout: 6000 }).catch(async () => await fresh.click({ timeout: 6000 }));
        });
        result.clicked = { ...target, rect: box };
      } else if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
        await page.touchscreen.tap(action.x, action.y);
        result.clicked = { x: action.x, y: action.y };
      } else {
        throw new Error('click needs index | text | selector | role (+name) | x+y');
      }
    } else if (type === 'type') {
      const target = await resolve(s, action);
      if (!target) throw new Error('type needs index | selector | text (label)');
      const loc = await locatorFor(s, target);
      await retryOnce(async () => {
        const fresh = await locatorFor(s, target);
        await fresh.fill('', { timeout: 6000 }).catch(() => {});
        await fresh.fill(String(action.value == null ? '' : action.value), { timeout: 6000 });
      });
      if (action.submit) await loc.press('Enter');
      result.typed = { into: target, chars: String(action.value == null ? '' : action.value).length, submit: Boolean(action.submit) };
    } else if (type === 'press') {
      await page.keyboard.press(String(action.key || 'Enter'));
      result.pressed = action.key || 'Enter';
    } else if (type === 'scroll') {
      const dy = Number.isFinite(action.dy) ? action.dy : 0.8 * s.preset.h;
      await page.evaluate((d) => window.scrollBy(0, d), dy);
      result.scrolledBy = dy;
    } else if (type === 'goto') {
      await navigate(s, action.url, { waitMs: Number.isFinite(action.waitMs) ? action.waitMs : 800, selector: action.selector || '' });
      result.goto = action.url;
    } else if (type === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      result.back = true;
    } else if (type === 'reload') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      result.reload = true;
    } else if (type === 'wait') {
      const ms = Number.isFinite(action.ms) ? Math.min(15000, Math.max(0, action.ms)) : 500;
      await page.waitForTimeout(ms);
      result.waited = ms;
    } else {
      throw new Error(`unknown action type: ${type}`);
    }
    await sleep(180);
    // An action may start a navigation; let it settle before the observation so
    // page.evaluate doesn't race a destroyed execution context.
    await s.page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
    await sleep(120);
  } catch (e) {
    result.ok = false;
    result.error = String(e && e.message ? e.message : e);
  }
  s.lastAction = result;
  const obs = await observeWithRetry(s);
  return { action: result, ...obs };
}

async function resolveTarget(s, target = {}) {
  const page = s.page;
  if (Number.isInteger(target.index) && s.lastElements[target.index - 1]) {
    const e = s.lastElements[target.index - 1];
    const frame = frameFor(s, e);
    const root = frame || page;
    return { loc: e.shadowHost ? root.locator(e.shadowHost).locator(e.selector).first() : root.locator(e.selector).first(), label: e.name };
  }
  if (target.selector) {
    const frame = frameFor(s, target);
    return { loc: (frame || page).locator(target.selector).first(), label: target.selector };
  }
  if (target.text) return { loc: page.getByText(target.text, { exact: false }).first(), label: target.text };
  if (target.role) return { loc: page.getByRole(target.role, target.name ? { name: target.name, exact: false } : {}).first(), label: target.name || target.role };
  return null;
}

// ---- network mocking -------------------------------------------------------
export async function addRoute(s, { pattern, response = {} } = {}) {
  if (!pattern) throw new Error('route needs a url pattern (string or glob)');
  const handler = async (route) => {
    try {
      if (response.abort) { await route.abort(response.abort === true ? 'failed' : String(response.abort)); return; }
      const opts = { status: Number(response.status) || 200, headers: response.headers || undefined };
      if (response.body != null) return route.fulfill({ ...opts, body: String(response.body), contentType: response.contentType || 'text/plain' });
      if (response.json != null) return route.fulfill({ ...opts, json: response.json });
      return route.fulfill({ ...opts, body: '' });
    } catch { /* route already handled */ }
  };
  await s.page.route(pattern, handler);
  s.routes.push({ pattern, response });
  return { ok: true, pattern, routes: s.routes.length };
}

export async function clearRoutes(s) {
  for (const r of s.routes) await s.page.unroute(r.pattern).catch(() => {});
  s.routes = [];
  return { ok: true, routes: 0 };
}

/**
 * Assert a list of checks against the live session. Each check returns pass/detail.
 * Types: visible | text | inputValue | urlIncludes | noOverflow | noConsoleErrors | elementCount
 */
export async function assertChecks(s, checks = []) {
  touch(s);
  const page = s.page;
  const results = [];
  for (const c of Array.isArray(checks) ? checks : []) {
    const rec = { type: c.type, pass: false };
    try {
      if (c.type === 'visible' || c.type === 'text' || c.type === 'inputValue') {
        const t = await resolveTarget(s, c);
        if (!t) { rec.detail = 'no target (index|selector|text|role)'; results.push(rec); continue; }
        const visible = await t.loc.isVisible().catch(() => false);
        if (c.type === 'visible') { rec.pass = visible; rec.detail = `${t.label}: visible=${visible}`; }
        else if (c.type === 'text') {
          const txt = visible ? await t.loc.innerText().catch(() => '') : '';
          rec.pass = visible && (c.contains == null ? true : txt.includes(String(c.contains)));
          rec.detail = `${t.label}: "${String(txt).slice(0, 80)}" contains=${c.contains == null ? '-' : JSON.stringify(c.contains)}`;
        } else {
          const val = visible ? await t.loc.inputValue().catch(() => '') : '';
          rec.pass = visible && (c.equals == null ? true : val === String(c.equals));
          rec.detail = `${t.label}: value=${JSON.stringify(String(val).slice(0, 60))}`;
        }
      } else if (c.type === 'urlIncludes') {
        const url = page.url();
        rec.pass = url.includes(String(c.value || ''));
        rec.detail = url;
      } else if (c.type === 'noOverflow') {
        const layout = await page.evaluate(collectLayoutFn, s.preset.w);
        rec.pass = layout.overflowX === false;
        rec.detail = layout.overflowX ? `overflow offenders: ${JSON.stringify(layout.overflowOffenders.slice(0, 3))}` : 'no horizontal overflow';
      } else if (c.type === 'noConsoleErrors') {
        rec.pass = s.errors.length === 0;
        rec.detail = s.errors.length ? JSON.stringify(s.errors.slice(0, 3)) : 'clean';
      } else if (c.type === 'elementCount') {
        const els = await page.evaluate(collectElementsFn);
        rec.pass = els.length >= Number(c.min || 1);
        rec.detail = `${els.length} interactive elements (min ${c.min || 1})`;
      } else {
        rec.detail = `unknown check type: ${c.type}`;
      }
    } catch (e) {
      rec.detail = String(e && e.message ? e.message : e);
    }
    results.push(rec);
  }
  return { pass: results.length > 0 && results.every((r) => r.pass), results };
}

export async function actById(id, action) {
  return act(getSession(id), action || {});
}

/**
 * Run a whole flow in one call: open the session, execute the steps, optionally
 * save per-step screenshots, return a compact step report + final screenshot.
 */
export async function runFlow({ url, device = 'iphone16', steps = [], screenshots = 'final', outDir = '', record = false, asserts = [], engine = 'chromium' } = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = outDir || path.join(process.cwd(), '.bezlo', `flow-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const started = await startSession({ url, device, recordVideo: Boolean(record), engine });
  const id = started.sessionId;
  const stepResults = [];
  const files = [];
  let last = started;
  let endResult = null;
  let assertResult = null;
  try {
    for (let i = 0; i < steps.length; i++) {
      last = await actById(id, steps[i]);
      const shot = screenshots === 'all' ? await saveFlowShot(last, dir, i + 1) : null;
      if (shot) files.push(shot);
      stepResults.push({
        step: i + 1,
        action: last.action,
        url: last.layout.finalUrl,
        title: last.layout.title,
        errors: last.errors,
        network: last.network,
        screenshot: shot || undefined,
      });
    }
    if (Array.isArray(asserts) && asserts.length) {
      assertResult = await assertChecks(sessions.get(id), asserts);
    }
    if (screenshots !== 'none') {
      const shot = await saveFlowShot(last, dir, steps.length + 1);
      if (shot) files.push(shot);
    }
  } finally {
    endResult = await endSession(id).catch(() => null);
  }
  // recording (CDP screencast → mp4 + gif, rendered in endSession)
  const videoFile = endResult && endResult.videoFile ? endResult.videoFile : null;
  const gifFile = endResult && endResult.gifFile ? endResult.gifFile : null;
  const pass = stepResults.every((x) => x.action && x.action.ok) && (!assertResult || assertResult.pass);
  const report = {
    at: new Date().toISOString(),
    url,
    engine,
    device: last.device,
    pass,
    steps: stepResults,
    asserts: assertResult,
    files,
    video: videoFile,
    gif: gifFile,
  };
  const reportFile = path.join(dir, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const junitFile = path.join(dir, 'junit.xml');
  fs.writeFileSync(junitFile, toJunit(report));
  return { steps: stepResults, final: last, files, outDir: dir, asserts: assertResult, pass, reportFile, junitFile, video: videoFile, gif: gifFile };
}

function xmlEscape(v) {
  return String(v == null ? '' : v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function toJunit(report) {
  const cases = [];
  for (const st of report.steps) {
    const ok = st.action && st.action.ok;
    cases.push({
      name: `step ${st.step}: ${st.action ? st.action.type : 'unknown'}`,
      ok,
      detail: ok ? '' : (st.action && st.action.error) || 'failed',
    });
  }
  if (report.asserts) {
    for (const a of report.asserts.results) {
      cases.push({ name: `assert: ${a.type}`, ok: a.pass, detail: a.detail || '' });
    }
  }
  const failures = cases.filter((c) => !c.ok).length;
  const body = cases
    .map((c) => `    <testcase classname="bezlo.flow" name="${xmlEscape(c.name)}">${c.ok ? '' : `<failure message="${xmlEscape(c.detail)}"/>`}</testcase>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="bezlo-flow" tests="${cases.length}" failures="${failures}" time="0">\n${body}\n  </testsuite>\n</testsuites>\n`;
}

async function saveFlowShot(obs, dir, n) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `step-${String(n).padStart(2, '0')}.png`);
  fs.writeFileSync(file, Buffer.from(obs.screenshot.base64, 'base64'));
  return file;
}

export function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new Error(`no such session: ${id} (sessions expire after 10 min idle)`);
  return s;
}
