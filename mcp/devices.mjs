// Bezlo MCP — device catalog.
//
// The descriptors themselves live in the extension (single source of truth:
// extension/stage/devices.js). This module exposes a small, stable list for the
// CLI / MCP server so an agent can pick a device by id or by fuzzy name.
import { DEVICES, byId as byIdRaw } from './lib/devices.mjs';

export const devices = DEVICES.map((d) => ({
  id: d.id,
  name: d.name,
  category: d.cat,
  width: d.w,
  height: d.h,
  dpr: d.dpr,
  os: d.os,
  year: d.year || null,
}));

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Resolve a device by id, exact name, or a forgiving substring (e.g. "iphone 15"). */
export function resolveDevice(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('missing device (use list_devices to see ids)');
  const direct = byIdRaw(raw);
  if (direct) return direct;
  const needle = norm(raw);
  let hit = devices.find((d) => norm(d.id) === needle || norm(d.name) === needle);
  if (hit) return byIdRaw(hit.id);
  hit = devices.find((d) => norm(d.name).includes(needle) || needle.includes(norm(d.id)));
  if (hit) return byIdRaw(hit.id);
  // "iphone15" -> "iPhone 15", "ipad pro 11" -> "iPad Pro 11″"
  hit = devices.find((d) => norm(d.name).replace(/[0-9]|(rd|th|gen)/g, '').includes(needle.replace(/[0-9]/g, '')));
  if (hit) return byIdRaw(hit.id);
  throw new Error(`unknown device: ${raw} (try list_devices)`);
}
