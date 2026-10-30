// Unit tests for pathtree.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPathTree, pathTreeFiles, pathTreeToNodes, type PathNode } from './pathtree';

const files = [
  'app/Http/Service/Controllers/UserController.php',
  'app/Http/Service/Controllers/AuthController.php',
  'app/Http/Kernel.php',
  'app/Models/User.php',
  'README.md',
  'config/app.php',
];

const shape = (ns: PathNode<string>[]): unknown =>
  ns.map((n) => (n.kind === 'file' ? n.name : { [`${n.name} (${n.fileCount})`]: shape(n.children) }));

test('group by directory with compaction', () => {
  const t = buildPathTree(files, { path: (f) => f });
  assert.deepEqual(shape(t), [
    { 'app (4)': [{ 'Http (3)': [{ 'Service/Controllers (2)': ['AuthController.php', 'UserController.php'] }, 'Kernel.php'] }, { 'Models (1)': ['User.php'] }] },
    { 'config (1)': ['app.php'] },
    'README.md',
  ]);
  const dir = t[0] as Extract<PathNode<string>, { kind: 'dir' }>;
  const http = dir.children[0] as Extract<PathNode<string>, { kind: 'dir' }>;
  assert.equal(http.children[0].kind === 'dir' && http.children[0].path, 'app/Http/Service/Controllers');
  assert.equal(pathTreeFiles(t).length, 6);
});

test('root chain compaction and no compaction', () => {
  const t = buildPathTree(['a/b/c/x.txt', 'a/b/c/y.txt'], { path: (f) => f });
  assert.deepEqual(shape(t), [{ 'a/b/c (2)': ['x.txt', 'y.txt'] }]);
  const u = buildPathTree(['a/b/x.txt'], { path: (f) => f, compact: false });
  assert.deepEqual(shape(u), [{ 'a (1)': [{ 'b (1)': ['x.txt'] }] }]);
});

test('flat mode sorts by name then dir', () => {
  const t = buildPathTree(['z/b.txt', 'a/b.txt', 'c.txt'], { path: (f) => f, groupByDirectory: false });
  assert.deepEqual(t.map((n) => n.kind === 'file' && `${n.dir}|${n.name}`), ['a|b.txt', 'z|b.txt', '|c.txt']);
});

test('group levels and unique ids', () => {
  const items = [
    { repo: '/r/two', path: 'x.txt' },
    { repo: '/r/one', path: 'src/a.ts' },
    { repo: '/r/one', path: 'src/a.ts' },
  ];
  const t = buildPathTree(items, { path: (i) => i.path, groups: [{ key: (i) => i.repo, label: (k) => k.split('/').pop()! }], idPrefix: 'c:' });
  assert.deepEqual(t.map((n) => n.name), ['one', 'two']);
  const ids = pathTreeFiles(t).map((f) => f.id);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((id) => id.startsWith('c:')));
  const nodes = pathTreeToNodes(t, { file: (n) => ({ checkable: true, data: n.item }) });
  assert.equal(nodes[0].description, '2 files');
  assert.equal(nodes[0].children![0].label, 'src');
  assert.equal(nodes[0].children![0].children![0].checkable, true);
  assert.equal(nodes[0].children![0].children![0].description, undefined);
});
