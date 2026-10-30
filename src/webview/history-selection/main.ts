// "History for Selection" webview (IntelliJ VcsSelectionHistoryDialog): block diff of the selected revision against
// its parent on top (ide-diff, read-only), the revisions that changed the block below (Local Changes first) with
// the commit message, plus Show Diff / Compare with Local / Show File at Revision actions.
import { createDiffViewer, type DiffViewerHost } from '@ide-diff/viewer';
import type { BlockRevisionView, HistorySelectionInit } from '../../features/compare/protocol';
import { languageFor } from '../shared/languages';
import { init, rpc } from '../shared/rpc';
import { emptyState, ensureStyles, formatPrettyDateTime, h, setLoading, showContextMenu, Splitter, Table, Toolbar, type MenuItem } from '../shared/ui';
import { injectCompareCss } from '../changes/view';

ensureStyles();
injectCompareCss(`
.hs-pane { display: flex; flex-direction: column; min-height: 0; height: 100%; position: relative; }
.hs-diff { flex: 1 1 auto; min-height: 0; position: relative; }
.hs-diff > * { height: 100%; }
.hs-stale { flex: none; padding: 4px 10px; color: var(--jb-warning); }
.hs-label { flex: none; padding: 6px 10px 0; color: var(--jb-fg-muted); }
.hs-msg { padding: 4px 10px 8px; font-family: var(--jb-mono); font-size: var(--jb-mono-size); white-space: pre-wrap; word-break: break-word; overflow: auto; user-select: text; flex: 1 1 auto; min-height: 0; }
.hs-local { font-style: italic; }
body .idd-theme-dark, body .idd-theme-light {
  --idd-font-family: var(--vscode-editor-font-family);
  --idd-font-size: var(--vscode-editor-font-size);
  --idd-line-height: calc(var(--vscode-editor-font-size) * 1.6);
  --idd-ui-font-family: var(--vscode-font-family);
  --idd-ui-font-size: 13px;
  --idd-editor-bg: var(--vscode-editor-background);
  --idd-editor-fg: var(--vscode-editor-foreground);
  --idd-gutter-bg: var(--vscode-editorGutter-background, var(--vscode-editor-background));
  --idd-divider-bg: var(--vscode-editorGutter-background, var(--vscode-editor-background));
  --idd-caret: var(--vscode-editorCursor-foreground);
  --idd-selection-bg: var(--vscode-editor-selectionBackground);
  --idd-line-number: var(--vscode-editorLineNumber-foreground);
  --idd-line-number-caret-row: var(--vscode-editorLineNumber-activeForeground);
  --idd-panel-bg: var(--vscode-editor-background);
  --idd-toolbar-bg: var(--vscode-editor-background);
  --idd-window-bg: var(--vscode-editorWidget-background);
  --idd-border: var(--jb-border);
  --idd-fg: var(--vscode-foreground);
  --idd-title-fg: var(--vscode-foreground);
  --idd-fg-muted: var(--vscode-descriptionForeground);
  --idd-fg-disabled: var(--vscode-disabledForeground);
  --idd-button-hover-bg: var(--vscode-toolbar-hoverBackground);
  --idd-popup-bg: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  --idd-popup-border: var(--vscode-menu-border, var(--vscode-widget-border, var(--jb-border)));
  --idd-list-selection-bg: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
  --idd-list-hover-bg: var(--vscode-list-hoverBackground);
  --idd-focus: var(--vscode-focusBorder);
  --idd-accent: var(--vscode-focusBorder);
  --idd-link: var(--vscode-textLink-foreground);
  --idd-scrollbar-thumb: var(--vscode-scrollbarSlider-background);
  --idd-scrollbar-thumb-hover: var(--vscode-scrollbarSlider-hoverBackground);
}
`);

const data = init<HistorySelectionInit>();
const theme = (): 'dark' | 'light' => (/\bvscode-(light|high-contrast-light)\b/.test(document.body.className) ? 'light' : 'dark');
let rows: BlockRevisionView[] = [];
let viewer: DiffViewerHost | undefined;
/** the selected revisions (newest first); the diff spans from the oldest's parent to the newest */
let shown: BlockRevisionView[] = [];

