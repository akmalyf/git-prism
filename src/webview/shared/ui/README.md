# Webview UI kit (`src/webview/shared/ui`)

Vanilla TS + CSS components that reproduce the JetBrains New UI ("Islands") look inside VS Code webviews.
Everything is themed through `--vscode-*` variables (dark, light and high contrast work automatically).

```ts
import { ensureStyles, h, Tree, Table, Toolbar, Splitter, showContextMenu } from '../shared/ui';
ensureStyles(); // optional: every component calls it; call it yourself if you only use the CSS classes
```

Conventions
- Numbers that are timestamps are **unix seconds** (as in `src/core/types.ts`); `Date` objects are accepted too.
- Components are classes with `element` (already appended to `parent` when a parent is given) and `dispose()`.
- Events are `Emitter`s: `tree.onDidActivate(e => …)` returns a `Disposable`.
- Persistence (`stateKey` options) uses `viewState` from `../rpc` (per-webview state, survives reloads).
- Icons are codicon names without the `codicon-` prefix (`'git-branch'`, `'refresh'`).
- Pure modules with unit tests: `format.ts`, `match.ts`, `selection.ts`, `pathtree.ts` (no DOM, importable from node tests).
  `../test-shim.d.ts` types `node:test` / `node:assert/strict` for `*.test.ts` files under `src/webview`.
- Theme variables: VS Code puts `--vscode-*` on `<html>`; the kit's tokens are defined on `:root` from them, and
  `body.vscode-light` / `body.vscode-high-contrast` adjust a few (ref/icon colors, borders).

---

## Styles & tokens — `styles.ts`, `../base.css`, `kit.css`

`ensureStyles()` injects both stylesheets once. Layout helpers / tokens you can use in your own CSS:

| token | meaning |
|---|---|
| `--jb-font`, `--jb-font-size` (13px), `--jb-mono`, `--jb-mono-size` | UI / editor fonts |
| `--jb-row` (24px), `--jb-indent` (18px) | list row height, tree indent |
| `--jb-radius` (6px), `--jb-radius-sm` (4px) | island / control radius |
| `--jb-fg`, `--jb-fg-muted`, `--jb-fg-disabled`, `--jb-link`, `--jb-error`, `--jb-warning` | text colors |
| `--jb-bg`, `--jb-island-bg`, `--jb-border`, `--jb-hover`, `--jb-focus` | surfaces |
| `--jb-sel-bg`, `--jb-sel-fg`, `--jb-sel-inactive-bg`, `--jb-sel-inactive-fg` | focused / unfocused selection |
| `--jb-accent`, `--jb-accent-fg` | primary button / checkbox fill |
| `--jb-git-modified/added/deleted/untracked/ignored/conflict/renamed` | git status colors |
| `--jb-ref-head/local/remote/tag` | ref label icon colors (log) |

CSS classes (all prefixed `jb-`):
- Layout: `jb-app` (full-height flex column), `jb-island` (rounded panel), `jb-fill`, `jb-row-flex`, `jb-col-flex`, `jb-scroll`, `jb-sep` / `jb-sep-v`.
- Text: `jb-muted`, `jb-mono`, `jb-bold`, `jb-strike`, `jb-dim` (grey row, e.g. merge commits), `jb-link`, `jb-error-text`.
- Git status: `jb-git-modified`, `jb-git-added`, `jb-git-deleted` (grey + strike), `jb-git-untracked`, `jb-git-ignored`,
  `jb-git-conflict`, `jb-git-renamed` (use `gitStatusClass(kind)` from `icons.ts`).
- Controls: `jb-btn` (+ `jb-btn-primary`), `jb-icon-btn` (+ `jb-on` = toggled), `jb-input`, `jb-textarea`, `jb-check`,
  `jb-radio`, `jb-combo`, `jb-badge`, `jb-ref`, `jb-kbd`.

## dom.ts

