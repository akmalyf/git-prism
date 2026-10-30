// Changed files of the selected commit(s) (IntelliJ VcsLogChangesBrowser): toolbar, tree grouped by directory
// with compacted folders and "N files" counts, status colors, groups per merge parent ("Changes to <hash>") or
// repository, Show Changes to Parents / Show Only Affected Changes, the file context menu and empty states.
import type { ChangeGroup, ChangesResult, CommitId, CommitOp, ContainingBranches, FileChange, LogState } from '../../features/log/protocol';
import { rpc, viewState } from '../shared/rpc';
import {
  buildPathTree,
  DisposableStore,
  Emitter,
  gitStatusClass,
  h,
  pathTreeToNodes,
  showContextMenu,
  Toolbar,
  Tree,
  type EmptyLine,
  type MenuItem,
  type TreeNode,
  type TreeOptions,
} from '../shared/ui';

export interface FileItem {
  group: ChangeGroup;
  file: FileChange;
}

export interface ChangesHost {
  state(): LogState;
  history: boolean;
  setOption(o: { showChangesToParents?: boolean; showOnlyAffectedChanges?: boolean }): void;
  setSetting(key: 'showDetails' | 'showDiffPreview' | 'diffPreviewLocation', value: unknown): void;
}

export class ChangesPanel {
  readonly element: HTMLElement;
  private readonly tree: Tree<FileItem>;
  private readonly toolbar: Toolbar;
  private readonly store = new DisposableStore();
  private result: ChangesResult | undefined;
  private commits: CommitId[] = [];
  private seq = 0;
  private groupByDir: boolean;
  private loading: Promise<void> | undefined;
  /** "<root>\0<hash>" → the current branch contains the commit (Drop / Extract Selected Changes) */
  private readonly onCurrent = new Map<string, boolean>();
  private readonly treeOpts: TreeOptions<FileItem> = {
    multiSelect: true,
    stateKey: 'log.changes',
    defaultExpandDepth: Infinity,
    speedSearch: true,
    ariaLabel: 'Commit changes browser',
    className: 'lg-changes-tree',
    emptyText: 'Select commit to view changes',
  };
  private readonly fileSelected = new Emitter<FileItem | undefined>();
  readonly onDidSelectFile = this.fileSelected.event;

