// "Shelf" view of the Commit tool window: shelved changelists (name, date) with their files; applied ones only with
// "Show Already Unshelved", deleted ones under "Recently Deleted". Toolbar like IntelliJ's ShelvedChangesToolbar
// (Unshelve Silently, Show Diff, View Options, Expand / Collapse All) plus Refresh / Preview Diff; ShelvedChangesPopupMenu.
import type { ShelfFile, ShelfInfo, ShelfViewModel } from '../../features/stash/protocol';
import { rpc, viewState } from '../shared/rpc';
import {
  formatDateTime,
  formatPrettyDateTime,
  h,
  isCtrlCmd,
  setFormatLocale,
  showContextMenu,
  Toolbar,
  Tree,
  type MenuItem,
  type TreeNode,
} from '../shared/ui';
import { fileNodes, filesUnder, injectCss } from '../stash/common';

type Data = { type: 'shelf'; shelf: ShelfInfo } | { type: 'file'; shelf: ShelfInfo; file: ShelfFile } | { type: 'deleted' };
type Node = TreeNode<Data>;

export function startShelfView(): void {
  injectCss();
  let vm: ShelfViewModel = { shelves: [], showApplied: false, groupByDirectory: true, multiRepo: false, locale: navigator.language };
  let preview = viewState.get<boolean>('shelf.preview', false);

  const app = document.getElementById('app')!;
  const toolbarEl = h('div.sv-toolbar');
  const treeEl = h('div.sv-tree');
  app.appendChild(h('div.sv-app', null, toolbarEl, treeEl));

  const toolbar = new Toolbar(toolbarEl, {
    ariaLabel: 'Shelf toolbar',
    items: [
      { id: 'unshelveSilently', icon: 'arrow-circle-up', tooltip: 'Unshelve Silently', shortcut: 'CmdOrCtrl+Alt+U', run: () => call('unshelveSilently') },
      { id: 'diff', icon: 'diff', tooltip: 'Show Diff', shortcut: 'CmdOrCtrl+D', run: () => void showDiff() },
      {
        id: 'options',
        icon: 'eye',
        tooltip: 'View Options',
        dropdown: () => [
          { header: 'Group By' },
          { label: 'Directory', checked: vm.groupByDirectory, run: () => void rpc.call('setGroupByDirectory', !vm.groupByDirectory) },
          '-',
          { header: 'Show' },
          { label: 'Already Unshelved', checked: vm.showApplied, run: () => void rpc.call('toggleShowApplied') },
        ],
      },
      { id: 'expand', icon: 'expand-all', tooltip: 'Expand All', shortcut: 'CmdOrCtrl+=', run: () => tree.expandAll() },
      { id: 'collapse', icon: 'collapse-all', tooltip: 'Collapse All', shortcut: 'CmdOrCtrl+-', run: () => tree.collapseAll(true) },
      '-',
      { id: 'preview', icon: 'open-preview', tooltip: 'Preview Diff', toggled: preview, run: () => togglePreview() },
      { id: 'import', icon: 'cloud-download', tooltip: 'Import Patches…', run: () => void rpc.call('importPatches') },
      { id: 'refresh', icon: 'refresh', tooltip: 'Refresh', run: () => void rpc.call('refresh') },
    ],
  });

  const tree = new Tree<Data>(treeEl, {
    multiSelect: true,
    stateKey: 'shelf.tree',
    defaultExpandDepth: 0,
    ariaLabel: 'Shelves',
    emptyText: ['No shelved changes', [{ text: 'Shelve Changes…', run: () => void rpc.call('shelve') }]],
  });

  function shelfNode(s: ShelfInfo): Node {
    const muted = s.applied || s.deleted;
    return {
      id: `shelf:${s.id}`,
      label: s.name,
      icon: 'archive',
      muted,
      description: vm.multiRepo ? s.repoName : undefined,
      trailing: formatPrettyDateTime(s.date),
      tooltip: `${s.name}\n${formatDateTime(s.date)}${s.branch ? `\nOn ${s.branch}` : ''}${s.baseCommit ? `\nBase: ${s.baseCommit.slice(0, 8)}` : ''}${s.applied ? '\nAlready unshelved' : ''}`,
      expanded: false,
      children: fileNodes<ShelfFile, Data>(s.files, {
        idPrefix: `shelf:${s.id}:`,
        groupByDirectory: vm.groupByDirectory,
        data: (file) => ({ type: 'file', shelf: s, file }),
        extra: () => (muted ? { muted: true } : {}),
      }),
      data: { type: 'shelf', shelf: s },
    };
  }

  function render(): void {
    setFormatLocale(vm.locale);
    const active = vm.shelves.filter((s) => !s.deleted && (vm.showApplied || !s.applied));
    const deleted = vm.shelves.filter((s) => s.deleted);
    const roots = active.map(shelfNode);
    if (deleted.length) {
      roots.push({ id: 'deleted', label: 'Recently Deleted', icon: 'trash', muted: true, expanded: false, children: deleted.map(shelfNode), data: { type: 'deleted' } });
    }
    tree.setRoots(roots);
    updateToolbar();
  }

  const isFile = (d: Data | undefined) => d?.type === 'file';
  const leadShelf = (): ShelfInfo | undefined => {
    const d = tree.getLead()?.data ?? tree.getSelection()[0]?.data;
    return d && d.type !== 'deleted' ? d.shelf : undefined;
  };
  const selectedShelves = (): ShelfInfo[] => {
    const m = new Map<string, ShelfInfo>();
    for (const n of tree.getSelection()) if (n.data && n.data.type !== 'deleted') m.set(n.data.shelf.id, n.data.shelf);
    return [...m.values()];
  };
  /** explicitly selected files (none when only shelf nodes are selected → whole shelves) */
  const selectedPaths = (shelfId: string): string[] | undefined => {
    const sel = tree.getSelection();
    if (sel.some((n) => n.data?.type === 'shelf' && n.data.shelf.id === shelfId)) return undefined;
    const paths = sel
      .flatMap((n) => filesUnder(n, isFile))
      .map((n) => n.data)
      .filter((d): d is Extract<Data, { type: 'file' }> => d?.type === 'file' && d.shelf.id === shelfId)
      .map((d) => d.file.path);
    return paths.length ? [...new Set(paths)] : undefined;
  };

  function call(method: string, extra: Record<string, unknown> = {}): void {
    const list = selectedShelves();
    if (!list.length) return;
    void rpc.call(method, { ids: list.map((s) => s.id), paths: list.length === 1 ? selectedPaths(list[0].id) : undefined, ...extra });
  }

  async function showDiff(opts: { withLocal?: boolean; preview?: boolean } = {}): Promise<void> {
    const s = leadShelf();
    if (!s) return;
    const lead = tree.getLead()?.data;
    if (opts.preview && lead?.type !== 'file') return;
    const index = lead?.type === 'file' ? Math.max(0, s.files.findIndex((f) => f.path === lead.file.path)) : 0;
    const paths = opts.withLocal ? selectedPaths(s.id) : undefined;
    await rpc.call('showDiff', { id: s.id, index: opts.withLocal ? 0 : index, paths, withLocal: opts.withLocal, preview: opts.preview });
  }

  function togglePreview(): void {
    preview = !preview;
    viewState.set('shelf.preview', preview);
    toolbar.update('preview', { toggled: preview });
  }

  function updateToolbar(): void {
    const any = selectedShelves().length > 0;
    toolbar.update('unshelveSilently', { disabled: !selectedShelves().some((s) => !s.applied && !s.deleted) });
    toolbar.update('diff', { disabled: !any });
  }

  function copy(): void {
    const text = tree
      .getSelection()
      .map((n) => (n.data?.type === 'file' ? n.data.file.path : n.label))
      .join('\n');
    if (text) void rpc.call('copy', text);
  }

  function menu(): MenuItem[] {
    const list = selectedShelves();
    const one = list.length === 1;
    const recycled = list.some((s) => s.applied || s.deleted);
    const onFile = tree.getSelection().some((n) => n.data?.type === 'file');
    // order of IntelliJ's ShelvedChangesPopupMenu
    return [
      { label: 'Unshelve…', icon: 'arrow-circle-up', disabled: !one || list[0].deleted, run: () => call('unshelve') },
      { label: 'Restore', disabled: !recycled, run: () => call('restore') },
      { label: 'Show Diff', icon: 'diff', shortcut: 'CmdOrCtrl+D', disabled: !one, run: () => void showDiff() },
      { label: 'Compare with Local', disabled: !one || !onFile, run: () => void showDiff({ withLocal: true }) },
      { label: 'Create Patch…', icon: 'diff', disabled: !one, run: () => call('createPatch', { clipboard: false }) },
      { label: 'Copy as Patch to Clipboard', disabled: !one, run: () => call('createPatch', { clipboard: true }) },
      { label: 'Import Patches…', run: () => void rpc.call('importPatches') },
      '-',
      { label: 'Rename…', disabled: !one || onFile, run: () => call('rename') },
      { label: 'Delete', icon: 'trash', shortcut: 'Delete', disabled: !list.length || onFile, run: () => call('delete') },
      '-',
      { label: 'Copy', icon: 'copy', shortcut: 'CmdOrCtrl+C', disabled: !tree.getSelection().length, run: () => copy() },
    ];
  }

  let previewTimer: number | undefined;
  tree.onDidChangeSelection(() => {
    updateToolbar();
    if (!preview) return;
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => void showDiff({ preview: true }), 250);
  });
  tree.onDidActivate(({ node }) => {
    if (node.data?.type === 'file') void showDiff();
  });
  tree.onContextMenu(({ x, y }) => showContextMenu(menu(), x, y));
  tree.element.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (isCtrlCmd(e) && e.altKey && k === 'u') {
      e.preventDefault();
      call('unshelveSilently');
    } else if (isCtrlCmd(e) && k === 'd') {
      e.preventDefault();
      void showDiff();
    } else if (isCtrlCmd(e) && k === 'c') {
      e.preventDefault();
      copy();
    } else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && !tree.getSelection().some((n) => n.data?.type === 'file')) {
      e.preventDefault();
      call('delete');
    } else if (e.key === 'F2' || (e.shiftKey && e.key === 'F6')) {
      e.preventDefault();
      if (selectedShelves().length === 1) call('rename');
    }
  });

  const apply = (m: ShelfViewModel) => {
    vm = m;
    render();
  };
  rpc.on<ShelfViewModel>('state', apply);
  rpc.call<ShelfViewModel>('state').then(apply);
}
