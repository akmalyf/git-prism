// Unit tests for parse.ts (node --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blockTexts,
  buildDirIndex,
  findLanguage,
  hunksTouch,
  invertChanges,
  mapRangeToOld,
  parseFollowLog,
  parseHunkHeaders,
  parseLineLog,
  parseLsTree,
  parseRevQuery,
  revUriParts,
  shortRev,
} from './parse';

const H1 = 'c9e02438b0f18906e3dbedd6e2aad7e20cf2e6ea';
const H2 = '80d9b024eb4eedcf724658d4bdbca25e08be0aab';
const H3 = 'ed9acc9fc6bcf583c661338b33bc140292d3b06a';

test('parseFollowLog keeps the path of every revision across renames', () => {
  const out =
    `\x1e${H1}\x1f${H2}\x1fA\x1fa@x\x1f1793264393\x1frename\0\nR100\0f.txt\0g.txt\0` +
    `\x1e${H2}\x1f${H3}\x1fA\x1fa@x\x1f1793264392\x1fchange b\0\nM\0f.txt\0` +
    `\x1e${H3}\x1f\x1fA\x1fa@x\x1f1793264391\x1finit\0\nA\0f.txt\0`;
  const r = parseFollowLog(out);
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].path, r[0].kind], ['g.txt', 'R']);
  assert.deepEqual([r[1].path, r[1].kind, r[1].parents], ['f.txt', 'M', [H3]]);
  assert.deepEqual([r[2].path, r[2].kind, r[2].parents, r[2].date, r[2].subject], ['f.txt', 'A', [], 1793264391, 'init']);
});

test('parseLineLog reads header, body, paths and hunks', () => {
  const out =
    `\x1e${H1}\x1f${H2}\x1fA\x1fa@x\x1f1793264393\x1ffeat c\x1fline1\nline2\n\x1d\n\ndiff --git a/f.txt b/f.txt\nindex 6fe8acc..a60b2cc 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -2,2 +2,2 @@\n B\n-c\n+C\n` +
    `\x1e${H3}\x1f\x1fA\x1fa@x\x1f1793264392\x1finit\x1f\x1d\n\ndiff --git a/f.txt b/f.txt\nnew file mode 100644\nindex 0000000..9405325\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +2,2 @@\n+b\n+c\n\\ No newline at end of file\n`;
  const r = parseLineLog(out);
  assert.equal(r.length, 2);
  assert.equal(r[0].body, 'line1\nline2');
  assert.equal(r[0].path, 'f.txt');
  assert.equal(r[0].oldPath, 'f.txt');
  assert.deepEqual(r[0].hunks[0], { oldStart: 2, oldCount: 2, newStart: 2, newCount: 2, lines: [' B', '-c', '+C'] });
  assert.deepEqual(blockTexts(r[0].hunks), { before: 'B\nc', after: 'B\nC' });
  assert.equal(r[1].oldPath, undefined);
  assert.deepEqual(blockTexts(r[1].hunks), { before: '', after: 'b\nc' });
});

