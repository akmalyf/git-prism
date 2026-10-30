// Virtualized tree (IntelliJ Tree): 50k+ nodes, persisted expansion, tri-state checkboxes with propagation,
// single/multi selection, full keyboard support, speed search with match highlighting, activation and context-menu
// events, per-node icon / colored label / grey description / badge / hover actions; lazy children.
import { h, listen, DisposableStore, Emitter, highlightText, isCtrlCmd, rafThrottle, uid } from './dom';
import { icon } from './icons';
import { matchText, type MatchRange } from './match';
import { SelectionModel, type SelectionNav } from './selection';
import { SpeedSearch } from './speedsearch';
import { emptyState, type EmptyLine } from './empty';
import { delegateTooltip, setTooltip } from './tooltip';
import { contextMenuPoint } from './menu';
import { loadState, saveState } from './persist';
import { ensureStyles } from './styles';

export interface TreeAction<D = any> {
  icon: string;
  tooltip: string;
  run(node: TreeNode<D>): void;
}

export interface TreeNode<D = any> {
  id: string;
  label: string;
  children?: TreeNode<D>[];
  /** lazy node: children come from TreeOptions.loadChildren on first expand */
  hasChildren?: boolean;
  /** initial expansion (persisted state wins) */
  expanded?: boolean;
  icon?: string;
  iconColor?: string;
  iconClass?: string;
  /** grey secondary text after the label */
  description?: string;
  /** right-aligned grey text */
  trailing?: string;
  className?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  muted?: boolean;
  badge?: string | number;
  checkable?: boolean;
  checked?: boolean;
  selectable?: boolean;
  tooltip?: string;
  actions?: TreeAction<D>[];
  searchText?: string;
  data?: D;
}

export type CheckState = 'on' | 'off' | 'mixed';

export interface TreeRenderContext {
  depth: number;
  selected: boolean;
  matches: MatchRange[] | null;
}

export interface TreeOptions<D = any> {
  multiSelect?: boolean;
  /** show checkboxes for checkable nodes (and tri-state for their ancestors) */
  checkboxes?: boolean;
  rowHeight?: number;
  indent?: number;
  /** persist expansion state */
  stateKey?: string;
  /** expansion depth for nodes without `expanded` (default 1: roots expanded) */
  defaultExpandDepth?: number;
  loadChildren?(node: TreeNode<D>): Promise<TreeNode<D>[]>;
  /** fire onDidActivate for nodes with children too (default: they toggle expansion) */
  activateParents?: boolean;
  speedSearch?: boolean;
  emptyText?: EmptyLine[] | string;
  ariaLabel?: string;
  className?: string;
  rowClass?(node: TreeNode<D>): string | undefined;
  /** replace the default label rendering (icon is still drawn) */
  renderLabel?(el: HTMLElement, node: TreeNode<D>, ctx: TreeRenderContext): void;
}

interface Row<D> {
  node: TreeNode<D>;
  depth: number;
  /** synthetic "Loading…" row */
  loading?: boolean;
}

interface Meta<D> {
  node: TreeNode<D>;
  parent: string | undefined;
  depth: number;
}

export class Tree<D = any> {
  readonly element: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private roots: TreeNode<D>[] = [];
  private meta = new Map<string, Meta<D>>();
  private rows: Row<D>[] = [];
  private rowIndex = new Map<string, number>();
  private expandState: Map<string, boolean>;
  private lazy = new Map<string, TreeNode<D>[]>();
  private loading = new Set<string>();
  private checkedLeaves = new Set<string>();
  private aggregate = new Map<string, CheckState>();
  private knownIds = new Set<string>();
  private readonly sel: SelectionModel<string>;
  private readonly nav: SelectionNav<string>;
  private readonly speed: SpeedSearch | undefined;
  private pattern = '';
  private matchCache = new Map<string, MatchRange[] | null>();
  private pool: HTMLElement[] = [];
  private renderedKey = '';
  private version = 0;
  private readonly rowH: number;
  private readonly domId = uid('jbtree');
  private readonly indent: number;
  private readonly store = new DisposableStore();
  private readonly scheduleRender = rafThrottle(() => this.render());

