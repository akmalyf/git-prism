// IntelliJ's commit order for the Git Log (pure TS, no vscode/node imports), so rows come out exactly as in
// PhpStorm: VcsLogSorter.sortByDateTopoOrder (VcsLogJoiner.NewCommitIntegrator) for the base order, then IntelliSort
// (BekSorter: BekBranchCreator + BekBranchMerger) on top of a GraphLayoutBuilder layout whose heads are sorted by
// HeadCommitsComparator / GitRefManager's branch layout comparator. Ports of intellij-community (Apache 2.0).

/** A ref pointing at a commit, as far as the head comparator cares. */
export interface HeadRef {
  /** short name: main, origin/main, v1.0, HEAD */
  name: string;
  kind: 'local' | 'remote' | 'tag' | 'HEAD';
}

// GitRefManager.GitBranchLayoutComparator: ORIGIN_MASTER, REMOTE_BRANCH, MASTER, LOCAL_BRANCH, TAG, CURRENT_BRANCH, HEAD, OTHER
function layoutType(r: HeadRef): number {
  switch (r.kind) {
    case 'remote':
      return r.name === 'origin/master' || r.name === 'origin/main' ? 0 : 1;
    case 'local':
      return r.name === 'master' || r.name === 'main' ? 2 : 3;
    case 'tag':
      return 4;
    case 'HEAD':
      return 6;
  }
}

/** java.lang.String.hashCode (int32 overflow), the graph color id of a ref name. */
export function javaStringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

/** com.intellij.openapi.util.text.NaturalComparator (case-insensitive, digit runs by value). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** GitRefManager branch layout comparator: negative = laid out more to the left ("more important"). */
export function compareLayoutRefs(a: HeadRef, b: HeadRef): number {
  return layoutType(a) - layoutType(b) || naturalCompare(a.name, b.name);
}

/** RefsModel.getRefForHeadCommit: the most important ref of a commit. */
export function bestLayoutRef(refs: readonly HeadRef[]): HeadRef | undefined {
  let best: HeadRef | undefined;
  for (const r of refs) if (!best || compareLayoutRefs(r, best) < 0) best = r;
  return best;
}

/**
 * Rows to start the layout from, in HeadCommitsComparator order: commits with refs by their best ref, then the
 * remaining childless rows in row order.
 */
export function sortHeads(rows: readonly number[], refsOf: (row: number) => readonly HeadRef[]): number[] {
  const best = new Map<number, HeadRef | undefined>();
  for (const r of rows) best.set(r, bestLayoutRef(refsOf(r)));
  return [...rows].sort((x, y) => {
    const a = best.get(x);
    const b = best.get(y);
    if (!a && !b) return x - y;
    if (!a) return 1;
    if (!b) return -1;
    return compareLayoutRefs(a, b);
  });
}

export interface SortGraph {
  /** parents of each commit as indexes into the same arrays; -1 = not loaded */
  parents: readonly (readonly number[])[];
  /** commit timestamps (any unit, the same for all commits) */
  times: ArrayLike<number>;
}

/**
 * VcsLogJoiner.NewCommitIntegrator: a commit is inserted above its first already placed parent and above every placed
 * commit with an older timestamp; parents are placed before their children (depth first). Returns commit indexes,
 * top to bottom.
 */
export function dateTopoOrder(g: SortGraph): number[] {
  const n = g.parents.length;
  const pending = new Uint8Array(n).fill(1);
  const list: number[] = [];
  const stack: number[] = [];
  const visit = (c: number) => {
    stack.push(c);
    pending[c] = 0;
  };
  for (let start = 0; start < n; start++) {
    if (!pending[start]) continue;
    visit(start);
    while (stack.length) {
      const c = stack[stack.length - 1];
      let descended = false;
      for (const p of g.parents[c]) {
        if (p >= 0 && pending[p]) {
          visit(p);
          descended = true;
          break;
        }
      }
      if (descended) continue;
      const ps = g.parents[c];
      const t = g.times[c];
      let i = 0;
      for (; i < list.length; i++) {
        const x = list[i];
        if (ps.includes(x)) break;
        if (g.times[x] < t) break;
      }
      list.splice(i, 0, c);
      stack.pop();
    }
  }
  return list;
}

