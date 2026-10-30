// Unit tests for the rebase plan / todo generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTodo,
  cleanMessage,
  combineMessages,
  isNoop,
  isProtectedBranch,
  moveRows,
  moveRowsTo,
  parseOverwrittenFiles,
  planDrop,
  planReword,
  planSquash,
  prettySquash,
  prohibitedStateMessage,
  shQuote,
  uniteRows,
  validatePlan,
  type RebaseEntry,
} from './todo';

const c = (hash: string, message = `subject ${hash}`) => ({ hash, message });
const path = (id: number) => `/tmp/x y/msg-${id}.txt`;

test('plain picks', () => {
  const t = buildTodo(planDrop([c('a'), c('b')], []), path);
  assert.equal(t.text, 'pick a subject a\npick b subject b\n');
  assert.equal(t.messages.length, 0);
});

test('reword adds exec amend with quoted message file', () => {
  const t = buildTodo(planReword([c('a'), c('b')], 'a', 'new\n\nbody  \n'), path);
  assert.equal(t.text.split('\n')[1], `exec git commit --amend --only --allow-empty --no-verify --cleanup=verbatim -F '/tmp/x y/msg-0.txt'`);
  assert.deepEqual(t.messages, [{ id: 0, text: 'new\n\nbody\n' }]);
  assert.match(t.text, /^pick a .*\nexec .*\npick b /);
});

test('drop', () => {
  const t = buildTodo(planDrop([c('a'), c('b'), c('c')], ['b']), path);
  assert.equal(t.text, 'pick a subject a\ndrop b subject b\npick c subject c\n');
});

test('squash moves later selected commits next to the oldest and applies the message once', () => {
  const plan = planSquash([c('a'), c('b'), c('c'), c('d')], ['a', 'c'], 'together');
  assert.deepEqual(plan.map((e) => `${e.action} ${e.hash}`), ['pick a', 'squash c', 'pick b', 'pick d']);
  const t = buildTodo(plan, path);
  assert.deepEqual(t.text.split('\n').slice(0, 3), ['pick a subject a', 'fixup c subject c', `exec git commit --amend --only --allow-empty --no-verify --cleanup=verbatim -F '/tmp/x y/msg-0.txt'`]);
  assert.equal(t.messages[0].text, 'together\n');
});

test('squash without edited message combines messages; fixup discards', () => {
  const e: RebaseEntry[] = [
    { hash: 'a', action: 'pick', message: 'A' },
    { hash: 'b', action: 'fixup', message: 'B' },
    { hash: 'c', action: 'squash', message: 'C\n\nbody' },
  ];
  assert.equal(buildTodo(e, path).messages[0].text, 'A\n\nC\n\nbody\n');
  const f: RebaseEntry[] = [e[0], e[1]];
  assert.equal(buildTodo(f, path).messages.length, 0);
});

test('edit stops, drop between group members is allowed', () => {
  const e: RebaseEntry[] = [
    { hash: 'a', action: 'edit', message: 'A' },
    { hash: 'b', action: 'drop', message: 'B' },
    { hash: 'c', action: 'squash', message: 'C' },
  ];
  assert.equal(buildTodo(e, path).text.split('\n').slice(0, 3).join('|'), 'edit a A|drop b B|fixup c C');
});

test('validation', () => {
  assert.equal(validatePlan([{ hash: 'a', action: 'squash', message: 'A' }]), 'There is no previous commit to squash into');
  assert.equal(validatePlan([{ hash: 'a', action: 'drop', message: 'A' }, { hash: 'b', action: 'fixup', message: 'B' }]), 'There is no previous commit to fixup into');
  assert.equal(validatePlan([{ hash: 'a', action: 'reword', message: 'A', newMessage: '  \n' }]), 'Commit message is empty');
  assert.equal(validatePlan([]), 'Nothing to rebase');
  assert.throws(() => buildTodo([], path));
});

test('noop detection', () => {
  assert.ok(isNoop(planDrop([c('a'), c('b')], []), ['a', 'b']));
  assert.ok(!isNoop(planDrop([c('b'), c('a')], []), ['a', 'b']));
});

test('pretty squash (IntelliJ)', () => {
  assert.equal(prettySquash(['A\n\nbody', 'fixup! A', 'squash! A\n\nmore', 'B', 'B']), 'A\n\nbody\n\n\nmore\n\n\nB');
  assert.equal(prettySquash(['fixup! X', 'C']), 'fixup! X\n\n\nC');
});

test('messages', () => {
  assert.equal(cleanMessage('\n\nA  \r\n\r\n\r\nB\n\n'), 'A\n\nB');
  assert.equal(combineMessages(['A', 'B', 'A']), 'A\n\nB');
  assert.equal(shQuote("it's"), `'it'\\''s'`);
});

test('move rows', () => {
  assert.deepEqual(moveRows(['a', 'b', 'c', 'd'], [1, 2], -1), { rows: ['b', 'c', 'a', 'd'], indices: [0, 1] });
  assert.deepEqual(moveRows(['a', 'b', 'c', 'd'], [1, 2], 1), { rows: ['a', 'd', 'b', 'c'], indices: [2, 3] });
  assert.deepEqual(moveRows(['a', 'b'], [0], -1).rows, ['a', 'b']);
  assert.deepEqual(moveRowsTo(['a', 'b', 'c', 'd'], [0, 2], 4), { rows: ['b', 'd', 'a', 'c'], indices: [2, 3] });
  assert.deepEqual(moveRowsTo(['a', 'b', 'c', 'd'], [3], 1), { rows: ['a', 'd', 'b', 'c'], indices: [1] });
});

test('unite', () => {
  const e = ['a', 'b', 'c', 'd'].map((h): RebaseEntry => ({ hash: h, action: 'pick', message: h }));
  const r = uniteRows(e, [3, 1]);
  assert.deepEqual(r.rows.map((x) => `${x.action} ${x.hash}`), ['pick a', 'pick b', 'squash d', 'pick c']);
  assert.deepEqual(r.indices, [1, 2]);
});

test('overwritten files', () => {
  const err = 'error: Your local changes to the following files would be overwritten by checkout:\n\tf2\n\tdir/a b.txt\nPlease commit your changes or stash them before you switch branches.\nAborting\n';
  assert.deepEqual(parseOverwrittenFiles(err), { kind: 'local', files: ['f2', 'dir/a b.txt'] });
  const u = 'error: The following untracked working tree files would be overwritten by checkout:\n\tf9\nPlease move or remove them before you switch branches.\n';
  assert.deepEqual(parseOverwrittenFiles(u), { kind: 'untracked', files: ['f9'] });
  assert.equal(parseOverwrittenFiles('fatal: bad'), undefined);
});

test('protected branches & states', () => {
  assert.ok(isProtectedBranch('main', ['master', 'main']));
  assert.ok(isProtectedBranch('release/1.0', ['release/.*']));
  assert.ok(!isProtectedBranch('mainline', ['main']));
  assert.ok(!isProtectedBranch('[x', ['[x']));
  assert.equal(prohibitedStateMessage('am', 'drop'), 'Cannot drop during rebase');
  assert.equal(prohibitedStateMessage('bisect', 'drop'), undefined);
  assert.equal(prohibitedStateMessage('rebase', 'reword'), 'Cannot reword during rebase');
  assert.equal(prohibitedStateMessage('none', 'reword'), undefined);
});
