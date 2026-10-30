// The branches pane on the left of the log (IntelliJ BranchesDashboard): thin vertical toolbar, "Branch or tag"
// search, the branches tree; single click navigates the log to the branch head or updates the branch filter
// (Branches Pane Settings), double click / Enter = "Update Branch Filter in Log", context menu = branch actions.
import type { RefOp, RefsInfo } from '../../features/log/protocol';
import { rpc, viewState } from '../shared/rpc';
import {
  confirmDialog,
  DisposableStore,
  h,
  matchText,
  SearchField,
  showContextMenu,
  Toolbar,
  Tree,
  type MenuItem,
  type TreeNode,
} from '../shared/ui';
import { buildBranchTree, leavesOf, type BranchKind, type BranchNodeData, type BranchRef } from './branchtree';

type Node = TreeNode<BranchNodeData>;

export interface BranchesHost {
  refs(): RefsInfo[];
  /** current branch filter */
  branchFilter(): string[] | undefined;
  setBranchFilter(branches: string[] | undefined): void;
  /** navigate the log table to a ref (no focus change) */
  navigate(ref: string, root?: string): void;
  hide(): void;
}

interface PaneSettings {
  singleClick: 'navigate' | 'filter';
  groupByDirectory: boolean;
  groupByRepository: boolean;
  showTags: boolean;
}

const q = (s: string) => `'${s}'`;

async function refOp(op: RefOp, root: string, ref?: string): Promise<void> {
  await rpc.call('refOp', { op, root, ref });
}

/** Runs an op in every repository holding the ref (same-named branches of several repositories are one node). */
async function forEach(refs: readonly BranchRef[], op: RefOp, ref: (r: BranchRef) => string | undefined = (r) => r.item.name): Promise<void> {
  for (const r of refs) await refOp(op, r.root, ref(r));
}

/** IntelliJ branch action list for a ref node (Git.Branch.Backend groups) — also used by the commit menu. */
export function branchActions(kind: BranchKind, name: string, refs: readonly BranchRef[], infos: readonly RefsInfo[]): MenuItem[] {
  const info = infos.find((i) => i.root === refs[0]?.root);
  const cur = info?.current ?? 'HEAD';
  const detached = !info?.current;
  const isCurrent = kind === 'local' && refs.some((r) => r.item.current);
  const qn = q(name);
  const qc = q(cur);
  const run = (op: RefOp) => () => void forEach(refs, op);
  const items: MenuItem[] = [];
  if (kind === 'head') {
    items.push(
      { label: 'New Branch from Current…', run: () => void forEach(refs, 'newBranch', () => 'HEAD') },
      '-',
      { label: 'Update', run: () => void forEach(refs, 'updateProject') },
      { label: 'Push…', run: () => void forEach(refs, 'push') },
    );
    return items;
  }
  if (kind === 'local') {
    if (!isCurrent) items.push({ label: 'Checkout', run: run('checkout') });
    items.push({ label: `New Branch from ${qn}…`, run: run('newBranch') });
    if (!isCurrent) {
      if (!detached) items.push({ label: `Checkout and Rebase onto ${qc}`, run: run('checkoutAndRebase') });
      items.push('-', { label: `Compare with ${qc}`, run: run('compareWithCurrent') }, { label: 'Show Diff with Working Tree', run: run('showDiffWithWorkingTree') }, '-');
      if (!detached) items.push({ label: `Rebase ${qc} onto ${qn}`, run: run('rebase') });
      items.push({ label: `Merge ${qn} into ${qc}`, run: run('merge') });
    } else items.push('-', { label: 'Show Diff with Working Tree', run: run('showDiffWithWorkingTree') });
    items.push('-');
    if (isCurrent || refs.some((r) => r.item.upstream)) items.push({ label: 'Update', run: run('update') });
    items.push({ label: 'Push…', run: () => void forEach(refs, 'push') }, '-', { label: 'Rename…', run: run('rename') });
    if (!isCurrent) items.push({ label: 'Delete', run: run('delete') });
    return items;
  }
  if (kind === 'remote') {
    items.push({ label: 'Checkout', run: run('checkout') }, { label: `New Branch from ${qn}…`, run: run('newBranch') });
    if (!detached) items.push({ label: `Checkout and Rebase onto ${qc}`, run: run('checkoutAndRebase') });
    items.push('-', { label: `Compare with ${qc}`, run: run('compareWithCurrent') }, { label: 'Show Diff with Working Tree', run: run('showDiffWithWorkingTree') }, '-');
    if (!detached) items.push({ label: `Rebase ${qc} onto ${qn}`, run: run('rebase') });
    items.push({ label: `Merge ${qn} into ${qc}`, run: run('merge') }, '-');
    items.push({ label: `Pull into ${qc} Using Rebase`, run: run('pullRebase'), disabled: detached }, { label: `Pull into ${qc} Using Merge`, run: run('pullMerge'), disabled: detached });
    items.push('-', { label: 'Delete', run: run('delete') });
    return items;
  }
  items.push({ label: 'Checkout', run: run('checkout') }, { label: `New Branch from ${qn}…`, run: run('newBranch') }, '-');
  items.push({ label: `Compare with ${qc}`, run: run('compareWithCurrent') }, { label: 'Show Diff with Working Tree', run: run('showDiffWithWorkingTree') }, '-');
  items.push({ label: `Merge ${qn} into ${qc}`, run: run('merge') }, '-', { label: 'Delete', run: run('deleteTag') });
  return items;
}