const app = document.getElementById('app')!;
const diffHost = h('div.hs-diff');
const stale = h('div.hs-stale.jb-hidden', null, 'The document was modified. Reopen Show History for Selection to update the line range.');
const errorEl = h('div.cmp-error.jb-hidden');
const topPane = h('div.hs-pane.jb-island', null, stale, errorEl, diffHost);

const toolbar = new Toolbar(null, {
  items: [
    { id: 'diff', icon: 'diff', tooltip: 'Show Diff', shortcut: 'CmdOrCtrl+D', run: () => act('showDiff') },
    { id: 'local', icon: 'compare-changes', tooltip: 'Compare with Local', run: () => act('compareWithLocal') },
    { id: 'open', icon: 'go-to-file', tooltip: 'Show File at Revision', shortcut: 'F4', run: () => act('openAtRevision') },
    '-',
    { id: 'log', icon: 'git-commit', tooltip: 'Show in Git Log', run: () => act('showInLog') },
    { id: 'copy', icon: 'copy', tooltip: 'Copy Revision Number', run: () => act('copyHash') },
    { type: 'spacer' },
    { type: 'custom', element: h('span.jb-muted', { style: { padding: '0 8px' } }, `${data.path}: ${data.start === data.end ? `line ${data.start}` : `lines ${data.start}–${data.end}`}`) },
  ],
});

const table = new Table<BlockRevisionView>(null, {
  rowId: (r) => r.hash || 'local',
  stateKey: 'history.table',
  multiSelect: true,
  header: true,
  columns: [
    { id: 'revision', title: 'Revision', width: 90, text: (r) => (r.local ? '' : r.hash.slice(0, 8)) },
    { id: 'date', title: 'Date', width: 140, text: (r) => (r.local ? '' : formatPrettyDateTime(r.date)) },
    { id: 'author', title: 'Author', width: 140, text: (r) => r.author },
    { id: 'message', title: 'Commit Message', flex: true, minWidth: 160, hideable: false, text: (r) => r.subject },
  ],
  rowClass: (r) => (r.local ? 'hs-local' : undefined),
  tooltip: (r) => (r.local ? 'Local Changes' : `${r.hash.slice(0, 8)} ${r.subject}\n${r.author} <${r.authorEmail}>`),
  speedSearch: (r) => `${r.subject} ${r.author} ${r.hash}`,
  emptyText: 'Loading…',
});
const tablePane = h('div.hs-pane', null, toolbar.element, table.element);
const msg = h('div.hs-msg');
const msgPane = h('div.hs-pane', null, h('div.hs-label', null, 'Commit Message:'), msg);
const bottom = new Splitter(null, { first: tablePane, second: msgPane, size: 0.65, proportional: true, min: 200, minOther: 120, stateKey: 'history.bottom' });
const bottomIsland = h('div.hs-pane.jb-island', null, bottom.element);
const main = new Splitter(null, { orientation: 'vertical', first: topPane, second: bottomIsland, size: 0.55, proportional: true, min: 80, minOther: 100, stateKey: 'history.main' });
main.element.classList.add('jb-islands');
app.appendChild(h('div.cmp-app', null, main.element));

const revTitle = (hash: string | undefined) => (hash ? `Revision ${hash.slice(0, 8)}` : '');

