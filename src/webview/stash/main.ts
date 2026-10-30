// "Stash" view of the Commit tool window: stashes per repository ("stash@{n}: message", branch, date), their files
// (working tree, index and untracked changes) with status colors; toolbar Refresh / Pop / Apply / Unstash… / Drop /
// Clear / Show Diff / Preview Diff / Expand / Collapse; context menus like IntelliJ's Git.Stash.* groups.
import type { StashFile, StashItem, StashRepo, StashViewModel } from '../../features/stash/protocol';
import { rpc } from '../shared/rpc';
import {
  ensureStyles,
  formatDateTime,
  formatPrettyDateTime,
  h,
  isCtrlCmd,
  pluralize,
  setFormatLocale,
  showContextMenu,
  Toolbar,
  Tree,
  type MenuItem,
  type TreeNode,
} from '../shared/ui';
import { fileNodes, filesUnder, injectCss } from './common';

type Data =
  | { type: 'repo'; repo: StashRepo }
  | { type: 'stash'; repo: StashRepo; stash: StashItem }
  | { type: 'file'; repo: StashRepo; stash: StashItem; file: StashFile };
type Node = TreeNode<Data>;

ensureStyles();
injectCss();

let vm: StashViewModel = { repos: [], previewDiff: false, locale: navigator.language };
/** stash commits never change: files are cached by hash */
const filesCache = new Map<string, StashFile[]>();
const loading = new Map<string, Promise<StashFile[]>>();

const app = document.getElementById('app')!;
const toolbarEl = h('div.sv-toolbar');
const treeEl = h('div.sv-tree');
app.appendChild(h('div.sv-app', null, toolbarEl, treeEl));

const toolbar = new Toolbar(toolbarEl, {
  ariaLabel: 'Stash toolbar',
  items: [
    { id: 'refresh', icon: 'refresh', tooltip: 'Refresh Stashes', run: () => void rpc.call('refresh') },
    '-',
    { id: 'pop', icon: 'git-stash-pop', tooltip: 'Pop', run: () => stashOp('pop') },
    { id: 'apply', icon: 'git-stash-apply', tooltip: 'Apply', run: () => stashOp('apply') },
    { id: 'unstashAs', icon: 'git-branch-create', tooltip: 'Unstash…', run: () => stashOp('unstashAs') },
    { id: 'drop', icon: 'trash', tooltip: 'Drop', shortcut: 'Delete', run: () => drop() },
    { id: 'clear', icon: 'clear-all', tooltip: 'Clear', run: () => clear() },
    '-',
    { id: 'diff', icon: 'diff', tooltip: 'Show Diff', shortcut: 'CmdOrCtrl+D', run: () => void showDiff() },
    { id: 'preview', icon: 'open-preview', tooltip: 'Preview Diff', toggled: false, run: () => void rpc.call('togglePreview') },
    '-',
    { id: 'expand', icon: 'expand-all', tooltip: 'Expand All', shortcut: 'CmdOrCtrl+=', run: () => tree.expandAll() },
    { id: 'collapse', icon: 'collapse-all', tooltip: 'Collapse All', shortcut: 'CmdOrCtrl+-', run: () => tree.collapseAll(true) },
  ],
});

const tree = new Tree<Data>(treeEl, {
  multiSelect: true,
  stateKey: 'stash.tree',
  defaultExpandDepth: 1,
  ariaLabel: 'Stashes',
  emptyText: ['No stashes', [{ text: 'Stash Changes…', run: () => void rpc.call('stash') }]],
  loadChildren: async (node) => {
    const d = node.data;
    if (d?.type !== 'stash') return [];
    return stashChildren(d.repo, d.stash, await loadFiles(d.repo.root, d.stash.hash));
  },
});

function loadFiles(root: string, hash: string): Promise<StashFile[]> {
  const cached = filesCache.get(hash);
  if (cached) return Promise.resolve(cached);
  let p = loading.get(hash);
  if (!p) {
    p = rpc.call<StashFile[]>('files', { repoRoot: root, hash }).then((files) => {
      filesCache.set(hash, files);
      loading.delete(hash);
      return files;
    }, (e) => {
      loading.delete(hash);
      throw e;
    });
    loading.set(hash, p);
  }
  return p;
}

const stashId = (root: string, hash: string) => `stash:${root}:${hash}`;

