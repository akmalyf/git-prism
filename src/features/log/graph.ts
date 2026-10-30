// Commit graph engine for the Git Log (pure TS, no vscode/node imports). A port of the essential parts of
// IntelliJ's vcs-log graph: GraphLayoutBuilder (layout index per commit: DFS from branch heads, first parent keeps
// the lineage), GraphElementComparatorByLayoutIndex (left-to-right order of the elements of a row) and
// PrintElementGeneratorImpl (per-row print elements, long edges hidden behind arrows). Rows are printed lazily in
// windows; the set of edges crossing a row comes from a sweep with periodic checkpoints, so building is O(n + e) and
// printing a window is O(window · lanes).
import type { GraphRowPrint } from './protocol';

export interface GraphInput {
  count: number;
  /** CSR: parents of row i are parentRows[parentStart[i] .. parentStart[i + 1]); -1 = parent not in the loaded set */
  parentStart: Int32Array;
  parentRows: Int32Array;
  /** rows that start a lineage first, in priority order (branch heads: current branch first) */
  headOrder?: readonly number[];
  /** color id (non-negative int) of the main lineage of a head row, e.g. a hash of its branch name */
  headColor?: (row: number) => number;
}

export interface PrintOptions {
  /** IntelliJ "Long Edges": show long edges instead of cutting them behind arrows */
  showLongEdges: boolean;
}

/** Edge print element types (GraphRowPrint.edges, 2nd value of each tuple) */
export const EDGE_UP = 0;
export const EDGE_DOWN = 1;
/** flags (GraphRowPrint.edges, 5th value) */
export const FLAG_ARROW = 1;
export const FLAG_TERMINAL = 2;
export const FLAG_DOTTED = 4;
/** values per edge tuple in GraphRowPrint.edges */
export const EDGE_TUPLE = 6;

// IntelliJ PrintElementGeneratorImpl constants
const LONG_EDGE_SIZE = 30;
const LONG_EDGE_PART_SIZE = 1;
const VERY_LONG_EDGE_SIZE = 1000;
const VERY_LONG_EDGE_PART_SIZE = 250;

const CHECKPOINT = 256;

const NODE = 0;
const EDGE = 1;
const SPECIAL = 2;

/** One element of a row: a node (up = row), a normal edge (up < down) or a "not loaded" special edge (down = -1). */
interface El {
  kind: number;
  up: number;
  down: number;
  key: number;
}

export class CommitGraph {
  readonly count: number;
  readonly parentStart: Int32Array;
  readonly parentRows: Int32Array;
  readonly childStart: Int32Array;
  readonly childRows: Int32Array;
  /** layout index per row (1-based) */
  readonly layout: Int32Array;
  private readonly liColor: Int32Array;
  private readonly big: number;
  /** checkpoints[k] = keys of normal edges with up < k·CHECKPOINT ≤ down */
  private readonly checkpoints: Float64Array[] = [new Float64Array(0)];
  private sweepRow = 0;
  private sweepState = new Set<number>();

