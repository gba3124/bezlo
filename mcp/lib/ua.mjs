// User-agent and client-hint overrides for one device preset. Shared by the stage engine (device iframes), the
// in-tab engine (the real tab, through chrome.debugger) and the tests, so a phone has one identity everywhere.
//
// Preset fields read: ua (ios | ipados | android | android-tablet | desktop), android (major), model (the
// client-hint model), osv (iOS kernel version, e.g. "26_0"), safari (Safari's Version/, e.g. "26.0").
// Chrome on Android sends a reduced UA; the model only travels in client hints. iOS Safari sends no hints.
// iPadOS Safari asks for desktop sites by default: a Mac UA, told apart only by its touch points.

export const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
// iPadOS Safari asks for desktop sites by default: a Mac UA, told apart only by its touch points.
export const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

export function chromeMajor(userAgent = globalThis.navigator?.userAgent ?? '') {
  return /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? '155';
}

// The Chromium brand list the browser would send: a GREASE entry, Chromium and Google Chrome at the same
// major. `fullVersion` is the browser's own full version when the caller knows it.
export function brandsFor(major = '155', fullVersion = `${major}.0.0.0`) {
  const grease = { brand: 'Not.A/Brand', version: '99' };
  return {
    full: fullVersion,
    major: String(major),
    brands: [{ brand: grease.brand, version: grease.version }, { brand: 'Chromium', version: String(major) }, { brand: 'Google Chrome', version: String(major) }],
    fullVersionList: [{ brand: grease.brand, version: `${grease.version}.0.0.0` }, { brand: 'Chromium', version: fullVersion }, { brand: 'Google Chrome', version: fullVersion }],
  };
}

// The Emulation.setUserAgentOverride / Playwright userAgent payload for a preset. `{}` means the stage's own
// browser stays untouched (desktop devices); everything else is a mobile identity.
export function uaOverride(preset, { major = chromeMajor(), brands } = {}) {
  if (!preset || preset.ua === 'desktop') return {};
  if (preset.ua === 'ios') {
    const osv = preset.osv || '26_0';
    const safari = preset.safari || '26.0';
    return {
      userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS ${osv} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${safari} Mobile/15E148 Safari/604.1`,
      platform: 'iPhone',
    };
  }
  if (preset.ua === 'ipados') {
    return { userAgent: IPAD_UA, platform: 'MacIntel' };
  }
  const B = brands ?? brandsFor(major);
  const tablet = preset.ua === 'android-tablet';
  return {
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${B.major}.0.0.0 ${tablet ? '' : 'Mobile '}Safari/537.36`,
    platform: 'Linux armv81',
    userAgentMetadata: {
      brands: B.brands, fullVersionList: B.fullVersionList, platform: 'Android', platformVersion: `${preset.android ?? 16}.0.0`,
      architecture: '', model: preset.model ?? '', mobile: !tablet, bitness: '', wow64: false, formFactors: [tablet ? 'Tablet' : 'Mobile'],
    },
  };
}

// The same identity as request headers, for a navigation that still belongs to the stage's process (a device's
// first navigation leaves before its own session exists). `Apple` devices send no client hints at all.
export function uaHeaders(preset, requestHeaders, { major = chromeMajor(), brands } = {}) {
  const o = uaOverride(preset, { major, brands });
  if (!o.userAgent) return { ...requestHeaders };
  const m = o.userAgentMetadata;
  const list = bs => bs.map(b => `"${b.brand}";v="${b.version}"`).join(', ');
  const B = brands ?? brandsFor(major);
  const ch = m ? {
    'sec-ch-ua': list(m.brands), 'sec-ch-ua-mobile': m.mobile ? '?1' : '?0', 'sec-ch-ua-platform': '"Android"',
    'sec-ch-ua-model': `"${m.model}"`, 'sec-ch-ua-platform-version': `"${m.platformVersion}"`, 'sec-ch-ua-full-version-list': list(m.fullVersionList),
    'sec-ch-ua-full-version': `"${B.full}"`, 'sec-ch-ua-arch': '""', 'sec-ch-ua-bitness': '""', 'sec-ch-ua-wow64': '?0', 'sec-ch-ua-form-factors': `"${m.formFactors[0]}"`,
  } : {};
  const out = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    const n = name.toLowerCase();
    if (n === 'user-agent') out[name] = o.userAgent;
    else if (n.startsWith('sec-ch-ua')) { if (m && ch[n]) out[name] = ch[n]; } // Apple: no client hints at all
    else out[name] = value;
  }
  if (m) for (const n of ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']) if (!Object.keys(out).some(h => h.toLowerCase() === n)) out[n] = ch[n];
  return out;
}
