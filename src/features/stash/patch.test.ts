// Unit tests for the patch parser / hunk applier (node --test).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyHunks, filterPatch, parsePatch, reverseHunks, unquotePath } from './patch';

const GIT_PATCH = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000000000000000000000000000000000000..19d9cc8584ac2c7dcf57d2680375e80f099dc481
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+staged
diff --git a/del.txt b/del.txt
deleted file mode 100644
index 587be6b4c3f93f93c489c0111bba5596147a26cb..0000000000000000000000000000000000000000
--- a/del.txt
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/f.txt b/f.txt
index de980441c3ab03a8c07dda1ad27b8a11f39deb1e..7be73ce51b0ad21a2c1e0e6e6d43c5c55a9ec7a1 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git a/img.png b/img.png
new file mode 100644
index 0000000000000000000000000000000000000000..aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
GIT binary patch
literal 4
LcmZQzWMT#Y01f~L

literal 0
HcmV?d00001

`;

test('parses git patches: kinds, paths, blobs, binary', () => {
  const p = parsePatch(GIT_PATCH);
  assert.equal(p.strip, 1);
  assert.deepEqual(
    p.files.map((f) => [f.path, f.oldPath, f.kind, f.binary]),
    [
      ['added.txt', undefined, 'A', false],
      ['del.txt', undefined, 'D', false],
      ['f.txt', undefined, 'M', false],
      ['new name.txt', 'old name.txt', 'R', false],
      ['img.png', undefined, 'A', true],
    ],
  );
  const f = p.files[2];
  assert.equal(f.oldBlob, 'de980441c3ab03a8c07dda1ad27b8a11f39deb1e');
  assert.equal(p.files[0].oldBlob, undefined);
  assert.equal(f.hunks.length, 1);
  assert.deepEqual(f.hunks[0].lines, [' a', '-b', '+B', ' c']);
});

test('filterPatch keeps only the chosen files and stays parseable', () => {
  const p = parsePatch(GIT_PATCH);
  const text = filterPatch(p, ['f.txt', 'added.txt']);
  const q = parsePatch(text);
  assert.deepEqual(q.files.map((f) => f.path), ['added.txt', 'f.txt']);
  assert.ok(text.endsWith(' c\n'));
});

test('applies and reverses hunks, with offset', () => {
  const p = parsePatch(GIT_PATCH);
  const h = p.files[2].hunks;
  assert.equal(applyHunks('a\nb\nc\n', h), 'a\nB\nc\n');
  assert.equal(applyHunks('x\ny\na\nb\nc\n', h), 'x\ny\na\nB\nc\n');
  assert.equal(applyHunks('a\nz\nc\n', h), undefined);
  assert.equal(applyHunks('a\nB\nc\n', reverseHunks(h)), 'a\nb\nc\n');
  assert.equal(applyHunks('', p.files[0].hunks), 'staged\n');
  assert.equal(applyHunks('x\n', p.files[1].hunks), '');
});

test('handles "No newline at end of file"', () => {
  const p = parsePatch(`diff --git a/n b/n
--- a/n
+++ b/n
@@ -1,2 +1,2 @@
 one
-two
\\ No newline at end of file
+two
`);
  assert.equal(applyHunks('one\ntwo', p.files[0].hunks), 'one\ntwo\n');
  assert.equal(applyHunks('one\ntwo\n', p.files[0].hunks), undefined);
});

test('parses plain unified diffs (IntelliJ style, -p0)', () => {
  const p = parsePatch(`Index: src/a.txt
IDEA additional info:
===================================================================
--- src/a.txt\t(revision 1234)
+++ src/a.txt\t(date 1700000000000)
@@ -1 +1 @@
-x
+y
`);
  assert.equal(p.strip, 0);
  assert.deepEqual(p.files.map((f) => [f.path, f.kind]), [['src/a.txt', 'M']]);
  assert.equal(applyHunks('x\n', p.files[0].hunks), 'y\n');
});

test('unquotes C-style paths', () => {
  assert.equal(unquotePath('"a/f\\303\\266o\\tx"'), 'a/föo\tx');
  assert.equal(unquotePath('plain'), 'plain');
  const p = parsePatch(`diff --git "a/f\\303\\266.txt" "b/f\\303\\266.txt"
--- "a/f\\303\\266.txt"
+++ "b/f\\303\\266.txt"
@@ -1 +1 @@
-1
+2
`);
  assert.equal(p.files[0].path, 'fö.txt');
});