test('parseLineLog unquotes C-quoted paths', () => {
  const out = `\x1e${H1}\x1f\x1fA\x1fa\x1f1\x1fs\x1f\x1d\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.equal(parseLineLog(out)[0].path, 'café.txt');
});

test('mapRangeToOld maps working tree lines to HEAD lines', () => {
  // HEAD: a B c d e ; worktree: a B X Y d e  (c replaced by X, Y)
  const hunks = parseHunkHeaders('@@ -3 +3,2 @@ B\n-c\n+X\n+Y\n');
  assert.deepEqual(hunks.map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount]), [[3, 1, 3, 2]]);
  assert.deepEqual(mapRangeToOld(hunks, 1, 2), { start: 1, end: 2 });
  assert.deepEqual(mapRangeToOld(hunks, 3, 4), { start: 3, end: 3 });
  assert.deepEqual(mapRangeToOld(hunks, 5, 6), { start: 4, end: 5 });
  assert.deepEqual(mapRangeToOld(hunks, 2, 6), { start: 2, end: 5 });
  // pure insertion after line 2: lines 3-4 are new
  const ins = parseHunkHeaders('@@ -2,0 +3,2 @@\n');
  assert.equal(mapRangeToOld(ins, 3, 4), undefined);
  assert.deepEqual(mapRangeToOld(ins, 3, 5), { start: 3, end: 3 });
  assert.deepEqual(mapRangeToOld(ins, 6, 6), { start: 4, end: 4 });
  // pure deletion of HEAD lines 2-3 (after worktree line 1)
  const del = parseHunkHeaders('@@ -2,2 +1,0 @@\n');
  assert.deepEqual(mapRangeToOld(del, 2, 2), { start: 4, end: 4 });
  assert.deepEqual(mapRangeToOld(del, 1, 1), { start: 1, end: 1 });
  assert.deepEqual(mapRangeToOld([], 4, 9), { start: 4, end: 9 });
});

test('hunksTouch detects local changes inside a range', () => {
  const hunks = parseHunkHeaders('@@ -3 +3,2 @@\n');
  assert.equal(hunksTouch(hunks, 1, 2), false);
  assert.equal(hunksTouch(hunks, 4, 6), true);
  assert.equal(hunksTouch(parseHunkHeaders('@@ -2,2 +1,0 @@\n'), 1, 2), true);
  assert.equal(hunksTouch(parseHunkHeaders('@@ -2,2 +1,0 @@\n'), 2, 4), false);
});

test('parseLsTree sorts folders first', () => {
  const out = ['100644 blob aaa       10\tsrc/b.txt', '040000 tree bbb       -\tsrc/lib', '160000 commit ccc       -\tsrc/mod', '100644 blob ddd        2\tsrc/A.txt', ''].join('\0');
  const r = parseLsTree(out);
  assert.deepEqual(r.map((e) => [e.type, e.name, e.size]), [['tree', 'lib', undefined], ['commit', 'mod', undefined], ['blob', 'A.txt', 2], ['blob', 'b.txt', 10]]);
  assert.equal(r[0].path, 'src/lib');
});

test('invertChanges swaps sides', () => {
  assert.deepEqual(invertChanges([{ path: 'a', kind: 'A' }, { path: 'b', kind: 'D' }, { path: 'n', oldPath: 'o', kind: 'R' }, { path: 'm', kind: 'M' }]), [
    { path: 'a', kind: 'D' },
    { path: 'b', kind: 'A' },
    { path: 'o', oldPath: 'n', kind: 'R' },
    { path: 'm', kind: 'M' },
  ]);
});

test('findLanguage prefers file names, then patterns, then the longest extension', () => {
  const langs = [
    { id: 'javascript', extensions: ['.js'] },
    { id: 'blade', extensions: ['.blade.php'] },
    { id: 'php', extensions: ['.php'] },
    { id: 'dockerfile', filenames: ['Dockerfile'], filenamePatterns: ['Dockerfile.*'] },
  ];
  assert.equal(findLanguage(langs, 'app/User.php'), 'php');
  assert.equal(findLanguage(langs, 'views/a.blade.php'), 'blade');
  assert.equal(findLanguage(langs, 'docker/dockerfile'), 'dockerfile');
  assert.equal(findLanguage(langs, 'docker/Dockerfile.prod'), 'dockerfile');
  assert.equal(findLanguage(langs, 'x.unknown'), undefined);
});

test('rev uri parts round-trip', () => {
  const d = { repoRoot: '/r', rev: H1, path: 'app/x y.php' };
  const p = revUriParts(d, shortRev(H1));
  assert.equal(p.path, '/app/x y.php (c9e02438)');
  assert.deepEqual(parseRevQuery(p.query), d);
  assert.equal(parseRevQuery('nope'), undefined);
  assert.equal(shortRev('main'), 'main');
});

test('parseFollowLog carries the path to revisions without a status (merges) and records renames', () => {
  const out =
    `\x1e${H1}\x1f${H2} ${H3}\x1fA\x1fa@x\x1f3\x1fmerge` +
    `\x1e${H2}\x1f${H3}\x1fA\x1fa@x\x1f2\x1frename\0\nR090\0old name.txt\0g.txt\0` +
    `\x1e${H3}\x1f\x1fA\x1fa@x\x1f1\x1fwithout status`;
  const r = parseFollowLog(out, 'g.txt');
  assert.deepEqual(r.map((v) => [v.path, v.oldPath, v.kind]), [
    ['g.txt', undefined, 'M'],
    ['g.txt', 'old name.txt', 'R'],
    ['old name.txt', undefined, 'M'],
  ]);
});

test('buildDirIndex synthesizes folders, sorts folders first', () => {
  const idx = buildDirIndex([
    { type: 'blob', path: 'b.txt' },
    { type: 'blob', path: 'src/[id]/page.tsx' },
    { type: 'blob', path: 'src/a.ts' },
    { type: 'commit', path: 'vendor/lib' },
    { type: 'blob', path: 'A.md' },
  ]);
  assert.deepEqual(idx.get('')!.map((e) => `${e.type}:${e.name}`), ['tree:src', 'tree:vendor', 'blob:A.md', 'blob:b.txt']);
  assert.deepEqual(idx.get('src')!.map((e) => e.path), ['src/[id]', 'src/a.ts']);
  assert.deepEqual(idx.get('vendor')!.map((e) => e.type), ['commit']);
  assert.equal(idx.get('src/[id]')![0].name, 'page.tsx');
});
