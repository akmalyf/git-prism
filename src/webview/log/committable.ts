// The commit table of the log (IntelliJ VcsLogGraphTable): virtualized 24 px rows over lazily fetched LogRows,
// columns Root / Author / Subject (graph + reference labels) / Date / Hash from the jbGit.log.columns setting,
// highlighters, tooltips (graph arrows, references, truncated text), clickable arrows, speed search through the
// host, Cmd/Ctrl+C, Cmd/Ctrl+D, ←/→ (parent/child), selection kept by commit across reloads.
import type { CommitId, LogColumn, LogRow, LogSettings } from '../../features/log/protocol';
import { rpc } from '../shared/rpc';
import {
  delegateTooltip,
  DisposableStore,
  Emitter,
  h,
  icon,
  isCtrlCmd,
  listen,
  SpeedSearch,
  Table,
  type Column,
  type EmptyLine,
} from '../shared/ui';
import { dateAndTime, formatLogDate } from './dates';
import { arrowAt, graphPixelWidth, laneColor, paintGraph } from './graphpaint';
import { groupLabels, labelsTooltip, type LabelPart } from './labels';
import type { LogModel, Slot } from './model';

const ROW_H = 24;

const COLUMN_TITLES: Record<LogColumn, string> = { root: 'Root', author: 'Author', subject: 'Subject', date: 'Date', hash: 'Hash' };
const DEFAULT_WIDTHS: Record<LogColumn, number> = { root: 14, author: 140, subject: 400, date: 140, hash: 84 };

export interface CommitTableHost {
  /** commits picked by "Not Cherry-Picked Commits" (greyed) */
  isPicked(row: LogRow): boolean;
  showDiff(): void;
  contextMenu(x: number, y: number): void;
}

const sameUser = (r: LogRow) => r.author === r.committer && r.authorEmail.toLowerCase() === r.committerEmail.toLowerCase();

export class CommitTable {
  readonly table: Table<Slot>;
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly speed: SpeedSearch;
  private lastSelected: CommitId[] = [];
  private restoring = 0;
  private widths: Partial<Record<LogColumn, number>>;
  private readonly selectionChanged = new Emitter<LogRow[]>();
  readonly onDidChangeSelection = this.selectionChanged.event;
  private searchSeq = 0;
  /** bumped by explicit selections (host 'select', Go To, branch navigation): a pending restore yields to them */
  private explicit = 0;

  constructor(
    private readonly model: LogModel,
    private readonly host: CommitTableHost,
    private readonly saveWidths: (w: Partial<Record<LogColumn, number>>) => void,
    widths: Partial<Record<LogColumn, number>>,
  ) {
    this.widths = { ...widths };
    this.table = new Table<Slot>(null, {
      rowId: (s) => String(s.index),
      rowHeight: ROW_H,
      multiSelect: true,
      header: true,
      columns: this.columns(),
      rowClass: (s) => this.rowClass(s),
      ariaLabel: 'Commits',
      className: 'lg-table',
      needMoreThreshold: 300,
    });
    this.element = this.table.element;
    this.speed = new SpeedSearch(this.element, {
      onPattern: (p) => {
        if (p) this.search(p, 0, true);
      },
      onNavigate: (d) => this.search(this.speed.pattern, d, false),
    });

    this.store.add(this.table.onDidScroll(({ first, last }) => model.ensure(first, last)));
    this.store.add(this.table.onNeedMore(() => {
      if (model.state.hasMore && !model.state.loading) void rpc.call('loadMore');
    }));
    this.store.add(this.table.onDidChangeSelection(() => this.selectionUpdated()));
    this.store.add(this.table.onDidActivate(() => host.showDiff()));
    this.store.add(this.table.onContextMenu(({ x, y }) => host.contextMenu(x, y)));
    this.store.add(this.table.onDidChangeColumns(() => this.columnsChangedByUser()));
    this.store.add(model.onDidLoadRows(() => {
      this.table.refresh();
      // the lead row may have become available: details/changes depend on loaded rows
      if (this.table.getSelection().some((s) => s.row) && !this.lastSelected.length) this.selectionUpdated();
    }));
    this.store.add(listen(this.element, 'keydown', (e) => this.onKey(e), true));
    const viewport = this.element.querySelector<HTMLElement>('.jb-table-viewport')!;
    this.store.add(listen(viewport, 'click', (e) => this.onClick(e)));
    this.store.add(delegateTooltip(viewport, (e) => this.tooltip(e)));
  }