function stashChildren(repo: StashRepo, stash: StashItem, files: StashFile[]): Node[] {
  return fileNodes<StashFile, Data>(files, {
    idPrefix: `${stashId(repo.root, stash.hash)}:`,
    data: (file) => ({ type: 'file', repo, stash, file }),
    extra: (f) => (f.source === 'index' ? { description: 'staged' } : {}),
  });
}

function stashNode(repo: StashRepo, s: StashItem): Node {
  const cached = filesCache.get(s.hash);
  return {
    id: stashId(repo.root, s.hash),
    label: `${s.ref}: ${s.message}`,
    icon: 'git-stash',
    description: s.branch,
    trailing: formatPrettyDateTime(s.date),
    tooltip: `${s.ref}: ${s.message}\n${s.branch ? `On ${s.branch}\n` : ''}${formatDateTime(s.date)}\n${s.hash}`,
    searchText: `${s.ref} ${s.message}`,
    expanded: false,
    ...(cached ? { children: stashChildren(repo, s, cached) } : { hasChildren: true }),
    data: { type: 'stash', repo, stash: s },
  };
}

function render(): void {
  setFormatLocale(vm.locale);
  const repos = vm.repos.filter((r) => r.stashes.length);
  const multi = vm.repos.length > 1;
  const roots: Node[] = multi
    ? repos.map((repo) => ({
        id: `repo:${repo.root}`,
        label: repo.name,
        icon: 'repo',
        description: pluralize(repo.stashes.length, 'stash', 'stashes'),
        tooltip: repo.root,
        expanded: true,
        children: repo.stashes.map((s) => stashNode(repo, s)),
        data: { type: 'repo', repo },
      }))
    : repos.flatMap((repo) => repo.stashes.map((s) => stashNode(repo, s)));
  tree.setRoots(roots);
  toolbar.update('preview', { toggled: vm.previewDiff });
  updateToolbar();
}

// ------------------------------------------------------------------ selection helpers

/** the stash of the lead selection (a stash node or one of its files) */
function leadStash(): { repo: StashRepo; stash: StashItem } | undefined {
  const d = tree.getLead()?.data ?? tree.getSelection()[0]?.data;
  if (!d || d.type === 'repo') return undefined;
  return { repo: d.repo, stash: d.stash };
}

function selectedStashes(): { repo: StashRepo; stash: StashItem }[] {
  const out = new Map<string, { repo: StashRepo; stash: StashItem }>();
  for (const n of tree.getSelection()) {
    const d = n.data;
    if (d && d.type !== 'repo') out.set(d.stash.hash, { repo: d.repo, stash: d.stash });
  }
  return [...out.values()];
}

function selectedRepo(): StashRepo | undefined {
  const d = tree.getLead()?.data ?? tree.getSelection()[0]?.data;
  return d?.repo ?? (vm.repos.filter((r) => r.stashes.length).length === 1 ? vm.repos.find((r) => r.stashes.length) : undefined);
}

const isFile = (d: Data | undefined) => d?.type === 'file';

function selectedFiles(): { repo: StashRepo; stash: StashItem; files: StashFile[] } | undefined {
  const lead = leadStash();
  if (!lead) return undefined;
  const files = tree
    .getSelection()
    .flatMap((n) => filesUnder(n, isFile))
    .map((n) => n.data)
    .filter((d): d is Extract<Data, { type: 'file' }> => d?.type === 'file' && d.stash.hash === lead.stash.hash)
    .map((d) => d.file);
  return { ...lead, files: [...new Map(files.map((f) => [f.path, f])).values()] };
}

function updateToolbar(): void {
  const one = !!leadStash();
  for (const id of ['pop', 'apply', 'unstashAs', 'diff']) toolbar.update(id, { disabled: !one });
  toolbar.update('drop', { disabled: !selectedStashes().length || tree.getSelection().some((n) => n.data?.type === 'file') });
  toolbar.update('clear', { disabled: !selectedRepo() });
}

// ------------------------------------------------------------------ actions

function stashOp(op: 'pop' | 'apply' | 'unstashAs'): void {
  const s = leadStash();
  if (s) void rpc.call(op, { repoRoot: s.repo.root, hash: s.stash.hash });
}

function drop(): void {
  const list = selectedStashes();
  if (!list.length) return;
  const root = list[0].repo.root;
  void rpc.call('drop', { repoRoot: root, hashes: list.filter((s) => s.repo.root === root).map((s) => s.stash.hash) });
}