```ts
h(tag, props?, ...children)        // tag may carry classes: h('div.jb-island.foo', { onClick }, 'text', child)
// props: class (string | string[] | Record<string,boolean>), style (string | object), dataset, attrs,
//        on<Event> handlers (onClick, onKeyDown…), any other key = DOM property (title, type, value, disabled, tabIndex…)
cls('a', cond && 'b', { c: true })   // → 'a b c'
escapeHtml(s); clear(el); setChildren(el, ...children)
listen(target, 'click', fn, opts?) → Disposable
highlightText(text, ranges)        // DocumentFragment with <mark class="jb-match"> for [start,end) ranges
new Emitter<T>()  .event(cb) → Disposable   .fire(v)   .dispose()
new DisposableStore() .add(d) .dispose()
isMac; isCtrlCmd(ev) // Cmd on macOS, Ctrl elsewhere
```

## icons.ts

```ts
icon('git-branch', { color?, className?, title?, spin? }) → <span class="codicon codicon-git-branch">
fileIconName('app/User.php') → { name: 'file-code', color: '…' }   // by extension / file name
fileIcon(path) → span;  folderIcon(open?) → span
gitStatusClass(kind: ChangeKind | 'conflict') → 'jb-git-modified' | …   // ChangeKind from core/types
gitStatusLabel(kind) → 'Modified' | 'Added' | …
```

## format.ts (pure)

```ts
setFormatLocale('id-ID')                   // default: navigator.language; pass init().locale if the host sends one
formatPrettyDateTime(t, now?)  // 'Moments ago' | '5 minutes ago' | 'Today 11.19' | 'Yesterday 14.53' | '27/10/26, 10.27'
formatDateTime(t)              // '27/10/26, 10.27' (locale short date + short time)
formatDate(t), formatTime(t)
formatRelative(t, now?)        // '5 minutes ago', '3 hours ago', '2 days ago', '4 months ago', '1 year ago'
formatSize(1536)               // '1.5 kB'
pluralize(11, 'file')          // '11 files'   pluralize(1, 'child', 'children') → '1 child'
shortHash(hash, 8)
formatShortcut('CmdOrCtrl+Alt+K')   // macOS '⌥⌘K', others 'Ctrl+Alt+K'
```

## match.ts (pure) — speed search matching

```ts
matchText('sercon', 'ServiceController.php') → [[0,3],[7,10]] | null
// case-insensitive; substring first, then IntelliJ-like fragment matching at word / camelHump starts
```

## selection.ts (pure)

`new SelectionModel<K>(multi = true)` with `click(key, nav, { shift, toggle })`, `moveTo(key, nav, extend)`,
`set(keys, lead?)`, `selectAll(nav)`, `retain(exists)`, `selected`, `lead`, `anchor`, `onDidChange`.
`nav = { indexOf(k): number; keyAt(i): K | undefined; count: number }`. Used by Tree and Table.

## pathtree.ts (pure) — changes grouped by directory

```ts
const nodes = buildPathTree(changes, {
  path: c => c.path,                // repo-relative, forward slashes
  groupByDirectory: true,           // false → flat list (file nodes carry `dir` for the grey path)
  compact: true,                    // 'Service/Controllers' folder compaction like IntelliJ
  groups: [{ key: c => c.repo, label: k => basename(k) }], // optional outer levels (repository/module)
  idPrefix: 'changes:',
});
// PathNode = { kind:'group', id, name, children, fileCount, key }
//          | { kind:'dir', id, name, path, children, fileCount }
//          | { kind:'file', id, name, path, dir, item }
// Sorted like IntelliJ: groups, then directories, then files; case-insensitive.

const treeNodes = pathTreeToNodes(nodes, {
  file: (n) => ({ className: gitStatusClass(n.item.kind), checkable: true, checked: true, data: n.item }),
  dir: (n) => ({ /* optional overrides; default: folder icon + '11 files' description */ }),
  group: (n) => ({ icon: 'repo' }),
});
```

## tree.ts — virtualized tree (50k+ nodes)

