// "Conflicts" dialog (IntelliJ MultipleFileMergeDialog): description, Name | Yours | Theirs tree-table of unmerged
// files (optionally grouped by directory / repository), Accept Yours / Accept Theirs / Merge… on the right, Close.
import { init, rpc, viewState } from '../shared/rpc';
import {
  button,
  buildPathTree,
  checkbox,
  dialogLayout,
  ensureStyles,
  h,
  highlightText,
  icon,
  pathTreeToNodes,
  setFormatLocale,
  showContextMenu,
  Tree,
  type TreeNode,
} from '../shared/ui';
import type { AcceptParams, ConflictFileInfo, ConflictsInit, ConflictsState } from '../../features/conflicts/protocol';

const data = init<ConflictsInit>();
if (data.locale) setFormatLocale(data.locale);
ensureStyles();

const style = document.createElement('style');
style.textContent = `
html, body, #app { height: 100%; margin: 0; }
.cf-body { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; box-sizing: border-box; }
.cf-desc { color: var(--jb-fg); user-select: text; -webkit-user-select: text; line-height: 1.5; }
.cf-desc b { font-weight: 600; }
.cf-desc code, .cf-msg { font-family: var(--jb-mono); font-size: var(--jb-mono-size); }
.cf-msg { margin: 2px 0 0; white-space: pre-wrap; color: var(--jb-fg); user-select: text; -webkit-user-select: text; }
.cf-main { display: flex; gap: 10px; flex: 1 1 auto; min-height: 0; }
.cf-left { display: flex; flex-direction: column; gap: 6px; flex: 1 1 auto; min-width: 0; min-height: 0; }
.cf-table { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 120px; border: 1px solid var(--jb-border);
  border-radius: var(--jb-radius); overflow: hidden; background: var(--jb-island-bg, var(--jb-bg)); }
.cf-header { display: flex; align-items: center; height: var(--jb-row); flex: none; padding: 0 8px 0 10px;
  border-bottom: 1px solid var(--jb-border); color: var(--jb-fg-muted); white-space: nowrap; }
.cf-header .cf-hname { flex: 1 1 auto; min-width: 0; }
.cf-col { width: var(--cf-col); flex: none; overflow: hidden; text-overflow: ellipsis; padding-left: 8px; box-sizing: border-box; }
.cf-tree { flex: 1 1 auto; min-height: 0; }
.cf-tree .jb-tree-row { padding-right: calc(var(--cf-col) * 2 + 8px); }
.cf-cells { position: absolute; top: 0; right: 8px; height: 100%; display: flex; align-items: center; pointer-events: none; }
.cf-cells .cf-col { color: var(--jb-fg); }
.cf-cells .cf-deleted { color: var(--jb-fg-muted); }
.jb-tree-row.jb-selected .cf-cells .cf-col { color: var(--jb-sel-inactive-fg); }
.jb-tree:focus-within .jb-tree-row.jb-selected .cf-cells .cf-col { color: var(--jb-sel-fg); }
.cf-buttons { display: flex; flex-direction: column; gap: 6px; flex: none; width: 140px; }
.cf-buttons .jb-btn { width: 100%; justify-content: center; }
.cf-done { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  border: 1px solid var(--jb-border); border-radius: var(--jb-radius); color: var(--jb-fg); text-align: center; padding: 16px; }
.cf-done .codicon { font-size: 28px !important; color: var(--jb-git-added, var(--vscode-testing-iconPassed)); }
:root { --cf-col: 130px; }
`;
document.head.appendChild(style);

type Data = { kind: 'file'; file: ConflictFileInfo } | { kind: 'dir' };

let state: ConflictsState | undefined;
let groupByDir = viewState.get<boolean>('groupByDir', true);
let busy = false;

