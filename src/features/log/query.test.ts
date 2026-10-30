// Tests of the pure Git Log query helpers and reference ordering.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ref } from '../../core/types';
import {
  authorPatterns,
  hashWords,
  interleave,
  isStructureChanging,
  parseFollowNames,
  parseRevList,
  parseShortlog,
  pathsInRoot,
  recentBranches,
  resolveBranchFilter,
  revListArgs,
  rowMatcher,
  type QuerySpec,
} from './query';
import { colorName, headPriority, isDefaultFavorite, labelsByHash } from './refs';

const base: QuerySpec = { sort: 'topological', firstParent: false, hasHead: true, authors: [], paths: [], history: false, limit: 0 };

test('rev-list args: defaults', () => {
  assert.deepEqual(revListArgs(base), ['rev-list', '--timestamp', '--parents', '--date-order', '--branches', '--remotes', '--tags', 'HEAD', '--']);
  assert.deepEqual(revListArgs({ ...base, hasHead: false, sort: 'date', limit: 100 }), [
    'rev-list', '--timestamp', '--parents', '--date-order', '--max-count=100', '--branches', '--remotes', '--tags', '--',
  ]);
});

test('rev-list args: filters', () => {
  const a = revListArgs({ ...base, refs: ['refs/heads/main', 'HEAD'], text: 'fix (bug)', since: 10, until: 20.5, paths: ['src/a.ts'], firstParent: true });
  assert.deepEqual(a, [
    'rev-list', '--timestamp', '--parents', '--date-order', '--first-parent', '--since=@10', '--until=@20',
    '--fixed-strings', '--regexp-ignore-case', '--grep=fix (bug)', 'refs/heads/main', 'HEAD', '--', 'src/a.ts',
  ]);
  const b = revListArgs({ ...base, text: 'fix (bug)', authors: ['^Bob <'], matchCase: true });
  assert.ok(b.includes('--extended-regexp'));
  assert.ok(!b.includes('--regexp-ignore-case'));
  assert.ok(b.includes('--author=^Bob <'));
  assert.ok(b.includes('--grep=fix \\(bug\\)'));
  const c = revListArgs({ ...base, text: 'a.*b', regex: true });
  assert.ok(c.includes('--extended-regexp') && c.includes('--grep=a.*b'));
  const h = revListArgs({ ...base, paths: ['x'], history: true });
  assert.deepEqual(h.slice(-4), ['--full-history', '--simplify-merges', '--', 'x']);
});

test('author patterns', () => {
  assert.deepEqual(authorPatterns(['me'], { name: 'Akmal Y', email: 'a@x.id' }), ['^Akmal Y <', '<a@x\\.id>']);
  assert.deepEqual(authorPatterns(['Bob <bob@b.c>', 'carol@c.d', 'D.(x)'], {}), ['^Bob <bob@b\\.c>', '<carol@c\\.d>', '^D\\.\\(x\\) <']);
  assert.deepEqual(authorPatterns(['me'], {}), []);
});

test('hash words and structure-changing filters', () => {
  assert.deepEqual(hashWords('8cae5af 9B6C3B7d'), ['8cae5af', '9b6c3b7d']);
  assert.deepEqual(hashWords('fix 8cae5af'), []);
  assert.deepEqual(hashWords('cafe'), []);
  assert.equal(isStructureChanging({ branches: ['main'], paths: ['/a'] }), false);
  assert.equal(isStructureChanging({ text: ' x ' }), true);
  assert.equal(isStructureChanging({ users: ['me'] }), true);
});