/** A graph in base order: node = position in the base order. */
interface NodeGraph {
  down: number[][];
  up: number[][];
  time: Float64Array;
}

function nodeGraph(g: SortGraph, order: readonly number[]): NodeGraph {
  const n = order.length;
  const nodeOf = new Int32Array(g.parents.length).fill(-1);
  order.forEach((c, i) => (nodeOf[c] = i));
  const down: number[][] = [];
  const up: number[][] = Array.from({ length: n }, () => []);
  const time = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = order[i];
    time[i] = g.times[c];
    const d: number[] = [];
    for (const p of g.parents[c]) {
      const node = p >= 0 ? nodeOf[p] : -1;
      if (node >= 0 && !d.includes(node)) d.push(node);
    }
    down.push(d);
  }
  for (let i = 0; i < n; i++) for (const d of down[i]) up[d].push(i);
  return { down, up, time };
}

/** GraphLayoutBuilder.build: layout index per node and the heads that start a layout ("important heads"). */
function buildLayout(g: NodeGraph, sortedHeads: readonly number[]): { layout: Int32Array; heads: number[] } {
  const n = g.down.length;
  const layout = new Int32Array(n);
  const heads: number[] = [];
  let current = 1;
  const stack: number[] = [];
  for (const head of sortedHeads) {
    if (layout[head] !== 0) continue;
    heads.push(head);
    stack.push(head);
    while (stack.length) {
      const node = stack[stack.length - 1];
      const first = layout[node] === 0;
      if (first) layout[node] = current;
      const next = g.down[node].find((d) => layout[d] === 0);
      if (next === undefined) {
        if (first) current++;
        stack.pop();
      } else stack.push(next);
    }
  }
  return { layout, heads };
}

class Restrictions {
  private readonly upToDown = new Map<number, number[]>();
  private readonly downToUp = new Map<number, number[]>();

  add(up: number, down: number): void {
    const a = this.upToDown.get(up);
    if (a) a.push(down);
    else this.upToDown.set(up, [down]);
    const b = this.downToUp.get(down);
    if (b) b.push(up);
    else this.downToUp.set(down, [up]);
  }

  /** Removes the restrictions pointing to `down`; reports up nodes left without any. */
  remove(down: number, released: (up: number) => void): void {
    const ups = this.downToUp.get(down);
    if (!ups) return;
    this.downToUp.delete(down);
    for (const up of ups) {
      const list = this.upToDown.get(up);
      if (!list) continue;
      const i = list.indexOf(down);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) {
        this.upToDown.delete(up);
        released(up);
      }
    }
  }

  has(up: number): boolean {
    return this.upToDown.has(up);
  }
}

/** BekBranchCreator */
function createBranches(g: NodeGraph, layout: Int32Array, heads: readonly number[], restrictions: Restrictions): number[][] {
  const done = new Uint8Array(g.down.length);
  const branches: number[][] = [];
  for (const head of heads) {
    if (done[head]) continue;
    done[head] = 1;
    const nodes = [head];
    const startLayout = layout[head];
    const stack = [head];
    while (stack.length) {
      const current = stack[stack.length - 1];
      const currentLayout = layout[current];
      const down = g.down[current];
      let next = -1;
      for (let i = down.length - 1; i >= 0; i--) {
        const d = down[i];
        if (done[d]) {
          if (layout[d] < startLayout) restrictions.add(current, d);
        } else if (currentLayout <= layout[d]) {
          let undoneUp = false;
          for (const u of g.up[d]) {
            if (!done[u] && layout[u] <= layout[d]) {
              undoneUp = true;
              break;
            }
          }
          if (!undoneUp) {
            done[d] = 1;
            nodes.push(d);
            next = d;
            break;
          }
        }
      }
      if (next < 0) stack.pop();
      else stack.push(next);
    }
    branches.push(nodes);
  }
  return branches;
}

// BekBranch constants (milliseconds)
const MAX_BLOCK_SIZE = 20;
const MAX_DELTA_TIME = 60 * 60 * 24 * 3 * 1000;
const SMALL_DELTA_TIME = 60 * 60 * 4 * 1000;

