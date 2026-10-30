// "Show Repository at Revision" webview: the file tree of one commit (one `git ls-tree -r` listing, folders expanded
// lazily from an in-memory index), a search field filtering all files of the revision, files opened read-only at
// that revision; context menu Show File at Revision / Compare with Local / Show History / Copy Path.
import { buildDirIndex, type DirEntry } from '../../features/compare/parse';
import type { RepoAtRevisionInit, RepoEntryView } from '../../features/compare/protocol';
import { init, rpc } from '../shared/rpc';
import {
  buildPathTree,
  ensureStyles,
  fileIconName,
  formatDateTime,
  h,
  matchText,
  pathTreeToNodes,
  pluralize,
  SearchField,
  showContextMenu,
  Toolbar,
  Tree,
  type MenuItem,
  type TreeNode,
} from '../shared/ui';
import { injectCompareCss } from '../changes/view';

ensureStyles();
injectCompareCss(`
.ra-pane { display: flex; flex-direction: column; min-height: 0; flex: 1 1 auto; }
.ra-tree { flex: 1 1 auto; min-height: 0; position: relative; }
.ra-bar { flex: none; display: flex; align-items: center; gap: 6px; padding: 0 4px 0 10px; min-height: 30px; }
.ra-bar .info { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ra-search { flex: none; padding: 4px 6px; display: flex; align-items: center; gap: 8px; }
.ra-search > :first-child { flex: 1 1 auto; min-width: 0; }
.ra-search .jb-muted { white-space: nowrap; }
`);

const MAX_RESULTS = 5000;
const data = init<RepoAtRevisionInit>();
type Node = TreeNode<DirEntry>;

const app = document.getElementById('app')!;
const errorEl = h('div.cmp-error.jb-hidden');
const info = h(
  'span.info',
  { title: `${data.rev}\n${data.subject}\n${data.author}, ${formatDateTime(data.date)}` },
  h('b', null, data.short),
  ' ',
  data.subject,
  h('span.jb-muted', null, `  ${data.author}, ${formatDateTime(data.date)}`),
);
const toolbar = new Toolbar(null, {
  items: [
    { id: 'expand', icon: 'expand-all', tooltip: 'Expand All', shortcut: 'CmdOrCtrl+=', run: () => tree.expandAll() },
    { id: 'collapse', icon: 'collapse-all', tooltip: 'Collapse All', shortcut: 'CmdOrCtrl+-', run: () => tree.collapseAll() },
    '-',
    { id: 'log', icon: 'git-commit', tooltip: 'Show in Git Log', run: () => call('showInLog', {}) },
    { id: 'copy', icon: 'copy', tooltip: 'Copy Revision Number', run: () => call('copy', { text: data.rev }) },
  ],
});
const search = new SearchField(null, { placeholder: 'Search files', debounce: 150, ariaLabel: 'Search files' });
const resultInfo = h('span.jb-muted');
const treeHost = h('div.ra-tree');
app.appendChild(
  h(
    'div.cmp-app',
    null,
    h('div.ra-bar', null, info, h('span.jb-fill'), toolbar.element),
    errorEl,
    h('div.ra-pane.jb-island', null, h('div.ra-search', null, search.element, resultInfo), treeHost),
  ),
);

function showError(e: unknown): void {
  errorEl.textContent = e instanceof Error ? e.message : String(e);
  errorEl.classList.remove('jb-hidden');
}

function call(method: string, params: unknown): void {
  rpc.call(method, params).catch(showError);
}

let index = new Map<string, DirEntry[]>();
let files: DirEntry[] = [];

function toNode(e: DirEntry): Node {
  if (e.type === 'tree') return { id: `d:${e.path}`, label: e.name, icon: 'folder', hasChildren: true, tooltip: e.path, data: e };
  if (e.type === 'commit') return { id: `s:${e.path}`, label: e.name, icon: 'file-submodule', description: 'submodule', tooltip: e.path, data: e };
  const spec = fileIconName(e.path);
  return { id: `f:${e.path}`, label: e.name, icon: spec.name, iconColor: spec.color, tooltip: e.path, data: e };
}