  // ---------------------------------------------------------------- columns

  private columns(): Column<Slot>[] {
    const s = this.model.state?.settings;
    const visible = s?.columns ?? ['author', 'subject', 'date'];
    const multiRoot = (this.model.state?.roots.length ?? 1) > 1;
    const order: LogColumn[] = [...(visible.includes('root') ? [] : (['root'] as LogColumn[])), ...visible, ...(['author', 'subject', 'date', 'hash'] as LogColumn[]).filter((c) => !visible.includes(c))];
    return order.map((id): Column<Slot> => {
      const base: Column<Slot> = {
        id,
        title: COLUMN_TITLES[id],
        width: this.widths[id] ?? DEFAULT_WIDTHS[id],
        minWidth: id === 'root' ? 8 : 40,
        // several repositories: the root column is always there (a color stripe; "Root Names" widens it with names)
        hidden: id === 'root' ? !multiRoot : !visible.includes(id),
        hideable: id !== 'subject',
      };
      switch (id) {
        case 'subject':
          return { ...base, flex: true, minWidth: 160, render: (cell, slot) => this.renderSubject(cell, slot) };
        case 'author':
          return { ...base, render: (cell, slot) => this.renderAuthor(cell, slot) };
        case 'date':
          return { ...base, text: (slot) => (slot.row ? formatLogDate(this.dateOf(slot.row), this.model.settings) : '') };
        case 'hash':
          return { ...base, className: () => 'jb-mono lg-hash', text: (slot) => slot.row?.hash.slice(0, 8) ?? '' };
        case 'root': {
          const names = visible.includes('root');
          return { ...base, title: names ? 'Root' : '', width: names ? (this.widths.root && this.widths.root > 30 ? this.widths.root : 110) : 10, resizable: names, hideable: false, render: (cell, slot) => this.renderRoot(cell, slot, names) };
        }
      }
    });
  }

  /** Re-applies settings (columns, highlighters, references). */
  updateSettings(prev: LogSettings | undefined, rootsChanged: boolean): void {
    const s = this.model.settings;
    if (!prev || rootsChanged || prev.columns.join() !== s.columns.join()) this.table.setColumns(this.columns());
    else this.table.refresh();
  }

  private columnsChangedByUser(): void {
    const cols = this.table.getColumns();
    let changed = false;
    for (const c of cols) {
      const id = c.id as LogColumn;
      if (c.width && c.width !== this.widths[id] && id !== 'subject' && !(id === 'root' && c.width <= 10)) {
        this.widths[id] = c.width;
        changed = true;
      }
    }
    if (changed) this.saveWidths(this.widths);
    const cur = this.model.settings.columns;
    // order/visibility from the header ('root' is controlled by "Root Names" only)
    const vis = cols.filter((c) => !c.hidden && c.id !== 'root').map((c) => c.id as LogColumn);
    const rootAt = cols.findIndex((c) => c.id === 'root');
    const next = cur.includes('root') ? [...vis.slice(0, Math.max(0, rootAt)), 'root' as LogColumn, ...vis.slice(Math.max(0, rootAt))] : vis;
    if (next.join() !== cur.join()) void rpc.call('setSetting', { key: 'columns', value: next });
  }

  private dateOf(r: LogRow): number {
    return this.model.settings.preferCommitDate ? r.commitDate : r.authorDate;
  }

  // ---------------------------------------------------------------- rendering

