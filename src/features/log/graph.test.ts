// Tests of the commit graph engine: layout, element order, edge continuity between rows, long edges, performance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommitGraph, EDGE_DOWN, EDGE_TUPLE, EDGE_UP, FLAG_ARROW, FLAG_DOTTED, FLAG_TERMINAL, toCsr } from './graph';
import type { GraphRowPrint } from './protocol';

/** Builds a graph from "hash: parent parent" lines in table (topological) order. */
function graphOf(lines: string[], heads: string[] = []): { g: CommitGraph; row: (h: string) => number } {
  const hashes = lines.map((l) => l.split(':')[0].trim());
  const idx = new Map(hashes.map((h, i) => [h, i]));
  const parents = lines.map((l) => (l.split(':')[1] ?? '').trim().split(/\s+/).filter(Boolean).map((p) => idx.get(p) ?? -1));
  const g = new CommitGraph({ count: lines.length, ...toCsr(parents), headOrder: heads.map((h) => idx.get(h)!) });
  return { g, row: (h) => idx.get(h)! };
}

function segs(r: GraphRowPrint): { pos: number; to: number; type: number; color: number; flags: number; target: number }[] {
  const out = [];
  for (let i = 0; i < r.edges.length; i += EDGE_TUPLE) {
    const [pos, to, type, color, flags, target] = r.edges.slice(i, i + EDGE_TUPLE);
    out.push({ pos, to, type, color, flags, target });
  }
  return out;
}

/** Every non-terminal DOWN half-segment of row r must meet an UP half-segment of row r+1 at the same x. */
function assertContinuity(rows: GraphRowPrint[]): void {
  for (let r = 0; r + 1 < rows.length; r++) {
    const downs = segs(rows[r]).filter((s) => s.type === EDGE_DOWN && !(s.flags & FLAG_TERMINAL)).map((s) => `${s.pos + s.to}`).sort();
    const ups = segs(rows[r + 1]).filter((s) => s.type === EDGE_UP && !(s.flags & FLAG_TERMINAL)).map((s) => `${s.pos + s.to}`).sort();
    assert.deepEqual(downs, ups, `row ${r} → ${r + 1}`);
  }
}

test('linear history stays in lane 0', () => {
  const { g } = graphOf(['d: c', 'c: b', 'b: a', 'a:']);
  const rows = g.print(0, 4, { showLongEdges: false });
  assert.deepEqual(rows.map((r) => r.node), [0, 0, 0, 0]);
  assert.deepEqual(rows.map((r) => r.width), [1, 1, 1, 1]);
  assert.equal(segs(rows[0]).length, 1);
  assert.equal(segs(rows[3]).length, 1);
  assertContinuity(rows);
  assert.equal(new Set(rows.map((r) => r.color)).size, 1);
});

test('merge: first parent keeps its lane, incoming branch goes right', () => {
  // git log --topo-order of: main m1 m2 m3 + feat f1 f2 merged, then m4
  const { g, row } = graphOf(['m4: M', 'M: m3 f2', 'f2: f1', 'f1: m2', 'm3: m2', 'm2: m1', 'm1:'], ['m4']);
  const rows = g.print(0, 7, { showLongEdges: false });
  assert.equal(rows[row('m4')].node, 0);
  assert.equal(rows[row('M')].node, 0);
  assert.equal(rows[row('f2')].node, 1);
  assert.equal(rows[row('f1')].node, 1);
  assert.equal(rows[row('m3')].node, 0);
  assert.equal(rows[row('m2')].node, 0);
  assert.equal(rows[row('f2')].width, 2);
  assertContinuity(rows);
  assert.equal(rows[row('m4')].color, rows[row('m1')].color);
  assert.notEqual(rows[row('f2')].color, rows[row('m1')].color);
  assert.deepEqual(g.children(row('m2')).sort(), [row('f1'), row('m3')].sort());
});

test('octopus merge and several roots', () => {
  const { g, row } = graphOf(['o: a b c', 'c: c0', 'b:', 'a: a0', 'a0:', 'c0:', 'x: y', 'y:'], ['o']);
  const rows = g.print(0, 8, { showLongEdges: false });
  assertContinuity(rows);
  assert.equal(rows[row('o')].node, 0);
  const downs = segs(rows[row('o')]).filter((s) => s.type === EDGE_DOWN);
  assert.equal(downs.length, 3);
  assert.equal(rows[row('a0')].node, 0);
  // separate component starting at x: lanes free again
  assert.equal(rows[row('x')].node, 0);
  assert.equal(rows[row('y')].node, 0);
});

test('HEAD lineage is preferred in lane 0', () => {
  // two branches; head order puts "b2" (current branch) first although "a2" is the top row
  const { g, row } = graphOf(['a2: a1', 'b2: b1', 'a1: r', 'b1: r', 'r:'], ['b2', 'a2']);
  const rows = g.print(0, 5, { showLongEdges: false });
  assert.equal(rows[row('b2')].node, 0);
  assert.equal(rows[row('b1')].node, 0);
  assert.equal(rows[row('a1')].node, 1);
  assertContinuity(rows);
});

