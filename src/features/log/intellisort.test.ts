// Unit tests for intellisort.ts (node --test).
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareLayoutRefs, dateTopoOrder, intelliSort, naturalCompare, sortHeads, type HeadRef } from './intellisort';

/** commits as [parents, time]; index = id */
const graph = (c: [number[], number][]) => ({ parents: c.map((x) => x[0]), times: c.map((x) => x[1]) });

const topological = (order: number[], parents: number[][]) => {
  const pos = new Map(order.map((c, i) => [c, i]));
  for (const [c, ps] of parents.entries()) for (const p of ps) if (p >= 0) assert.ok(pos.get(c)! < pos.get(p)!, `${c} above ${p}`);
};

test('dateTopoOrder: newest first, children above parents', () => {
  // 0 <- 1 <- 2 (main), 0 <- 3 (feature, newer than 2)
  const g = graph([[[], 10], [[0], 20], [[1], 30], [[0], 40]]);
  const order = dateTopoOrder(g);
  assert.deepEqual(order, [3, 2, 1, 0]);
  topological(order, g.parents as number[][]);
});

test('dateTopoOrder: a child stays above an older parent even if it is older than others', () => {
  // 1 (t=5) has parent 0 (t=50): skewed clock
  const g = graph([[[], 50], [[0], 5], [[], 30]]);
  const order = dateTopoOrder(g);
  topological(order, g.parents as number[][]);
  assert.equal(order[order.length - 1] === 0 || order.indexOf(1) < order.indexOf(0), true);
});

test('layout comparator: origin/master, remotes, master, locals, tags, HEAD', () => {
  const refs: HeadRef[] = [
    { name: 'HEAD', kind: 'HEAD' },
    { name: 'v2', kind: 'tag' },
    { name: 'feature', kind: 'local' },
    { name: 'master', kind: 'local' },
    { name: 'origin/dev', kind: 'remote' },
    { name: 'origin/master', kind: 'remote' },
  ];
  assert.deepEqual([...refs].sort(compareLayoutRefs).map((r) => r.name), ['origin/master', 'origin/dev', 'master', 'feature', 'v2', 'HEAD']);
  assert.ok(naturalCompare('release-2', 'release-10') < 0);
  assert.deepEqual(sortHeads([0, 1, 2], (r) => (r === 2 ? [{ name: 'origin/main', kind: 'remote' }] : [])), [2, 0, 1]);
});

test('intelliSort: merged branch commits sit right below the merge', () => {
  // main: 0 <- 1 <- 4(merge of 3) ; feature: 0 <- 2 <- 3 ; times interleave
  const g = graph([[[], 1], [[0], 3], [[0], 2], [[2], 4], [[1, 3], 5]]);
  const refs = (c: number): HeadRef[] => (c === 4 ? [{ name: 'master', kind: 'local' }] : []);
  const order = intelliSort(g, refs);
  topological(order, g.parents as number[][]);
  assert.deepEqual(order, [4, 3, 2, 1, 0]);
});

test('intelliSort: every commit placed once, topological, for a random DAG', () => {
  const n = 400;
  const c: [number[], number][] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    const ps: number[] = [];
    if (i > 0) ps.push(Math.floor(rnd() * i));
    if (i > 5 && rnd() < 0.2) ps.push(Math.floor(rnd() * i));
    c.push([[...new Set(ps)], i * 60 + Math.floor(rnd() * 600)]);
  }
  const rev = c.map((_, i) => c[n - 1 - i]);
  const g = graph(rev.map(([ps, t]) => [ps.map((p) => n - 1 - p), t]));
  const order = intelliSort(g, (x) => (x % 37 === 0 ? [{ name: `b${x}`, kind: 'local' }] : []));
  assert.equal(new Set(order).size, n);
  topological(order, g.parents as number[][]);
});
