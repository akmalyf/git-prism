// Unit tests for the pure Git Log webview modules (run: node scripts/build.mjs --test && node --test dist-test/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RefLabel, RefsInfo } from '../../features/log/protocol';
import { setFormatLocale } from '../shared/ui/format';
import { buildBranchTree, leavesOf } from './branchtree';
import { buildCommitMenu, type CommitMenuAction, type CommitMenuEntry, type MenuCommit } from './commitmenu';
import { formatLogDate, formatPattern } from './dates';
import { buildFileHistoryMenu, type FileHistoryMenuEntry } from './historymenu';
import { groupLabels } from './labels';
import { linkify } from './linkify';

const sec = (d: Date) => d.getTime() / 1000;

test('date column formats', () => {
  setFormatLocale('id-ID');
  const now = new Date(2026, 9, 29, 15, 0);
  assert.equal(formatLogDate(sec(new Date(2026, 9, 29, 11, 19)), { dateFormat: '', prettyDates: true }, now), 'Today 11.19');
  assert.equal(formatLogDate(sec(new Date(2026, 9, 28, 14, 53)), { dateFormat: '', prettyDates: true }, now), 'Yesterday 14.53');
  assert.equal(formatLogDate(sec(new Date(2026, 9, 27, 10, 27)), { dateFormat: '', prettyDates: false }, now), '27/10/26, 10.27');
  assert.equal(formatLogDate(sec(new Date(2026, 0, 2, 3, 4, 5)), { dateFormat: 'yyyy-MM-dd HH:mm:ss', prettyDates: true }, now), '2026-01-02 03:04:05');
  assert.equal(formatPattern(new Date(2026, 0, 2, 3, 4), "d.M.yy 'at' H:mm"), '2.1.26 at 3:04');
  assert.equal(formatLogDate(0, { dateFormat: '', prettyDates: true }, now), '');
});

const ref = (name: string, kind: RefLabel['kind'], extra: Partial<RefLabel> = {}): RefLabel => ({ name, full: name, kind, ...extra });

test('reference labels group a branch with its upstream', () => {
  const refs = [ref('main', 'local', { current: true, upstream: 'origin/main' }), ref('origin/main', 'remote', { remote: 'origin' }), ref('origin/dev', 'remote', { remote: 'origin' }), ref('v1.0', 'tag')];
  const parts = groupLabels(refs, { showTagNames: true, compact: false });
  assert.deepEqual(parts.map((p) => p.text), ['origin & main', 'origin/dev', 'v1.0']);
  assert.deepEqual(parts[0].kinds, ['remote', 'local']);
  assert.equal(parts[0].current, true);
  assert.deepEqual(groupLabels(refs, { showTagNames: false, compact: false }).map((p) => p.text), ['origin & main', 'origin/dev', '']);
  assert.deepEqual(groupLabels(refs, { showTagNames: true, compact: true }).map((p) => p.text), ['origin & main', '', '']);
  const other = groupLabels([ref('feat', 'local', { upstream: 'origin/feature' }), ref('origin/feature', 'remote', { remote: 'origin' })], { showTagNames: true, compact: false });
  assert.deepEqual(other.map((p) => p.text), ['origin/feature & feat']);
});

test('linkify finds URLs and hashes', () => {
  const s = linkify('Fix #12, see https://example.com/a/b. Reverts 1a2b3c4d and deadbeef words');
  assert.deepEqual(s.filter((x) => x.kind !== 'text').map((x) => `${x.kind}:${x.text}`), ['url:https://example.com/a/b', 'hash:1a2b3c4d']);
  assert.equal(s.map((x) => x.text).join(''), 'Fix #12, see https://example.com/a/b. Reverts 1a2b3c4d and deadbeef words');
});

const commit = (o: Partial<MenuCommit> = {}): MenuCommit => ({ root: 0, hash: 'a'.repeat(40), parents: ['b'.repeat(40)], childRows: [-1], parentRows: [1], refs: [], onCurrentBranch: true, ...o });
const get = (m: CommitMenuEntry[], id: string) => m.find((e): e is CommitMenuAction => typeof e === 'object' && 'id' in e && e.id === id)!;
const roots = [{ detached: false, branch: 'main', operation: 'none' as const }];

test('commit menu order and enablement', () => {
  const m = buildCommitMenu([commit({ head: true })], roots);
  const labels = m.filter((e): e is CommitMenuAction => typeof e === 'object' && 'id' in e).map((e) => e.label);
  assert.deepEqual(labels.slice(0, 8), ['Copy Revision Number', 'Create Patch…', 'Cherry-Pick', `Checkout Revision '${'a'.repeat(8)}'`, 'Show Repository at Revision', 'Compare Versions', 'Compare with Local', 'Reset Current Branch to Here…']);
  assert.equal(labels[labels.length - 1], 'Go to Parent Commit');
  assert.equal(get(m, 'undo').disabled, false);
  assert.equal(get(m, 'cherryPick').disabled, true, 'already in the current branch');
  assert.equal(get(m, 'compareVersions').disabled, true);
  assert.equal(get(m, 'squash').disabled, true);
  assert.equal(get(m, 'goToChild').disabled, true);
  assert.equal(get(m, 'goToParent').disabled, false);

  const two = buildCommitMenu([commit(), commit({ hash: 'c'.repeat(40) })], roots);
  assert.equal(get(two, 'compareVersions').disabled, false);
  assert.equal(get(two, 'squash').disabled, false);
  assert.equal(get(two, 'reword').disabled, true);
  assert.equal(get(two, 'checkoutRevision').disabled, true);

  const merge = buildCommitMenu([commit({ parents: ['b'.repeat(40), 'd'.repeat(40)] })], roots);
  assert.equal(get(merge, 'revert').disabled, true);
  assert.equal(get(merge, 'reword').disabled, true);
  assert.equal(get(merge, 'interactiveRebase').disabled, false);

  const other = buildCommitMenu([commit({ onCurrentBranch: false })], roots);
  assert.equal(get(other, 'cherryPick').disabled, false);
  assert.equal(get(other, 'fixup').disabled, true);
  assert.equal(get(other, 'undo').disabled, true);

  const rebasing = buildCommitMenu([commit()], [{ detached: true, operation: 'rebase' }]);
  assert.equal(get(rebasing, 'drop').disabled, true);
  assert.equal(get(rebasing, 'pushUpTo').disabled, true);

  const withRefs = buildCommitMenu([commit({ refs: [ref('main', 'local'), ref('v1', 'tag')] })], roots);
  assert.equal(withRefs.filter((e) => typeof e === 'object' && 'branch' in e).length, 1);
  const co = get(withRefs, 'checkoutRevision');
  assert.equal(co.label, 'Checkout');
  assert.deepEqual(co.checkoutBranches?.map((r) => r.name), ['main']);
});

