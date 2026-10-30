// Reusable IntelliJ-style changes tree for the compare feature's webviews (Changes browser, compare-branches Files
// tab and commit changes): grouped by directory with counts and status colors, toolbar, context menu, double-click
// diff. Talks to the host through the 'changes.*' RPC (src/features/compare/changesRpc.ts).
import type { FileChange } from '../../core/types';
import type { ChangesSource } from '../../features/compare/protocol';
import { rpc, viewState } from '../shared/rpc';
import {
  buildPathTree,
  contextMenuPoint,
  gitStatusClass,
  gitStatusLabel,
  h,
  isCtrlCmd,
  pathTreeFiles,
  pathTreeToNodes,
  showContextMenu,
  Toolbar,
  Tree,
  type MenuItem,
  type ToolbarItem,
  type TreeNode,
} from '../shared/ui';

export interface ChangesViewOptions {
  stateKey: string;
  /** current source; undefined = nothing to show */
  source(): ChangesSource | undefined;
  emptyText?: string;
  /** extra toolbar items after the standard ones */
  extraItems?: ToolbarItem[];
  /** hide Get (e.g. for commit changes where it is still allowed but not wanted) */
  noGet?: boolean;
  onError?(e: unknown): void;
  /** called after new changes were shown */
  onChanges?(changes: FileChange[]): void;
}

type Node = TreeNode<FileChange>;

export class ChangesView {
  readonly element: HTMLElement;
  readonly toolbar: Toolbar;
  readonly tree: Tree<FileChange>;
  private changes: FileChange[] = [];
  private files: FileChange[] = [];
  private groupByDir: boolean;
  private seq = 0;
  /** the Tree keeps a reference to this object and reads `emptyText` on every render */
  private readonly treeOptions: { emptyText: string } & Record<string, unknown>;

  constructor(parent: HTMLElement | null, private readonly o: ChangesViewOptions) {
    this.groupByDir = viewState.get(`${o.stateKey}.groupByDir`, true);
    const body = h('div.cmp-tree');
    this.element = h('div.cmp-changes');
    this.toolbar = new Toolbar(this.element, { items: this.items(), ariaLabel: 'Changes toolbar' });
    this.element.appendChild(body);
    this.treeOptions = {
      multiSelect: true,
      stateKey: o.stateKey,
      defaultExpandDepth: Infinity,
      emptyText: 'Loading…',
      ariaLabel: 'Changed files',
    };
    this.tree = new Tree<FileChange>(body, this.treeOptions);
    this.tree.onDidActivate(({ node }) => node.data && this.showDiff(node));
    this.tree.onContextMenu(({ x, y }) => showContextMenu(this.menu(), x, y));
    this.tree.onDidChangeSelection(() => this.updateToolbar());
    this.tree.element.addEventListener('keydown', (e) => {
      if (isCtrlCmd(e) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this.showDiff();
      } else if (e.key === 'F4') {
        e.preventDefault();
        this.jumpToSource();
      }
    });
    parent?.appendChild(this.element);
    this.updateToolbar();
  }

  private items(): ToolbarItem[] {
    const items: ToolbarItem[] = [
      { id: 'diff', icon: 'diff', tooltip: 'Show Diff', shortcut: 'CmdOrCtrl+D', run: () => this.showDiff() },
    ];
    if (!this.o.noGet) items.push({ id: 'get', icon: 'desktop-download', tooltip: 'Get', run: () => this.get() });
    items.push(
      '-',
      { id: 'expand', icon: 'expand-all', tooltip: 'Expand All', shortcut: 'CmdOrCtrl+=', run: () => this.tree.expandAll() },
      { id: 'collapse', icon: 'collapse-all', tooltip: 'Collapse All', shortcut: 'CmdOrCtrl+-', run: () => this.tree.collapseAll() },
      {
        id: 'group',
        icon: 'list-tree',
        tooltip: 'Group By',
        dropdown: () => [{ header: 'Group By' }, { label: 'Directory', checked: this.groupByDir, run: () => this.setGroupByDir(!this.groupByDir) }],
      },
      ...(this.o.extraItems ?? []),
    );
    return items;
  }

  private setGroupByDir(v: boolean): void {
    this.groupByDir = v;
    viewState.set(`${this.o.stateKey}.groupByDir`, v);
    this.render();
  }

  /** Loads the changes of the current source from the host. */
  async load(): Promise<void> {
    const src = this.o.source();
    const seq = ++this.seq;
    if (!src) {
      this.setChanges([]);
      return;
    }
    try {
      const changes = await rpc.call<FileChange[]>('changes.load', src);
      if (seq === this.seq) this.setChanges(changes);
    } catch (e) {
      if (seq !== this.seq) return;
      this.setChanges([]);
      this.o.onError?.(e);
    }
  }

  setChanges(changes: FileChange[]): void {
    this.changes = changes;
    this.render();
    this.o.onChanges?.(changes);
  }

  get count(): number {
    return this.changes.length;
  }

  setEmptyText(text: string): void {
    this.o.emptyText = text;
    this.render();
  }