  constructor(input: GraphInput) {
    const n = (this.count = input.count);
    this.big = n + 1;
    // normalize parents: drop duplicates, a parent at/above its child (not topological) counts as not loaded
    const ps = new Int32Array(n + 1);
    const pr: number[] = [];
    for (let i = 0; i < n; i++) {
      ps[i] = pr.length;
      const from = input.parentStart[i];
      const to = input.parentStart[i + 1];
      for (let j = from; j < to; j++) {
        let p = input.parentRows[j];
        if (p <= i || p >= n) p = -1;
        let dup = false;
        for (let k = ps[i]; k < pr.length; k++) if (pr[k] === p && p >= 0) dup = true;
        if (!dup) pr.push(p);
      }
    }
    ps[n] = pr.length;
    this.parentStart = ps;
    this.parentRows = Int32Array.from(pr);

    // children CSR
    const cc = new Int32Array(n + 1);
    for (const p of this.parentRows) if (p >= 0) cc[p + 1]++;
    for (let i = 0; i < n; i++) cc[i + 1] += cc[i];
    const fill = cc.slice(0, n);
    const cr = new Int32Array(cc[n]);
    for (let i = 0; i < n; i++) {
      for (let j = ps[i]; j < ps[i + 1]; j++) {
        const p = this.parentRows[j];
        if (p >= 0) cr[fill[p]++] = i;
      }
    }
    this.childStart = cc;
    this.childRows = cr;

    // layout (GraphLayoutBuilder): heads = prioritized rows, then rows without children in row order
    const heads: number[] = [];
    const seen = new Uint8Array(n);
    for (const h of input.headOrder ?? []) {
      if (h >= 0 && h < n && !seen[h]) {
        seen[h] = 1;
        heads.push(h);
      }
    }
    for (let i = 0; i < n; i++) if (!seen[i] && cc[i + 1] === cc[i]) heads.push(i);
    const li = (this.layout = new Int32Array(n));
    const liHead: number[] = [0];
    const headStart = new Map<number, number>();
    let cur = 1;
    const stack: number[] = [];
    for (const head of heads) {
      if (li[head] !== 0) continue;
      headStart.set(head, cur);
      stack.push(head);
      while (stack.length) {
        const node = stack[stack.length - 1];
        const first = li[node] === 0;
        if (first) li[node] = cur;
        let next = -1;
        for (let j = ps[node]; j < ps[node + 1]; j++) {
          const p = this.parentRows[j];
          if (p >= 0 && li[p] === 0) {
            next = p;
            break;
          }
        }
        if (next < 0) {
          if (first) liHead[cur++] = head;
          stack.pop();
        } else stack.push(next);
      }
    }
    const color = (this.liColor = new Int32Array(cur + 1));
    const headColor = input.headColor ?? ((row: number) => row);
    for (let l = 1; l < cur; l++) {
      const head = liHead[l];
      const base = headColor(head) & 0x7fffffff;
      color[l] = headStart.get(head) === l ? base : mixColor(base, l);
    }
  }

  /** Color id of a row's node. */
  nodeColor(row: number): number {
    return this.liColor[this.layout[row]];
  }

  parents(row: number): number[] {
    const out: number[] = [];
    for (let j = this.parentStart[row]; j < this.parentStart[row + 1]; j++) out.push(this.parentRows[j]);
    return out;
  }

  children(row: number): number[] {
    return Array.from(this.childRows.subarray(this.childStart[row], this.childStart[row + 1]));
  }

  /** Marks every row reachable from `row` through parents (the row itself included). */
  ancestors(row: number): Uint8Array {
    const mark = new Uint8Array(this.count);
    if (row < 0 || row >= this.count) return mark;
    const stack = [row];
    mark[row] = 1;
    while (stack.length) {
      const r = stack.pop()!;
      for (let j = this.parentStart[r]; j < this.parentStart[r + 1]; j++) {
        const p = this.parentRows[j];
        if (p >= 0 && !mark[p]) {
          mark[p] = 1;
          stack.push(p);
        }
      }
    }
    return mark;
  }

