// Tests for the git blame --porcelain parser.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isUncommitted, parseBlamePorcelain, shiftLines, unquotePath, UNCOMMITTED } from './blame';

const A = '59487621b4541c6d19360fc18943dd2b613bd04b';
const B = '182191232e7b5b666d415076e86018e9a30f4393';
const meta = (name: string, time: number, summary: string) =>
  [`author ${name}`, 'author-mail <v@x.io>', `author-time ${time}`, 'author-tz +0700', `committer ${name}`, '<v@x.io>'.replace(/^/, 'committer-mail '), `committer-time ${time}`, 'committer-tz +0700', `summary ${summary}`];

const OUT = [
  `${A} 1 1 1`, ...meta('Vasya Pupkin', 100, 'first'), 'boundary', 'filename f.txt', '\ta',
  `${UNCOMMITTED} 2 2 1`, ...meta('External file (--contents)', 200, 'Version of g.txt from standard input'), `previous ${B} g.txt`, 'filename g.txt', '\tB2',
  `${B} 3 3 2`, ...meta('Vasya Pupkin', 150, 'second'), `previous ${A} f.txt`, 'filename f.txt', '\tc',
  `${B} 4 4`, '\td',
  `${UNCOMMITTED} 5 5 1`, '\tnew',
  '',
].join('\n');

test('parses commits and lines', () => {
  const r = parseBlamePorcelain(OUT);
  assert.equal(r.lines.length, 5);
  assert.deepEqual(r.lines.map((l) => l.hash), [A, UNCOMMITTED, B, B, UNCOMMITTED]);
  assert.equal(r.lines[3].origLine, 4);
  assert.equal(r.lines[3].filename, 'f.txt');
  const a = r.commits.get(A)!;
  assert.equal(a.boundary, true);
  assert.equal(a.summary, 'first');
  assert.equal(a.authorMail, 'v@x.io');
  assert.equal(a.authorTime, 100);
  assert.equal(a.previous, undefined);
  assert.deepEqual(r.commits.get(B)!.previous, { hash: A, path: 'f.txt' });
  assert.ok(isUncommitted(r.lines[1].hash));
});

test('tab-prefixed content that looks like a header is not misparsed', () => {
  const r = parseBlamePorcelain([`${A} 1 1 1`, ...meta('X', 1, 's'), 'filename f', `\t${B} 2 2 1`, ''].join('\n'));
  assert.equal(r.lines.length, 1);
  assert.equal(r.commits.size, 1);
});

test('shiftLines inserts uncommitted lines', () => {
  const r = parseBlamePorcelain(OUT);
  const s = shiftLines(r.lines, 1, 1, 3);
  assert.equal(s.length, 7);
  assert.equal(s[0].hash, A);
  assert.ok(isUncommitted(s[1].hash) && isUncommitted(s[3].hash));
  assert.equal(s[4].hash, B);
});

test('quoted (non-ASCII) paths are unquoted', () => {
  assert.equal(unquotePath('"dir \\303\\251/renamed.txt"'), 'dir é/renamed.txt');
  assert.equal(unquotePath('"a\\"b\\\\c\\td"'), 'a"b\\c\td');
  assert.equal(unquotePath('plain name.txt'), 'plain name.txt');
  const r = parseBlamePorcelain([`${B} 1 1 1`, ...meta('X', 1, 's'), `previous ${A} "\\303\\274 file.txt"`, 'filename "dir \\303\\251/r.txt"', '\tx', ''].join('\n'));
  assert.equal(r.lines[0].filename, 'dir é/r.txt');
  assert.deepEqual(r.commits.get(B)!.previous, { hash: A, path: 'ü file.txt' });
});