  private rowClass(slot: Slot): string | undefined {
    const r = slot.row;
    if (!r) return 'lg-pending';
    const s = this.model.settings;
    const out: string[] = [];
    if ((s.highlightMergeCommits && r.parents.length > 1) || this.host.isPicked(r)) out.push('jb-dim');
    if (s.highlightMyCommits && r.mine) out.push('jb-bold');
    if (s.highlightCurrentBranch && r.onCurrentBranch && !this.onlyCurrentBranchShown(r.root)) out.push('lg-on-current');
    return out.join(' ') || undefined;
  }

  /** IntelliJ's CurrentBranchHighlighter stays off when the log is filtered to just the current branch (or HEAD). */
  private onlyCurrentBranchShown(root: number): boolean {
    const b = this.model.state.filters.branches;
    if (b?.length !== 1) return false;
    return b[0] === 'HEAD' || b[0] === this.model.state.roots[root]?.branch;
  }

  private renderAuthor(cell: HTMLElement, slot: Slot): void {
    const r = slot.row;
    const t = r ? (sameUser(r) || !r.committer ? r.author : `${r.author}*`) : '';
    if (cell.textContent !== t) cell.textContent = t;
  }

  private renderRoot(cell: HTMLElement, slot: Slot, names: boolean): void {
    const r = slot.row;
    let bar = cell.firstElementChild as HTMLElement | null;
    if (!bar || !bar.classList.contains('lg-root-bar')) {
      cell.replaceChildren((bar = h('span.lg-root-bar')), h('span.lg-root-name'));
    }
    cell.classList.add('lg-root-cell');
    cell.classList.toggle('lg-root-wide', names);
    bar.style.background = r ? laneColor(r.root * 5 + 2) : 'transparent';
    const name = names && r ? (this.model.state.roots[r.root]?.name ?? '') : '';
    const label = bar.nextElementSibling as HTMLElement;
    if (label.textContent !== name) label.textContent = name;
  }

