// Webview-side commit list: the latest LogState, one slot per row whose LogRow is fetched lazily in aligned
// chunks for the visible window (stale versions discarded), plus refs/settings caches and change events.
import type { LogRow, LogSettings, LogState, RefsInfo, RowsResult } from '../../features/log/protocol';
import { rpc } from '../shared/rpc';
import { Emitter } from '../shared/ui';

export interface Slot {
  index: number;
  row?: LogRow;
}

const CHUNK = 200;

export class LogModel {
  state!: LogState;
  slots: Slot[] = [];
  refs: RefsInfo[] = [];
  private version = -1;
  private inflight = new Set<number>();
  private failed = new Set<number>();
  private readonly stateChanged = new Emitter<{ rebuilt: boolean; previous?: LogState }>();
  private readonly rowsLoaded = new Emitter<void>();
  private readonly refsChanged = new Emitter<void>();
  readonly onDidChangeState = this.stateChanged.event;
  readonly onDidLoadRows = this.rowsLoaded.event;
  readonly onDidChangeRefs = this.refsChanged.event;

  constructor() {
    rpc.on<LogState>('state', (s) => this.apply(s));
    rpc.on<LogSettings>('settings', (s) => {
      if (!this.state) return;
      const longEdges = s.showLongEdges !== this.state.settings.showLongEdges;
      this.apply({ ...this.state, settings: s });
      if (longEdges) this.invalidateRows();
    });
    rpc.on('refs', () => void this.loadRefs());
  }

  async start(): Promise<void> {
    this.apply(await rpc.call<LogState>('state'));
    await this.loadRefs();
  }

  get settings(): LogSettings {
    return this.state.settings;
  }

  apply(s: LogState): void {
    const previous = this.state;
    const rebuilt = s.version !== this.version || s.rowCount !== this.slots.length;
    this.state = s;
    if (rebuilt) {
      this.version = s.version;
      this.slots = Array.from({ length: s.rowCount }, (_, index) => ({ index }));
      this.inflight.clear();
      this.failed.clear();
    }
    this.stateChanged.fire({ rebuilt, previous });
  }

  async loadRefs(): Promise<void> {
    try {
      this.refs = await rpc.call<RefsInfo[]>('refs');
    } catch {
      this.refs = [];
    }
    this.refsChanged.fire();
  }

  /** Drops fetched rows (graph printing changed) and refetches on demand. */
  invalidateRows(): void {
    for (const s of this.slots) s.row = undefined;
    this.inflight.clear();
    this.rowsLoaded.fire();
  }

  row(i: number): LogRow | undefined {
    return this.slots[i]?.row;
  }

  /** Fetches rows [first, last) (plus a margin) that are not loaded yet. */
  ensure(first: number, last: number): void {
    const n = this.slots.length;
    if (!n) return;
    const a = Math.max(0, Math.floor((first - 50) / CHUNK));
    const b = Math.min(Math.ceil(n / CHUNK), Math.ceil((last + 50) / CHUNK));
    for (let c = a; c < b; c++) {
      if (this.inflight.has(c) || this.failed.has(c)) continue;
      const from = c * CHUNK;
      const to = Math.min(n, from + CHUNK);
      let missing = false;
      for (let i = from; i < to; i++) if (!this.slots[i].row) {
        missing = true;
        break;
      }
      if (missing) void this.fetch(c, from, to);
    }
  }

  /** Loads rows [from, to) and resolves when they are available (or the list changed). */
  async load(from: number, to: number): Promise<void> {
    const version = this.version;
    for (let c = Math.floor(from / CHUNK); c * CHUNK < to; c++) {
      const a = c * CHUNK;
      const b = Math.min(this.slots.length, a + CHUNK);
      if (a >= b) break;
      let missing = false;
      for (let i = a; i < b; i++) if (!this.slots[i].row) missing = true;
      if (missing) await this.fetch(c, a, b, true);
      if (version !== this.version) return;
    }
  }

  private async fetch(chunk: number, from: number, to: number, force = false): Promise<void> {
    if (this.inflight.has(chunk) && !force) return;
    this.inflight.add(chunk);
    const version = this.version;
    try {
      const res = await rpc.call<RowsResult>('rows', { version, from, to });
      if (res.version !== this.version || version !== this.version) return;
      for (const r of res.rows) {
        const s = this.slots[r.index];
        if (s) s.row = r;
      }
      this.rowsLoaded.fire();
    } catch {
      if (version === this.version) this.failed.add(chunk);
    } finally {
      if (version === this.version) this.inflight.delete(chunk);
    }
  }

  rootPath(row: LogRow): string {
    return this.state.roots[row.root]?.root ?? '';
  }
}
