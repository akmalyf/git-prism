// Unit tests for lineStatus.ts (node --test).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  applyEdits,
  caretLine,
  codeBlock,
  isSelectedByLine,
  markedLineNumbers,
  markerLines,
  markerType,
  nextRange,
  originalText,
  prevRange,
  rangeForLine,
  rollbackEdit,
  toRanges,
  wholeRange,
  type LstRange,
} from './lineStatus';

// @ide-diff/core is ESM-only; load it dynamically (this file compiles as CommonJS).
let compareLines: typeof import('@ide-diff/core', { with: { 'resolution-mode': 'import' } }).compareLines;
before(async () => {
  ({ compareLines } = await import('@ide-diff/core'));
});

const ranges = (base: string, cur: string): LstRange[] => toRanges(compareLines(base, cur));

test('marker types from compareLines', () => {
  assert.deepEqual(ranges('a\nb\nc\n', 'a\nX\nc\n').map(markerType), ['modified']);
  assert.deepEqual(ranges('a\nb\nc\n', 'a\nc\n').map(markerType), ['deleted']);
  assert.deepEqual(ranges('a\nb\nc\n', 'a\nb\nc\nd\n').map(markerType), ['added']);
  assert.deepEqual(ranges('a\nb\nc\nd\ne\n', 'X\nb\nc\ne\nf\n').map(markerType), ['modified', 'deleted', 'added']);
  assert.deepEqual(wholeRange(1, 3).map(markerType), ['modified']);
  assert.deepEqual(wholeRange(0, 3).map(markerType), ['added']);
});

test('isSelectedByLine: deletions belong to the line below', () => {
  const del = { line1: 3, line2: 3, vcsLine1: 3, vcsLine2: 4 };
  assert.equal(isSelectedByLine(3, del), true);
  assert.equal(isSelectedByLine(2, del), false);
  const mod = { line1: 1, line2: 3, vcsLine1: 1, vcsLine2: 2 };
  assert.equal(isSelectedByLine(1, mod), true);
  assert.equal(isSelectedByLine(2, mod), true);
  assert.equal(isSelectedByLine(3, mod), false);
});

test('next/previous change without wrap-around', () => {
  const rs: LstRange[] = [
    { line1: 2, line2: 4, vcsLine1: 2, vcsLine2: 3 },
    { line1: 7, line2: 7, vcsLine1: 6, vcsLine2: 8 },
    { line1: 10, line2: 11, vcsLine1: 10, vcsLine2: 10 },
  ];
  assert.equal(nextRange(rs, 0), rs[0]);
  assert.equal(nextRange(rs, 2), rs[1]);
  assert.equal(nextRange(rs, 4), rs[1]);
  assert.equal(nextRange(rs, 6), rs[1]);
  assert.equal(nextRange(rs, 7), rs[2]);
  assert.equal(nextRange(rs, 10), undefined);
  assert.equal(prevRange(rs, 12), rs[2]);
  assert.equal(prevRange(rs, 10), rs[1]);
  assert.equal(prevRange(rs, 7), rs[0]);
  assert.equal(prevRange(rs, 3), undefined);
  assert.equal(prevRange(rs, 2), undefined);
  assert.equal(rangeForLine(rs, 7), rs[1]);
  assert.equal(rangeForLine(rs, 5), undefined);
});

test('rollbackEdit restores the base lines of one range', () => {
  const cases: Array<[string, string]> = [
    ['a\nb\nc\n', 'a\nX\nY\nc\n'],
    ['a\nb\nc\n', 'a\nc\n'],
    ['a\nb\nc\n', 'a\nb\nc\nd\n'],
    ['a\nb\nc', 'a\nb'],
    ['a\nb', 'a\nb\nc'],
    ['a\nb', 'x\ny'],
    ['', 'x\ny\n'],
    ['a\n', ''],
  ];
  for (const [base, cur] of cases) {
    const rs = ranges(base, cur);
    const curLines = cur.split('\n');
    const baseLines = base.split('\n');
    const all = applyEdits(curLines, rs.map((r) => rollbackEdit(curLines, baseLines, r, '\n')), '\n');
    assert.equal(all, base, `${JSON.stringify(base)} <- ${JSON.stringify(cur)}`);
    // one range at a time also converges
    let text = cur;
    for (let guard = 0; guard < 10; guard++) {
      const r = ranges(base, text)[0];
      if (!r) break;
      const lines = text.split('\n');
      text = applyEdits(lines, [rollbackEdit(lines, baseLines, r, '\n')], '\n');
    }
    assert.equal(text, base);
  }
  const crlf = rollbackEdit(['a', 'X', 'c'], ['a', 'b', 'c'], { line1: 1, line2: 2, vcsLine1: 1, vcsLine2: 2 }, '\r\n');
  assert.equal(crlf.text, 'b\r\n');
});

test('original text and marker lines', () => {
  const base = ['a', 'b', 'c'];
  assert.equal(originalText(base, { line1: 1, line2: 1, vcsLine1: 1, vcsLine2: 3 }), 'b\nc');
  assert.equal(originalText(base, { line1: 1, line2: 2, vcsLine1: 1, vcsLine2: 1 }), '');
  assert.deepEqual(markerLines({ line1: 1, line2: 3, vcsLine1: 1, vcsLine2: 1 }, 5), { from: 1, to: 2, atEnd: false });
  assert.deepEqual(markerLines({ line1: 2, line2: 2, vcsLine1: 2, vcsLine2: 3 }, 5), { from: 2, to: 2, atEnd: false });
  assert.deepEqual(markerLines({ line1: 5, line2: 5, vcsLine1: 5, vcsLine2: 6 }, 5), { from: 4, to: 4, atEnd: true });
  assert.deepEqual(markedLineNumbers([{ line1: 1, line2: 3, vcsLine1: 1, vcsLine2: 1 }, { line1: 4, line2: 4, vcsLine1: 2, vcsLine2: 3 }], 6), [2, 3, 5]);
  assert.deepEqual(markedLineNumbers([{ line1: 0, line2: 100, vcsLine1: 0, vcsLine2: 0 }], 100, 3), [1, 2, 3]);
});

test('caret line and code block', () => {
  assert.equal(caretLine({ line1: 3, line2: 5, vcsLine1: 3, vcsLine2: 3 }, 10), 3);
  assert.equal(caretLine({ line1: 10, line2: 10, vcsLine1: 9, vcsLine2: 10 }, 10), 9);
  assert.equal(codeBlock('a\nb', 'ts'), '```ts\na\nb\n```');
  assert.equal(codeBlock('x ```` y'), '`````\nx ```` y\n`````');
});