```ts
interface TreeNode<D = any> {
  id: string; label: string;
  children?: TreeNode<D>[];     // undefined = leaf
  hasChildren?: boolean;        // lazy: children come from options.loadChildren on first expand
  expanded?: boolean;           // initial state (persisted state from stateKey wins)
  icon?: string; iconColor?: string; iconClass?: string;
  description?: string;         // grey secondary text after the label ('11 files', a path)
  className?: string;           // e.g. gitStatusClass('M') → colors the label
  bold?: boolean; italic?: boolean; strike?: boolean; muted?: boolean;
  badge?: string | number;      // trailing count badge
  trailing?: string;            // trailing grey text, right-aligned
  checkable?: boolean; checked?: boolean;   // leaves hold the state; parents are tri-state, computed
  selectable?: boolean;         // default true
  tooltip?: string;
  actions?: { icon: string; tooltip: string; run(node: TreeNode<D>): void }[];  // hover buttons on the right
  searchText?: string;          // speed-search text (default label)
  data?: D;
}

const tree = new Tree<Change>(container, {
  multiSelect: true, checkboxes: true, stateKey: 'commit.tree',
  defaultExpandDepth: Infinity, emptyText: ['No changes'],
  loadChildren: async (node) => [...],
  renderLabel?: (el, node, ctx) => void,  // optional: replace the default label rendering
});
tree.setRoots(nodes);                 // keeps expansion / selection / scroll by node id
// check state of ids already known is kept; `checked` is read for new ids (setRoots(n, { resetChecks: true }) re-reads all)
tree.onDidChangeSelection(nodes => …);
tree.onDidActivate(({ node, event }) => …);           // double-click / Enter
tree.onContextMenu(({ nodes, x, y, event }) => showContextMenu(items, x, y));
tree.onDidChangeChecked(({ nodes }) => …);           // leaves whose state changed
tree.onDidToggleExpand(({ node, expanded }) => …);
tree.select(['id'], { reveal: true, focus: true }); tree.getSelection(); tree.getLead();
tree.expand(id, recursive?); tree.collapse(id); tree.expandAll(); tree.collapseAll(keepRoots?); tree.reveal(id);
tree.setChecked(ids, true); tree.checkAll(false); tree.getCheckState(id) // 'on'|'off'|'mixed'
tree.getChecked(); tree.updateNode(id, { label: 'x' }); tree.getNode(id); tree.getParent(id); tree.focus();
```
Mouse: click / Shift / Cmd(Ctrl) selection, twistie click toggles (Alt = recursive), checkbox click toggles (whole
selection when the row is selected), double-click activates leaves and toggles parents (`activateParents: true` to
receive onDidActivate for parents too), right-click selects the row if it is not selected yet, then fires onContextMenu.
Keyboard: ↑↓, ←/→ (collapse/parent, expand/first child), Home/End, PageUp/PageDown, Shift+arrows, Cmd/Ctrl+A,
Cmd/Ctrl+= / Cmd/Ctrl+- (expand/collapse all),
Enter (activate), Space (toggle checkbox of selection), Shift+F10 / ContextMenu key, type to speed-search
(↑↓ jump between matches, Esc closes; matches highlighted).

## table.ts — virtualized table (100k+ rows)