  constructor(private readonly host: ChangesHost) {
    this.groupByDir = viewState.get('log.changes.groupByDir', true);
    this.toolbar = new Toolbar(null, { items: [], ariaLabel: 'Changes toolbar', className: 'lg-changes-toolbar' });
    this.tree = new Tree<FileItem>(null, this.treeOpts);
    this.element = h('div.lg-changes', null, this.toolbar.element, this.tree.element);
    this.tree.setRoots([]);
    this.store.add(this.tree.onDidActivate(({ node }) => node.data && this.diff(node.data, 'commit')));
    this.store.add(this.tree.onDidChangeSelection(() => {
      this.updateToolbar();
      this.fileSelected.fire(this.lead());
    }));
    this.store.add(this.tree.onContextMenu(({ x, y }) => this.contextMenu(x, y)));
    this.tree.element.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        const l = this.lead();
        if (l) this.diff(l, 'commit');
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'F4') {
        const l = this.lead();
        if (l && l.file.kind !== 'D') void rpc.call('openFile', { root: l.group.root, path: l.file.path });
        e.preventDefault();
      }
    });
    this.updateToolbar();
  }

  // ---------------------------------------------------------------- data

  /** Loads the changes of the selected commits (empty = nothing selected). */
  load(commits: CommitId[]): Promise<void> {
    this.commits = commits;
    const seq = ++this.seq;
    if (!commits.length) {
      this.result = undefined;
      this.setEmpty('Select commit to view changes');
      this.tree.setRoots([]);
      this.updateToolbar();
      this.fileSelected.fire(undefined);
      return (this.loading = Promise.resolve());
    }
    this.setEmpty('Loading…');
    if (commits.length === 1) this.loadOnCurrent(commits[0]);
    const p = rpc
      .call<ChangesResult>('changes', { commits })
      .then((res) => {
        if (seq !== this.seq) return;
        this.result = res;
        this.render();
      })
      .catch((e) => {
        if (seq !== this.seq) return;
        this.result = undefined;
        this.tree.setRoots([]);
        this.setEmpty(['Error loading changes', String(e instanceof Error ? e.message : e)]);
        this.updateToolbar();
      });
    this.loading = p;
    return p;
  }

  private loadOnCurrent(c: CommitId): void {
    const key = `${c.root}\0${c.hash}`;
    if (this.onCurrent.has(key)) return;
    void rpc
      .call<ContainingBranches>('containingBranches', { root: c.root, hash: c.hash })
      .then((r) => this.onCurrent.set(key, !!r?.current))
      .catch(() => undefined);
  }

  /**
   * The commit whose changes Drop / Extract Selected Changes edit: a single non-merge commit of the current branch
   * (HEAD itself, or any commit when detached: the host re-checks); undefined when the actions are unavailable.
   */
  private editableCommit(items: FileItem[]): CommitId | undefined {
    const res = this.result;
    if (this.commits.length !== 1 || !res || res.merge || res.groups.length !== 1 || !items.length) return undefined;
    const c = this.commits[0];
    const group = res.groups[0];
    if (group.to !== c.hash || items.some((i) => i.group !== group)) return undefined;
    const root = this.host.state()?.roots.find((r) => r.root === c.root);
    if (!root || root.empty || root.operation !== 'none') return undefined;
    const current = this.onCurrent.get(`${c.root}\0${c.hash}`) || root.head === c.hash || root.detached;
    return current ? c : undefined;
  }

  private selectedChangesOp(op: 'dropSelectedChanges' | 'extractSelectedChanges', items: FileItem[]): void {
    const c = this.editableCommit(items);
    const g = this.sameGroup(items);
    if (!c || !g) return;
    // the host's commitOp request forwards hashes only: jbGit.commit.<op> takes [commit, ...paths]
    void rpc.call('commitOp', { op: op as string as CommitOp, commits: [c, ...g.paths.map((p) => ({ root: c.root, hash: p }))] });
  }

  /** Waits for the pending load. */
  ready(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  reload(): void {
    this.onCurrent.clear();
    void this.load(this.commits);
  }

  private setEmpty(t: EmptyLine[] | string): void {
    this.treeOpts.emptyText = t;
    this.tree.setRoots(this.tree.getRoots());
  }

  private render(): void {
    const res = this.result;
    if (!res) return;
    const items: FileItem[] = res.groups.flatMap((group) => group.files.map((file) => ({ group, file })));
    const roots = new Set(res.groups.map((g) => g.root));
    const grouped = res.groups.length > 1;
    const state = this.host.state();
    const nodes = buildPathTree(items, {
      path: (i) => i.file.path,
      groupByDirectory: this.groupByDir,
      compact: true,
      groups: grouped ? [{ key: (i) => String(res.groups.indexOf(i.group)), label: (k) => this.groupLabel(res.groups[Number(k)], roots.size > 1, state), compare: (a, b) => Number(a) - Number(b) }] : [],
      idPrefix: 'c:',
    });
    const tree = pathTreeToNodes<FileItem, FileItem>(nodes, {
      file: (n) => ({
        className: gitStatusClass(n.item.file.kind),
        data: n.item,
        description: n.item.file.oldPath && n.item.file.oldPath !== n.item.file.path ? `${n.item.file.kind === 'C' ? 'copied' : 'moved'} from ${n.item.file.oldPath}` : this.groupByDir ? undefined : n.dir || undefined,
        tooltip: n.item.file.oldPath ? `${n.item.file.oldPath} → ${n.item.file.path}` : n.item.file.path,
      }),
      group: (g) => ({ icon: roots.size > 1 && !res.groups[Number(g.key)].title ? 'repo' : 'git-commit' }),
    });
    this.tree.setRoots(tree as TreeNode<FileItem>[]);
    if (!items.length) {
      if (res.affectedOnly && this.host.history) {
        this.setEmpty(['No changes that affect selected paths.', [{ text: 'Show changes for all paths', run: () => this.host.setOption({ showOnlyAffectedChanges: false }) }]]);
      } else if (res.merge) {
        this.setEmpty(['No merged conflicts.', [{ text: 'Show changes to parents', run: () => this.host.setOption({ showChangesToParents: true }) }]]);
      } else this.setEmpty('No changes');
    }
    this.updateToolbar();
    if (!this.tree.getSelection().length) this.fileSelected.fire(this.firstFile());
    else this.fileSelected.fire(this.lead());
  }

  private groupLabel(g: ChangeGroup, multiRoot: boolean, state: LogState): string {
    const repo = state.roots.find((r) => r.root === g.root)?.name ?? g.root;
    if (g.title) return multiRoot ? `${repo}: ${g.title}` : g.title;
    return repo;
  }

  /** All files in tree order (diff navigation). */
  files(): FileItem[] {
    return this.result?.groups.flatMap((group) => group.files.map((file) => ({ group, file }))) ?? [];
  }

  firstFile(): FileItem | undefined {
    const walk = (ns: readonly TreeNode<FileItem>[]): FileItem | undefined => {
      for (const n of ns) {
        if (n.data) return n.data;
        if (n.children) {
          const r = walk(n.children);
          if (r) return r;
        }
      }
      return undefined;
    };
    return walk(this.tree.getRoots());
  }

  lead(): FileItem | undefined {
    const l = this.tree.getLead();
    if (l?.data && this.tree.getSelection().includes(l)) return l.data;
    return this.tree.getSelection().find((n) => n.data)?.data;
  }

  /** Selected files (of all groups) or every file under selected folders. */
  selected(): FileItem[] {
    const out = new Set<FileItem>();
    const add = (n: TreeNode<FileItem>) => {
      if (n.data) out.add(n.data);
      n.children?.forEach(add);
    };
    this.tree.getSelection().forEach(add);
    return [...out];
  }

  // ---------------------------------------------------------------- actions

  diff(item: FileItem, mode: 'commit' | 'local' | 'beforeLocal'): void {
    void rpc.call('showDiff', { group: item.group, path: item.file.path, mode });
  }

  /** Show Diff for the selected commit(s) from the table: the selected file, or the first one. */
  async showDiffForCommit(): Promise<void> {
    await this.ready();
    const item = this.lead() ?? this.firstFile();
    if (item) this.diff(item, 'commit');
  }

  private sameGroup(items: FileItem[]): { group: ChangeGroup; paths: string[] } | undefined {
    if (!items.length) return undefined;
    const group = items[0].group;
    const list = items.filter((i) => i.group === group);
    const paths = [...new Set(list.flatMap((i) => (i.file.oldPath && i.file.oldPath !== i.file.path ? [i.file.path, i.file.oldPath] : [i.file.path])))];
    return { group, paths };
  }

  private revert(items: FileItem[]): void {
    const g = this.sameGroup(items);
    if (g) void rpc.call('revertSelectedChanges', { root: g.group.root, paths: g.paths, rev: g.group.to, from: g.group.from });
  }

  private cherryPick(items: FileItem[]): void {
    const g = this.sameGroup(items);
    if (g) void rpc.call('cherryPickSelectedChanges', { root: g.group.root, paths: g.paths, rev: g.group.to, from: g.group.from });
  }

  private get(items: FileItem[]): void {
    const g = this.sameGroup(items);
    if (g) void rpc.call('getFromRevision', { root: g.group.root, paths: g.paths, rev: g.group.to });
  }

  /** Vcs.ShowHistoryForRevision ("History Up to Here"): the file's history up to this commit, in a new tab. */
  private history(item: FileItem): void {
    void rpc.call('historyUpTo', { root: item.group.root, path: item.file.kind === 'D' ? (item.file.oldPath ?? item.file.path) : item.file.path, revision: item.group.to });
  }

  private atRevision(item: FileItem): { root: string; path: string; rev: string } {
    const deleted = item.file.kind === 'D';
    return { root: item.group.root, path: deleted ? (item.file.oldPath ?? item.file.path) : item.file.path, rev: deleted ? item.group.from : item.group.to };
  }

  private updateToolbar(): void {
    const sel = this.selected();
    const lead = this.lead();
    const res = this.result;
    const s = this.host.state()?.settings;
    const opts = this.host.state()?.options;
    const viewItems = (): MenuItem[] => {
      const items: MenuItem[] = [
        { header: 'Group By' },
        { label: 'Directory', checked: this.groupByDir, run: () => this.setGroupByDir(!this.groupByDir) },
      ];
      if (this.host.history) items.push('-', { label: 'Show Only Affected Changes', checked: !!opts?.showOnlyAffectedChanges, run: () => this.host.setOption({ showOnlyAffectedChanges: !opts?.showOnlyAffectedChanges }) });
      items.push('-', { label: 'Show Changes to Parents', checked: !!opts?.showChangesToParents, disabled: !res?.merge && !opts?.showChangesToParents, run: () => this.host.setOption({ showChangesToParents: !opts?.showChangesToParents }) });
      items.push(
        { header: 'Layout' },
        { label: 'Show Details', checked: !!s?.showDetails, run: () => this.host.setSetting('showDetails', !s?.showDetails) },
        { label: 'Show Diff Preview', checked: !!s?.showDiffPreview, run: () => this.host.setSetting('showDiffPreview', !s?.showDiffPreview) },
        {
          label: 'Diff Preview Location',
          disabled: !s?.showDiffPreview,
          submenu: [
            { label: 'Bottom', radio: true, checked: s?.diffPreviewLocation === 'bottom', run: () => this.host.setSetting('diffPreviewLocation', 'bottom') },
            { label: 'Right', radio: true, checked: s?.diffPreviewLocation === 'right', run: () => this.host.setSetting('diffPreviewLocation', 'right') },
          ],
        },
      );
      return items;
    };
    this.toolbar.setItems([
      { id: 'diff', icon: 'diff', tooltip: 'Show Diff', shortcut: 'CmdOrCtrl+D', disabled: !lead, run: () => lead && this.diff(lead, 'commit') },
      { id: 'local', icon: 'compare-changes', tooltip: 'Compare with Local', disabled: !lead || lead.file.kind === 'D', run: () => lead && this.diff(lead, 'local') },
      { id: 'revert', icon: 'discard', tooltip: 'Revert Selected Changes', disabled: !sel.length, run: () => this.revert(sel) },
      { id: 'cherry', icon: 'git-stash-apply', tooltip: 'Cherry-Pick Selected Changes', disabled: !sel.length, run: () => this.cherryPick(sel) },
      { id: 'history', icon: 'history', tooltip: 'History Up to Here', disabled: !lead || sel.length > 1, run: () => lead && this.history(lead) },
      '-',
      { id: 'view', icon: 'eye', tooltip: 'View Options', dropdown: viewItems },
      { type: 'spacer' },
      { id: 'expand', icon: 'expand-all', tooltip: 'Expand All', shortcut: 'CmdOrCtrl+=', run: () => this.tree.expandAll() },
      { id: 'collapse', icon: 'collapse-all', tooltip: 'Collapse All', shortcut: 'CmdOrCtrl+-', run: () => this.tree.collapseAll() },
    ]);
  }

  /** Re-renders option dependent parts (state/options changed). */
  refreshToolbar(): void {
    this.updateToolbar();
  }

  private setGroupByDir(v: boolean): void {
    this.groupByDir = v;
    viewState.set('log.changes.groupByDir', v);
    this.render();
  }

  private contextMenu(x: number, y: number): void {
    const sel = this.selected();
    const lead = this.lead() ?? sel[0];
    if (!lead) return;
    const one = sel.length <= 1;
    const del = lead.file.kind === 'D';
    const added = lead.file.kind === 'A';
    const opts = this.host.state().options;
    const abs = (i: FileItem) => `${i.group.root.replace(/\\/g, '/')}/${i.file.path}`;
    const editable = !!this.editableCommit(sel);
    // IntelliJ disables both when every change of the commit is selected ("Unable to drop all changes from the commit")
    const all = editable && sel.length >= (this.result?.groups[0]?.files.length ?? 0);
    const items: MenuItem[] = [
      { label: 'Show Diff', icon: 'diff', shortcut: 'CmdOrCtrl+D', run: () => this.diff(lead, 'commit') },
      { label: 'Compare with Local', disabled: !one || del, run: () => this.diff(lead, 'local') },
      { label: 'Compare Before with Local', disabled: !one || added, run: () => this.diff(lead, 'beforeLocal') },
      '-',
      { label: 'Jump to Source', icon: 'go-to-file', shortcut: 'F4', disabled: del, run: () => void rpc.call('openFile', { root: lead.group.root, path: lead.file.path }) },
      { label: 'Show File at Revision', disabled: !one, run: () => void rpc.call('openFileAtRevision', this.atRevision(lead)) },
      '-',
      { label: 'Revert Selected Changes', icon: 'discard', run: () => this.revert(sel) },
      { label: 'Cherry-Pick Selected Changes', icon: 'git-stash-apply', run: () => this.cherryPick(sel) },
      { label: 'Drop Selected Changes', disabled: !editable || all, run: () => this.selectedChangesOp('dropSelectedChanges', sel) },
      { label: 'Extract Selected Changes to Separate Commit…', disabled: !editable || all, run: () => this.selectedChangesOp('extractSelectedChanges', sel) },
      { label: 'Get', run: () => this.get(sel) },
      { label: 'History Up to Here', icon: 'history', disabled: !one, run: () => this.history(lead) },
      '-',
      { label: 'Annotate', disabled: !one || del, run: () => void rpc.call('annotate', { root: lead.group.root, path: lead.file.path, rev: lead.group.to }) },
      '-',
      {
        label: 'Copy Path/Reference…',
        submenu: [
          { label: 'Absolute Path', run: () => void rpc.call('copy', { text: sel.map(abs).join('\n') }) },
          { label: 'Path From Repository Root', run: () => void rpc.call('copy', { text: sel.map((i) => i.file.path).join('\n') }) },
          { label: 'File Name', run: () => void rpc.call('copy', { text: sel.map((i) => i.file.path.slice(i.file.path.lastIndexOf('/') + 1)).join('\n') }) },
        ],
      },
    ];
    if (this.result?.merge || opts.showChangesToParents) items.push('-', { label: 'Show Changes to Parents', checked: opts.showChangesToParents, run: () => this.host.setOption({ showChangesToParents: !opts.showChangesToParents }) });
    showContextMenu(items, x, y, { section: 'files' });
  }

  focus(): void {
    this.tree.focus();
  }

  dispose(): void {
    this.store.dispose();
    this.tree.dispose();
    this.toolbar.dispose();
  }
}
