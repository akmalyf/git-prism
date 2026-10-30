// Tests for revision document uri queries.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseRevisionQuery } from './target';

test('JSON query', () => {
  assert.deepEqual(parseRevisionQuery(JSON.stringify({ repoRoot: '/r', rev: 'abc', path: 'a/b.ts' }), '/r/a/b.ts'), { repoRoot: '/r', rev: 'abc', path: 'a/b.ts' });
});

test('URL parameters, path derived from the uri', () => {
  assert.deepEqual(parseRevisionQuery('repoRoot=%2Fr&rev=HEAD~1', '/r/x/y.txt'), { repoRoot: '/r', rev: 'HEAD~1', path: 'x/y.txt' });
});

test('incomplete query', () => {
  assert.equal(parseRevisionQuery('rev=1', '/a'), undefined);
  assert.equal(parseRevisionQuery('{bad json', '/a'), undefined);
});
