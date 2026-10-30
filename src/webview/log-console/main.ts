// Git panel "Console" tab (bundle 'log-console'): IntelliJ VcsConsoleView look — thin vertical toolbar (Soft-Wrap,
// Scroll to End, Clear All) and a monospace, selectable log of git commands with "HH:mm:ss.SSS:" timestamps,
// highlighted command lines and red error output. Host side: src/features/log/consoleview.ts.
import { formatConsoleTime, type ConsoleLine } from '../../features/log/consoleparse';
import { rpc, viewState } from '../shared/rpc';
import { ensureStyles, h, isCtrlCmd, showContextMenu, Toolbar, type MenuItem } from '../shared/ui';
import css from './console.css';

ensureStyles();
document.head.appendChild(h('style', null, css));

const LIMIT = 5000;
let softWrap = viewState.get('softWrap', false);
let scrollToEnd = viewState.get('scrollToEnd', true);
let lastId = 0;
const lines: ConsoleLine[] = [];

const out = h('div.cn-out', { tabIndex: 0, attrs: { role: 'log', 'aria-label': 'Git Console' } });
const toolbar = new Toolbar(null, {
  orientation: 'vertical',
  className: 'cn-toolbar',
  ariaLabel: 'Console actions',
  items: [
    { id: 'wrap', icon: 'word-wrap', tooltip: 'Soft-Wrap', toggled: softWrap, run: () => setWrap(!softWrap) },
    { id: 'end', icon: 'arrow-down', tooltip: 'Scroll to End', toggled: scrollToEnd, run: () => setScrollToEnd(!scrollToEnd) },
    '-',
    { id: 'clear', icon: 'clear-all', tooltip: 'Clear All', run: () => void rpc.call('clear') },
  ],
});
const app = h('div.jb-app.cn-app', null, toolbar.element, h('div.jb-island.cn-island', null, out));
document.getElementById('app')!.appendChild(app);

function setWrap(v: boolean): void {
  softWrap = v;
  viewState.set('softWrap', v);
  toolbar.update('wrap', { toggled: v });
  out.classList.toggle('cn-wrap', v);
}

function setScrollToEnd(v: boolean): void {
  scrollToEnd = v;
  viewState.set('scrollToEnd', v);
  toolbar.update('end', { toggled: v });
  if (v) out.scrollTop = out.scrollHeight;
}

function render(l: ConsoleLine): HTMLElement {
  const row = h('div.cn-line', { class: `cn-${l.kind}`, dataset: { id: String(l.id) } });
  if (l.kind === 'command') {
    row.append(h('span.cn-time', null, `${formatConsoleTime(l.time)}: `), h('span.cn-cmd', null, l.text));
    row.title = l.exit !== undefined ? `${l.ms} ms, exit code ${l.exit}` : `${l.ms} ms`;
  } else row.textContent = l.text || '​';
  return row;
}

function append(added: ConsoleLine[]): void {
  const fresh = added.filter((l) => l.id > lastId);
  if (!fresh.length) return;
  const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 4;
  const frag = document.createDocumentFragment();
  for (const l of fresh) frag.appendChild(render(l));
  out.appendChild(frag);
  lines.push(...fresh);
  lastId = fresh[fresh.length - 1].id;
  const drop = lines.length - LIMIT;
  if (drop > 0) {
    lines.splice(0, drop);
    for (let i = 0; i < drop && out.firstChild; i++) out.firstChild.remove();
  }
  // follow the output while "Scroll to End" is on, or while the user already sits at the bottom
  if (scrollToEnd || atEnd) out.scrollTop = out.scrollHeight;
}

function clearAll(): void {
  lines.length = 0;
  out.replaceChildren();
}

/** Lines intersecting the current text selection inside the console (all lines when none). */
function selectedLines(): { lines: ConsoleLine[]; partial: string | undefined } {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !out.contains(sel.anchorNode)) return { lines, partial: undefined };
  return { lines: [], partial: sel.toString() };
}

function copy(all: boolean): void {
  const s = selectedLines();
  if (!all && s.partial !== undefined) void rpc.call('copyText', s.partial);
  else void rpc.call('copy', { lines, timestamps: true });
}

function selectAll(): void {
  const r = document.createRange();
  r.selectNodeContents(out);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

function menu(x: number, y: number): void {
  const hasSel = selectedLines().partial !== undefined;
  const items: MenuItem[] = [
    { label: 'Copy', shortcut: 'CmdOrCtrl+C', disabled: !hasSel, run: () => copy(false) },
    { label: 'Copy All', disabled: !lines.length, run: () => copy(true) },
    { label: 'Select All', shortcut: 'CmdOrCtrl+A', run: selectAll },
    '-',
    { label: 'Soft-Wrap', checked: softWrap, run: () => setWrap(!softWrap) },
    { label: 'Scroll to End', checked: scrollToEnd, run: () => setScrollToEnd(!scrollToEnd) },
    '-',
    { label: 'Clear All', icon: 'clear-all', run: () => void rpc.call('clear') },
    '-',
    { label: 'Open in Output Panel', run: () => void rpc.call('openOutput') },
  ];
  showContextMenu(items, x, y);
}

out.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  menu(e.clientX, e.clientY);
});
out.addEventListener('keydown', (e) => {
  if (isCtrlCmd(e) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectAll();
  } else if (e.key === 'End' && isCtrlCmd(e)) {
    out.scrollTop = out.scrollHeight;
  } else if (e.key === 'Home' && isCtrlCmd(e)) {
    out.scrollTop = 0;
  } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    const r = out.getBoundingClientRect();
    menu(r.left + 20, r.top + 20);
  }
});
// scrolling up turns "Scroll to End" off, reaching the bottom again keeps following (IntelliJ behavior)
out.addEventListener('wheel', (e) => {
  if (e.deltaY < 0 && scrollToEnd) setScrollToEnd(false);
});

rpc.on<ConsoleLine[]>('append', append);
rpc.on('clear', clearAll);
setWrap(softWrap);
void rpc.call<ConsoleLine[]>('snapshot').then((all) => {
  clearAll();
  lastId = 0;
  append(all);
  out.scrollTop = out.scrollHeight;
});
