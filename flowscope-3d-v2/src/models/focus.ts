/** Z, Y, X are indices in the encoder's 8 × 12 × 24 output grid. */
export type Focus = { z: number; y: number; x: number };
const storageKey = 'flowscope.spatial-focus.v1';
let focus: Focus = { z: 4, y: 6, x: 8 };

function valid(value: unknown): value is Focus {
  if (!value || typeof value !== 'object') return false;
  const p = value as Focus;
  return [[p.z, 8], [p.y, 12], [p.x, 24]].every(([n, limit]) => Number.isInteger(n) && n >= 0 && n < limit);
}

try {
  const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
  if (valid(saved)) focus = saved;
} catch { /* A local presentation can run without browser storage. */ }

export function readFocus(): Focus { return { ...focus }; }
export function writeFocus(next: Focus) {
  if (!valid(next)) return;
  focus = { ...next };
  try { sessionStorage.setItem(storageKey, JSON.stringify(focus)); } catch { /* In-memory selection remains available. */ }
  window.dispatchEvent(new CustomEvent('flowscope-focus', { detail: readFocus() }));
}