export class BranchesPanel {
  readonly element: HTMLElement;
  private readonly tree: Tree<BranchNodeData>;
  private readonly toolbar: Toolbar;
  private readonly search: SearchField;
  private readonly store = new DisposableStore();
  private settings: PaneSettings;
  private suppressSelect = 0;

  constructor(private readonly host: BranchesHost) {
    this.settings = { singleClick: 'navigate', groupByDirectory: true, groupByRepository: false, showTags: true, ...viewState.get<Partial<PaneSettings>>('log.branchesPane', {}) };
    this.toolbar = new Toolbar(null, { orientation: 'vertical', items: [], ariaLabel: 'Branches toolbar', className: 'lg-branches-toolbar' });
    this.search = new SearchField(null, { placeholder: 'Branch or tag', ariaLabel: 'Git branches search' });
    this.search.element.classList.add('lg-branches-search');
    this.tree = new Tree<BranchNodeData>(null, {
      multiSelect: true,
      stateKey: 'log.branches',
      defaultExpandDepth: 2,
      activateParents: false,
      speedSearch: true,
      ariaLabel: 'Git branches',
      className: 'lg-branches-tree',
      emptyText: 'Nothing found',
    });
    this.element = h('div.lg-branches', null, this.toolbar.element, h('div.lg-branches-main', null, this.search.element, this.tree.element));
    this.store.add(this.search.onDidChange(() => this.render()));
    this.store.add(this.tree.onDidChangeSelection((nodes) => this.onSelect(nodes)));
    this.store.add(this.tree.onDidActivate(({ node }) => this.filterBySelection(node)));
    this.store.add(this.tree.onContextMenu(({ nodes, x, y }) => this.contextMenu(nodes, x, y)));
    this.search.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.tree.focus();
        const first = leavesOf(this.tree.getRoots())[0];
        if (first) this.tree.select([first.id], { reveal: true });
      }
    });
    this.updateToolbar();
  }

  private save(): void {
    viewState.set('log.branchesPane', this.settings);
  }

  /** Rebuilds the tree from the current refs (keeps expansion/selection by id). */
  render(): void {
    const pattern = this.search.value.trim();
    const infos = this.host.refs();
    const nodes = buildBranchTree(infos, {
      groupByDirectory: this.settings.groupByDirectory,
      groupByRepository: this.settings.groupByRepository && infos.length > 1,
      showTags: this.settings.showTags,
      filter: pattern ? (n) => matchText(pattern, n) !== null : undefined,
    });
    this.suppressSelect++;
    try {
      this.tree.setRoots(nodes);
      if (pattern) this.tree.expandAll();
    } finally {
      this.suppressSelect--;
    }
    this.updateToolbar();
  }

  focusSearch(): void {
    this.search.focus();
  }

  private selectedLeaves(): Node[] {
    return this.tree.getSelection().filter((n) => n.data?.kind);
  }

  private updateToolbar(): void {
    const sel = this.selectedLeaves();
    const one = sel.length === 1 ? sel[0].data! : undefined;
    const infos = this.host.refs();
    const deletable = sel.length > 0 && sel.every((n) => n.data!.kind !== 'head' && !(n.data!.kind === 'local' && n.data!.refs!.some((r) => r.item.current)));
    const updatable = sel.length > 0 && sel.every((n) => n.data!.kind === 'local' && n.data!.refs!.some((r) => r.item.upstream || r.item.current));
    const fav = one && one.kind !== 'head' && one.kind !== 'tag' ? one.refs!.some((r) => r.item.favorite) : false;
    const s = this.settings;
    this.toolbar.setItems([
      { id: 'hide', icon: 'chevron-left', tooltip: 'Hide Git Branches', run: () => this.host.hide() },
      '-',
      { id: 'new', icon: 'add', tooltip: 'New Branch…', disabled: sel.length > 1, run: () => this.newBranch() },
      { id: 'update', icon: 'arrow-circle-down', tooltip: 'Update Selected', disabled: !updatable, run: () => void this.updateSelected() },
      { id: 'delete', icon: 'trash', tooltip: 'Delete', disabled: !deletable, run: () => void this.deleteSelected() },
      { id: 'compare', icon: 'compare-changes', tooltip: 'Compare with Current', disabled: !one || one.kind === 'head' || (one.kind === 'local' && one.refs!.some((r) => r.item.current)), run: () => one && void forEach(one.refs!, 'compareWithCurrent') },
      { id: 'fetch', icon: 'repo-fetch', tooltip: 'Fetch All Remotes', disabled: !infos.length, run: () => void this.fetchAll() },
      { id: 'navigate', icon: 'target', tooltip: 'Navigate Log to Selected Branch Head', disabled: !one, run: () => one && this.host.navigate(one.name!, one.refs![0]?.root) },
      { id: 'favorite', icon: fav ? 'star-full' : 'star-empty', tooltip: 'Mark/Unmark As Favorite', disabled: !one || one.kind === 'head' || one.kind === 'tag', run: () => one && void this.toggleFavorite(one) },
      '-',
      {
        id: 'settings',
        icon: 'settings-gear',
        tooltip: 'Branches Pane Settings',
        dropdown: () => [
          { header: 'On Single Click' },
          { label: 'Update Branch Filter', radio: true, checked: s.singleClick === 'filter', run: () => this.setPane({ singleClick: 'filter' }) },
          { label: 'Navigate Log to Branch Head', radio: true, checked: s.singleClick === 'navigate', run: () => this.setPane({ singleClick: 'navigate' }) },
          '-',
          { label: 'Group by Directory', checked: s.groupByDirectory, run: () => this.setPane({ groupByDirectory: !s.groupByDirectory }) },
          ...(infos.length > 1 ? [{ label: 'Group by Repository', checked: s.groupByRepository, run: () => this.setPane({ groupByRepository: !s.groupByRepository }) }] : []),
          { label: 'Show Tags', checked: s.showTags, run: () => this.setPane({ showTags: !s.showTags }) },
        ],
      },
      { id: 'expand', icon: 'expand-all', tooltip: 'Expand All', shortcut: 'CmdOrCtrl+=', run: () => this.tree.expandAll() },
      { id: 'collapse', icon: 'collapse-all', tooltip: 'Collapse All', shortcut: 'CmdOrCtrl+-', run: () => this.tree.collapseAll(true) },
    ]);
  }

  private setPane(p: Partial<PaneSettings>): void {
    this.settings = { ...this.settings, ...p };
    this.save();
    this.render();
  }

  private onSelect(nodes: Node[]): void {
    this.updateToolbar();
    if (this.suppressSelect) return;
    const leaves = nodes.filter((n) => n.data?.kind);
    if (!leaves.length) return;
    if (this.settings.singleClick === 'filter') this.applyFilter(leaves);
    else {
      const lead = this.tree.getLead();
      const d = (lead?.data?.kind ? lead : leaves[leaves.length - 1]).data!;
      this.host.navigate(d.name!, d.refs![0]?.root);
    }
  }

  private applyFilter(leaves: Node[]): void {
    const names = [...new Set(leaves.map((n) => n.data!.name!))];
    const cur = this.host.branchFilter() ?? [];
    if (names.join('\n') === cur.join('\n')) return;
    this.host.setBranchFilter(names);
  }

  /** Double click / Enter: "Update Branch Filter in Log". */
  private filterBySelection(node: Node): void {
    const sel = this.selectedLeaves();
    this.applyFilter(sel.length ? sel : node.data?.kind ? [node] : []);
  }

  private newBranch(): void {
    const one = this.selectedLeaves()[0]?.data;
    const infos = this.host.refs();
    if (one && one.kind !== 'head') void refOp('newBranch', one.refs![0].root, one.name);
    else if (infos[0]) void refOp('newBranch', infos[0].root, 'HEAD');
  }

  private async updateSelected(): Promise<void> {
    for (const n of this.selectedLeaves()) await forEach(n.data!.refs!, 'update');
  }

  private async deleteSelected(): Promise<void> {
    const sel = this.selectedLeaves().filter((n) => n.data!.kind !== 'head');
    if (sel.length > 1) {
      const ok = await confirmDialog({ title: `Delete ${sel.length} references`, message: `Delete ${sel.map((n) => n.data!.name).join(', ')}?`, ok: 'Delete', danger: true });
      if (!ok) return;
    }
    for (const n of sel) await forEach(n.data!.refs!, n.data!.kind === 'tag' ? 'deleteTag' : 'delete');
  }

  private async fetchAll(): Promise<void> {
    for (const info of this.host.refs()) await refOp('fetch', info.root);
  }

  private async toggleFavorite(d: BranchNodeData): Promise<void> {
    for (const r of d.refs!) await rpc.call('toggleFavorite', { root: r.root, name: d.name });
  }

  private contextMenu(nodes: Node[], x: number, y: number): void {
    const leaves = nodes.filter((n) => n.data?.kind);
    const infos = this.host.refs();
    let items: MenuItem[];
    if (leaves.length === 1) {
      const d = leaves[0].data!;
      items = branchActions(d.kind!, d.name!, d.refs!, infos);
      if (d.kind === 'local' || d.kind === 'remote') items.push('-', { label: 'Mark/Unmark As Favorite', icon: 'star-empty', run: () => void this.toggleFavorite(d) });
      items.unshift({ label: 'Update Branch Filter in Log', shortcut: 'Enter', run: () => this.applyFilter(leaves) }, { label: 'Navigate Log to Selected Branch Head', icon: 'target', run: () => this.host.navigate(d.name!, d.refs![0]?.root) }, '-');
    } else if (leaves.length > 1) {
      const deletable = leaves.every((n) => n.data!.kind !== 'head' && !(n.data!.kind === 'local' && n.data!.refs!.some((r) => r.item.current)));
      items = [
        { label: 'Update Branch Filter in Log', shortcut: 'Enter', run: () => this.applyFilter(leaves) },
        '-',
        { label: 'Update Selected', disabled: !leaves.every((n) => n.data!.kind === 'local'), run: () => void this.updateSelected() },
        { label: 'Delete', disabled: !deletable, run: () => void this.deleteSelected() },
      ];
    } else {
      const remote = nodes.find((n) => n.data?.group === 'remote');
      if (!remote) return;
      items = [{ label: 'Fetch', icon: 'repo-fetch', run: () => void Promise.all((remote.data!.roots ?? []).map((r) => refOp('fetch', r))) }];
    }
    showContextMenu(items, x, y);
  }

  dispose(): void {
    this.store.dispose();
    this.tree.dispose();
    this.toolbar.dispose();
    this.search.dispose();
  }
}