```ts
const table = new Table<Commit>(container, {
  rowId: c => c.hash,
  stateKey: 'log.table',             // persists widths, order, hidden columns
  columns: [
    { id: 'author', title: 'Author', width: 120, text: c => c.author },
    { id: 'subject', title: 'Subject', flex: true, minWidth: 200, hideable: false,
      render: (cell, c, i, ctx) => { /* draw canvas graph + text; reuse cell children */ } },
    { id: 'date', title: 'Date', width: 130, text: c => formatPrettyDateTime(c.commitDate) },
  ],
  rowClass: (c) => (c.parents.length > 1 ? 'jb-dim' : undefined),
  tooltip: (c, i, columnId) => undefined,   // string | Node, shown on hover
  speedSearch: (c) => c.subject,            // optional
  header: true, emptyText: ['No commits matching filters'],
});
table.setRows(rows); table.appendRows(more); table.setHasMore(true);
table.onNeedMore(() => loadNextPage());     // fired when scrolled near the end while hasMore
table.onDidChangeSelection(rows => …); table.onDidActivate(({ row, index, columnId }) => …);
table.onContextMenu(({ rows, x, y, event, columnId }) => …);
table.select([hash], { reveal: true }); table.scrollToIndex(i, 'center'); table.refresh(); table.setColumnVisible('date', false);
table.getSelection(); table.getSelectedIds(); table.getLeadIndex(); table.visibleRange(); table.setEmptyText([...]);
table.onDidScroll(({ first, last }) => …); table.onDidClickHeader(columnId => …); table.setColumns(cols);
```
`CellContext = { index, selected, focused, width, height, columnId }`. Header: drag the border to resize,
drag a title to reorder, right-click to show/hide columns.

## splitter.ts

```ts
const split = new Splitter(container, {
  orientation: 'horizontal',      // panes side by side; 'vertical' = stacked
  first: left, second: right,
  size: 260, fixed: 'first',      // size in px of the fixed pane (or ratio 0..1 with proportional: true)
  min: 120, minOther: 200, stateKey: 'log.split.branches', collapsible: true,
});
split.setSize(300); split.getSize(); split.setCollapsed(true); split.toggleCollapsed(); split.onDidResize(size => …);
split.element.classList.add('jb-islands');   // 5px transparent gap between two .jb-island panes instead of a 1px line
```

## toolbar.ts

```ts
const tb = new Toolbar(container, {
  orientation: 'horizontal',      // or 'vertical' (thin JB side toolbar)
  items: [
    { id: 'refresh', icon: 'refresh', tooltip: 'Refresh', shortcut: 'CmdOrCtrl+R', run: () => … },
    { id: 'eye', icon: 'eye', tooltip: 'View Options', dropdown: () => menuItems },   // shows a menu
    '-',
    { id: 'regex', icon: 'regex', tooltip: 'Regex', toggled: false, run: (b) => tb.update('regex', { toggled: !b.toggled }) },
    { id: 'branch', label: 'Branch', dropdown: true, run: (_, el) => showListPopup(el, …) },   // text button with ▾
    { type: 'spacer' },
    { type: 'custom', element: someEl },
  ],
});
tb.update('refresh', { disabled: true }); tb.setItems(items); tb.getElement('eye');
```
Items that do not fit go into a trailing `»` overflow menu (horizontal toolbars).

## menu.ts

```ts
type MenuItem = '-' | { header: string } | {
  label: string; id?: string; icon?: string; shortcut?: string; checked?: boolean; radio?: boolean;
  disabled?: boolean; description?: string; run?(): void; submenu?: MenuItem[] | (() => MenuItem[]);
};
showContextMenu(items, x, y) → MenuHandle;
showDropdownMenu(items, anchorEl, { align: 'start' | 'end' }) → MenuHandle;   // { close(), closed: Promise<void> }
```
Keyboard: ↑↓ Home End, → / Enter open submenu, ← closes it, Enter runs, Esc / blur / outside click close,
typing a letter jumps to the next item starting with it. Positioned within the viewport.

## popup.ts — anchored list popup with search

```ts
const picked = await showListPopup<string>(anchorEl, {
  title: 'Select Branches', items: [{ header: 'Local' }, { value: 'main', label: 'main', icon: 'git-branch' }, '-', …],
  multiSelect: true,           // checkboxes; click/Space toggles, Enter or outside click applies, Esc cancels
                               // items with `action: true` ("Select…") resolve immediately with [value]
                               // Enter with nothing checked resolves with the active item
  search: true, placeholder: 'Search', emptyText: 'Nothing to show', width: 300,
});
// picked: V[] | undefined (undefined = cancelled). Single-select resolves on click / Enter with [value].
```

