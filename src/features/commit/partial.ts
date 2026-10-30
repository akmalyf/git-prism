// Line-level partial commit (IntelliJ "partial changes"): parses `git diff -U0` output into hunks with stable content
// ids, tracks which changed lines are excluded from the commit (line keys "<hunk id>:-<i>" / "<hunk id>:+<i>") and
// builds the patch of the included lines for `git apply --cached --unidiff-zero`. Pure; tested in partial.test.ts.

export interface Hunk {
  /** content id: hash of the removed + added lines, plus an ordinal among identical hunks */
  id: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** removed lines (without the leading '-') */
  removed: string[];
  /** added lines (without the leading '+') */
  added: string[];
  /** the last removed line has no newline at end of file */
  noEolOld: boolean;
  /** the last added line has no newline at end of file */
  noEolNew: boolean;
}

export interface FileDiff {
  /** "diff --git", "index", "---", "+++" (and mode) lines */
  header: string[];
  hunks: Hunk[];
  binary: boolean;
}

export type LineState = 'on' | 'off' | 'mixed';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** FNV-1a, 32 bit, hex. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Parses the output of `git diff -U0 --no-color` for one file. */
export function parseZeroDiff(text: string): FileDiff {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const header: string[] = [];
  const hunks: Hunk[] = [];
  let binary = false;
  let cur: Hunk | undefined;
  let last: '-' | '+' | undefined;
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      cur = {
        id: '',
        oldStart: +m[1],
        oldCount: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3],
        newCount: m[4] === undefined ? 1 : +m[4],
        removed: [],
        added: [],
        noEolOld: false,
        noEolNew: false,
      };
      hunks.push(cur);
      last = undefined;
      continue;
    }
    if (!cur) {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
      header.push(line);
      continue;
    }
    if (line.startsWith('-')) {
      cur.removed.push(line.slice(1));
      last = '-';
    } else if (line.startsWith('+')) {
      cur.added.push(line.slice(1));
      last = '+';
    } else if (line.startsWith('\\')) {
      if (last === '-') cur.noEolOld = true;
      else if (last === '+') cur.noEolNew = true;
    }
  }
  const seen = new Map<string, number>();
  for (const h of hunks) {
    const base = hash(`${h.removed.join('\n')}\0${h.added.join('\n')}\0${h.noEolOld ? 1 : 0}${h.noEolNew ? 1 : 0}`);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    h.id = n ? `${base}.${n}` : base;
  }
  return { header, hunks, binary };
}

export function lineKey(h: Hunk, side: '-' | '+', i: number): string {
  return `${h.id}:${side}${i}`;
}

/** Every line key of a hunk. */
export function hunkKeys(h: Hunk): string[] {
  return [...h.removed.map((_, i) => lineKey(h, '-', i)), ...h.added.map((_, i) => lineKey(h, '+', i))];
}

export function hunkState(h: Hunk, excluded: ReadonlySet<string>): LineState {
  let on = 0;
  let off = 0;
  for (const k of hunkKeys(h)) excluded.has(k) ? off++ : on++;
  return on && off ? 'mixed' : off ? 'off' : 'on';
}

/** Inclusion of the whole file: 'on' all lines, 'off' no line, 'mixed' some lines included. */
export function fileState(hunks: readonly Hunk[], excluded: ReadonlySet<string>): LineState {
  let on = false;
  let off = false;
  for (const h of hunks) {
    const s = hunkState(h, excluded);
    if (s !== 'off') on = true;
    if (s !== 'on') off = true;
  }
  return on && off ? 'mixed' : off ? 'off' : 'on';
}

/** Drops excluded keys that no longer belong to a current hunk (the change was edited or committed). */
export function pruneExcluded(hunks: readonly Hunk[], excluded: Iterable<string>): string[] {
  const valid = new Set(hunks.flatMap(hunkKeys));
  return [...new Set(excluded)].filter((k) => valid.has(k));
}

interface SegLine {
  text: string;
  /** the line is the end of file without a trailing newline */
  noEol: boolean;
}

/**
 * Content that replaces the hunk's old lines when only the included lines are applied. Removed and added lines are
 * paired by position (line i of the old part ↔ line i of the new part): an excluded removal keeps the old line,
 * an excluded addition drops the new line.
 */
export function includedSegment(h: Hunk, excluded: ReadonlySet<string>): SegLine[] {
  const out: SegLine[] = [];
  const n = Math.max(h.removed.length, h.added.length);
  for (let i = 0; i < n; i++) {
    if (i < h.removed.length && excluded.has(lineKey(h, '-', i))) {
      out.push({ text: h.removed[i], noEol: h.noEolOld && i === h.removed.length - 1 });
    }
    if (i < h.added.length && !excluded.has(lineKey(h, '+', i))) {
      out.push({ text: h.added[i], noEol: h.noEolNew && i === h.added.length - 1 });
    }
  }
  // only the last line of a file can lack its newline
  for (let i = 0; i < out.length - 1; i++) out[i].noEol = false;
  return out;
}

