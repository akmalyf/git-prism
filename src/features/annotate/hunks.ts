// Line-level changes of a document against its base (HEAD) version and the edits that roll them back
// (IntelliJ's line status tracker ranges). Pure; tested in hunks.test.ts.

/** Lines [baseStart, baseEnd) of the base were replaced by lines [start, end) of the current text (0-based). */
export interface Hunk {
  baseStart: number;
  baseEnd: number;
  start: number;
  end: number;
}

/** Above this edit distance the middle part is reported as one hunk instead of running Myers further. */
const MAX_D = 4000;

/** Myers O(ND) diff of two line arrays → hunks (consecutive changes merged). */
export function diffLines(base: readonly string[], cur: readonly string[]): Hunk[] {
  let pre = 0;
  while (pre < base.length && pre < cur.length && base[pre] === cur[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < cur.length - pre && base[base.length - 1 - suf] === cur[cur.length - 1 - suf]) suf++;
  const a = base.slice(pre, base.length - suf);
  const b = cur.slice(pre, cur.length - suf);
  if (!a.length && !b.length) return [];
  if (!a.length || !b.length) return [{ baseStart: pre, baseEnd: pre + a.length, start: pre, end: pre + b.length }];

  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_D);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return [{ baseStart: pre, baseEnd: pre + n, start: pre, end: pre + m }];

  // backtrack → matched (equal) pairs
  const equal: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const px = vd[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) {
      x--;
      y--;
      equal.push([x, y]);
    }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    equal.push([x, y]);
  }
  equal.reverse();

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ex, ey] of [...equal, [n, m] as [number, number]]) {
    if (ex > ai || ey > bi) hunks.push({ baseStart: pre + ai, baseEnd: pre + ex, start: pre + bi, end: pre + ey });
    ai = ex + 1;
    bi = ey + 1;
  }
  return hunks;
}

/** Hunks touching the (inclusive, 0-based) line range of a selection. A pure deletion touches the lines around it. */
export function hunksTouching(hunks: readonly Hunk[], fromLine: number, toLine: number): Hunk[] {
  return hunks.filter((h) => (h.start < h.end ? fromLine < h.end && toLine >= h.start : fromLine <= h.start && toLine >= h.start - 1));
}

/**
 * Line of the base text that corresponds to `line` of the current text (0-based): unchanged lines map exactly, lines
 * inside a change map to the start of the replaced base lines (used to keep the caret on "Annotate Previous Revision").
 */
export function mapLineToBase(hunks: readonly Hunk[], line: number): number {
  let delta = 0;
  for (const h of hunks) {
    if (line < h.start) break;
    if (line < h.end) return h.baseEnd > h.baseStart ? Math.min(h.baseStart + (line - h.start), h.baseEnd - 1) : h.baseStart;
    delta = h.baseEnd - h.end;
  }
  return Math.max(0, line + delta);
}

/** A text replacement in line/character coordinates of the current text. */
export interface LineEdit {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  text: string;
}

/**
 * Edits that turn the hunks' lines of `cur` back into the base lines. `cur` must be the document split on its line
 * separator (so it has at least one element); `eol` is that separator.
 */
export function rollbackEdits(cur: readonly string[], base: readonly string[], hunks: readonly Hunk[], eol: string): LineEdit[] {
  const n = cur.length;
  return hunks.map((h) => {
    const lines = base.slice(h.baseStart, h.baseEnd);
    if (h.end < n) return { startLine: h.start, startChar: 0, endLine: h.end, endChar: 0, text: lines.map((l) => l + eol).join('') };
    const endLine = n - 1;
    const endChar = cur[n - 1].length;
    if (h.start === 0) return { startLine: 0, startChar: 0, endLine, endChar, text: lines.join(eol) };
    // the hunk reaches the end of the text: replace from the end of the previous line, separators go first
    return { startLine: h.start - 1, startChar: cur[h.start - 1].length, endLine, endChar, text: lines.map((l) => eol + l).join('') };
  });
}

/** Applies LineEdits (test helper and fallback): edits must not overlap. */
export function applyEdits(cur: readonly string[], edits: readonly LineEdit[], eol: string): string {
  const starts: number[] = [];
  let o = 0;
  for (const l of cur) {
    starts.push(o);
    o += l.length + eol.length;
  }
  const text = cur.join(eol);
  const sorted = [...edits].sort((a, b) => b.startLine - a.startLine || b.startChar - a.startChar);
  let out = text;
  for (const e of sorted) {
    const s = starts[e.startLine] + e.startChar;
    const t = starts[e.endLine] + e.endChar;
    out = out.slice(0, s) + e.text + out.slice(t);
  }
  return out;
}
