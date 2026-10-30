// Tests of the Git Console tab line parser, buffer and timestamp format.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsoleBuffer, consoleText, formatConsoleTime, parseConsoleMessage } from './consoleparse';

test('successful command line', () => {
  assert.deepEqual(parseConsoleMessage('info', '[proj] git status --porcelain=v2  (12 ms)'), [
    { kind: 'command', text: '[proj] git status --porcelain=v2', ms: 12 },
  ]);
});

test('failed command with stderr', () => {
  const msg = "[proj] git checkout 'no such'  (5 ms) → exit 1\nerror: pathspec 'no such' did not match\nhint: x";
  assert.deepEqual(parseConsoleMessage('error', msg), [
    { kind: 'command', text: "[proj] git checkout 'no such'", ms: 5, exit: 1 },
    { kind: 'error', text: "error: pathspec 'no such' did not match" },
    { kind: 'error', text: 'hint: x' },
  ]);
});

test('failed command without stderr', () => {
  assert.deepEqual(parseConsoleMessage('error', '[r] git diff --quiet  (3 ms) → exit -1\n'), [
    { kind: 'command', text: '[r] git diff --quiet', ms: 3, exit: -1 },
    { kind: 'error', text: 'exit code -1' },
  ]);
});

test('other messages keep their level', () => {
  assert.deepEqual(parseConsoleMessage('warn', 'a\r\nb'), [
    { kind: 'warning', text: 'a' },
    { kind: 'warning', text: 'b' },
  ]);
  assert.deepEqual(parseConsoleMessage('info', ''), []);
  assert.equal(parseConsoleMessage('info', '[x] gitk  (1 ms)')[0].kind, 'output');
});

test('buffer is bounded and ids increase', () => {
  const b = new ConsoleBuffer(3);
  b.push([{ kind: 'output', text: '1' }, { kind: 'output', text: '2' }], 1);
  const added = b.push([{ kind: 'output', text: '3' }, { kind: 'output', text: '4' }], 2);
  assert.deepEqual(added.map((l) => l.id), [3, 4]);
  assert.deepEqual(b.all.map((l) => l.text), ['2', '3', '4']);
  b.clear();
  assert.equal(b.all.length, 0);
  assert.equal(b.push([{ kind: 'output', text: '5' }], 3)[0].id, 5);
});

test('timestamps and text', () => {
  const t = new Date(2026, 9, 29, 9, 5, 7, 42).getTime();
  assert.equal(formatConsoleTime(t), '09:05:07.042');
  const lines = [
    { id: 1, time: t, kind: 'command' as const, text: '[p] git fetch' },
    { id: 2, time: t, kind: 'error' as const, text: 'fatal: x' },
  ];
  assert.equal(consoleText(lines, true), '09:05:07.042: [p] git fetch\nfatal: x');
  assert.equal(consoleText(lines, false), '[p] git fetch\nfatal: x');
});
