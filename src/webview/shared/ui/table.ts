// Virtualized table (IntelliJ JBTable as used by the VCS Log): 100k+ rows, columns that can be resized,
// reordered by drag and hidden/shown (persisted), custom cell renderers (graph canvas etc.), selection model shared
// with the tree, keyboard navigation, row classes, hover tooltips, speed search, infinite-scroll callback.
import { h, listen, DisposableStore, Emitter, isCtrlCmd, rafThrottle, uid } from './dom';
import { SelectionModel, type SelectionNav } from './selection';
import { SpeedSearch } from './speedsearch';
import { matchText } from './match';
import { emptyState, type EmptyLine } from './empty';
import { delegateTooltip, type TooltipContent } from './tooltip';
import { showContextMenu, type MenuItem } from './menu';
import { loadState, saveState } from './persist';
import { ensureStyles } from './styles';

export interface CellContext {
  index: number;
  selected: boolean;
  /** table has keyboard focus */
  focused: boolean;
  width: number;
  height: number;
  columnId: string;
  /** current speed-search pattern ('' when none) */
  searchPattern: string;
}

export interface Column<R> {
  id: string;
  title: string;
  width?: number;
  minWidth?: number;
  /** takes the remaining width (at most one column; default: the last visible column) */
  flex?: boolean;
  align?: 'left' | 'right' | 'center';
  hidden?: boolean;
  /** can be hidden from the header context menu (default true) */
  hideable?: boolean;
  resizable?: boolean;
  /** plain text cell */
  text?(row: R, index: number): string;
  /**
   * Custom cell: fill `cell` completely (cells are recycled between rows — reuse or replace children, never
   * assume the previous content belongs to this row).
   */
  render?(cell: HTMLElement, row: R, index: number, ctx: CellContext): void;
  /** extra class for the cell */
  className?(row: R, index: number): string | undefined;
}

export interface TableOptions<R> {
  columns: Column<R>[];
  rowId(row: R): string;
  rowHeight?: number;
  multiSelect?: boolean;
  header?: boolean;
  stateKey?: string;
  rowClass?(row: R, index: number): string | undefined;
  tooltip?(row: R, index: number, columnId: string): TooltipContent;
  speedSearch?(row: R): string;
  emptyText?: EmptyLine[] | string;
  ariaLabel?: string;
  className?: string;
  /** rows before the end at which onNeedMore fires (default 100) */
  needMoreThreshold?: number;
}

interface ColumnState {
  order: string[];
  widths: Record<string, number>;
  hidden: string[];
}

export class Table<R> {
  readonly element: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private columns: Column<R>[];
  private rows: R[] = [];
  private ids: string[] = [];
  private index = new Map<string, number>();
  private hasMore = false;
  private needMoreFired = false;
  private readonly sel: SelectionModel<string>;
  private readonly nav: SelectionNav<string>;
  private readonly speed: SpeedSearch | undefined;
  private pattern = '';
  private pool: { el: HTMLElement; cells: HTMLElement[] }[] = [];
  private poolColumnsKey = '';
  private renderedKey = '';
  private version = 0;
  private readonly rowH: number;
  private readonly domId = uid('jbtable');
  private readonly store = new DisposableStore();
  private readonly scheduleRender = rafThrottle(() => this.render());
  private emptyText: EmptyLine[] | string | undefined;

  private readonly selectionChanged = new Emitter<R[]>();
  private readonly activated = new Emitter<{ row: R; index: number; columnId: string | undefined; event: MouseEvent | KeyboardEvent }>();
  private readonly contextMenu = new Emitter<{ rows: R[]; row: R | undefined; index: number | undefined; columnId: string | undefined; x: number; y: number; event: MouseEvent | KeyboardEvent }>();
  private readonly needMore = new Emitter<void>();
  private readonly columnsChanged = new Emitter<void>();
  private readonly scrolled = new Emitter<{ first: number; last: number }>();
  private readonly headerClicked = new Emitter<string>();
  readonly onDidChangeSelection = this.selectionChanged.event;
  readonly onDidActivate = this.activated.event;
  readonly onContextMenu = this.contextMenu.event;
  readonly onNeedMore = this.needMore.event;
  readonly onDidChangeColumns = this.columnsChanged.event;
  readonly onDidScroll = this.scrolled.event;
  readonly onDidClickHeader = this.headerClicked.event;

