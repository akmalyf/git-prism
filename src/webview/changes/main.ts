// Changes browser webview ('jbGit.changes.show'): "Changes between <from> and <to>" header with a swap button
// and the shared changes tree (Show Diff, Get, Expand/Collapse, Group By, context menu).
import type { ChangesInit, ChangesSource } from '../../features/compare/protocol';
import { init, rpc, viewState } from '../shared/rpc';
import { ensureStyles, h, iconButton, pluralize } from '../shared/ui';
import { ChangesView, injectCompareCss } from './view';

ensureStyles();
injectCompareCss();
const data = init<ChangesInit>();
let swapped = viewState.get('swapped', false);
const source = (): ChangesSource => ({ ...data.source, swapped });

const app = document.getElementById('app')!;
const title = h('span.cmp-title');
const count = h('span.jb-muted');
const error = h('div.cmp-error.jb-hidden');
const swap = iconButton({
  icon: 'arrow-swap',
  tooltip: 'Swap Sides',
  onClick: () => {
    swapped = !swapped;
    viewState.set('swapped', swapped);
    renderHeader();
    view.load();
  },
});
const header = h('div.cmp-header', null, title, count, h('span.jb-fill'), swap);
const root = h('div.cmp-app', null, header, error);
app.appendChild(root);

const view = new ChangesView(root, {
  stateKey: 'changes',
  source,
  emptyText: 'No changes',
  onError: (e) => showError(e),
  onChanges: (c) => {
    error.classList.add('jb-hidden');
    count.textContent = c.length ? pluralize(c.length, 'file') : '';
  },
});

function showError(e: unknown): void {
  error.textContent = e instanceof Error ? e.message : String(e);
  error.classList.remove('jb-hidden');
}

function renderHeader(): void {
  const from = data.fromLabel;
  const to = data.toLabel;
  const left = swapped ? (to ?? 'current working tree') : from;
  const right = swapped ? from : (to ?? 'current working tree');
  const scope = data.source.paths?.length ? ` in ${data.source.paths.join(', ')}` : '';
  title.replaceChildren('Changes between ', h('b', null, left), ' and ', h('b', null, right), scope);
  title.title = `Changes between ${left} and ${right}${scope}`;
}

renderHeader();
view.load().then(() => view.focus());
rpc.on('refresh', () => view.load());