  /** Print elements of rows [from, to). */
  print(from: number, to: number, opts: PrintOptions): GraphRowPrint[] {
    from = Math.max(0, from);
    to = Math.min(this.count, to);
    if (from >= to) return [];
    const longEdgeSize = opts.showLongEdges ? VERY_LONG_EDGE_SIZE : LONG_EDGE_SIZE;
    const visiblePart = opts.showLongEdges ? VERY_LONG_EDGE_PART_SIZE : LONG_EDGE_PART_SIZE;
    const arrowSize = opts.showLongEdges ? LONG_EDGE_SIZE : Number.MAX_SAFE_INTEGER;
    const big = this.big;
    const li = this.layout;

    // normal edges crossing each row in [from - 1, to + 1)
    const first = Math.max(0, from - 1);
    const last = Math.min(this.count, to + 1);
    const crossing = this.crossing(first, last);

    const edgeVisible = (up: number, down: number, row: number) => down - up < longEdgeSize || Math.min(row - up, down - row) <= visiblePart;

    const cmp2 = (e: El, node: number): number => {
      if (e.kind === SPECIAL) return li[e.up] - li[node];
      const m = Math.max(li[e.up], li[e.down]);
      const nl = li[node];
      return m !== nl ? m - nl : e.up - node;
    };
    const cmp = (a: El, b: El): number => {
      if (a.kind !== NODE && b.kind !== NODE) {
        if (a.kind === SPECIAL) return -cmp2(b, a.up);
        if (b.kind === SPECIAL) return cmp2(a, b.up);
        if (a.up === b.up) return a.down < b.down ? -cmp2(b, a.down) : cmp2(a, b.down);
        return a.up < b.up ? cmp2(a, b.up) : -cmp2(b, a.up);
      }
      if (a.kind !== NODE) return cmp2(a, b.up);
      if (b.kind !== NODE) return -cmp2(b, a.up);
      return 0;
    };

    const rowCache = new Map<number, { els: El[]; pos: Map<number, number> }>();
    const rowEls = (row: number) => {
      let c = rowCache.get(row);
      if (c) return c;
      const els: El[] = [{ kind: NODE, up: row, down: row, key: -(row + 1) }];
      for (const key of crossing.get(row) ?? []) {
        const up = Math.floor(key / big);
        const down = key - up * big;
        if (edgeVisible(up, down, row)) els.push({ kind: EDGE, up, down, key });
      }
      if (row > 0) {
        const u = row - 1;
        for (let j = this.parentStart[u]; j < this.parentStart[u + 1]; j++) {
          if (this.parentRows[j] < 0) els.push({ kind: SPECIAL, up: u, down: -1, key: u * big + (big - 1) });
        }
      }
      els.sort(cmp);
      const pos = new Map<number, number>();
      els.forEach((e, i) => pos.set(e.key, i));
      c = { els, pos };
      rowCache.set(row, c);
      return c;
    };

    const arrowType = (e: El, row: number): number => {
      if (e.kind === SPECIAL) return e.up === row - 1 ? EDGE_DOWN : -1;
      const size = e.down - e.up;
      const upOffset = row - e.up;
      const downOffset = e.down - row;
      if (size >= longEdgeSize) {
        if (upOffset === visiblePart) return EDGE_DOWN;
        if (downOffset === visiblePart) return EDGE_UP;
      }
      if (size >= arrowSize) {
        if (upOffset === 1) return EDGE_DOWN;
        if (downOffset === 1) return EDGE_UP;
      }
      return -1;
    };
    const endPos = (row: number, e: El, up: boolean): number => {
      if (row < 0 || row >= this.count) return -1;
      const { pos } = rowEls(row);
      const p = pos.get(e.key);
      if (p !== undefined) return p;
      const node = up ? e.up : e.down;
      if (node === row) return pos.get(-(row + 1)) ?? -1;
      return -1;
    };
    const edgeColor = (e: El): number => {
      if (e.kind === SPECIAL || li[e.up] >= li[e.down]) return this.liColor[li[e.up]];
      return this.liColor[li[e.down]];
    };

    const out: GraphRowPrint[] = [];
    for (let row = from; row < to; row++) {
      const { els } = rowEls(row);
      const edges: number[] = [];
      let nodePos = 0;
      const push = (e: El, position: number, toPos: number, type: number, flags: number, target: number) => {
        edges.push(position, toPos, type, edgeColor(e), flags | (e.kind === SPECIAL ? FLAG_DOTTED : 0), target);
      };
      const addEdge = (e: El, position: number, terminals: boolean) => {
        const at = arrowType(e, row);
        const down = endPos(row + 1, e, false);
        const up = endPos(row - 1, e, true);
        if (down >= 0) push(e, position, down, EDGE_DOWN, at === EDGE_DOWN ? FLAG_ARROW : 0, -1);
        else if (terminals && at === EDGE_DOWN) push(e, position, position, EDGE_DOWN, FLAG_ARROW | FLAG_TERMINAL, e.down);
        if (up >= 0) push(e, position, up, EDGE_UP, at === EDGE_UP ? FLAG_ARROW : 0, -1);
        else if (terminals && at === EDGE_UP) push(e, position, position, EDGE_UP, FLAG_ARROW | FLAG_TERMINAL, e.up);
      };
      els.forEach((el, position) => {
        if (el.kind !== NODE) {
          addEdge(el, position, true);
          return;
        }
        nodePos = position;
        for (let j = this.childStart[row]; j < this.childStart[row + 1]; j++) {
          const c = this.childRows[j];
          addEdge({ kind: EDGE, up: c, down: row, key: c * big + row }, position, false);
        }
        for (let j = this.parentStart[row]; j < this.parentStart[row + 1]; j++) {
          const p = this.parentRows[j];
          const e: El = p >= 0 ? { kind: EDGE, up: row, down: p, key: row * big + p } : { kind: SPECIAL, up: row, down: -1, key: row * big + (big - 1) };
          addEdge(e, position, false);
        }
      });
      out.push({ node: nodePos, color: this.nodeColor(row), width: els.length, edges });
    }
    return out;
  }