const desc = h('div.cf-desc');
const msg = h('pre.cf-msg');
const hYours = h('span.cf-col', null, 'Yours');
const hTheirs = h('span.cf-col', null, 'Theirs');
const header = h('div.cf-header', null, h('span.cf-hname', null, 'Name'), hYours, hTheirs);
const treeHost = h('div.cf-tree');
const table = h('div.cf-table', null, header, treeHost);
const doneEl = h('div.cf-done');
const group = checkbox({
  label: 'Group by directory',
  checked: groupByDir,
  onChange: (v) => {
    groupByDir = v;
    viewState.set('groupByDir', v);
    renderTree();
  },
});
const left = h('div.cf-left', null, table, doneEl, group.element);

const btnYours = button({ label: 'Accept Yours', onClick: () => accept('yours') });
const btnTheirs = button({ label: 'Accept Theirs', onClick: () => accept('theirs') });
const btnMerge = button({ label: 'Merge…', primary: true, onClick: () => merge() });
const buttons = h('div.cf-buttons', null, btnYours, btnTheirs, btnMerge);

const body = h('div.cf-body', null, desc, msg, h('div.cf-main', null, left, buttons));

const dlg = dialogLayout(document.getElementById('app')!, {
  title: 'Conflicts',
  body,
  buttons: [{ id: 'close', label: 'Close', cancel: true, run: () => void rpc.call('close') }],
});
dlg.body.style.display = 'flex';
dlg.body.style.flexDirection = 'column';
dlg.body.style.minHeight = '0';

const tree = new Tree<Data>(treeHost, {
  multiSelect: true,
  defaultExpandDepth: Infinity,
  stateKey: 'conflicts.tree',
  ariaLabel: 'Conflicts',
  emptyText: ['Loading merge conflicts…'],
  renderLabel: (el, node, ctx) => {
    el.append(highlightText(node.label, ctx.matches));
    const d = node.data;
    if (d?.kind !== 'file') return;
    // absolutely positioned against the row (the label is not positioned, so its overflow clipping doesn't apply)
    el.append(
      h('span.cf-cells', null,
        h('span.cf-col', { class: { 'cf-deleted': d.file.yours === 'Deleted' } }, d.file.yours),
        h('span.cf-col', { class: { 'cf-deleted': d.file.theirs === 'Deleted' } }, d.file.theirs),
      ),
    );
  },
});

tree.onDidChangeSelection(() => updateButtons());
tree.onDidActivate(({ node }) => {
  if (node.data?.kind === 'file') merge();
});
tree.onContextMenu(({ x, y }) => {
  const files = selectedFiles();
  if (!files.length || busy) return;
  showContextMenu(
    [
      { label: 'Accept Yours', run: () => accept('yours') },
      { label: 'Accept Theirs', run: () => accept('theirs') },
      { label: 'Merge…', run: () => merge() },
      '-',
      { label: 'Open in Editor', icon: 'go-to-file', disabled: files.length !== 1, run: () => void rpc.call('open', files[0]) },
    ],
    x,
    y,
  );
});

function filesUnder(node: TreeNode<Data>, out: ConflictFileInfo[]): void {
  if (node.data?.kind === 'file') out.push(node.data.file);
  for (const c of node.children ?? []) filesUnder(c, out);
}