function clear(): void {
  const r = selectedRepo();
  if (r) void rpc.call('clear', { repoRoot: r.root });
}

/** Show Diff: all files of the stash, starting at the selected one. */
async function showDiff(preview = false): Promise<void> {
  const sel = selectedFiles();
  if (!sel) return;
  const all = await loadFiles(sel.repo.root, sel.stash.hash).catch(() => undefined);
  if (!all) return;
  const lead = tree.getLead()?.data;
  const start = lead?.type === 'file' ? all.findIndex((f) => f.path === lead.file.path) : 0;
  if (preview && lead?.type !== 'file') return;
  await rpc.call('showDiff', { repoRoot: sel.repo.root, hash: sel.stash.hash, files: all, index: Math.max(0, start), preview });
}

function fileAction(action: string): void {
  const sel = selectedFiles();
  if (sel?.files.length) void rpc.call('fileAction', { repoRoot: sel.repo.root, hash: sel.stash.hash, files: sel.files, action });
}

function copy(): void {
  const text = tree
    .getSelection()
    .map((n) => (n.data?.type === 'file' ? n.data.file.path : n.data?.type === 'stash' ? `${n.data.stash.ref}: ${n.data.stash.message}` : n.label))
    .join('\n');
  if (text) void rpc.call('copy', text);
}

function menu(): MenuItem[] {
  const one = !!leadStash();
  const files = tree.getSelection().some((n) => n.data?.type === 'file' || n.data?.type === 'stash');
  const onFile = tree.getSelection().some((n) => n.data?.type === 'file');
  const repo = selectedRepo();
  const multiRepo = vm.repos.length > 1;
  const items: MenuItem[] = [
    { label: 'Pop', icon: 'git-stash-pop', disabled: !one, run: () => stashOp('pop') },
    { label: 'Apply', icon: 'git-stash-apply', disabled: !one, run: () => stashOp('apply') },
    { label: 'Unstash…', icon: 'git-branch-create', disabled: !one, run: () => stashOp('unstashAs') },
    { label: 'Drop', icon: 'trash', shortcut: 'Delete', disabled: !selectedStashes().length || onFile, run: () => drop() },
    { label: multiRepo && repo ? `Clear Stashes in ${repo.name}` : 'Clear', icon: 'clear-all', disabled: !repo, run: () => clear() },
    '-',
    { label: 'Show Diff', icon: 'diff', shortcut: 'CmdOrCtrl+D', disabled: !one, run: () => void showDiff() },
  ];
  if (onFile) {
    items.push(
      { label: 'Compare with Local', disabled: !files, run: () => fileAction('compareLocal') },
      { label: 'Compare Before with Local', disabled: !files, run: () => fileAction('compareBeforeLocal') },
      { label: 'Edit Source', icon: 'go-to-file', shortcut: 'F4', run: () => fileAction('editSource') },
      { label: 'Open Repository Version', run: () => fileAction('openRevision') },
      { label: 'Cherry-Pick Selected Changes', run: () => fileAction('cherryPick') },
    );
  }
  items.push('-', { label: 'Copy', icon: 'copy', shortcut: 'CmdOrCtrl+C', disabled: !tree.getSelection().length, run: () => copy() });
  return items;
}

let previewTimer: number | undefined;
tree.onDidChangeSelection(() => {
  updateToolbar();
  if (!vm.previewDiff) return;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void showDiff(true), 250);
});
tree.onDidActivate(({ node }) => {
  if (node.data?.type === 'file') void showDiff();
});
tree.onContextMenu(({ x, y }) => showContextMenu(menu(), x, y));
tree.element.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (isCtrlCmd(e) && k === 'd') {
    e.preventDefault();
    void showDiff();
  } else if (isCtrlCmd(e) && k === 'c') {
    e.preventDefault();
    copy();
  } else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && !tree.getSelection().some((n) => n.data?.type === 'file')) {
    e.preventDefault();
    drop();
  } else if (e.key === 'F4') {
    e.preventDefault();
    fileAction('editSource');
  }
});

rpc.on<StashViewModel>('state', (m) => {
  vm = m;
  render();
});
rpc.call<StashViewModel>('state').then((m) => {
  vm = m;
  render();
});
