// Unit tests for lineMap.ts (node --test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLine } from './lineMap';

test('maps lines around insertions, deletions and modifications', () => {
  // left lines 2..3 replaced by right lines 2..5; left line 6 deleted (right has nothing at 8)
  const changes = [
    { startLine1: 2, endLine1: 4, startLine2: 2, endLine2: 6 },
    { startLine1: 6, endLine1: 7, startLine2: 8, endLine2: 8 },
  ];
  assert.equal(mapLine(changes, 0, 1), 0);
  assert.equal(mapLine(changes, 3, 1), 3);
  assert.equal(mapLine(changes, 4, 1), 6);
  assert.equal(mapLine(changes, 6, 1), 8);
  assert.equal(mapLine(changes, 9, 1), 10);
  assert.equal(mapLine(changes, 5, 2), 3);
  assert.equal(mapLine(changes, 7, 2), 5);
  assert.equal(mapLine([], 4, 2), 4);
});
