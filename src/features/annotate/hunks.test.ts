// Tests for the line diff and the rollback edits.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyEdits, diffLines, hunksTouching, mapLineToBase, rollbackEdits } from './hunks';

const L = (s: string) => s.split('\n');

function roundTrip(base: string, cur: string, eol = '\n') {
  const b = base.split(eol);
  const c = cur.split(eol);
  const hunks = diffLines(b, c);
  assert.equal(applyEdits(c, rollbackEdits(c, b, hunks, eol), eol), base, `${JSON.stringify(base)} <- ${JSON.stringify(cur)}`);
  return hunks;
}

test('identical texts have no hunks', () => {
  assert.deepEqual(diffLines(L('a\nb'), L('a\nb')), []);
});

test('modification, insertion and deletion', () => {
  assert.deepEqual(diffLines(L('a\nb\nc'), L('a\nB\nc')), [{ baseStart: 1, baseEnd: 2, start: 1, end: 2 }]);
  assert.deepEqual(diffLines(L('a\nc'), L('a\nb\nc')), [{ baseStart: 1, baseEnd: 1, start: 1, end: 2 }]);
  assert.deepEqual(diffLines(L('a\nb\nc'), L('a\nc')), [{ baseStart: 1, baseEnd: 2, start: 1, end: 1 }]);
  assert.deepEqual(diffLines(L('a\nb\nc\nd\ne'), L('x\nb\nc\nd\ny')), [
    { baseStart: 0, baseEnd: 1, start: 0, end: 1 },
    { baseStart: 4, baseEnd: 5, start: 4, end: 5 },
  ]);
});

test('Myers finds the minimal interleaved diff', () => {
  const h = diffLines(L('a\nb\nc\na\nb\nb\na'), L('c\nb\na\nb\na\nc'));
  const changed = h.reduce((s, x) => s + (x.baseEnd - x.baseStart) + (x.end - x.start), 0);
  assert.equal(changed, 5);
});

test('rollback round trips', () => {
  roundTrip('a\nb\nc\n', 'a\nB\nc\n');
  roundTrip('a\nb\nc\n', 'a\nc\n');
  roundTrip('a\nc\n', 'a\nb\nc\n');
  roundTrip('a\nb', 'a\nb\n');
  roundTrip('a\nb\n', 'a\nb');
  roundTrip('a\nb\nc', 'a\nb\nc\nd\ne');
  roundTrip('a\nb\nc\nd', 'a');
  roundTrip('', 'x\ny\n');
  roundTrip('x\ny\n', '');
  roundTrip('1\n2\n3\n4\n5\n6', '0\n2\n3x\n4\n6\n7');
  roundTrip('a\r\nb\r\n', 'a\r\nB\r\nc\r\n', '\r\n');
});

test('hunks touching a selection', () => {
  const h = diffLines(L('a\nb\nc\nd\ne\nf'), L('a\nB\nc\nd\nf'));
  // modified line 1, deletion of 'e' at current line 4
  assert.deepEqual(hunksTouching(h, 1, 1), [h[0]]);
  assert.deepEqual(hunksTouching(h, 2, 2), []);
  assert.deepEqual(hunksTouching(h, 3, 3), [h[1]]);
  assert.deepEqual(hunksTouching(h, 4, 4), [h[1]]);
  assert.deepEqual(hunksTouching(h, 0, 5), h);
});

test('partial rollback only reverts the touched hunk', () => {
  const base = L('a\nb\nc\nd');
  const cur = L('A\nb\nc\nD');
  const h = hunksTouching(diffLines(base, cur), 3, 3);
  assert.equal(applyEdits(cur, rollbackEdits(cur, base, h, '\n'), '\n'), 'A\nb\nc\nd');
});

test('random texts round trip', () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  for (let i = 0; i < 300; i++) {
    const gen = () => Array.from({ length: rnd(12) }, () => 'abcd'[rnd(4)]).join('\n') + (rnd(2) ? '\n' : '');
    roundTrip(gen(), gen());
  }
});

test('lines map to the base text', () => {
  const base = L('a\nb\nc\nd\ne');
  const cur = L('a\nX\nY\nc\ne\nf');
  const h = diffLines(base, cur);
  assert.equal(mapLineToBase(h, 0), 0);
  assert.equal(mapLineToBase(h, 1), 1);
  assert.equal(mapLineToBase(h, 2), 1);
  assert.equal(mapLineToBase(h, 3), 2);
  assert.equal(mapLineToBase(h, 4), 4);
  assert.equal(mapLineToBase(h, 5), 5);
  assert.equal(mapLineToBase(diffLines(L('a\nb'), L('x\na\nb')), 2), 1);
});
