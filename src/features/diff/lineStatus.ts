// Line status ranges of an editor against its VCS base (IntelliJ's LineStatusTracker): marker types, Next/Previous
// Change lookup, the rollback edit of one range and the popup's original text. Pure; tested in lineStatus.test.ts.

/** Current lines [line1, line2) replaced base lines [vcsLine1, vcsLine2) (0-based, end exclusive). */
export interface LstRange {
  line1: number;
  line2: number;
  vcsLine1: number;
  vcsLine2: number;
}

export type MarkerType = 'added' | 'modified' | 'deleted';

/** Line fragments as produced by compareLines (startLine1/endLine1 = base, startLine2/endLine2 = current). */
export interface LineFragmentLike {
  startLine1: number;
  endLine1: number;
  startLine2: number;
  endLine2: number;
}

export function toRanges(fragments: readonly LineFragmentLike[]): LstRange[] {
  return fragments.map((f) => ({ line1: f.startLine2, line2: f.endLine2, vcsLine1: f.startLine1, vcsLine2: f.endLine1 }));
}

/** One range covering everything (file not in HEAD, or a diff too big to compute). */
export function wholeRange(baseLines: number, curLines: number): LstRange[] {
  return [{ line1: 0, line2: curLines, vcsLine1: 0, vcsLine2: baseLines }];
}

export function markerType(r: LstRange): MarkerType {
  if (r.line1 === r.line2) return 'deleted';
  return r.vcsLine1 === r.vcsLine2 ? 'added' : 'modified';
}

/** DiffUtil.isSelectedByLine: an empty (deleted) range is selected by the line right below it. */
export function isSelectedByLine(line: number, r: LstRange): boolean {
  return r.line1 === r.line2 ? line === r.line1 : line >= r.line1 && line < r.line2;
}

/** LineStatusTrackerBlockOperations.getNextRange: no wrap-around. */
export function nextRange(ranges: readonly LstRange[], line: number): LstRange | undefined {
  return ranges.find((r) => line < r.line2 && !isSelectedByLine(line, r));
}

/** LineStatusTrackerBlockOperations.getPrevRange: no wrap-around. */
export function prevRange(ranges: readonly LstRange[], line: number): LstRange | undefined {
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    if (line > r.line1 && !isSelectedByLine(line, r)) return r;
  }
  return undefined;
}

export function rangeForLine(ranges: readonly LstRange[], line: number): LstRange | undefined {
  return ranges.find((r) => isSelectedByLine(line, r));
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
 * The edit that turns a range's lines of `cur` back into its base lines. `cur` is the document split on its line
 * separator (at least one element), `eol` that separator.
 */
export function rollbackEdit(cur: readonly string[], base: readonly string[], r: LstRange, eol: string): LineEdit {
  const n = cur.length;
  const lines = base.slice(r.vcsLine1, r.vcsLine2);
  if (r.line2 < n) return { startLine: r.line1, startChar: 0, endLine: r.line2, endChar: 0, text: lines.map((l) => l + eol).join('') };
  const endLine = n - 1;
  const endChar = cur[n - 1].length;
  if (r.line1 === 0) return { startLine: 0, startChar: 0, endLine, endChar, text: lines.join(eol) };
  // the range reaches the end of the text: replace from the end of the previous line, separators go first
  return { startLine: r.line1 - 1, startChar: cur[r.line1 - 1].length, endLine, endChar, text: lines.map((l) => eol + l).join('') };
}

/** Applies non-overlapping edits (test helper). */
export function applyEdits(cur: readonly string[], edits: readonly LineEdit[], eol: string): string {
  const starts: number[] = [];
  let o = 0;
  for (const l of cur) {
    starts.push(o);
    o += l.length + eol.length;
  }
  let out = cur.join(eol);
  for (const e of [...edits].sort((a, b) => b.startLine - a.startLine || b.startChar - a.startChar)) {
    out = out.slice(0, starts[e.startLine] + e.startChar) + e.text + out.slice(starts[e.endLine] + e.endChar);
  }
  return out;
}

/** The base text of a range (what Copy puts on the clipboard and the change popup shows). */
export function originalText(base: readonly string[], r: LstRange, eol = '\n'): string {
  return base.slice(r.vcsLine1, r.vcsLine2).join(eol);
}

/** Lines a marker is drawn on: changed lines, or for a deletion the line below it (the last line when at the end). */
export function markerLines(r: LstRange, lineCount: number): { from: number; to: number; atEnd: boolean } {
  if (r.line1 < r.line2) return { from: r.line1, to: r.line2 - 1, atEnd: false };
  const atEnd = r.line1 >= lineCount;
  const line = atEnd ? Math.max(0, lineCount - 1) : r.line1;
  return { from: line, to: line, atEnd };
}

/** 1-based line numbers that have a marker (for the `editorLineNumber in …` context key), capped. */
export function markedLineNumbers(ranges: readonly LstRange[], lineCount: number, cap = 10000): number[] {
  const out: number[] = [];
  for (const r of ranges) {
    const m = markerLines(r, lineCount);
    for (let l = m.from; l <= m.to && out.length < cap; l++) out.push(l + 1);
    if (out.length >= cap) break;
  }
  return out;
}

/** The line the caret goes to for Next/Previous Change: the first changed line, or the marker line of a deletion. */
export function caretLine(r: LstRange, lineCount: number): number {
  return markerLines(r, lineCount).from;
}

/** A Markdown code block for `text` whose fence is longer than any backtick run inside it. */
export function codeBlock(text: string, lang = ''): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((s) => s.length + 1)));
  return `${fence}${lang}\n${text}\n${fence}`;
}
