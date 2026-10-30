// Maps a line of one diff side to the corresponding line of the other side (Jump to Source from the left editor).
// Pure; tested in lineMap.test.ts.

export interface LineRange {
  startLine1: number;
  endLine1: number;
  startLine2: number;
  endLine2: number;
}

/** `line` (0-based) on side `from` → line on the other side. Inside a change it maps to the same offset, clamped. */
export function mapLine(changes: readonly LineRange[], line: number, from: 1 | 2): number {
  let delta = 0;
  for (const c of changes) {
    const s = from === 1 ? c.startLine1 : c.startLine2;
    const e = from === 1 ? c.endLine1 : c.endLine2;
    const os = from === 1 ? c.startLine2 : c.startLine1;
    const oe = from === 1 ? c.endLine2 : c.endLine1;
    if (line < s) break;
    if (line < e) return os + Math.min(line - s, Math.max(0, oe - os - 1));
    delta = oe - e;
  }
  return Math.max(0, line + delta);
}