/** BekBranch + BekBranchMerger: returns nodes top to bottom. `ms` converts a node time to milliseconds. */
function mergeBranches(g: NodeGraph, branches: number[][], restrictions: Restrictions, ms: (node: number) => number): number[] {
  const n = g.down.length;
  const nodeToBranch = new Int32Array(n);
  branches.forEach((b, i) => b.forEach((node) => (nodeToBranch[node] = i)));
  const noInsert = branches.map((b) => b.length);
  const prepared: ([number, number] | undefined)[] = branches.map(() => undefined);
  const queued = new Float64Array(branches.length);
  const queue: number[] = [];
  const less = (a: number, b: number) => queued[a] < queued[b] || (queued[a] === queued[b] && a < b);
  const push = (b: number) => {
    queue.push(b);
    let i = queue.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(queue[i], queue[p])) break;
      [queue[i], queue[p]] = [queue[p], queue[i]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = queue[0];
    const last = queue.pop()!;
    if (queue.length) {
      queue[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < queue.length && less(queue[l], queue[m])) m = l;
        if (r < queue.length && less(queue[r], queue[m])) m = r;
        if (m === i) break;
        [queue[i], queue[m]] = [queue[m], queue[i]];
        i = m;
      }
    }
    return top;
  };
  const prepare = (bi: number) => {
    const nodes = branches[bi];
    const size = noInsert[bi];
    if (!size || prepared[bi]) return;
    const currentNode = nodes[size - 1];
    if (restrictions.has(currentNode)) return;
    let prev = size - 1;
    for (; prev > 0; prev--) {
      const upNode = nodes[prev - 1];
      const downNode = nodes[prev];
      if (restrictions.has(upNode)) break;
      const down = g.down[upNode];
      const contains = down.includes(downNode);
      if (down.length > 1 && contains) continue;
      if (!contains) break;
      const delta = Math.abs(ms(upNode) - ms(downNode));
      if (delta > MAX_DELTA_TIME) break;
      if (prev < size - MAX_BLOCK_SIZE && delta > SMALL_DELTA_TIME) break;
    }
    prepared[bi] = [prev, size];
    queued[bi] = ms(nodes[prev]);
    push(bi);
  };

  const result = new Int32Array(n);
  let start = n;
  for (let bi = 0; bi < branches.length; bi++) prepare(bi);
  const released: number[] = [];
  while (queue.length) {
    const bi = pop();
    const [from, to] = prepared[bi]!;
    released.length = 0;
    start -= to - from;
    for (let i = from; i < to; i++) {
      const node = branches[bi][i];
      result[start + i - from] = node;
      restrictions.remove(node, (up) => released.push(up));
    }
    noInsert[bi] -= to - from;
    prepared[bi] = undefined;
    for (const node of released) {
      const rb = nodeToBranch[node];
      if (noInsert[rb] && branches[rb][noInsert[rb] - 1] === node) prepare(rb);
    }
    prepare(bi);
  }
  if (start !== 0) throw new Error(`IntelliSort left ${start} commits unplaced`);
  return Array.from(result);
}

/**
 * The PhpStorm order of a commit set (IntelliSort): commit indexes, top to bottom. `times` in seconds. Branch heads
 * (`refsOf`, all refs of a commit incl. tags and HEAD) and childless commits start the layout.
 */
export function intelliSort(g: SortGraph, refsOf: (commit: number) => readonly HeadRef[]): number[] {
  const base = dateTopoOrder(g);
  if (base.length < 2) return base;
  const ng = nodeGraph(g, base);
  const candidates: number[] = [];
  // GraphLayoutBuilder heads: childless commits + commits of branches (tags don't start a layout)
  for (let i = 0; i < base.length; i++) if (!ng.up[i].length || refsOf(base[i]).some((r) => r.kind !== 'tag')) candidates.push(i);
  const heads = sortHeads(candidates, (node) => refsOf(base[node]));
  const { layout, heads: layoutHeads } = buildLayout(ng, heads);
  const restrictions = new Restrictions();
  const branches = createBranches(ng, layout, layoutHeads, restrictions);
  const sorted = mergeBranches(ng, branches, restrictions, (node) => ng.time[node] * 1000);
  return sorted.map((node) => base[node]);
}
