// Unit tests for partial.ts (node --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPartialPatch, fileState, hunkKeys, hunkState, hunkViews, keysForSelection, parseZeroDiff, pruneExcluded } from './partial';

const DIFF = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -2 +2 @@',
  '-two',
  '+TWO',
  '@@ -4,0 +5,2 @@',
  '+new1',
  '+new2',
  '@@ -7,2 +8,0 @@',
  '-seven',
  '-eight',
  '',
].join('\n');

/** Applies a zero-context patch to `old` lines (test oracle; mirrors git apply --unidiff-zero). */
function apply(old: string[], patch: string): string[] {
  const out = [...old];
  let offset = 0;
  const lines = patch.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[i]);
    if (!m) continue;
    const os = +m[1];
    const oc = +m[2];
    const rem: string[] = [];
    const add: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !lines[j].startsWith('@@'); j++) {
      if (lines[j].startsWith('-')) rem.push(lines[j].slice(1));
      else if (lines[j].startsWith('+')) add.push(lines[j].slice(1));
    }
    const at = (oc ? os - 1 : os) + offset;
    assert.deepEqual(out.slice(at, at + oc), rem, 'preimage matches');
    out.splice(at, oc, ...add);
    offset += add.length - oc;
    i = j - 1;
  }
  return out;
}

const OLD = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const NEW = ['one', 'TWO', 'three', 'four', 'new1', 'new2', 'five', 'six', 'nine'];

test('parseZeroDiff reads hunks, counts and header', () => {
  const d = parseZeroDiff(DIFF);
  assert.equal(d.header.length, 4);
  assert.equal(d.binary, false);
  assert.equal(d.hunks.length, 3);
  assert.deepEqual(
    d.hunks.map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount, h.removed.length, h.added.length]),
    [
      [2, 1, 2, 1, 1, 1],
      [4, 0, 5, 2, 0, 2],
      [7, 2, 8, 0, 2, 0],
    ],
  );
  assert.equal(new Set(d.hunks.map((h) => h.id)).size, 3);
  assert.equal(parseZeroDiff(DIFF).hunks[1].id, d.hunks[1].id, 'ids are stable');
});

test('identical hunks get distinct ids', () => {
  const d = parseZeroDiff('@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-a\n+b\n');
  assert.notEqual(d.hunks[0].id, d.hunks[1].id);
});

test('binary diff is detected', () => {
  assert.equal(parseZeroDiff('diff --git a/x b/x\nindex 1..2 100644\nBinary files a/x and b/x differ\n').binary, true);
});

test('full patch reproduces the new text', () => {
  const d = parseZeroDiff(DIFF);
  assert.deepEqual(apply(OLD, buildPartialPatch(d, new Set())!), NEW);
});

test('excluding hunks keeps the old lines and shifts later hunks', () => {
  const d = parseZeroDiff(DIFF);
  const ex = new Set(hunkKeys(d.hunks[1]));
  const patch = buildPartialPatch(d, ex)!;
  assert.deepEqual(apply(OLD, patch), ['one', 'TWO', 'three', 'four', 'five', 'six', 'nine']);
  assert.match(patch, /@@ -7,2 \+6,0 @@/);
  const ex2 = new Set(hunkKeys(d.hunks[0]));
  assert.deepEqual(apply(OLD, buildPartialPatch(d, ex2)!), ['one', 'two', 'three', 'four', 'new1', 'new2', 'five', 'six', 'nine']);
});

test('nothing included → no patch', () => {
  const d = parseZeroDiff(DIFF);
  assert.equal(buildPartialPatch(d, new Set(d.hunks.flatMap(hunkKeys))), undefined);
});

test('single lines of a hunk', () => {
  const d = parseZeroDiff('@@ -2,2 +2,3 @@\n-b\n-c\n+B\n+C\n+D\n');
  const h = d.hunks[0];
  // keep "c" (exclude its removal) and drop "D"
  const ex = new Set([`${h.id}:-1`, `${h.id}:+2`]);
  assert.deepEqual(apply(['a', 'b', 'c', 'e'], buildPartialPatch(d, ex)!), ['a', 'B', 'c', 'C', 'e']);
  assert.equal(hunkState(h, ex), 'mixed');
  assert.equal(fileState(d.hunks, ex), 'mixed');
  assert.equal(fileState(d.hunks, new Set()), 'on');
  assert.equal(fileState(d.hunks, new Set(hunkKeys(h))), 'off');
});

test('no newline at end of file', () => {
  const d = parseZeroDiff('@@ -2 +2,2 @@\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n');
  const h = d.hunks[0];
  assert.equal(h.noEolOld, true);
  assert.equal(h.noEolNew, true);
  // excluding "c" still includes the newline added after "b"
  assert.equal(buildPartialPatch(d, new Set([`${h.id}:+1`])), '@@ -2,1 +2,1 @@\n-b\n\\ No newline at end of file\n+b\n');
  // excluding the "b" line pair keeps the old "b" (still without newline) and adds "c" after it → the newline moves to b
  assert.equal(buildPartialPatch(d, new Set([`${h.id}:-0`, `${h.id}:+0`])), '@@ -2,1 +2,2 @@\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n');
});

test('pruneExcluded drops stale keys', () => {
  const d = parseZeroDiff(DIFF);
  const k = hunkKeys(d.hunks[0]);
  assert.deepEqual(pruneExcluded(d.hunks, [...k, 'dead:+0']), k);
});

test('keysForSelection pairs lines and handles empty sides', () => {
  const d = parseZeroDiff(DIFF);
  const v = hunkViews(d.hunks, new Set());
  const [a, b, c] = d.hunks;
  assert.deepEqual(keysForSelection(v, 'new', 2, 2), [`${a.id}:+0`, `${a.id}:-0`]);
  assert.deepEqual(keysForSelection(v, 'new', 6, 6), [`${b.id}:+1`]);
  // deletion of seven/eight sits before new line 9 ("nine"); also hit from line 8 right above it
  assert.equal(v[2].newLine, 9);
  assert.deepEqual(keysForSelection(v, 'new', 9, 9), [`${c.id}:-0`, `${c.id}:-1`]);
  assert.deepEqual(keysForSelection(v, 'new', 8, 8), [`${c.id}:-0`, `${c.id}:-1`]);
  assert.deepEqual(keysForSelection(v, 'old', 7, 7), [`${c.id}:-0`]);
  assert.deepEqual(keysForSelection(v, 'old', 8, 8), [`${c.id}:-1`]);
});