test('parse rev-list output', () => {
  const t = parseRevList('1704596400 aaa bbb ccc\n1704423600 bbb\n\n1 ccc\n');
  assert.deepEqual(t.hashes, ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(t.parents, [['bbb', 'ccc'], [], []]);
  assert.deepEqual(t.times, [1704596400, 1704423600, 1]);
});

test('interleave keeps per-list order and sorts by time', () => {
  const r = interleave([{ times: [10, 5, 7, 1] }, { times: [8, 6] }]);
  assert.deepEqual([...r.list], [0, 1, 1, 0, 0, 0]);
  assert.deepEqual([...r.pos], [0, 0, 1, 1, 2, 3]);
  const one = interleave([{ times: [3, 2] }]);
  assert.deepEqual([...one.pos], [0, 1]);
});

test('branch filter resolution and paths', () => {
  const refs = [
    { name: 'refs/heads/main', short: 'main' },
    { name: 'refs/remotes/origin/main', short: 'origin/main' },
    { name: 'refs/tags/main', short: 'main' },
  ];
  assert.deepEqual(resolveBranchFilter(['main', 'origin/main', 'HEAD', 'nope'], refs, true), ['refs/heads/main', 'refs/remotes/origin/main', 'HEAD']);
  assert.deepEqual(resolveBranchFilter(['HEAD'], refs, false), []);
  const h = 'A'.repeat(40);
  assert.deepEqual(resolveBranchFilter([h, 'abc123'], refs, true), ['a'.repeat(40)]);
  assert.deepEqual(pathsInRoot(['/r/a/b.ts', '/r', '/rx/c', 'C:\\r\\d'], '/r'), ['a/b.ts', '.']);
  assert.deepEqual(pathsInRoot(['C:/r/d/e'], 'C:\\r'), ['d/e']);
});

test('row matcher, recent branches, shortlog', () => {
  const m = rowMatcher('fix')!;
  assert.ok(m('Fix bug', 'x', '00'));
  assert.ok(!m('feature', 'x', '00'));
  assert.ok(rowMatcher('8cae')!('x', 'y', '8cae5af'));
  assert.ok(rowMatcher('(')!('a (b', '', ''));
  assert.equal(rowMatcher('(', true), undefined);
  assert.ok(rowMatcher('Bob', false, true)!('x', 'Bob', '1'));
  assert.ok(!rowMatcher('bob', false, true)!('x', 'Bob', '1'));
  const reflog = 'commit: x\ncheckout: moving from feat to main\ncheckout: moving from main to feat\ncheckout: moving from gone to main';
  assert.deepEqual(recentBranches(reflog, new Set(['main', 'feat'])), ['main', 'feat']);
  const s = parseShortlog('     7\tAkmal <a@x.id>\n     2\tAKMAL <A@x.id>\n    12\tBob <b@b>\n');
  assert.deepEqual(s, [
    { name: 'Bob', email: 'b@b', count: 12 },
    { name: 'Akmal', email: 'a@x.id', count: 9 },
  ]);
});

test('reference labels order, head priority and colors', () => {
  const r = (name: string, hash: string, extra: Partial<Ref> = {}): Ref => {
    const type = name.startsWith('refs/heads/') ? 'head' : name.startsWith('refs/remotes/') ? 'remote' : 'tag';
    const short = name.replace(/^refs\/(heads|remotes|tags)\//, '');
    return { name, short, type, hash, remote: type === 'remote' ? short.split('/')[0] : undefined, ...extra };
  };
  const refs = [
    r('refs/tags/v1', 'a'),
    r('refs/remotes/origin/main', 'a'),
    r('refs/heads/zeta', 'a'),
    r('refs/heads/main', 'a', { upstream: 'origin/main' }),
    r('refs/heads/feature/x', 'b'),
    r('refs/remotes/origin/dev', 'c'),
  ];
  const fav = new Set(['main', 'origin/main']);
  const m = labelsByHash(refs, 'b', 'feature/x', fav);
  assert.deepEqual(m.get('a')!.map((l) => l.name), ['main', 'zeta', 'origin/main', 'v1']);
  assert.equal(m.get('a')![0].upstream, 'origin/main');
  assert.equal(m.get('a')![0].favorite, true);
  assert.equal(m.get('b')![0].current, true);
  assert.deepEqual(headPriority(m, 'b'), ['b', 'a', 'c']);
  const detached = labelsByHash(refs, 'd', undefined, fav);
  assert.deepEqual(detached.get('d')!.map((l) => l.kind), ['HEAD']);
  assert.equal(headPriority(detached, 'd')[0], 'd');
  assert.equal(colorName(m.get('c'), 'c'), 'dev');
  assert.equal(colorName(undefined, 'abc'), 'abc');
  assert.ok(isDefaultFavorite('origin/master') && !isDefaultFavorite('dev'));
});

test('follow names: NUL separated, non-ASCII kept unquoted', () => {
  const out = 'r\u00e9named.txt\0r\u00e9named.txt\0\n\u00fcn\u00ef c\u00f6d\u00e9.txt\0';
  assert.deepEqual(parseFollowNames(out, 'r\u00e9named.txt'), ['\u00fcn\u00ef c\u00f6d\u00e9.txt']);
  assert.deepEqual(parseFollowNames('', 'a'), []);
});