/** Selected files, including the files under selected directories / repositories. */
function selectedFiles(): ConflictFileInfo[] {
  const out: ConflictFileInfo[] = [];
  for (const n of tree.getSelection()) filesUnder(n, out);
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.repoRoot}\0${f.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function updateButtons(): void {
  const has = !busy && !!state?.files.length && selectedFiles().length > 0;
  for (const b of [btnYours, btnTheirs, btnMerge]) b.disabled = !has;
}

function renderTree(): void {
  const files = state?.files ?? [];
  const multi = (state?.repos.length ?? 0) > 1;
  const repoName = new Map(state?.repos.map((r) => [r.root, r.name]));
  const nodes = buildPathTree(files, {
    path: (f) => f.path,
    groupByDirectory: groupByDir,
    compact: true,
    groups: multi ? [{ key: (f) => f.repoRoot, label: (k) => repoName.get(k) ?? k }] : undefined,
    idPrefix: 'cf:',
  });
  const roots = pathTreeToNodes<ConflictFileInfo, Data>(nodes, {
    file: (n) => ({
      id: `cf:${n.item.repoRoot}\0${n.item.path}`,
      className: 'jb-git-conflict',
      tooltip: `${n.path} (${n.item.type})`,
      data: { kind: 'file', file: n.item },
    }),
    dir: () => ({ data: { kind: 'dir' } }),
    group: () => ({ data: { kind: 'dir' } }),
  });
  const hadSelection = tree.getSelection().length > 0;
  tree.setRoots(roots);
  if (!hadSelection || !tree.getSelection().length) {
    const first = firstFile(roots);
    if (first) tree.select([first.id], { reveal: true });
  }
  updateButtons();
}

function firstFile(nodes: TreeNode<Data>[]): TreeNode<Data> | undefined {
  for (const n of nodes) {
    if (n.data?.kind === 'file') return n;
    const f = firstFile(n.children ?? []);
    if (f) return f;
  }
  return undefined;
}

function render(s: ConflictsState): void {
  // results of overlapping host computations may arrive out of order
  if (state && s.seq < state.seq) return;
  state = s;
  desc.replaceChildren(
    ...s.description.map((p) => (p.bold ? h('b', null, p.text) : p.code ? h('code', null, p.text) : document.createTextNode(p.text))),
  );
  desc.style.display = s.description.length ? '' : 'none';
  msg.textContent = s.message ?? '';
  msg.style.display = s.message ? '' : 'none';
  hYours.textContent = s.yoursTitle;
  hYours.title = s.yoursTitle;
  hTheirs.textContent = s.theirsTitle;
  hTheirs.title = s.theirsTitle;
  dlg.setError(s.error);

  const done = !s.error && s.done && !s.files.length;
  table.style.display = done ? 'none' : '';
  group.element.style.display = done ? 'none' : '';
  buttons.style.display = done ? 'none' : '';
  doneEl.style.display = done ? '' : 'none';
  if (done && s.done) {
    const children: Node[] = [icon('pass'), h('div', null, s.done.text)];
    if (s.done.action) {
      const a = s.done.action;
      const b = button({ label: a.label, primary: true, onClick: () => void rpc.call('next', a.id) });
      children.push(b);
      queueMicrotask(() => b.focus());
    }
    doneEl.replaceChildren(...children);
  }
  renderTree();
}

async function run(fn: () => Promise<ConflictsState>): Promise<void> {
  if (busy) return;
  busy = true;
  updateButtons();
  dlg.setBusy(true, 'Resolving Conflicts…');
  try {
    render(await fn());
  } catch (e) {
    dlg.setError(e instanceof Error ? e.message : String(e));
  } finally {
    busy = false;
    dlg.setBusy(false);
    updateButtons();
    tree.focus();
  }
}

function accept(side: 'yours' | 'theirs'): void {
  const files = selectedFiles();
  if (!files.length) return;
  const p: AcceptParams = { files: files.map((f) => ({ repoRoot: f.repoRoot, path: f.path })), accept: side };
  void run(() => rpc.call<ConflictsState>('accept', p));
}

function merge(): void {
  const files = selectedFiles();
  if (!files.length) return;
  void run(() => rpc.call<ConflictsState>('merge', { files: files.map((f) => ({ repoRoot: f.repoRoot, path: f.path })) }));
}

rpc.on<ConflictsState>('state', (s) => {
  if (!busy) render(s);
});

doneEl.style.display = 'none';
updateButtons();
rpc
  .call<ConflictsState>('load')
  .then((s) => {
    render(s);
    tree.focus();
  })
  .catch((e) => dlg.setError(e instanceof Error ? e.message : String(e)));