  /** Keys of normal edges strictly crossing each row of [from, to) (up < row < down). */
  private crossing(from: number, to: number): Map<number, number[]> {
    const big = this.big;
    const k = Math.floor(from / CHECKPOINT);
    this.sweepTo(k * CHECKPOINT);
    const state = new Set<number>(this.checkpoints[k]);
    const res = new Map<number, number[]>();
    for (let r = k * CHECKPOINT; r < to; r++) {
      // state = edges with up < r ≤ down
      if (r >= from) {
        const list: number[] = [];
        for (const key of state) if (key - Math.floor(key / big) * big > r) list.push(key);
        res.set(r, list);
      }
      this.advance(state, r);
    }
    return res;
  }

  /** state: edges with up < r ≤ down  →  edges with up < r + 1 ≤ down */
  private advance(state: Set<number>, r: number): void {
    const big = this.big;
    for (let j = this.childStart[r]; j < this.childStart[r + 1]; j++) state.delete(this.childRows[j] * big + r);
    for (let j = this.parentStart[r]; j < this.parentStart[r + 1]; j++) {
      const p = this.parentRows[j];
      if (p >= 0) state.add(r * big + p);
    }
  }

  private sweepTo(row: number): void {
    while (this.sweepRow < row) {
      this.advance(this.sweepState, this.sweepRow);
      this.sweepRow++;
      if (this.sweepRow % CHECKPOINT === 0) this.checkpoints[this.sweepRow / CHECKPOINT] = Float64Array.from(this.sweepState);
    }
  }
}

/** Color id of a non-main lineage of a head (stable for the same head color + layout index). */
function mixColor(base: number, layoutIndex: number): number {
  let h = Math.imul(base ^ 0x5bd1e995, 31) + Math.imul(layoutIndex, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h & 0x7fffffff;
}

/** Stable non-negative 31-bit hash of a string (branch names → color ids). */
export function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h & 0x7fffffff;
}

/** Builds the CSR parent arrays from per-row parent lists. */
export function toCsr(parents: readonly (readonly number[])[]): { parentStart: Int32Array; parentRows: Int32Array } {
  const parentStart = new Int32Array(parents.length + 1);
  let total = 0;
  for (let i = 0; i < parents.length; i++) {
    parentStart[i] = total;
    total += parents[i].length;
  }
  parentStart[parents.length] = total;
  const parentRows = new Int32Array(total);
  let k = 0;
  for (const ps of parents) for (const p of ps) parentRows[k++] = p;
  return { parentStart, parentRows };
}