const treeOptions = {
  multiSelect: true,
  stateKey: `repo.${data.rev}`,
  defaultExpandDepth: 0,
  emptyText: 'Loading…',
  ariaLabel: `Repository at ${data.short}`,
  loadChildren: async (node: Node) => (index.get(node.data?.path ?? '') ?? []).map(toNode),
};
const tree = new Tree<DirEntry>(treeHost, treeOptions);

/** All files under the selected nodes (folders expand to their files when `deep`). */
function selectedFiles(deep = false): DirEntry[] {
  const out: DirEntry[] = [];
  const walk = (e: DirEntry) => {
    if (e.type === 'blob') out.push(e);
    else if (e.type === 'tree' && deep) for (const c of index.get(e.path) ?? []) walk(c);
  };
  for (const n of tree.getSelection()) if (n.data) walk(n.data);
  return [...new Set(out)];
}

function open(entries: DirEntry[]): void {
  if (entries.length) call('open', { paths: entries.map((e) => e.path) });
}

tree.onDidActivate(({ node }) => {
  if (node.data?.type === 'blob') open([node.data]);
});
tree.onContextMenu(({ nodes, x, y }) => {
  const blobs = selectedFiles();
  const one = nodes.length === 1 ? nodes[0].data : undefined;
  const items: MenuItem[] = [
    { label: 'Show File at Revision', icon: 'go-to-file', shortcut: 'F4', disabled: !blobs.length, run: () => open(blobs) },
    { label: 'Compare with Local', icon: 'compare-changes', disabled: !one || one.type !== 'blob', run: () => one && call('compareWithLocal', { path: one.path }) },
    '-',
    { label: 'Show History', icon: 'history', disabled: !one, run: () => one && call('history', { path: one.path }) },
    { label: 'Copy Path', icon: 'copy', disabled: !nodes.length, run: () => call('copy', { text: nodes.map((n) => n.data?.path ?? '').join('\n') }) },
  ];
  showContextMenu(items, x, y);
});
tree.element.addEventListener('keydown', (e) => {
  if (e.key === 'F4') {
    e.preventDefault();
    open(selectedFiles());
  } else if (e.key === 'ArrowDown' && !tree.getSelection().length) {
    e.preventDefault();
    const first = tree.visibleNodes()[0];
    if (first) tree.select([first.id], { reveal: true });
  }
});
search.input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault();
    const first = tree.visibleNodes().find((n) => n.data?.type === 'blob') ?? tree.visibleNodes()[0];
    if (first) tree.select([first.id], { reveal: true, focus: true });
  }
});

function showAll(): void {
  resultInfo.textContent = pluralize(files.length, 'file');
  treeOptions.emptyText = 'Empty tree';
  tree.setRoots((index.get('') ?? []).map(toNode));
}

/** Files whose path matches the search text, grouped by directory and expanded. */
function showMatches(text: string): void {
  const hits: DirEntry[] = [];
  let total = 0;
  for (const f of files) {
    if (!matchText(text, f.path)) continue;
    total++;
    if (hits.length < MAX_RESULTS) hits.push(f);
  }
  resultInfo.textContent = total > hits.length ? `${hits.length} of ${pluralize(total, 'file')}` : pluralize(total, 'file');
  const nodes = buildPathTree(hits, { path: (f) => f.path, groupByDirectory: true, compact: true, idPrefix: 'm:' });
  treeOptions.emptyText = `No files matching '${text}'`;
  tree.setRoots(
    pathTreeToNodes<DirEntry, DirEntry>(nodes, {
      file: (n) => ({ ...toNode(n.item), id: n.id }),
      dir: () => ({ expanded: true }),
    }),
  );
}

search.onDidChange(({ value }) => {
  const text = value.trim();
  if (text) showMatches(text);
  else showAll();
});

rpc
  .call<RepoEntryView[]>('list')
  .then((entries) => {
    files = entries.filter((e) => e.type !== 'tree').map((e) => ({ type: e.type, path: e.path, name: e.name }));
    index = buildDirIndex(files as { type: 'blob' | 'commit'; path: string }[]);
    showAll();
    tree.focus();
  })
  .catch((e) => {
    treeOptions.emptyText = 'Cannot load the repository tree';
    tree.setRoots([]);
    showError(e);
  });
