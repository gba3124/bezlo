// Device presets. w × h is the screen in CSS px, portrait (what screen.width/height report on the device); dpr is
// its devicePixelRatio. Sources: Apple's published point sizes; Chrome-reported viewports for Android.
// Fields the stage reads: id, name, cat, kind (island | notch | home | punch | tablet | fold | foldopen | monitor),
// w, h, dpr, os, year, new (a "NEW" micro-label in the picker); optional status, landTop, landSide (CSS px)
// override the kind's defaults in frames.js.
// Fields the engine reads: ua (ios | ipados | android | android-tablet | desktop), osv/safari (the iOS version in
// the UA, see ua.js), android (major), model (the client-hint model; Chrome on Android sends it only there).

export const CATEGORIES = ['iphone', 'android', 'tablet', 'desktop'];

const iphone = (id, name, w, h, dpr, year, kind = 'island', status) => ({ id, name, cat: 'iphone', kind, w, h, dpr, os: 'iOS 26', year, ua: 'ios', osv: '26_0', safari: '26.0', ...(status && { status }) });
// The 2026 lineup: the picker labels them NEW.
const iphone26 = (id, name, w, h, dpr, kind = 'island') => ({ ...iphone(id, name, w, h, dpr, 2026, kind), new: true });
const ipad = (id, name, w, h, year) => ({ id, name, cat: 'tablet', kind: 'tablet', w, h, dpr: 2, os: 'iPadOS 26', year, ua: 'ipados' });
const android = (id, name, model, w, h, dpr, year, { cat = 'android', kind = 'punch', version = 16, tablet = false } = {}) =>
  ({ id, name, cat, kind, w, h, dpr, os: `Android ${version}`, year, ua: tablet ? 'android-tablet' : 'android', android: version, model });

export const DEVICES = [
  iphone26('ip18pm', 'iPhone 18 Pro Max', 440, 956, 3),
  iphone26('ip18p', 'iPhone 18 Pro', 402, 873, 3),
  iphone26('duof', 'iPhone Duo (folded)', 466, 678, 3, 'fold'),
  iphone26('duoo', 'iPhone Duo (unfolded)', 890, 626, 3, 'foldopen'),
  iphone('ip17pm', 'iPhone 17 Pro Max', 440, 956, 3, 2025),
  iphone('ip17p', 'iPhone 17 Pro', 402, 874, 3, 2025),
  iphone('ipair', 'iPhone Air', 420, 912, 3, 2025),
  iphone('ip17', 'iPhone 17', 402, 874, 3, 2025),
  iphone('ip16e', 'iPhone 16e', 390, 844, 3, 2025, 'notch'),
  iphone('ip16pm', 'iPhone 16 Pro Max', 440, 956, 3, 2024),
  iphone('ip16p', 'iPhone 16 Pro', 402, 874, 3, 2024),
  iphone('ip16pl', 'iPhone 16 Plus', 430, 932, 3, 2024, 'island', 59),
  iphone('ip16', 'iPhone 16', 393, 852, 3, 2024, 'island', 59),
  iphone('ip15pm', 'iPhone 15 Pro Max', 430, 932, 3, 2023, 'island', 59),
  iphone('ip15p', 'iPhone 15 Pro', 393, 852, 3, 2023, 'island', 59),
  iphone('ip15', 'iPhone 15', 393, 852, 3, 2023, 'island', 59),
  iphone('ip14p', 'iPhone 14 Pro', 393, 852, 3, 2022, 'island', 59),
  iphone('ip14', 'iPhone 14', 390, 844, 3, 2022, 'notch'),
  iphone('ip13', 'iPhone 13', 390, 844, 3, 2021, 'notch'),
  iphone('ip13m', 'iPhone 13 mini', 375, 812, 3, 2021, 'notch', 50),
  iphone('ip12', 'iPhone 12', 390, 844, 3, 2020, 'notch'),
  iphone('ip11', 'iPhone 11', 414, 896, 2, 2019, 'notch', 48),
  iphone('ipse3', 'iPhone SE (3rd gen)', 375, 667, 2, 2022, 'home'),

  android('px10', 'Pixel 10', 'Pixel 10', 412, 923, 2.625, 2025),
  android('px10p', 'Pixel 10 Pro', 'Pixel 10 Pro', 427, 952, 3, 2025),
  android('px9', 'Pixel 9', 'Pixel 9', 412, 923, 2.625, 2024),
  android('px8', 'Pixel 8', 'Pixel 8', 412, 915, 2.625, 2023),
  android('px7', 'Pixel 7', 'Pixel 7', 412, 915, 2.625, 2022),
  android('gs25u', 'Galaxy S25 Ultra', 'SM-S938B', 412, 891, 3.5, 2025),
  android('gs25e', 'Galaxy S25 Edge', 'SM-S937B', 412, 891, 3.5, 2025),
  android('gs25', 'Galaxy S25', 'SM-S931B', 360, 780, 3, 2025),
  android('gs24u', 'Galaxy S24 Ultra', 'SM-S928B', 384, 824, 3.75, 2024),
  android('gs24', 'Galaxy S24', 'SM-S921B', 360, 780, 3, 2024),
  android('gs23', 'Galaxy S23', 'SM-S911B', 360, 780, 3, 2023),
  android('ga56', 'Galaxy A56', 'SM-A566B', 412, 892, 2.625, 2025),
  android('ga16', 'Galaxy A16', 'SM-A166B', 412, 892, 2.625, 2024, { version: 15 }),
  android('gzfold7', 'Galaxy Z Fold7 (folded)', 'SM-F966B', 412, 960, 2.625, 2025),
  android('gzflip7', 'Galaxy Z Flip7', 'SM-F766B', 360, 840, 3, 2025),
  // Unfolded, Chrome treats the Fold as a tablet: no "Mobile" in the UA.
  android('gzfold7o', 'Galaxy Z Fold7 (open)', 'SM-F966B', 984, 1092, 2, 2025, { cat: 'tablet', tablet: true }),

  ipad('ipadmini', 'iPad mini', 744, 1133, 2024),
  ipad('ipad', 'iPad (A16)', 820, 1180, 2025),
  ipad('ipadair11', 'iPad Air 11″', 820, 1180, 2025),
  ipad('ipadair13', 'iPad Air 13″', 1024, 1366, 2025),
  ipad('ipadpro11', 'iPad Pro 11″', 834, 1210, 2025),
  ipad('ipadpro13', 'iPad Pro 13″', 1032, 1376, 2025),
  android('pxtab', 'Pixel Tablet', 'Pixel Tablet', 800, 1280, 2, 2023, { cat: 'tablet', kind: 'tablet', tablet: true }),
  android('gtabs9', 'Galaxy Tab S9', 'SM-X710', 800, 1280, 2, 2023, { cat: 'tablet', kind: 'tablet', version: 15, tablet: true }),

  // The stage's own browser at a desktop size: no UA change, mouse input.
  { id: 'laptop', name: 'Laptop 1440', cat: 'desktop', kind: 'monitor', w: 1440, h: 900, dpr: 2, os: 'macOS', year: 0, ua: 'desktop' },
  { id: 'desk1080', name: 'Desktop 1080p', cat: 'desktop', kind: 'monitor', w: 1920, h: 1080, dpr: 1, os: 'Windows', year: 0, ua: 'desktop' },
];

export const byId = id => DEVICES.find(d => d.id === id);
