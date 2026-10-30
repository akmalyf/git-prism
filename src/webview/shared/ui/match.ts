// Speed-search matching (pure): case-insensitive substring, then IntelliJ-like fragment matching where each
// fragment of the pattern starts at a word / camelHump boundary ("sercon" → ServiceController).
export type MatchRange = [start: number, end: number];

function isWordStart(t: string, i: number): boolean {
  if (i === 0) return true;
  const c = t[i];
  const p = t[i - 1];
  if (!/[\p{L}\p{N}]/u.test(c)) return true;
  if (!/[\p{L}\p{N}]/u.test(p)) return true;
  if (c !== c.toLowerCase() && p === p.toLowerCase() && p !== p.toUpperCase()) return true; // camelHump
  if (/\p{N}/u.test(c) !== /\p{N}/u.test(p)) return true;
  return false;
}

/** Returns highlighted [start,end) ranges of `text` matching `pattern`, or null when it does not match. */
export function matchText(pattern: string, text: string, matchCase = false): MatchRange[] | null {
  const pat = pattern.replace(/\s+/g, ' ').trim();
  if (!pat) return [];
  const p = matchCase ? pat : pat.toLowerCase();
  const t = matchCase ? text : text.toLowerCase();
  const idx = t.indexOf(p);
  if (idx >= 0) return [[idx, idx + p.length]];
  if (text.length > 1000) return null;
  const compact = p.replace(/ /g, '');
  const starts = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) starts[i] = isWordStart(text, i) ? 1 : 0;
  let budget = 5000;
  const rec = (pi: number, ti: number): MatchRange[] | null => {
    if (pi === compact.length) return [];
    if (--budget < 0) return null;
    for (let j = ti; j < t.length; j++) {
      if (!starts[j] || t[j] !== compact[pi]) continue;
      let k = 0;
      while (pi + k < compact.length && j + k < t.length && t[j + k] === compact[pi + k]) k++;
      for (let len = k; len >= 1; len--) {
        const rest = rec(pi + len, j + len);
        if (rest) return [[j, j + len], ...rest];
      }
    }
    return null;
  };
  return rec(0, 0);
}

/** Merges adjacent/overlapping ranges and shifts them by `offset` (useful when a label is a slice of the text). */
export function normalizeRanges(ranges: MatchRange[], offset = 0): MatchRange[] {
  const sorted = ranges.map(([a, b]) => [a + offset, b + offset] as MatchRange).sort((x, y) => x[0] - y[0]);
  const out: MatchRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