/**
 * Patch (for `git apply --cached --unidiff-zero`) that applies only the included lines of `diff` to the old version.
 * Returns undefined when no line is included.
 */
export function buildPartialPatch(diff: FileDiff, excluded: ReadonlySet<string>): string | undefined {
  const out: string[] = [];
  let delta = 0;
  for (const h of diff.hunks) {
    const seg = includedSegment(h, excluded);
    const oldSeg: SegLine[] = h.removed.map((text, i) => ({ text, noEol: h.noEolOld && i === h.removed.length - 1 }));
    if (seg.length === oldSeg.length && seg.every((l, i) => l.text === oldSeg[i].text && l.noEol === oldSeg[i].noEol)) continue;
    const oc = oldSeg.length;
    const nc = seg.length;
    const pos0 = oc ? h.oldStart - 1 : h.oldStart;
    const npos0 = pos0 + delta;
    const ns = nc ? npos0 + 1 : npos0;
    out.push(`@@ -${h.oldStart},${oc} +${ns},${nc} @@`);
    for (const l of oldSeg) {
      out.push(`-${l.text}`);
      if (l.noEol) out.push('\\ No newline at end of file');
    }
    for (const l of seg) {
      out.push(`+${l.text}`);
      if (l.noEol) out.push('\\ No newline at end of file');
    }
    delta += nc - oc;
  }
  if (!out.length) return undefined;
  return [...diff.header, ...out].join('\n') + '\n';
}

/** Hunk data for the diff viewer: 1-based line numbers in the old (left) and new (right) text. */
export interface HunkView {
  id: string;
  /** first line of the hunk in the old / new text (for an empty side: the line before which the change sits) */
  oldLine: number;
  newLine: number;
  removed: number;
  added: number;
  /** excluded removed / added line indexes */
  excludedRemoved: number[];
  excludedAdded: number[];
}

export function hunkViews(hunks: readonly Hunk[], excluded: ReadonlySet<string>): HunkView[] {
  return hunks.map((h) => ({
    id: h.id,
    oldLine: h.oldCount ? h.oldStart : h.oldStart + 1,
    newLine: h.newCount ? h.newStart : h.newStart + 1,
    removed: h.removed.length,
    added: h.added.length,
    excludedRemoved: h.removed.map((_, i) => i).filter((i) => excluded.has(lineKey(h, '-', i))),
    excludedAdded: h.added.map((_, i) => i).filter((i) => excluded.has(lineKey(h, '+', i))),
  }));
}

/**
 * Line keys touched by a selection of lines [from, to] (1-based, inclusive) on one side of the diff. Lines are paired
 * like in includedSegment(): selecting line i of one side also selects line i of the other side; selecting the last
 * line of the longer side's counterpart takes the remaining lines; an empty side is hit by its anchor line.
 */
export function keysForSelection(hunks: readonly HunkView[], side: 'old' | 'new', from: number, to: number): string[] {
  const out: string[] = [];
  for (const h of hunks) {
    const start = side === 'old' ? h.oldLine : h.newLine;
    const own = side === 'old' ? h.removed : h.added;
    const other = side === 'old' ? h.added : h.removed;
    const ownSign = side === 'old' ? '-' : '+';
    const otherSign = side === 'old' ? '+' : '-';
    const idx: number[] = [];
    if (own === 0) {
      // anchor: the line before which the other side's lines sit; also hit from the line right above it
      if ((start >= from && start <= to) || start - 1 === to) for (let i = 0; i < other; i++) out.push(`${h.id}:${otherSign}${i}`);
      continue;
    }
    for (let i = 0; i < own; i++) if (start + i >= from && start + i <= to) idx.push(i);
    if (!idx.length) continue;
    for (const i of idx) {
      out.push(`${h.id}:${ownSign}${i}`);
      if (i < other) out.push(`${h.id}:${otherSign}${i}`);
    }
    if (idx.includes(own - 1)) for (let i = own; i < other; i++) out.push(`${h.id}:${otherSign}${i}`);
  }
  return out;
}

/** All line keys of the given hunk views. */
export function viewKeys(h: HunkView): string[] {
  const out: string[] = [];
  for (let i = 0; i < h.removed; i++) out.push(`${h.id}:-${i}`);
  for (let i = 0; i < h.added; i++) out.push(`${h.id}:+${i}`);
  return out;
}

export function viewState(h: HunkView): LineState {
  const off = h.excludedRemoved.length + h.excludedAdded.length;
  const all = h.removed + h.added;
  return off === 0 ? 'on' : off === all ? 'off' : 'mixed';
}
