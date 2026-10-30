// Unit tests for match.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchText, normalizeRanges } from './match';

test('substring match is case-insensitive', () => {
  assert.deepEqual(matchText('cont', 'UserController.php'), [[4, 8]]);
  assert.deepEqual(matchText('', 'abc'), []);
  assert.equal(matchText('Cont', 'usercontroller', true), null);
});

test('camelHump / word fragments', () => {
  assert.deepEqual(matchText('srvctrl', 'ServiceController'), null);
  assert.deepEqual(matchText('sercon', 'ServiceController'), [[0, 3], [7, 10]]);
  assert.deepEqual(matchText('fb', 'feature/bug-fix'), [[0, 1], [8, 9]]);
  assert.deepEqual(matchText('ubf', 'upgrade/bug-fix'), [[0, 1], [8, 9], [12, 13]]);
  assert.deepEqual(matchText('o m', 'origin/main'), [[0, 1], [7, 8]]);
  assert.equal(matchText('xyz', 'origin/main'), null);
});

test('normalizeRanges', () => {
  assert.deepEqual(normalizeRanges([[5, 7], [0, 2], [2, 3]], 1), [[1, 4], [6, 8]]);
});