  constructor(parent: HTMLElement | null, private readonly o: TableOptions<R>) {
    ensureStyles();
    this.rowH = o.rowHeight ?? 24;
    this.emptyText = o.emptyText;
    this.columns = this.applyState(o.columns.map((c) => ({ ...c })));
    this.sel = new SelectionModel<string>(o.multiSelect ?? true);
    const self = this;
    this.nav = {
      indexOf: (k) => self.index.get(k) ?? -1,
      keyAt: (i) => self.ids[i],
      get count() {
        return self.ids.length;
      },
    };
    this.headerEl = h('div.jb-table-header', { class: { 'jb-hidden': o.header === false }, attrs: { role: 'row' } });
    this.spacer = h('div.jb-table-spacer');
    this.viewport = h('div.jb-table-viewport', null, this.spacer);
    this.emptyEl = h('div.jb-table-empty.jb-hidden');
    this.element = h('div.jb-table', {
      tabIndex: 0,
      class: o.className,
      style: { '--jb-row': `${this.rowH}px` },
      attrs: { role: 'grid', 'aria-label': o.ariaLabel, 'aria-multiselectable': o.multiSelect === false ? undefined : 'true' },
    }, this.headerEl, this.viewport, this.emptyEl);
    if (o.speedSearch) {
      this.speed = new SpeedSearch(this.element, {
        onPattern: (p) => this.setPattern(p),
        onNavigate: (d) => this.nextMatch(d, false),
      });
    }
    this.store.add(this.sel.onDidChange(() => {
      this.version++;
      this.scheduleRender();
      this.selectionChanged.fire(this.getSelection());
    }));
    this.store.add(listen(this.viewport, 'scroll', () => {
      this.headerEl.scrollLeft = this.viewport.scrollLeft;
      this.scheduleRender();
    }, { passive: true }));
    this.store.add(listen(this.element, 'keydown', (e) => this.onKey(e)));
    this.store.add(listen(this.element, 'focusin', () => this.repaintFocus()));
    this.store.add(listen(this.element, 'focusout', (e) => {
      if (!this.element.contains(e.relatedTarget as Node)) this.speed?.close();
      this.repaintFocus();
    }));
    this.store.add(listen(this.viewport, 'mousedown', (e) => this.onMouseDown(e)));
    this.store.add(listen(this.viewport, 'dblclick', (e) => this.onDblClick(e)));
    this.store.add(listen(this.viewport, 'contextmenu', (e) => this.onContext(e)));
    this.store.add(listen(this.headerEl, 'contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(this.columnsMenu(), e.clientX, e.clientY);
    }));
    if (o.tooltip) {
      const tip = o.tooltip;
      this.store.add(delegateTooltip(this.viewport, (e) => {
        const cell = (e.target as HTMLElement).closest<HTMLElement>('.jb-td');
        const rowEl = cell?.parentElement;
        if (!cell || !rowEl) return undefined;
        const i = Number(rowEl.dataset.index);
        const col = cell.dataset.col!;
        const row = this.rows[i];
        if (row === undefined) return undefined;
        const content = tip(row, i, col);
        if (!content) return undefined;
        return { anchor: { x: e.clientX, y: rowEl.getBoundingClientRect().bottom - 4 }, content, key: `${this.ids[i]}|${col}` };
      }));
    }
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        this.renderedKey = '';
        this.scheduleRender();
      });
      ro.observe(this.viewport);
      this.store.add({ dispose: () => ro.disconnect() });
    }
    this.renderHeader();
    parent?.appendChild(this.element);
    this.updateEmpty();
  }

  // ---------------------------------------------------------------- data

  /** Replaces all rows; selection is kept for row ids that still exist. */
  setRows(rows: R[], opts: { keepSelection?: boolean; keepScroll?: boolean } = {}): void {
    this.rows = rows;
    this.ids = rows.map((r) => this.o.rowId(r));
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    this.needMoreFired = false;
    if (opts.keepSelection === false) this.sel.clear();
    else this.sel.retain((id) => this.index.has(id));
    if (opts.keepScroll === false) this.viewport.scrollTop = 0;
    this.changedData();
  }

  appendRows(rows: R[]): void {
    for (const r of rows) {
      const id = this.o.rowId(r);
      this.index.set(id, this.rows.length);
      this.rows.push(r);
      this.ids.push(id);
    }
    this.needMoreFired = false;
    this.changedData();
  }

  getRows(): readonly R[] {
    return this.rows;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  getRow(index: number): R | undefined {
    return this.rows[index];
  }

  indexOf(id: string): number {
    return this.index.get(id) ?? -1;
  }

  /** Whether more rows can be loaded (enables onNeedMore). */
  setHasMore(more: boolean): void {
    this.hasMore = more;
    this.needMoreFired = false;
    this.scheduleRender();
  }

  setEmptyText(text: EmptyLine[] | string | undefined): void {
    this.emptyText = text;
    this.updateEmpty();
  }

  /** Re-renders visible rows (after row objects changed or external state used by renderers changed). */
  refresh(): void {
    this.version++;
    this.scheduleRender();
  }

  /** First/last (exclusive) rendered row indices. */
  visibleRange(): { first: number; last: number } {
    const first = Math.floor(this.viewport.scrollTop / this.rowH);
    const last = Math.min(this.rows.length, Math.ceil((this.viewport.scrollTop + this.viewport.clientHeight) / this.rowH));
    return { first, last };
  }

  private changedData(): void {
    this.spacer.style.height = `${this.rows.length * this.rowH}px`;
    this.updateEmpty();
    if (this.pattern) this.speed?.setNoMatch(!this.anyMatch());
    this.version++;
    this.render();
  }

  private updateEmpty(): void {
    const show = !this.rows.length && !!this.emptyText;
    this.emptyEl.classList.toggle('jb-hidden', !show);
    if (show) this.emptyEl.replaceChildren(emptyState(this.emptyText!));
  }

  // ---------------------------------------------------------------- columns

  getColumns(): readonly Column<R>[] {
    return this.columns;
  }

  setColumnVisible(id: string, visible: boolean): void {
    const c = this.columns.find((x) => x.id === id);
    if (!c || !!c.hidden === !visible) return;
    c.hidden = !visible;
    this.columnsUpdated();
  }

  setColumnWidth(id: string, width: number): void {
    const c = this.columns.find((x) => x.id === id);
    if (!c) return;
    c.width = Math.max(c.minWidth ?? 30, Math.round(width));
    this.columnsUpdated();
  }

  /** Replaces column definitions (renderers etc.); persisted order/width/visibility are re-applied. */
  setColumns(columns: Column<R>[]): void {
    this.columns = this.applyState(columns.map((c) => ({ ...c })));
    this.columnsUpdated(false);
  }

  private visibleColumns(): Column<R>[] {
    return this.columns.filter((c) => !c.hidden);
  }

  private flexColumn(): Column<R> | undefined {
    const vis = this.visibleColumns();
    return vis.find((c) => c.flex) ?? vis[vis.length - 1];
  }

  private applyState(cols: Column<R>[]): Column<R>[] {
    const st = loadState<ColumnState | undefined>(this.o.stateKey ? `table.${this.o.stateKey}` : undefined, undefined);
    if (!st) return cols;
    for (const c of cols) {
      if (st.widths[c.id]) c.width = st.widths[c.id];
      if (c.hideable !== false) c.hidden = st.hidden.includes(c.id);
    }
    const pos = (id: string) => {
      const i = st.order.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const orig = new Map(cols.map((c, i) => [c.id, i]));
    return cols.sort((a, b) => pos(a.id) - pos(b.id) || orig.get(a.id)! - orig.get(b.id)!);
  }

  private persistColumns(): void {
    if (!this.o.stateKey) return;
    const st: ColumnState = {
      order: this.columns.map((c) => c.id),
      widths: Object.fromEntries(this.columns.filter((c) => c.width).map((c) => [c.id, c.width!])),
      hidden: this.columns.filter((c) => c.hidden).map((c) => c.id),
    };
    saveState(`table.${this.o.stateKey}`, st);
  }

  private columnsUpdated(persist = true): void {
    if (persist) this.persistColumns();
    this.renderHeader();
    this.poolColumnsKey = '';
    this.version++;
    this.render();
    this.columnsChanged.fire();
  }

  private columnsMenu(): MenuItem[] {
    return this.columns
      .filter((c) => c.hideable !== false)
      .map((c) => ({
        label: c.title,
        checked: !c.hidden,
        run: () => this.setColumnVisible(c.id, !!c.hidden),
      }));
  }

  private cellStyle(el: HTMLElement, c: Column<R>): void {
    if (c === this.flexColumn()) {
      el.style.flex = '1 1 0';
      el.style.width = '';
      el.style.minWidth = `${c.minWidth ?? 60}px`;
    } else {
      el.style.flex = '0 0 auto';
      el.style.width = `${c.width ?? 100}px`;
      el.style.minWidth = '';
    }
    el.style.textAlign = c.align ?? '';
  }

  private renderHeader(): void {
    this.headerEl.replaceChildren();
    for (const c of this.visibleColumns()) {
      const resizer = c.resizable === false ? null : h('div.jb-th-resizer', { onPointerdown: (e: PointerEvent) => this.startResize(e, c) });
      const th = h('div.jb-th', { dataset: { col: c.id }, attrs: { role: 'columnheader' }, onPointerdown: (e: PointerEvent) => this.startReorder(e, c, th) }, h('span.jb-th-title', null, c.title), resizer);
      this.cellStyle(th, c);
      this.headerEl.append(th);
    }
    this.headerEl.append(h('div.jb-th-pad'));
  }

  private startResize(e: PointerEvent, c: Column<R>): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const vis = this.visibleColumns();
    // resizing the flex column resizes the next fixed one inversely
    const flex = this.flexColumn();
    const col = c === flex ? vis[vis.indexOf(c) + 1] : c;
    if (!col) return;
    const sign = c === flex ? -1 : 1;
    const startX = e.clientX;
    const startW = col.width ?? (this.headerEl.querySelector<HTMLElement>(`[data-col="${CSS.escape(col.id)}"]`)?.offsetWidth ?? 100);
    document.body.classList.add('jb-resizing-h');
    const move = (ev: PointerEvent) => {
      col.width = Math.max(col.minWidth ?? 30, Math.round(startW + sign * (ev.clientX - startX)));
      this.renderHeader();
      this.poolColumnsKey = '';
      this.version++;
      this.render();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.body.classList.remove('jb-resizing-h');
      this.columnsUpdated();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  private startReorder(e: PointerEvent, c: Column<R>, th: HTMLElement): void {
    if (e.button !== 0) return;
    const startX = e.clientX;
    let dragging = false;
    th.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) < 5) return;
      dragging = true;
      th.classList.add('jb-th-dragging');
      th.style.transform = `translateX(${dx}px)`;
    };
    const up = (ev: PointerEvent) => {
      th.removeEventListener('pointermove', move);
      th.removeEventListener('pointerup', up);
      th.removeEventListener('pointercancel', up);
      if (!dragging) {
        this.headerClicked.fire(c.id);
        return;
      }
      const ths = [...this.headerEl.querySelectorAll<HTMLElement>('.jb-th')].filter((x) => x !== th);
      const x = ev.clientX;
      let before: string | undefined;
      for (const t of ths) {
        const r = t.getBoundingClientRect();
        if (x < r.left + r.width / 2) {
          before = t.dataset.col;
          break;
        }
      }
      const rest = this.columns.filter((x2) => x2 !== c);
      const at = before ? rest.findIndex((x2) => x2.id === before) : rest.length;
      rest.splice(at, 0, c);
      this.columns = rest;
      this.columnsUpdated();
    };
    th.addEventListener('pointermove', move);
    th.addEventListener('pointerup', up);
    th.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------- selection

  getSelection(): R[] {
    return this.sel.ordered(this.nav).map((id) => this.rows[this.index.get(id)!]).filter((r) => r !== undefined);
  }

  getSelectedIds(): string[] {
    return this.sel.ordered(this.nav);
  }

  getSelectedIndices(): number[] {
    return this.getSelectedIds().map((id) => this.index.get(id)!);
  }

  getLeadIndex(): number | undefined {
    return this.sel.lead !== undefined ? this.index.get(this.sel.lead) : undefined;
  }

  select(ids: string[], opts: { reveal?: boolean; focus?: boolean } = {}): void {
    const valid = ids.filter((id) => this.index.has(id));
    this.sel.set(valid, valid[valid.length - 1]);
    if (opts.reveal !== false && valid.length) this.scrollToIndex(this.index.get(valid[valid.length - 1])!, 'nearest');
    if (opts.focus) this.focus();
  }

  selectIndex(i: number, opts: { reveal?: boolean; focus?: boolean } = {}): void {
    const id = this.ids[i];
    if (id !== undefined) this.select([id], opts);
  }

  clearSelection(): void {
    this.sel.clear();
  }

  focus(): void {
    this.element.focus({ preventScroll: true });
  }

  scrollToIndex(i: number, mode: 'nearest' | 'center' | 'top' = 'nearest'): void {
    const vp = this.viewport;
    const top = i * this.rowH;
    const vh = vp.clientHeight || this.rowH * 10;
    if (mode === 'top') vp.scrollTop = top;
    else if (mode === 'center') vp.scrollTop = top - vh / 2 + this.rowH / 2;
    else if (top < vp.scrollTop) vp.scrollTop = top;
    else if (top + this.rowH > vp.scrollTop + vh) vp.scrollTop = top + this.rowH - vh;
    this.render();
  }

  // ---------------------------------------------------------------- speed search

  private setPattern(p: string): void {
    this.pattern = p;
    if (p) {
      const any = this.anyMatch();
      this.speed?.setNoMatch(!any);
      if (any) this.nextMatch(1, true);
    }
    this.version++;
    this.render();
  }

  private isMatch(i: number): boolean {
    return !!this.pattern && !!this.o.speedSearch && matchText(this.pattern, this.o.speedSearch(this.rows[i])) !== null;
  }

  private anyMatch(): boolean {
    for (let i = 0; i < this.rows.length; i++) if (this.isMatch(i)) return true;
    return false;
  }

  private nextMatch(dir: 1 | -1, includeCurrent: boolean): void {
    const n = this.rows.length;
    if (!n) return;
    const start = this.getLeadIndex() ?? 0;
    for (let k = includeCurrent ? 0 : 1; k <= n; k++) {
      const i = (((start + dir * k) % n) + n) % n;
      if (this.isMatch(i)) {
        this.sel.set([this.ids[i]], this.ids[i]);
        this.scrollToIndex(i, 'nearest');
        return;
      }
    }
  }

  // ---------------------------------------------------------------- rendering

  private repaintFocus(): void {
    this.version++;
    this.scheduleRender();
  }

  private render(): void {
    const vp = this.viewport;
    const vh = vp.clientHeight || 600;
    const first = Math.max(0, Math.floor(vp.scrollTop / this.rowH) - 3);
    const last = Math.min(this.rows.length, Math.ceil((vp.scrollTop + vh) / this.rowH) + 3);
    // header padding for the vertical scrollbar
    const sb = vp.offsetWidth - vp.clientWidth;
    (this.headerEl.lastElementChild as HTMLElement | null)?.style.setProperty('width', `${sb}px`);
    const key = `${first}:${last}:${this.version}:${vp.clientWidth}`;
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      const vis = this.visibleColumns();
      const colKey = vis.map((c) => `${c.id}:${c.width}`).join('|');
      if (colKey !== this.poolColumnsKey) {
        for (const p of this.pool) p.el.remove();
        this.pool = [];
        this.poolColumnsKey = colKey;
      }
      const count = last - first;
      while (this.pool.length < count) {
        const cells = vis.map((c) => {
          const td = h('div.jb-td', { dataset: { col: c.id }, attrs: { role: 'gridcell' } });
          this.cellStyle(td, c);
          return td;
        });
        const el = h('div.jb-table-row', { attrs: { role: 'row' } }, cells);
        this.pool.push({ el, cells });
        vp.appendChild(el);
      }
      const focused = this.element.contains(document.activeElement);
      const widths = new Map<string, number>();
      for (let k = 0; k < this.pool.length; k++) {
        const p = this.pool[k];
        if (k >= count) {
          p.el.style.display = 'none';
          continue;
        }
        p.el.style.display = '';
        const i = first + k;
        const row = this.rows[i];
        const id = this.ids[i];
        const selected = this.sel.isSelected(id);
        p.el.id = `${this.domId}-${i}`;
        p.el.dataset.index = String(i);
        p.el.style.transform = `translateY(${i * this.rowH}px)`;
        p.el.className = 'jb-table-row';
        if (selected) p.el.classList.add('jb-selected');
        if (id === this.sel.lead) p.el.classList.add('jb-lead');
        if (this.pattern && this.isMatch(i)) p.el.classList.add('jb-search-match');
        const extra = this.o.rowClass?.(row, i);
        if (extra) p.el.classList.add(...extra.split(' ').filter(Boolean));
        p.el.setAttribute('aria-selected', String(selected));
        p.el.setAttribute('aria-rowindex', String(i + 1));
        vis.forEach((c, ci) => {
          const cell = p.cells[ci];
          const cc = c.className?.(row, i);
          cell.className = cc ? `jb-td ${cc}` : 'jb-td';
          if (c.render) {
            let w = widths.get(c.id);
            if (w === undefined) widths.set(c.id, (w = cell.offsetWidth || c.width || 100));
            c.render(cell, row, i, { index: i, selected, focused, width: w, height: this.rowH, columnId: c.id, searchPattern: this.pattern });
          } else {
            const t = c.text ? c.text(row, i) : '';
            if (cell.childNodes.length !== 1 || cell.firstChild!.nodeType !== Node.TEXT_NODE || cell.textContent !== t) cell.textContent = t;
          }
        });
      }
      const lead = this.getLeadIndex();
      if (lead !== undefined) this.element.setAttribute('aria-activedescendant', `${this.domId}-${lead}`);
      else this.element.removeAttribute('aria-activedescendant');
      this.scrolled.fire({ first: Math.max(0, first), last });
    }
    const threshold = this.o.needMoreThreshold ?? 100;
    if (this.hasMore && !this.needMoreFired && last >= this.rows.length - threshold) {
      this.needMoreFired = true;
      this.needMore.fire();
    }
  }

  // ---------------------------------------------------------------- input

  private rowAt(e: Event): { index: number; columnId: string | undefined } | undefined {
    const t = e.target as HTMLElement;
    const rowEl = t.closest<HTMLElement>('.jb-table-row');
    if (!rowEl) return undefined;
    const i = Number(rowEl.dataset.index);
    if (!Number.isFinite(i) || this.rows[i] === undefined) return undefined;
    return { index: i, columnId: t.closest<HTMLElement>('.jb-td')?.dataset.col };
  }

  private onMouseDown(e: MouseEvent): void {
    this.speed?.close();
    const hit = this.rowAt(e);
    if (e.button !== 0) {
      if (e.button === 2) this.focus();
      return;
    }
    if ((e.target as HTMLElement).closest('button, a, input, .jb-link')) {
      this.focus();
      return;
    }
    e.preventDefault();
    this.focus();
    if (!hit) return;
    const id = this.ids[hit.index];
    if (this.sel.isSelected(id) && !e.shiftKey && !isCtrlCmd(e) && this.sel.size > 1) {
      const up = () => {
        window.removeEventListener('mouseup', up);
        if (this.sel.isSelected(id)) this.sel.set([id], id);
      };
      window.addEventListener('mouseup', up);
      return;
    }
    this.sel.click(id, this.nav, { shift: e.shiftKey, toggle: isCtrlCmd(e) });
  }

  private onDblClick(e: MouseEvent): void {
    const hit = this.rowAt(e);
    if (!hit || (e.target as HTMLElement).closest('button, a, input, .jb-link')) return;
    this.activated.fire({ row: this.rows[hit.index], index: hit.index, columnId: hit.columnId, event: e });
  }

  private onContext(e: MouseEvent): void {
    const hit = this.rowAt(e);
    if (hit) {
      const id = this.ids[hit.index];
      if (!this.sel.isSelected(id)) this.sel.set([id], id);
    }
    this.contextMenu.fire({ rows: this.getSelection(), row: hit ? this.rows[hit.index] : undefined, index: hit?.index, columnId: hit?.columnId, x: e.clientX, y: e.clientY, event: e });
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    if (this.speed?.handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const n = this.rows.length;
    const lead = this.getLeadIndex();
    const pageRows = Math.max(1, Math.floor(this.viewport.clientHeight / this.rowH) - 1);
    const go = (i: number) => {
      if (!n) return;
      i = Math.max(0, Math.min(n - 1, i));
      this.sel.moveTo(this.ids[i], this.nav, e.shiftKey);
      this.scrollToIndex(i, 'nearest');
    };
    switch (e.key) {
      case 'ArrowDown':
        go(lead === undefined ? 0 : lead + 1);
        break;
      case 'ArrowUp':
        go(lead === undefined ? 0 : lead - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(n - 1);
        break;
      case 'PageDown':
        go((lead ?? 0) + pageRows);
        break;
      case 'PageUp':
        go((lead ?? 0) - pageRows);
        break;
      case 'Enter':
        if (lead !== undefined) this.activated.fire({ row: this.rows[lead], index: lead, columnId: undefined, event: e });
        break;
      case 'a':
      case 'A':
        if (!isCtrlCmd(e)) return;
        this.sel.selectAll(this.nav);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  dispose(): void {
    this.store.dispose();
    this.sel.dispose();
    for (const em of [this.selectionChanged, this.activated, this.contextMenu, this.needMore, this.columnsChanged, this.scrolled, this.headerClicked]) em.dispose();
    this.element.remove();
  }
}