  private render(): void {
    const nodes = buildPathTree(this.changes, { path: (c) => c.path, groupByDirectory: this.groupByDir, compact: true, idPrefix: 'c:' });
    this.files = pathTreeFiles(nodes).map((n) => n.item);
    const roots = pathTreeToNodes<FileChange, FileChange>(nodes, {
      file: (n) => ({
        className: gitStatusClass(n.item.kind),
        data: n.item,
        tooltip: n.item.oldPath ? `${gitStatusLabel(n.item.kind)}: ${n.item.oldPath} → ${n.item.path}` : `${gitStatusLabel(n.item.kind)}: ${n.item.path}`,
        description: n.item.oldPath && n.item.kind === 'R' ? `${this.groupByDir ? '' : n.dir ? n.dir + '  ' : ''}moved from ${n.item.oldPath}` : this.groupByDir ? undefined : n.dir || undefined,
      }),
    });
    this.treeOptions.emptyText = this.o.emptyText ?? 'No changes';
    this.tree.setRoots(roots);
    this.updateToolbar();
  }

  /** Selected files (directories expand to the files below them). */
  selectedFiles(): FileChange[] {
    const out = new Set<FileChange>();
    const walk = (n: Node) => {
      if (n.data) out.add(n.data);
      for (const c of n.children ?? []) walk(c);
    };
    for (const n of this.tree.getSelection()) walk(n);
    return this.files.filter((f) => out.has(f));
  }

  private updateToolbar(): void {
    const sel = this.selectedFiles().length > 0;
    this.toolbar.update('diff', { disabled: !this.files.length });
    if (!this.o.noGet) this.toolbar.update('get', { disabled: !sel });
  }

  showDiff(node?: Node): void {
    const src = this.o.source();
    if (!src || !this.files.length) return;
    const sel = node?.data ? [node.data] : this.selectedFiles();
    let files = this.files;
    let index = sel.length ? Math.max(0, files.indexOf(sel[0])) : 0;
    if (sel.length > 1) {
      files = sel;
      index = 0;
    }
    rpc.call('changes.diff', { ...src, files, index }).catch((e) => this.o.onError?.(e));
  }

  private compareWithLocal(): void {
    const src = this.o.source();
    const [file] = this.selectedFiles();
    if (src && file) rpc.call('changes.compareWithLocal', { ...src, file }).catch((e) => this.o.onError?.(e));
  }

  async get(): Promise<void> {
    const src = this.o.source();
    const files = this.selectedFiles();
    if (!src || !files.length) return;
    try {
      if (await rpc.call<boolean>('changes.get', { ...src, files })) await this.load();
    } catch (e) {
      this.o.onError?.(e);
    }
  }

  private history(): void {
    const [file] = this.selectedFiles();
    if (file) rpc.call('changes.history', { path: file.path }).catch((e) => this.o.onError?.(e));
  }

  jumpToSource(): void {
    const files = this.selectedFiles();
    if (files.length) rpc.call('changes.jumpToSource', { files }).catch((e) => this.o.onError?.(e));
  }

  private menu(): MenuItem[] {
    const src = this.o.source();
    const files = this.selectedFiles();
    const one = files.length === 1;
    const afterRev = src && (src.swapped ? src.from : src.to);
    const items: MenuItem[] = [
      { label: 'Show Diff', icon: 'diff', shortcut: 'CmdOrCtrl+D', disabled: !files.length, run: () => this.showDiff() },
      { label: 'Compare with Local', disabled: !one || !afterRev, run: () => this.compareWithLocal() },
    ];
    if (!this.o.noGet) items.push({ label: 'Get', icon: 'desktop-download', disabled: !files.length, run: () => this.get() });
    items.push(
      '-',
      { label: 'Show History', icon: 'history', disabled: !one, run: () => this.history() },
      { label: 'Jump to Source', icon: 'go-to-file', shortcut: 'F4', disabled: !files.length || files.every((f) => f.kind === 'D' && !src?.swapped), run: () => this.jumpToSource() },
    );
    return items;
  }

  /** Opens the context menu at the lead row (Shift+F10 is handled by the tree; this is for external triggers). */
  openMenuAtLead(): void {
    const p = contextMenuPoint(this.tree.element);
    showContextMenu(this.menu(), p.x, p.y);
  }

  focus(): void {
    this.tree.focus();
  }
}

/** Styles shared by the compare feature's webviews. */
export const COMPARE_CSS = `
.cmp-app { height: 100%; display: flex; flex-direction: column; min-height: 0; padding: 0; }
.cmp-changes { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; height: 100%; }
.cmp-tree { flex: 1 1 auto; min-height: 0; position: relative; }
.cmp-header { flex: none; display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 10px; white-space: nowrap; overflow: hidden; }
.cmp-header .cmp-title { overflow: hidden; text-overflow: ellipsis; }
.cmp-header b { font-weight: 600; }
.cmp-error { color: var(--jb-error); padding: 6px 10px; white-space: normal; }
.cmp-details { padding: 8px 10px; overflow: auto; user-select: text; min-height: 0; }
.cmp-details .msg { font-family: var(--jb-mono); font-size: var(--jb-mono-size); white-space: pre-wrap; word-break: break-word; margin-bottom: 10px; }
.cmp-details .msg .subject { font-weight: 600; }
.cmp-details .meta { color: var(--jb-fg-muted); line-height: 1.7; }
.cmp-details .meta .jb-link { cursor: pointer; }
.cmp-details .branches { color: var(--jb-fg-muted); margin-top: 6px; white-space: normal; }
.cmp-section-title { flex: none; padding: 5px 10px; color: var(--jb-fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cmp-island { margin: 0; }
`;

let cssInjected = false;
export function injectCompareCss(extra = ''): void {
  if (!cssInjected) {
    cssInjected = true;
    const s = document.createElement('style');
    s.textContent = COMPARE_CSS;
    document.head.appendChild(s);
  }
  if (extra) {
    const s = document.createElement('style');
    s.textContent = extra;
    document.head.appendChild(s);
  }
}