test('parents that are not loaded get a dotted terminal arrow', () => {
  const { g } = graphOf(['b: a', 'a: missing', 'z:']);
  const rows = g.print(0, 3, { showLongEdges: false });
  const s = segs(rows[2]).filter((x) => x.flags & FLAG_DOTTED);
  assert.ok(s.some((x) => x.type === EDGE_DOWN && x.flags & FLAG_TERMINAL));
  assert.ok(s.some((x) => x.type === EDGE_UP));
  assertContinuity(rows);
});

test('long edges are cut behind arrows unless "Long Edges" is on', () => {
  // m0 merges side s (directly below) and main p which is 40 rows further down
  const lines = ['m0: p s0'];
  for (let i = 0; i < 40; i++) lines.push(`s${i}: ${i === 39 ? 'p' : `s${i + 1}`}`);
  lines.push('p:');
  const { g } = graphOf(lines, ['m0']);
  const cut = g.print(0, lines.length, { showLongEdges: false });
  assertContinuity(cut);
  const mid = cut[20];
  assert.equal(mid.width, 1, 'hidden edge does not take a lane');
  const terms = cut.flatMap((r, i) => segs(r).filter((s) => s.flags & FLAG_TERMINAL).map((s) => ({ ...s, row: i })));
  assert.ok(terms.some((t) => t.type === EDGE_DOWN && t.row === 1 && t.target === lines.length - 1));
  assert.ok(terms.some((t) => t.type === EDGE_UP && t.row === lines.length - 2 && t.target === 0));
  const full = g.print(0, lines.length, { showLongEdges: true });
  assertContinuity(full);
  assert.equal(full[20].width, 2);
  // with long edges shown, edges ≥ 30 rows get arrow heads next to their ends
  assert.ok(segs(full[1]).some((s) => s.flags & FLAG_ARROW && !(s.flags & FLAG_TERMINAL)));
});

test('printing windows gives the same result as printing everything', () => {
  const { lines } = randomHistory(3000, 7);
  const { g } = graphOf(lines);
  const all = g.print(0, lines.length, { showLongEdges: false });
  assertContinuity(all);
  for (const [a, b] of [[0, 100], [1234, 1400], [2900, 3000], [255, 257], [512, 513]]) {
    assert.deepEqual(g.print(a, b, { showLongEdges: false }), all.slice(a, b));
  }
  const fullOn = g.print(0, lines.length, { showLongEdges: true });
  assertContinuity(fullOn);
  const anc = g.ancestors(0);
  assert.equal(anc[0], 1);
});

test('100k commits build and print fast', () => {
  const { parents } = randomHistory(100_000, 12);
  const t0 = Date.now();
  const g = new CommitGraph({ count: parents.length, ...toCsr(parents) });
  const built = Date.now() - t0;
  const t1 = Date.now();
  let width = 0;
  for (let from = 0; from < parents.length; from += 500) for (const r of g.print(from, from + 500, { showLongEdges: false })) width = Math.max(width, r.width);
  const printed = Date.now() - t1;
  assert.ok(built < 2000, `build ${built}ms`);
  assert.ok(printed < 8000, `print ${printed}ms`);
  assert.ok(width >= 1);
  // a window deep down is cheap thanks to checkpoints
  const t2 = Date.now();
  g.print(90_000, 90_100, { showLongEdges: true });
  assert.ok(Date.now() - t2 < 500);
});

/** Pseudo-random topologically ordered history with `branches` concurrent lines and merges. */
function randomHistory(n: number, branches: number): { lines: string[]; parents: number[][] } {
  let seed = 42;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  // rows are created bottom-up (oldest last); build parents as row indices relative to the end
  const parents: number[][] = Array.from({ length: n }, () => []);
  const tips: number[] = [n - 1];
  for (let i = n - 2; i >= 0; i--) {
    const k = Math.floor(rnd() * tips.length);
    const p = [tips[k]];
    if (tips.length > 1 && rnd() < 0.08) {
      const m = (k + 1 + Math.floor(rnd() * (tips.length - 1))) % tips.length;
      p.push(tips[m]);
      tips.splice(m, 1);
    }
    parents[i] = p;
    const kk = tips.indexOf(p[0]);
    if (tips.length < branches && rnd() < 0.1) tips.push(i);
    else tips[kk] = i;
  }
  const lines = parents.map((ps, i) => `c${i}: ${ps.map((p) => `c${p}`).join(' ')}`);
  return { lines, parents };
}

test('up/down constants', () => {
  assert.equal(EDGE_UP, 0);
  assert.equal(EDGE_DOWN, 1);
});