  private readonly selectionChanged = new Emitter<TreeNode<D>[]>();
  private readonly activated = new Emitter<{ node: TreeNode<D>; event: MouseEvent | KeyboardEvent }>();
  private readonly contextMenu = new Emitter<{ nodes: TreeNode<D>[]; node: TreeNode<D> | undefined; x: number; y: number; event: MouseEvent | KeyboardEvent }>();
  private readonly checkChanged = new Emitter<{ nodes: TreeNode<D>[] }>();
  private readonly expandToggled = new Emitter<{ node: TreeNode<D>; expanded: boolean }>();
  readonly onDidChangeSelection = this.selectionChanged.event;
  readonly onDidActivate = this.activated.event;
  readonly onContextMenu = this.contextMenu.event;
  readonly onDidChangeChecked = this.checkChanged.event;
  readonly onDidToggleExpand = this.expandToggled.event;

  constructor(parent: HTMLElement | null, private readonly o: TreeOptions<D> = {}) {
    ensureStyles();
    this.rowH = o.rowHeight ?? 24;
    this.indent = o.indent ?? 18;
    this.sel = new SelectionModel<string>(o.multiSelect ?? true);
    const self = this;
    this.nav = {
      indexOf: (k) => self.rowIndex.get(k) ?? -1,
      keyAt: (i) => self.rows[i]?.node.id,
      get count() {
        return self.rows.length;
      },
    };
    this.expandState = new Map(Object.entries(loadState<Record<string, boolean>>(o.stateKey ? `tree.${o.stateKey}` : undefined, {})));
    this.spacer = h('div.jb-tree-spacer');
    this.emptyEl = h('div.jb-tree-empty.jb-hidden');
    this.viewport = h('div.jb-tree-viewport', null, this.spacer);
    this.element = h('div.jb-tree', {
      tabIndex: 0,
      class: o.className,
      style: { '--jb-row': `${this.rowH}px` },
      attrs: { role: 'tree', 'aria-label': o.ariaLabel, 'aria-multiselectable': o.multiSelect === false ? undefined : 'true' },
    }, this.viewport, this.emptyEl);
    if (o.speedSearch !== false) {
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
    this.store.add(listen(this.viewport, 'scroll', () => this.scheduleRender(), { passive: true }));
    this.store.add(listen(this.element, 'keydown', (e) => this.onKey(e)));
    this.store.add(listen(this.viewport, 'mousedown', (e) => this.onMouseDown(e)));
    this.store.add(listen(this.viewport, 'dblclick', (e) => this.onDblClick(e)));
    this.store.add(listen(this.viewport, 'click', (e) => {
      if ((e.target as HTMLElement).closest('.jb-tree-check')) e.preventDefault();
    }));
    this.store.add(listen(this.viewport, 'contextmenu', (e) => this.onContext(e)));
    this.store.add(listen(this.element, 'focusout', (e) => {
      if (!this.element.contains(e.relatedTarget as Node)) this.speed?.close();
    }));
    this.store.add(delegateTooltip(this.viewport, (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.jb-tree-row');
      if (!row || (e.target as HTMLElement).closest('.jb-tree-actions')) return undefined;
      const r = this.rows[Number(row.dataset.index)];
      if (!r?.node.tooltip) return undefined;
      return { anchor: { x: e.clientX, y: row.getBoundingClientRect().bottom - 6 }, content: r.node.tooltip, key: r.node.id };
    }));
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        this.renderedKey = '';
        this.scheduleRender();
      });
      ro.observe(this.viewport);
      this.store.add({ dispose: () => ro.disconnect() });
    }
    parent?.appendChild(this.element);
  }

  // ---------------------------------------------------------------- data

  /**
   * Replaces the nodes. Expansion, selection, scroll position and check states of known ids are kept;
   * `checked` is read for new ids (or for all with resetChecks).
   */
  setRoots(roots: TreeNode<D>[], opts: { resetChecks?: boolean; resetExpansion?: boolean } = {}): void {
    this.roots = roots;
    if (opts.resetChecks) {
      this.checkedLeaves.clear();
      this.knownIds.clear();
    }
    if (opts.resetExpansion) this.expandState.clear();
    this.lazy = new Map([...this.lazy].filter(([id]) => this.findIn(roots, id) !== undefined));
    this.reindex();
    this.sel.retain((id) => this.meta.has(id));
    this.rebuild();
  }

  getRoots(): TreeNode<D>[] {
    return this.roots;
  }

  getNode(id: string): TreeNode<D> | undefined {
    return this.meta.get(id)?.node;
  }

  getParent(id: string): TreeNode<D> | undefined {
    const p = this.meta.get(id)?.parent;
    return p ? this.meta.get(p)?.node : undefined;
  }

  /** Children (including loaded lazy children). */
  getChildren(node: TreeNode<D>): TreeNode<D>[] | undefined {
    return node.children ?? this.lazy.get(node.id);
  }

  /** Visible rows in order. */
  visibleNodes(): TreeNode<D>[] {
    return this.rows.filter((r) => !r.loading).map((r) => r.node);
  }

  /** Patches a node in place (label, icon, className, badge…). Use setRoots to change structure. */
  updateNode(id: string, patch: Partial<TreeNode<D>>): void {
    const m = this.meta.get(id);
    if (!m) return;
    const structural = 'children' in patch || 'hasChildren' in patch;
    Object.assign(m.node, patch);
    if ('checked' in patch && m.node.checkable) {
      if (patch.checked) this.checkedLeaves.add(id);
      else this.checkedLeaves.delete(id);
      this.computeAggregate();
    }
    if (structural) this.setRoots(this.roots);
    else this.refresh();
  }

  /** Re-renders visible rows (after mutating node objects). */
  refresh(): void {
    this.matchCache.clear();
    this.version++;
    this.scheduleRender();
  }

  private findIn(nodes: TreeNode<D>[], id: string): TreeNode<D> | undefined {
    const stack = [...nodes];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === id) return n;
      const c = this.getChildren(n);
      if (c) stack.push(...c);
    }
    return undefined;
  }

  private reindex(): void {
    this.meta.clear();
    const walk = (nodes: TreeNode<D>[], parent: string | undefined, depth: number) => {
      for (const n of nodes) {
        this.meta.set(n.id, { node: n, parent, depth });
        if (!this.knownIds.has(n.id)) {
          this.knownIds.add(n.id);
          if (n.checkable && n.checked) this.checkedLeaves.add(n.id);
        }
        const c = this.getChildren(n);
        if (c) walk(c, n.id, depth + 1);
      }
    };
    walk(this.roots, undefined, 0);
    for (const id of this.checkedLeaves) if (!this.meta.has(id)) this.checkedLeaves.delete(id);
    if (this.knownIds.size > this.meta.size * 2 + 1000) this.knownIds = new Set(this.meta.keys());
    this.computeAggregate();
  }

  private computeAggregate(): void {
    this.aggregate.clear();
    if (!this.o.checkboxes) return;
    const visit = (n: TreeNode<D>): CheckState | undefined => {
      const c = this.getChildren(n);
      if (!c || !c.length) {
        if (!n.checkable) return undefined;
        const s: CheckState = this.checkedLeaves.has(n.id) ? 'on' : 'off';
        this.aggregate.set(n.id, s);
        return s;
      }
      let on = 0;
      let off = 0;
      for (const ch of c) {
        const s = visit(ch);
        if (s === 'on') on++;
        else if (s === 'off') off++;
        else if (s === 'mixed') on++, off++;
      }
      if (!on && !off) return undefined;
      const s: CheckState = on && off ? 'mixed' : on ? 'on' : 'off';
      this.aggregate.set(n.id, s);
      return s;
    };
    for (const r of this.roots) visit(r);
  }

  // ---------------------------------------------------------------- expansion

  isExpanded(id: string): boolean {
    const m = this.meta.get(id);
    if (!m) return false;
    const s = this.expandState.get(id);
    if (s !== undefined) return s;
    return m.node.expanded ?? m.depth < (this.o.defaultExpandDepth ?? 1);
  }

  private expandable(n: TreeNode<D>): boolean {
    const c = this.getChildren(n);
    return c ? c.length > 0 : !!n.hasChildren;
  }

  private setExpandedState(id: string, v: boolean): void {
    this.expandState.delete(id);
    this.expandState.set(id, v);
    if (this.expandState.size > 5000) this.expandState.delete(this.expandState.keys().next().value!);
  }

  private persistExpansion(): void {
    if (this.o.stateKey) saveState(`tree.${this.o.stateKey}`, Object.fromEntries(this.expandState));
  }

  expand(id: string, recursive = false): void {
    const doExpand = (n: TreeNode<D>) => {
      if (!this.expandable(n)) return;
      const was = this.isExpanded(n.id);
      this.setExpandedState(n.id, true);
      if (!this.getChildren(n) && n.hasChildren) void this.load(n);
      if (!was) this.expandToggled.fire({ node: n, expanded: true });
      if (recursive) for (const c of this.getChildren(n) ?? []) doExpand(c);
    };
    const n = this.getNode(id);
    if (!n) return;
    doExpand(n);
    this.persistExpansion();
    this.rebuild();
  }

  collapse(id: string, recursive = false): void {
    const n = this.getNode(id);
    if (!n) return;
    const doCollapse = (x: TreeNode<D>) => {
      if (!this.expandable(x)) return;
      const was = this.isExpanded(x.id);
      this.setExpandedState(x.id, false);
      if (was) this.expandToggled.fire({ node: x, expanded: false });
      if (recursive) for (const c of this.getChildren(x) ?? []) doCollapse(c);
    };
    doCollapse(n);
    // keep the lead visible: move selection to the collapsed node if it was inside
    const lead = this.sel.lead;
    if (lead && lead !== id && this.isAncestor(id, lead)) this.sel.set([id], id);
    this.persistExpansion();
    this.rebuild();
  }

  toggle(id: string): void {
    if (this.isExpanded(id)) this.collapse(id);
    else this.expand(id);
  }

  expandAll(): void {
    for (const m of this.meta.values()) if (this.expandable(m.node) && this.getChildren(m.node)) this.setExpandedState(m.node.id, true);
    this.persistExpansion();
    this.rebuild();
  }

  /** Collapses everything (roots stay expanded when keepRoots, like IntelliJ "Collapse All" in change trees). */
  collapseAll(keepRoots = false): void {
    for (const m of this.meta.values()) if (this.expandable(m.node)) this.setExpandedState(m.node.id, keepRoots && m.depth === 0);
    const lead = this.sel.lead;
    if (lead) {
      let top = lead;
      for (let p = this.meta.get(lead)?.parent; p; p = this.meta.get(p)?.parent) if (!this.isExpanded(p)) top = p;
      if (top !== lead) this.sel.set([top], top);
    }
    this.persistExpansion();
    this.rebuild();
  }

  /** Expands ancestors and scrolls the node into view. */
  reveal(id: string): void {
    let changed = false;
    for (let p = this.meta.get(id)?.parent; p; p = this.meta.get(p)?.parent) {
      if (!this.isExpanded(p)) {
        this.setExpandedState(p, true);
        changed = true;
      }
    }
    if (changed) {
      this.persistExpansion();
      this.rebuild();
    }
    const i = this.rowIndex.get(id);
    if (i !== undefined) this.ensureVisible(i, true);
  }

  private isAncestor(anc: string, id: string): boolean {
    for (let p = this.meta.get(id)?.parent; p; p = this.meta.get(p)?.parent) if (p === anc) return true;
    return false;
  }

  private async load(n: TreeNode<D>): Promise<void> {
    if (!this.o.loadChildren || this.loading.has(n.id)) return;
    this.loading.add(n.id);
    this.rebuild();
    try {
      const children = await this.o.loadChildren(n);
      this.lazy.set(n.id, children);
    } catch (e) {
      console.error(e);
      this.lazy.set(n.id, []);
    } finally {
      this.loading.delete(n.id);
    }
    if (this.meta.has(n.id)) {
      this.reindex();
      this.rebuild();
    }
  }

  private rebuild(): void {
    const rows: Row<D>[] = [];
    const walk = (nodes: TreeNode<D>[], depth: number) => {
      for (const n of nodes) {
        rows.push({ node: n, depth });
        if (this.isExpanded(n.id)) {
          const c = this.getChildren(n);
          if (c) walk(c, depth + 1);
          else if (this.loading.has(n.id)) rows.push({ node: { id: `${n.id}\u0000loading`, label: 'Loading…', muted: true, selectable: false }, depth: depth + 1, loading: true });
          else if (n.hasChildren && this.o.loadChildren) void this.load(n);
        }
      }
    };
    walk(this.roots, 0);
    this.rows = rows;
    this.rowIndex = new Map(rows.map((r, i) => [r.node.id, i]));
    this.spacer.style.height = `${rows.length * this.rowH}px`;
    this.emptyEl.classList.toggle('jb-hidden', rows.length > 0);
    if (!rows.length && this.o.emptyText) this.emptyEl.replaceChildren(emptyState(this.o.emptyText));
    if (this.pattern) this.updateSearch(false);
    this.version++;
    this.render();
  }

  // ---------------------------------------------------------------- selection

  getSelection(): TreeNode<D>[] {
    return this.sel.ordered(this.nav).filter((id) => this.meta.has(id)).map((id) => this.meta.get(id)!.node).concat(
      [...this.sel.selected].filter((id) => this.meta.has(id) && !this.rowIndex.has(id)).map((id) => this.meta.get(id)!.node),
    );
  }

  getSelectedIds(): string[] {
    return this.getSelection().map((n) => n.id);
  }

  getLead(): TreeNode<D> | undefined {
    return this.sel.lead ? this.getNode(this.sel.lead) : undefined;
  }

  select(ids: string[], opts: { reveal?: boolean; focus?: boolean } = {}): void {
    const valid = ids.filter((id) => this.meta.has(id));
    if (opts.reveal !== false) for (const id of valid) this.reveal(id);
    this.sel.set(valid, valid[valid.length - 1]);
    if (opts.focus) this.focus();
  }

  clearSelection(): void {
    this.sel.clear();
  }

  focus(): void {
    this.element.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- checkboxes

  getCheckState(id: string): CheckState | undefined {
    return this.aggregate.get(id);
  }

  /** Checked checkable leaves in tree order. */
  getChecked(): TreeNode<D>[] {
    const out: TreeNode<D>[] = [];
    const walk = (nodes: TreeNode<D>[]) => {
      for (const n of nodes) {
        const c = this.getChildren(n);
        if (c && c.length) walk(c);
        else if (n.checkable && this.checkedLeaves.has(n.id)) out.push(n);
      }
    };
    walk(this.roots);
    return out;
  }

  /** Sets nodes (leaves or parents → all their checkable leaves) checked/unchecked. */
  setChecked(ids: string[], checked: boolean, fire = true): void {
    const changed: TreeNode<D>[] = [];
    const apply = (n: TreeNode<D>) => {
      const c = this.getChildren(n);
      if (c && c.length) c.forEach(apply);
      else if (n.checkable && this.checkedLeaves.has(n.id) !== checked) {
        if (checked) this.checkedLeaves.add(n.id);
        else this.checkedLeaves.delete(n.id);
        n.checked = checked;
        changed.push(n);
      }
    };
    for (const id of ids) {
      const n = this.getNode(id);
      if (n) apply(n);
    }
    if (!changed.length) return;
    this.computeAggregate();
    this.version++;
    this.scheduleRender();
    if (fire) this.checkChanged.fire({ nodes: changed });
  }

  checkAll(checked: boolean): void {
    this.setChecked(this.roots.map((r) => r.id), checked);
  }

  private toggleChecks(ids: string[]): void {
    const states = ids.map((id) => this.aggregate.get(id)).filter((s): s is CheckState => !!s);
    if (!states.length) return;
    const lead = this.sel.lead && ids.includes(this.sel.lead) ? this.aggregate.get(this.sel.lead) : states[0];
    this.setChecked(ids, lead !== 'on');
  }

  // ---------------------------------------------------------------- speed search

  private setPattern(p: string): void {
    this.pattern = p;
    this.matchCache.clear();
    this.updateSearch(true);
    this.version++;
    this.render();
  }

  private matches(n: TreeNode<D>): MatchRange[] | null {
    if (!this.pattern) return null;
    let m = this.matchCache.get(n.id);
    if (m === undefined) {
      m = matchText(this.pattern, n.searchText ?? n.label);
      if (m && n.searchText && n.searchText !== n.label) m = matchText(this.pattern, n.label) ?? [];
      this.matchCache.set(n.id, m);
    }
    return m;
  }

  private updateSearch(moveSelection: boolean): void {
    if (!this.pattern) return;
    const any = this.rows.some((r) => !r.loading && this.matches(r.node));
    this.speed?.setNoMatch(!any);
    if (moveSelection && any) {
      const cur = this.sel.lead ? this.rowIndex.get(this.sel.lead) ?? 0 : 0;
      if (!(this.rows[cur] && this.matches(this.rows[cur].node))) this.nextMatch(1, true);
    }
  }

  private nextMatch(dir: 1 | -1, includeCurrent: boolean): void {
    const n = this.rows.length;
    if (!n) return;
    const start = this.sel.lead ? this.rowIndex.get(this.sel.lead) ?? 0 : 0;
    for (let k = includeCurrent ? 0 : 1; k <= n; k++) {
      const i = (((start + dir * k) % n) + n) % n;
      const r = this.rows[i];
      if (!r.loading && r.node.selectable !== false && this.matches(r.node)) {
        this.sel.set([r.node.id], r.node.id);
        this.ensureVisible(i, false);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- rendering

  private ensureVisible(i: number, center: boolean): void {
    const vp = this.viewport;
    const top = i * this.rowH;
    const vh = vp.clientHeight || this.rowH * 10;
    if (center && (top < vp.scrollTop || top + this.rowH > vp.scrollTop + vh)) vp.scrollTop = top - vh / 2 + this.rowH / 2;
    else if (top < vp.scrollTop) vp.scrollTop = top;
    else if (top + this.rowH > vp.scrollTop + vh) vp.scrollTop = top + this.rowH - vh;
    this.render();
  }

  private render(): void {
    const vp = this.viewport;
    const vh = vp.clientHeight || 600;
    const first = Math.max(0, Math.floor(vp.scrollTop / this.rowH) - 4);
    const last = Math.min(this.rows.length, Math.ceil((vp.scrollTop + vh) / this.rowH) + 4);
    const key = `${first}:${last}:${this.version}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const count = last - first;
    while (this.pool.length < count) {
      const el = h_row();
      this.pool.push(el);
      vp.appendChild(el);
    }
    for (let k = 0; k < this.pool.length; k++) {
      const el = this.pool[k];
      if (k >= count) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      this.renderRow(el, first + k);
    }
    const lead = this.sel.lead !== undefined ? this.rowIndex.get(this.sel.lead) : undefined;
    if (lead !== undefined) this.element.setAttribute('aria-activedescendant', `${this.domId}-${lead}`);
    else this.element.removeAttribute('aria-activedescendant');
  }

  private renderRow(el: HTMLElement, i: number): void {
    const r = this.rows[i];
    const n = r.node;
    const selected = this.sel.isSelected(n.id);
    const expandable = !r.loading && this.expandable(n);
    const expanded = expandable && this.isExpanded(n.id);
    el.id = `${this.domId}-${i}`;
    el.dataset.index = String(i);
    el.style.transform = `translateY(${i * this.rowH}px)`;
    el.className = 'jb-tree-row';
    if (selected) el.classList.add('jb-selected');
    if (n.id === this.sel.lead) el.classList.add('jb-lead');
    const extra = this.o.rowClass?.(n);
    if (extra) el.classList.add(...extra.split(' ').filter(Boolean));
    el.setAttribute('aria-level', String(r.depth + 1));
    el.setAttribute('aria-selected', String(selected));
    if (expandable) el.setAttribute('aria-expanded', String(expanded));
    else el.removeAttribute('aria-expanded');

    const parts: Node[] = [];
    parts.push(h('span.jb-tree-indent', { style: { width: `${r.depth * this.indent + 4}px` } }));
    parts.push(h('span.jb-twistie', null, expandable ? icon(expanded ? 'chevron-down' : 'chevron-right') : null));
    const state = this.o.checkboxes ? this.aggregate.get(n.id) : undefined;
    if (state) {
      const cb = h('input.jb-check.jb-tree-check', { type: 'checkbox', tabIndex: -1, checked: state === 'on', indeterminate: state === 'mixed' });
      parts.push(cb);
    }
    if (r.loading) parts.push(icon('loading', { spin: true }));
    else if (n.icon) parts.push(icon(n.icon, { color: n.iconColor, className: n.iconClass }));
    const matches = this.matches(n);
    const label = h('span.jb-tree-label', {
      class: [n.className, { 'jb-bold': n.bold, 'jb-italic': n.italic, 'jb-strike': n.strike, 'jb-muted': n.muted }],
    });
    if (this.o.renderLabel) this.o.renderLabel(label, n, { depth: r.depth, selected, matches });
    else label.append(highlightText(n.label, matches));
    parts.push(label);
    if (n.description) parts.push(h('span.jb-tree-desc', null, n.description));
    parts.push(h('span.jb-fill'));
    if (n.trailing) parts.push(h('span.jb-tree-trailing', null, n.trailing));
    if (n.badge !== undefined && n.badge !== '') parts.push(h('span.jb-badge', null, String(n.badge)));
    if (n.actions?.length) {
      parts.push(
        h('span.jb-tree-actions', null, n.actions.map((a) => {
          const b = h('button.jb-icon-btn.jb-tree-action', { type: 'button', tabIndex: -1, dataset: { action: a.tooltip }, onMousedown: (e: MouseEvent) => e.stopPropagation(), onClick: (e: MouseEvent) => {
            e.stopPropagation();
            a.run(n);
          } }, icon(a.icon));
          setTooltip(b, a.tooltip);
          return b;
        })),
      );
    }
    el.replaceChildren(...parts);
  }

  // ---------------------------------------------------------------- input

  private rowAt(e: Event): number | undefined {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.jb-tree-row');
    if (!row) return undefined;
    const i = Number(row.dataset.index);
    return Number.isFinite(i) && this.rows[i] ? i : undefined;
  }

  private onMouseDown(e: MouseEvent): void {
    this.speed?.close();
    const i = this.rowAt(e);
    if (e.button !== 0) {
      if (e.button === 2 && i === undefined) this.focus();
      return;
    }
    e.preventDefault();
    this.focus();
    if (i === undefined) return;
    const r = this.rows[i];
    if (r.loading) return;
    const t = e.target as HTMLElement;
    if (t.closest('.jb-twistie')) {
      if (this.expandable(r.node)) {
        if (e.altKey) this.isExpanded(r.node.id) ? this.collapse(r.node.id, true) : this.expand(r.node.id, true);
        else this.toggle(r.node.id);
      }
      return;
    }
    if (t.closest('.jb-tree-check')) {
      const ids = this.sel.isSelected(r.node.id) && this.sel.size > 1 ? this.getSelectedIds() : [r.node.id];
      this.setChecked(ids, this.aggregate.get(r.node.id) !== 'on');
      return;
    }
    if (r.node.selectable === false) return;
    if (this.sel.isSelected(r.node.id) && !e.shiftKey && !isCtrlCmd(e) && this.sel.size > 1) {
      // keep multi-selection for a possible drag/double-click; collapse to single on mouseup without move
      const up = () => {
        window.removeEventListener('mouseup', up);
        if (this.sel.isSelected(r.node.id)) this.sel.set([r.node.id], r.node.id);
      };
      window.addEventListener('mouseup', up);
      this.sel.lead = r.node.id;
      this.version++;
      this.render();
      return;
    }
    this.sel.click(r.node.id, this.nav, { shift: e.shiftKey, toggle: isCtrlCmd(e) });
  }

  private onDblClick(e: MouseEvent): void {
    const i = this.rowAt(e);
    if (i === undefined) return;
    const t = e.target as HTMLElement;
    if (t.closest('.jb-twistie, .jb-tree-check, .jb-tree-actions')) return;
    this.activate(this.rows[i].node, e);
  }

  private activate(n: TreeNode<D>, e: MouseEvent | KeyboardEvent): void {
    if (this.rows[this.rowIndex.get(n.id) ?? -1]?.loading) return;
    if (this.expandable(n) && !this.o.activateParents) this.toggle(n.id);
    else this.activated.fire({ node: n, event: e });
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const i = this.rowAt(e);
    if (i !== undefined) {
      const n = this.rows[i].node;
      if (this.rows[i].loading) return;
      if (!this.sel.isSelected(n.id) && n.selectable !== false) this.sel.set([n.id], n.id);
    }
    const nodes = this.getSelection();
    this.contextMenu.fire({ nodes, node: i !== undefined ? this.rows[i].node : undefined, x: e.clientX, y: e.clientY, event: e });
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).closest('input:not(.jb-check), textarea')) return;
    if (this.speed?.handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const n = this.rows.length;
    const leadIdx = this.sel.lead !== undefined ? this.rowIndex.get(this.sel.lead) : undefined;
    const lead = leadIdx !== undefined ? this.rows[leadIdx] : undefined;
    const pageRows = Math.max(1, Math.floor(this.viewport.clientHeight / this.rowH) - 1);
    const go = (i: number, dir: 1 | -1) => {
      if (!n) return;
      i = Math.max(0, Math.min(n - 1, i));
      // skip non-selectable rows
      let k = i;
      while (k >= 0 && k < n && (this.rows[k].loading || this.rows[k].node.selectable === false)) k += dir;
      if (k < 0 || k >= n) {
        k = i;
        while (k >= 0 && k < n && (this.rows[k].loading || this.rows[k].node.selectable === false)) k -= dir;
      }
      if (k < 0 || k >= n) return;
      this.sel.moveTo(this.rows[k].node.id, this.nav, e.shiftKey);
      this.ensureVisible(k, false);
    };
    switch (e.key) {
      case 'ArrowDown':
        go(leadIdx === undefined ? 0 : leadIdx + 1, 1);
        break;
      case 'ArrowUp':
        go(leadIdx === undefined ? 0 : leadIdx - 1, -1);
        break;
      case 'Home':
        go(0, 1);
        break;
      case 'End':
        go(n - 1, -1);
        break;
      case 'PageDown':
        go((leadIdx ?? 0) + pageRows, 1);
        break;
      case 'PageUp':
        go((leadIdx ?? 0) - pageRows, -1);
        break;
      case 'ArrowRight':
        if (!lead) go(0, 1);
        else if (this.expandable(lead.node) && !this.isExpanded(lead.node.id)) this.expand(lead.node.id);
        else if (this.expandable(lead.node) && leadIdx! + 1 < n) go(leadIdx! + 1, 1);
        break;
      case 'ArrowLeft':
        if (!lead) break;
        if (this.expandable(lead.node) && this.isExpanded(lead.node.id)) this.collapse(lead.node.id);
        else {
          const p = this.meta.get(lead.node.id)?.parent;
          if (p && this.rowIndex.has(p) && this.getNode(p)?.selectable !== false) go(this.rowIndex.get(p)!, -1);
        }
        break;
      case 'Enter':
        if (lead) this.activate(lead.node, e);
        break;
      case ' ':
        if (this.o.checkboxes && this.sel.size) this.toggleChecks(this.getSelectedIds());
        else return;
        break;
      case 'F10':
        if (!e.shiftKey) return;
        this.keyboardContextMenu(e);
        break;
      case 'ContextMenu':
        this.keyboardContextMenu(e);
        break;
      case 'a':
      case 'A':
        if (!isCtrlCmd(e)) return;
        this.sel.selectAll(this.nav, (id) => this.getNode(id)?.selectable !== false && !id.endsWith('\u0000loading'));
        break;
      case '+':
      case '=':
        if (!isCtrlCmd(e)) return;
        this.expandAll();
        break;
      case '-':
        if (!isCtrlCmd(e)) return;
        this.collapseAll();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  private keyboardContextMenu(e: KeyboardEvent): void {
    const i = this.sel.lead !== undefined ? this.rowIndex.get(this.sel.lead) : undefined;
    let pt: { x: number; y: number };
    if (i !== undefined) {
      this.ensureVisible(i, false);
      const el = this.pool.find((p) => p.dataset.index === String(i) && p.style.display !== 'none');
      pt = el ? contextMenuPoint(el.querySelector('.jb-tree-label') ?? el) : contextMenuPoint(this.element);
    } else pt = contextMenuPoint(this.element);
    this.contextMenu.fire({ nodes: this.getSelection(), node: this.getLead(), x: pt.x, y: pt.y, event: e });
  }

  dispose(): void {
    this.store.dispose();
    this.sel.dispose();
    this.selectionChanged.dispose();
    this.activated.dispose();
    this.contextMenu.dispose();
    this.checkChanged.dispose();
    this.expandToggled.dispose();
    this.element.remove();
  }
}

function h_row(): HTMLElement {
  return h('div.jb-tree-row', { attrs: { role: 'treeitem' } });
}