const info = (root: string, o: Partial<RefsInfo> = {}): RefsInfo => ({ root, name: root.slice(1), current: 'main', head: 'h', detached: false, local: [], remote: [], tags: [], recent: [], favorites: [], ...o });

test('branches tree groups by directory and merges repositories', () => {
  const a = info('/a', {
    local: [{ name: 'main', full: 'refs/heads/main', hash: '1', current: true, favorite: true }, { name: 'feature/x', full: 'refs/heads/feature/x', hash: '2', ahead: 2, behind: 1 }, { name: 'feature/y', full: '', hash: '3' }, { name: 'dev', full: '', hash: '4' }],
    remote: [{ name: 'origin/HEAD', full: '', hash: '1', remote: 'origin' }, { name: 'origin/main', full: '', hash: '1', remote: 'origin' }, { name: 'origin/bug/z', full: '', hash: '5', remote: 'origin' }],
    tags: [{ name: 'v1', full: '', hash: '1' }],
  });
  const b = info('/b', { local: [{ name: 'main', full: '', hash: '9', current: true }] });
  const tree = buildBranchTree([a, b], { groupByDirectory: true, groupByRepository: false, showTags: true });
  assert.deepEqual(tree.map((n) => n.label), ['HEAD (Current Branch)', 'Local', 'Remote', 'Tags']);
  const local = tree[1].children!;
  assert.deepEqual(local.map((n) => n.label), ['main', 'dev', 'feature']);
  assert.equal(local[0].data!.refs!.length, 2, 'main of both repositories');
  assert.deepEqual(local[2].children!.map((n) => n.label), ['x', 'y']);
  assert.equal(local[2].children![0].description, '↓1 ↑2');
  const origin = tree[2].children![0];
  assert.equal(origin.label, 'origin');
  assert.deepEqual(origin.children!.map((n) => n.label), ['bug', 'main']);
  assert.equal(leavesOf(tree).length, 8);

  const flat = buildBranchTree([a], { groupByDirectory: false, groupByRepository: false, showTags: false, filter: (n) => n.includes('feature') });
  assert.deepEqual(flat.map((n) => n.label), ['Local']);
  assert.deepEqual(flat[0].children!.map((n) => n.label), ['feature/x', 'feature/y']);

  const byRepo = buildBranchTree([a, b], { groupByDirectory: false, groupByRepository: true, showTags: false });
  assert.deepEqual(byRepo[1].children!.map((n) => n.label), ['a', 'b']);
});

test('file history context menu (Vcs.FileHistory.ContextMenu)', () => {
  const c = (hash: string, extra: Partial<MenuCommit> = {}): MenuCommit => ({ root: 0, hash, parents: ['p'], childRows: [], parentRows: [], refs: [], onCurrentBranch: true, ...extra });
  const roots = [{ detached: false, branch: 'main', operation: 'none' as const }];
  const info = { root: '/r', hash: 'a', dir: false, path: 'f.ts', deleted: false, changed: true };
  const menu = buildFileHistoryMenu([c('a')], roots, info);
  const labels = menu.map((e) => (e === '-' ? '-' : e.label));
  assert.deepEqual(labels, [
    'Copy Revision Number', 'Create Patch…', 'Cherry-Pick', '-',
    'Get', 'Show File at Revision', 'Compare with Local', 'Show Diff', 'Show Diff in a New Tab', 'Show All Affected Files', 'Annotate', 'Show in Git Log', '-',
    'Revert Commit', 'Fixup…', 'Squash Into…', '-', 'New Tag…',
  ]);
  assert.ok(!labels.some((l) => /Reset|Undo|Drop|Interactively|Push All|Edit Commit Message/.test(l)));
  const byLabel = (m: FileHistoryMenuEntry[], l: string) => m.find((e): e is Exclude<FileHistoryMenuEntry, '-'> => e !== '-' && e.label === l);
  // deleted in that revision: no file to open/annotate
  const del = buildFileHistoryMenu([c('a')], roots, { ...info, deleted: true, path: undefined });
  assert.equal(byLabel(del, 'Show File at Revision')?.disabled, true);
  assert.equal(byLabel(del, 'Annotate')?.disabled, true);
  // directory history: no Get
  assert.equal(byLabel(buildFileHistoryMenu([c('a')], roots, { ...info, dir: true }), 'Get')?.disabled, true);
  // two rows: "Compare"
  const two = buildFileHistoryMenu([c('a'), c('b')], roots);
  assert.equal(byLabel(two, 'Compare')?.disabled, false);
  assert.equal(byLabel(two, 'Show All Affected Files')?.disabled, true);
  assert.equal(byLabel(two, 'Cherry-Pick')?.disabled, true);
});
