// Unit tests for the File History helpers (historyfile.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affectedFiles, compareChange, historyChange, insidePaths, pathAtRevision } from './historyfile';

test('history paths filter', () => {
  assert.ok(insidePaths('src/a.ts', ['src']));
  assert.ok(insidePaths('x', ['.']));
  assert.ok(!insidePaths('srcx/a.ts', ['src']));
  const files = [{ path: 'b.ts', oldPath: 'a.ts', kind: 'R' as const }, { path: 'c.ts', kind: 'M' as const }];
  assert.deepEqual(affectedFiles(files, ['a.ts']), [files[0]]);
});

test('history file in a commit follows renames', () => {
  const files = [{ path: 'new.ts', oldPath: 'old.ts', kind: 'R' as const }, { path: 'z.ts', kind: 'D' as const }];
  assert.equal(historyChange(files, ['new.ts', 'old.ts'])?.path, 'new.ts');
  assert.equal(historyChange(files, ['old.ts'])?.path, 'new.ts');
  assert.equal(historyChange(files, ['q.ts']), undefined);
  assert.deepEqual(pathAtRevision(files[1], []), { path: 'z.ts', deleted: true });
  assert.deepEqual(pathAtRevision(undefined, ['old.ts']), { path: 'old.ts', deleted: false });
  assert.deepEqual(pathAtRevision(undefined, []), { deleted: true });
});

test('compare two revisions of the file', () => {
  assert.deepEqual(compareChange('a', 'a'), { path: 'a', kind: 'M' });
  assert.deepEqual(compareChange('a', 'b'), { path: 'b', oldPath: 'a', kind: 'R' });
  assert.deepEqual(compareChange(undefined, 'b'), { path: 'b', kind: 'A' });
  assert.deepEqual(compareChange('a', undefined), { path: 'a', kind: 'D' });
  assert.equal(compareChange(undefined, undefined), undefined);
});