## searchfield.ts

```ts
const sf = new SearchField(container, {
  placeholder: 'Text or hash', regex: false, matchCase: false,   // omit to hide the '.*' / 'Cc' toggles
  wholeWords: undefined, historyKey: 'log.text', debounce: 300,
});
sf.onDidChange(({ value, regex, matchCase, wholeWords }) => …); sf.onDidSubmit(…);
sf.value; sf.setValue('x'); sf.focus(); sf.addToHistory('x'); sf.setToggles({ regex: true }); sf.setInvalid(true);
sf.toRegExp();   // RegExp for value + toggles (null when empty; throws for an invalid regex → setInvalid(true))
```

## tabs.ts

```ts
const tabs = new Tabs(container, {
  prefix: 'Git:',
  tabs: [{ id: 'log', label: 'Log', closable: false, content?: el }, { id: 'console', label: 'Console' }],
  active: 'log', add: { tooltip: 'New Tab', run: () => … },
});
tabs.onDidChange(id => …); tabs.onDidClose(id => …); tabs.setTabs(…); tabs.setActive('console');
```
Tabs with `content` are shown/hidden automatically inside `tabs.panels`.

## dialog.ts

```ts
// whole-webview dialog (WebviewPanel used as a dialog: Push, Interactive Rebase, Conflicts…)
const dlg = dialogLayout(document.getElementById('app')!, {
  title: 'Push Commits to project', body: content,
  buttons: [{ id: 'push', label: 'Push', primary: true, run: () => … }, { id: 'cancel', label: 'Cancel', cancel: true, run: close }],
  leftButtons: [{ id: 'help', icon: 'question', run: … }],   // optional, bottom-left
});
dlg.setEnabled('push', false); dlg.setError('…'); dlg.setBusy(true);

// in-page modal overlay
const r = await openModal({ title: 'Create New Branch', body, buttons: [...], width: 420 }).result; // button id | undefined
await confirmDialog({ title: 'Delete Tag', message: 'Delete tag v1?', ok: 'Delete' }) // → boolean
await promptDialog({ title: 'Rename', label: 'New name:', value: 'x', validate: v => v ? undefined : 'Empty' }) // string | undefined
formRow('Branch:', control, { hint }); formSection('Options'); formGrid(rows)
```
Enter triggers the primary button (Cmd/Ctrl+Enter inside a textarea), Esc triggers the `cancel` button.
A `run` returning `false` (or a Promise resolving to false) keeps the dialog open.

## controls.ts

```ts
button({ label: 'Commit', primary: true, onClick, disabled, icon, title })
iconButton({ icon: 'refresh', tooltip: 'Refresh', shortcut, toggled, onClick })
checkbox({ label: 'Amend', checked: true | false | 'mixed', onChange }) → { element, input, checked, set(v), setDisabled(b) }
radioGroup({ options: [{ value, label, description }], value, onChange, orientation: 'vertical' }) → { element, value, set(v) }
textField({ value, placeholder, onInput, onChange, monospace, width }) → HTMLInputElement
textArea({ value, rows, monospace, onInput, placeholder }) → HTMLTextAreaElement
comboBox({ options: [{ value, label, icon }], value, onChange, width }) → { element, value, set(v), setOptions(o) }
link('Rollback', run); badge(11); refLabel('origin/main', 'remote'); kbd('CmdOrCtrl+K')
```

## empty.ts, tooltip.ts, loading.ts

```ts
emptyState(['No changes', ['Use ', { text: 'Commit', run: () => … }, ' to …']])  // centered grey lines with links
setTooltip(el, 'Refresh', { shortcut: 'CmdOrCtrl+R' }) → Disposable; showTooltip(anchor, text); hideTooltip();
delegateTooltip(container, (e) => ({ anchor, content, key }) | undefined)   // one tooltip for many children
spinner(); const p = progressLine(); container.prepend(p.element); p.show(); p.hide();
setLoading(container, true, 'Loading…')   // overlay with spinner
```