function showRevision(sel: readonly BlockRevisionView[]): void {
  shown = rows.filter((r) => sel.includes(r));
  const newest = shown[0];
  const oldest = shown[shown.length - 1];
  const single = shown.length === 1 ? newest : undefined;
  toolbar.update('diff', { disabled: !newest });
  toolbar.update('local', { disabled: !single || !!single.local });
  toolbar.update('open', { disabled: !single });
  toolbar.update('log', { disabled: !single || !!single.local });
  toolbar.update('copy', { disabled: !single || !!single.local });
  msg.textContent = shown
    .map((r) => (r.local ? 'Local Changes' : r.body ? `${r.subject}\n\n${r.body}` : r.subject))
    .join('\n\n');
  if (!newest) {
    viewer?.dispose();
    viewer = undefined;
    diffHost.replaceChildren(emptyState('No revision selected'));
    return;
  }
  const original = oldest.before;
  const modified = newest.after;
  const originalTitle = revTitle(oldest.parent) || 'No previous revision';
  const modifiedTitle = newest.local ? 'Local Changes' : revTitle(newest.hash);
  if (viewer) {
    viewer.setOptions({ original, modified, originalTitle, modifiedTitle });
    return;
  }
  diffHost.replaceChildren();
  viewer = createDiffViewer(diffHost, {
    original,
    modified,
    originalTitle,
    modifiedTitle,
    language: languageFor(data.language),
    theme: theme(),
    readOnly: true,
    collapseUnchanged: false,
  });
}

new MutationObserver(() => viewer?.setOptions({ theme: theme() })).observe(document.body, { attributes: true, attributeFilter: ['class'] });

type Action = 'showDiff' | 'compareWithLocal' | 'openAtRevision' | 'showInLog' | 'copyHash';
function act(a: Action, sel: readonly BlockRevisionView[] = shown): void {
  const newest = sel[0];
  const oldest = sel[sel.length - 1];
  if (!newest) return;
  if (a !== 'showDiff' && sel.length > 1) return;
  // Show Diff over several revisions: whole file from the oldest one's parent to the newest one
  rpc.call(a, { hash: newest.hash, parent: oldest.parent, path: newest.path, oldPath: oldest.oldPath }).catch(showError);
}

function showError(e: unknown): void {
  errorEl.textContent = e instanceof Error ? e.message : String(e);
  errorEl.classList.remove('jb-hidden');
}

table.onDidChangeSelection((sel) => showRevision(sel));
table.onDidActivate(({ row }) => act('showDiff', [row]));
table.onContextMenu(({ rows: picked, x, y }) => {
  const sel = rows.filter((r) => picked.includes(r));
  if (!sel.length) return;
  const one = sel.length === 1 ? sel[0] : undefined;
  const items: MenuItem[] = [
    { label: 'Show Diff', icon: 'diff', shortcut: 'CmdOrCtrl+D', run: () => act('showDiff', sel) },
    { label: 'Compare with Local', disabled: !one || !!one.local, run: () => act('compareWithLocal', sel) },
    { label: 'Show File at Revision', shortcut: 'F4', disabled: !one, run: () => act('openAtRevision', sel) },
    '-',
    { label: 'Show in Git Log', disabled: !one || !!one.local, run: () => act('showInLog', sel) },
    { label: 'Copy Revision Number', icon: 'copy', disabled: !one || !!one.local, run: () => act('copyHash', sel) },
    {
      label: 'Copy Commit Subject',
      disabled: sel.every((r) => r.local),
      run: () => rpc.call('copySubject', { text: sel.filter((r) => !r.local).map((r) => r.subject).join('\n') }).catch(showError),
    },
  ];
  showContextMenu(items, x, y);
});
table.element.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    act('showDiff');
  } else if (e.key === 'F4') {
    e.preventDefault();
    act('openAtRevision');
  }
});

rpc.on('stale', () => stale.classList.remove('jb-hidden'));

async function load(): Promise<void> {
  setLoading(app, true, 'Loading affected revisions…');
  try {
    rows = await rpc.call<BlockRevisionView[]>('load');
    table.setEmptyText('No revisions changed the selected lines');
    table.setRows(rows);
    if (rows.length) table.select([rows[0].hash || 'local'], { reveal: true, focus: true });
    else showRevision([]);
  } catch (e) {
    table.setEmptyText('Cannot load revision contents');
    table.setRows([]);
    showRevision([]);
    showError(e);
  } finally {
    setLoading(app, false);
  }
}

load();
