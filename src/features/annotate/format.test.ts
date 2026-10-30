// Tests for annotation text: IntelliJ name shortening, column alignment and color steps.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { BlameCommit } from './blame';
import { buildColumns, orderSteps, shortenName, ORDER_STEPS } from './format';

test('shortenName matches IntelliJ ShortNameType', () => {
  const n = 'Vasya Pupkin <vasya.pupkin@jetbrains.com>';
  assert.equal(shortenName(n, 'fullName'), 'Vasya Pupkin');
  assert.equal(shortenName(n, 'firstName'), 'Vasya');
  assert.equal(shortenName(n, 'lastName'), 'Pupkin');
  assert.equal(shortenName(n, 'initials'), 'VP');
  assert.equal(shortenName(n, 'email'), 'vasya.pupkin@jetbrains.com');
  assert.equal(shortenName('Vasya <vasya.pupkin@jetbrains.com> Pupkin', 'fullName'), 'Vasya Pupkin');
  assert.equal(shortenName('vasya.pupkin@jetbrains.com', 'firstName'), 'Vasya');
  assert.equal(shortenName('vasya.pupkin@jetbrains.com', 'lastName'), 'Pupkin');
  assert.equal(shortenName('<vasya.pupkin@jetbrains.com>', 'initials'), 'VP');
  assert.equal(shortenName('Jean-Luc Picard', 'initials'), 'JLP');
});

function c(hash: string, author: string, t: number, summary = 's'): BlameCommit {
  return { hash, author, authorMail: '', authorTime: t, authorTz: '', committer: author, committerMail: '', committerTime: t, committerTz: '', summary, boundary: false, filename: 'f' };
}

test('columns are aligned and uncommitted lines blank', () => {
  const commits = new Map([
    ['a'.repeat(40), c('a'.repeat(40), 'Al', 0)],
    ['b'.repeat(40), c('b'.repeat(40), 'Bartholomew', 0)],
    ['0'.repeat(40), c('0'.repeat(40), 'External file (--contents)', 0)],
  ]);
  const lines = ['a', 'b', '0'].map((h) => ({ hash: h.repeat(40), origLine: 1, filename: 'f' }));
  const { texts, width } = buildColumns(lines, commits, { showHash: true, showDate: false, showAuthor: true, showSubject: false, names: 'fullName', commitDate: false });
  assert.equal(texts[0], 'aaaaaaaa Al');
  assert.equal(texts[1], 'bbbbbbbb Bartholomew');
  assert.equal(texts[2], '');
  assert.equal(width, 8 + 1 + 11);
});

test('order steps rank commits newest first', () => {
  const commits = new Map([1, 5, 3].map((t) => [String(t), c(String(t), 'x', t)] as [string, BlameCommit]));
  const s = orderSteps(commits, false);
  assert.equal(s.get('5'), 0);
  assert.equal(s.get('1'), ORDER_STEPS - 1);
  assert.ok(s.get('3')! > 0 && s.get('3')! < ORDER_STEPS - 1);
});