  private renderSubject(cell: HTMLElement, slot: Slot): void {
    const r = slot.row;
    let canvas = cell.firstElementChild as HTMLCanvasElement | null;
    let text: HTMLElement;
    let refs: HTMLElement;
    if (!canvas || canvas.tagName !== 'CANVAS') {
      canvas = h('canvas.lg-graph');
      text = h('span.lg-subject-text');
      refs = h('span.lg-refs');
      cell.replaceChildren(canvas, text, refs);
      cell.classList.add('lg-subject-cell');
    } else {
      text = canvas.nextElementSibling as HTMLElement;
      refs = text.nextElementSibling as HTMLElement;
    }
    cell.classList.add('lg-subject-cell');
    cell.dataset.index = String(slot.index);
    const s = this.model.settings;
    cell.classList.toggle('lg-refs-left', s.referencesOnLeft);
    const w = graphPixelWidth(r?.graph);
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(ROW_H * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${ROW_H}px`;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    if (r) {
      ctx.scale(dpr, dpr);
      paintGraph(ctx, r.graph, ROW_H, !!r.head);
    }
    const subject = r?.subject ?? '';
    if (text.textContent !== subject) text.textContent = subject;
    const key = r ? `${r.hash}|${s.showTagNames}|${s.compactReferences}|${r.refs.map((x) => x.name + (x.favorite ? '*' : '')).join(',')}` : '';
    if (refs.dataset.key !== key) {
      refs.dataset.key = key;
      refs.replaceChildren(...(r ? groupLabels(r.refs, { showTagNames: s.showTagNames, compact: s.compactReferences }).map(renderLabel) : []));
    }
  }

  // ---------------------------------------------------------------- selection

  /** Selected rows (loaded ones), in table order. */
  selectedRows(): LogRow[] {
    return this.table.getSelection().map((s) => s.row).filter((r): r is LogRow => !!r);
  }

  selectedIds(): CommitId[] {
    return this.selectedRows().map((r) => ({ root: this.model.rootPath(r), hash: r.hash }));
  }

  leadRow(): LogRow | undefined {
    const i = this.table.getLeadIndex();
    return i === undefined ? undefined : this.model.row(i);
  }

  private selectionUpdated(): void {
    if (this.restoring) return;
    const slots = this.table.getSelection();
    // selected rows not loaded yet (Shift+End, Cmd+A …): load them, the event follows
    const missing = slots.filter((s) => !s.row);
    if (missing.length && missing.length <= 5000) {
      const idx = missing.map((s) => s.index);
      void this.model.load(Math.min(...idx), Math.max(...idx) + 1).then(() => this.selectionUpdated());
    }
    this.lastSelected = this.selectedIds();
    this.selectionChanged.fire(this.selectedRows());
  }

  /** New row list: keeps the selected commits selected (and the lead row at the same screen offset). */
  async rebuilt(): Promise<void> {
    const keep = this.lastSelected;
    const viewport = this.element.querySelector<HTMLElement>('.jb-table-viewport')!;
    const leadOld = this.table.getLeadIndex();
    const explicit = this.explicit;
    const offset = leadOld !== undefined ? leadOld * ROW_H - viewport.scrollTop : undefined;
    this.restoring++;
    try {
      this.table.setRows(this.model.slots, { keepSelection: false });
      this.table.setHasMore(this.model.state.hasMore);
      if (!keep.length) return;
      const rows = await rpc.call<number[]>('rowsOf', { commits: keep });
      if (explicit !== this.explicit) return;
      const found = rows.filter((r) => r >= 0 && r < this.model.slots.length);
      if (!found.length) {
        // the selected commits are gone (filtered out, reset away): select the top commit like IntelliJ
        this.lastSelected = [];
        if (this.model.slots.length) {
          this.table.select(['0'], { reveal: false });
          this.table.scrollToIndex(0, 'top');
          await this.model.load(0, 1);
        }
        return;
      }
      this.table.select(found.map(String), { reveal: false });
      const lead = found[found.length - 1];
      // the lead row stays where it was on screen; when it was scrolled away the scroll position is kept
      if (offset !== undefined && offset >= -ROW_H && offset < viewport.clientHeight) viewport.scrollTop = lead * ROW_H - offset;
      await this.model.load(Math.min(...found), Math.max(...found) + 1);
    } catch {
      /* host gone */
    } finally {
      this.restoring--;
      if (!this.restoring) this.selectionUpdated();
    }
  }

  selectRow(row: number, opts: { focus?: boolean; center?: boolean } = {}): void {
    if (row < 0 || row >= this.model.slots.length) return;
    this.explicit++;
    this.table.select([String(row)], { reveal: false, focus: opts.focus });
    this.table.scrollToIndex(row, opts.center ? 'center' : 'nearest');
  }

  focus(): void {
    this.table.focus();
  }

  setEmptyText(t: EmptyLine[] | string | undefined): void {
    this.table.setEmptyText(t);
  }

  // ---------------------------------------------------------------- input

  goToParent(): void {
    const r = this.leadRow();
    const p = r?.parentRows.find((x) => x >= 0);
    if (p !== undefined) this.selectRow(p);
  }

  goToChild(): void {
    const r = this.leadRow();
    const c = r?.childRows.filter((x) => x >= 0);
    if (c?.length) this.selectRow(Math.max(...c));
  }

  copyHashes(): void {
    const hashes = this.selectedRows().map((r) => r.hash);
    if (hashes.length) void rpc.call('copy', { text: hashes.join('\n') });
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    const consume = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (this.speed.handleKey(e)) {
      consume();
      return;
    }
    if (isCtrlCmd(e) && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      this.copyHashes();
      consume();
    } else if (isCtrlCmd(e) && e.altKey && e.shiftKey && e.code === 'KeyC') {
      this.copyHashes();
      consume();
    } else if (isCtrlCmd(e) && (e.key === 'd' || e.key === 'D')) {
      this.host.showDiff();
      consume();
    } else if (e.key === 'ArrowLeft' && !e.shiftKey && !isCtrlCmd(e)) {
      this.goToParent();
      consume();
    } else if (e.key === 'ArrowRight' && !e.shiftKey && !isCtrlCmd(e)) {
      this.goToChild();
      consume();
    }
  }

  private search(pattern: string, dir: 0 | 1 | -1, fromCurrent: boolean): void {
    const lead = this.table.getLeadIndex() ?? -1;
    const seq = ++this.searchSeq;
    const from = fromCurrent ? lead - 1 : lead;
    void rpc
      .call<{ row: number }>('search', { text: pattern, from: dir === -1 ? lead : from, backward: dir === -1 })
      .then((res) => {
        if (seq !== this.searchSeq || this.speed.pattern !== pattern) return;
        this.speed.setNoMatch(res.row < 0);
        if (res.row >= 0) this.selectRow(res.row);
      });
  }

  private onClick(e: MouseEvent): void {
    const canvas = (e.target as HTMLElement).closest('canvas.lg-graph');
    if (!canvas) return;
    const cell = canvas.parentElement as HTMLElement;
    const row = this.model.row(Number(cell.dataset.index));
    const r = canvas.getBoundingClientRect();
    const target = arrowAt(row?.graph, e.clientX - r.left, e.clientY - r.top, ROW_H);
    if (target !== undefined) this.selectRow(target, { center: true, focus: true });
  }

  private tooltip(e: MouseEvent): { anchor: { x: number; y: number }; content: string | Node; key: unknown } | undefined {
    const t = e.target as HTMLElement;
    const cell = t.closest<HTMLElement>('.jb-td');
    const rowEl = cell?.parentElement;
    if (!cell || !rowEl) return undefined;
    const index = Number(rowEl.dataset.index);
    const row = this.model.row(index);
    if (!row) return undefined;
    const anchor = { x: e.clientX, y: rowEl.getBoundingClientRect().bottom - 4 };
    const col = cell.dataset.col;
    if (t.closest('canvas.lg-graph')) {
      const r = (t as HTMLElement).getBoundingClientRect();
      const target = arrowAt(row.graph, e.clientX - r.left, e.clientY - r.top, ROW_H);
      if (target === undefined) return undefined;
      const tr = this.model.row(target);
      if (!tr) {
        this.model.ensure(target, target + 1);
        return { anchor, content: 'Jump to commit', key: `${index}|arrow|${target}|0` };
      }
      const { date, time } = dateAndTime(this.dateOf(tr));
      return { anchor, content: `Jump to ${tr.subject} by ${tr.author} on ${date} at ${time}`, key: `${index}|arrow|${target}` };
    }
    if (t.closest('.lg-refs') && row.refs.length) return { anchor, content: labelsTooltip(row.refs), key: `${index}|refs` };
    if (col === 'subject') {
      const text = cell.querySelector<HTMLElement>('.lg-subject-text');
      if (text && text.scrollWidth > text.clientWidth) return { anchor, content: row.subject, key: `${index}|subject` };
      return undefined;
    }
    if (col === 'author') {
      const lines = [`${row.author} <${row.authorEmail}>`];
      if (!sameUser(row) && row.committer) lines.push(`committed by ${row.committer} <${row.committerEmail}>`);
      return { anchor, content: lines.join('\n'), key: `${index}|author` };
    }
    if (col === 'root') return { anchor, content: this.model.state.roots[row.root]?.name ?? '', key: `${index}|root` };
    if (col === 'date') {
      const { date, time } = dateAndTime(this.dateOf(row));
      return { anchor, content: `${date} ${time}`, key: `${index}|date` };
    }
    return undefined;
  }

  dispose(): void {
    this.store.dispose();
    this.table.dispose();
  }
}

/** A reference label element: kind icons (★ for favorites) + text. */
export function renderLabel(p: LabelPart): HTMLElement {
  const icons = p.kinds.map((k, i) => {
    const fav = p.favorite && i === p.kinds.length - 1;
    return icon(fav ? 'star-full' : 'tag', { className: `lg-ref-icon lg-ref-${k}${p.current && k === 'local' ? ' lg-ref-current' : ''}` });
  });
  return h('span.lg-ref', { class: { 'lg-ref-icononly': !p.text } }, icons, p.text ? h('span.lg-ref-text', null, p.text) : null);
}
