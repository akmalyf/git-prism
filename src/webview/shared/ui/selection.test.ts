// Unit tests for selection.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SelectionModel, arrayNav } from './selection';

const nav = arrayNav(['a', 'b', 'c', 'd', 'e']);
const sorted = (s: SelectionModel<string>) => s.ordered(nav);

test('click, toggle, shift range', () => {
  const s = new SelectionModel<string>();
  let fired = 0;
  s.onDidChange(() => fired++);
  s.click('b', nav);
  assert.deepEqual(sorted(s), ['b']);
  s.click('d', nav, { shift: true });
  assert.deepEqual(sorted(s), ['b', 'c', 'd']);
  s.click('a', nav, { shift: true });
  assert.deepEqual(sorted(s), ['a', 'b']);
  s.click('e', nav, { toggle: true });
  assert.deepEqual(sorted(s), ['a', 'b', 'e']);
  s.click('a', nav, { toggle: true });
  assert.deepEqual(sorted(s), ['b', 'e']);
  assert.equal(s.lead, 'a');
  assert.equal(fired, 5);
});

test('keyboard extend keeps anchor', () => {
  const s = new SelectionModel<string>();
  s.moveTo('c', nav);
  s.moveTo('d', nav, true);
  s.moveTo('e', nav, true);
  assert.deepEqual(sorted(s), ['c', 'd', 'e']);
  s.moveTo('b', nav, true);
  assert.deepEqual(sorted(s), ['b', 'c']);
  assert.equal(s.anchor, 'c');
});

test('single mode ignores modifiers', () => {
  const s = new SelectionModel<string>(false);
  s.click('a', nav);
  s.click('c', nav, { shift: true });
  assert.deepEqual(sorted(s), ['c']);
  s.selectAll(nav);
  assert.deepEqual(sorted(s), ['c']);
});

test('retain and selectAll', () => {
  const s = new SelectionModel<string>();
  s.selectAll(nav, (k) => k !== 'c');
  assert.deepEqual(sorted(s), ['a', 'b', 'd', 'e']);
  s.retain((k) => k === 'b' || k === 'e');
  assert.deepEqual(sorted(s), ['b', 'e']);
  const same = new SelectionModel<string>();
  let fired = 0;
  same.onDidChange(() => fired++);
  same.set(['a']);
  same.set(['a']);
  assert.equal(fired, 1);
});
