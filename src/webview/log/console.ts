// Git Console pane at the bottom of the Log view (IntelliJ VcsConsoleView): a header that expands/collapses it, a
// resize handle, and a monospace, selectable log of git commands with "HH:mm:ss.SSS:" timestamps, highlighted
// command lines and red error output. Host side: src/features/log/consoleview.ts (RPC methods "console.*").
import { formatConsoleTime, type ConsoleLine } from '../../features/log/consoleparse';
import { rpc, viewState } from '../shared/rpc';
import { h, icon, isCtrlCmd, showContextMenu, Toolbar, type MenuItem } from '../shared/ui';

const LIMIT = 5000;
const HEADER = 26;

export class ConsolePane {
  readonly element: HTMLElement;
  private readonly out: HTMLElement;
  private readonly toolbar: Toolbar;
  private readonly chevron: HTMLElement;
  private readonly lines: ConsoleLine[] = [];
  private lastId = 0;
  private softWrap = viewState.get('console.softWrap', false);
  private scrollToEnd = viewState.get('console.scrollToEnd', true);
  /** always starts collapsed */
  private expanded = false;
  private height = viewState.get('console.height', 180);
  private loaded = false;

  constructor(private readonly onLayout: () => void) {
    this.out = h('div.cn-out', { tabIndex: 0, attrs: { role: 'log', 'aria-label': 'Git Console' } });
    this.toolbar = new Toolbar(null, {
      className: 'cn-toolbar',
      ariaLabel: 'Console actions',
      items: [
        { id: 'wrap', icon: 'word-wrap', tooltip: 'Soft-Wrap', toggled: this.softWrap, run: () => this.setWrap(!this.softWrap) },
        { id: 'end', icon: 'arrow-down', tooltip: 'Scroll to End', toggled: this.scrollToEnd, run: () => this.setScrollToEnd(!this.scrollToEnd) },
        { id: 'clear', icon: 'clear-all', tooltip: 'Clear All', run: () => void rpc.call('console.clear') },
      ],
    });
    this.chevron = icon('chevron-right');
    const title = h('button.cn-title', { type: 'button', title: 'Expand / Collapse Console', onClick: () => this.setExpanded(!this.expanded) }, this.chevron, h('span', null, 'Console'));
    const header = h('div.cn-header', null, title, this.toolbar.element);
    header.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('.cn-toolbar')) this.setExpanded(!this.expanded);
    });
    const grip = h('div.cn-grip', { title: 'Drag to resize' });
    grip.addEventListener('pointerdown', (e) => this.startResize(e, grip));
    this.element = h('div.jb-island.cn-pane', null, grip, header, this.out);

    this.out.addEventListener('contextmenu', (e) => this.menu(e.clientX, e.clientY));
    this.out.addEventListener('keydown', (e) => {
      if (isCtrlCmd(e) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.selectAll();
      } else if (e.key === 'End' && isCtrlCmd(e)) this.out.scrollTop = this.out.scrollHeight;
      else if (e.key === 'Home' && isCtrlCmd(e)) this.out.scrollTop = 0;
    });
    // scrolling up turns "Scroll to End" off (IntelliJ behavior)
    this.out.addEventListener('wheel', (e) => {
      if (e.deltaY < 0 && this.scrollToEnd) this.setScrollToEnd(false);
    });

    rpc.on<ConsoleLine[]>('console.append', (l) => this.append(l));
    rpc.on('console.clear', () => this.clear());
    rpc.on('console.expand', () => this.setExpanded(true));
    this.setWrap(this.softWrap);
    this.apply();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const all = await rpc.call<ConsoleLine[]>('console.snapshot');
    this.clear();
    this.lastId = 0;
    this.append(all);
    this.out.scrollTop = this.out.scrollHeight;
  }

  setExpanded(v: boolean): void {
    this.expanded = v;
    this.apply();
    if (v) {
      void this.load();
      this.out.scrollTop = this.out.scrollHeight;
    }
  }

  private apply(): void {
    this.element.classList.toggle('cn-collapsed', !this.expanded);
    this.chevron.className = `codicon codicon-${this.expanded ? 'chevron-down' : 'chevron-right'} jb-icon`;
    this.element.style.height = `${this.expanded ? Math.max(HEADER + 40, this.height) : HEADER}px`;
    this.onLayout();
  }

  private startResize(e: PointerEvent, grip: HTMLElement): void {
    if (!this.expanded) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = this.element.getBoundingClientRect().height;
    const max = () => Math.max(HEADER + 40, (this.element.parentElement?.clientHeight ?? window.innerHeight) - 160);
    const move = (ev: PointerEvent) => {
      this.height = Math.min(max(), Math.max(HEADER + 40, start + startY - ev.clientY));
      this.apply();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      viewState.set('console.height', this.height);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  }

  private setWrap(v: boolean): void {
    this.softWrap = v;
    viewState.set('console.softWrap', v);
    this.toolbar.update('wrap', { toggled: v });
    this.out.classList.toggle('cn-wrap', v);
  }

  private setScrollToEnd(v: boolean): void {
    this.scrollToEnd = v;
    viewState.set('console.scrollToEnd', v);
    this.toolbar.update('end', { toggled: v });
    if (v) this.out.scrollTop = this.out.scrollHeight;
  }

  private render(l: ConsoleLine): HTMLElement {
    const row = h('div.cn-line', { class: `cn-${l.kind}`, dataset: { id: String(l.id) } });
    if (l.kind === 'command') {
      row.append(h('span.cn-time', null, `${formatConsoleTime(l.time)}: `), h('span.cn-cmd', null, l.text));
      row.title = l.exit !== undefined ? `${l.ms} ms, exit code ${l.exit}` : `${l.ms} ms`;
    } else row.textContent = l.text || '​';
    return row;
  }

  private append(added: ConsoleLine[]): void {
    if (!this.loaded) return;
    const fresh = added.filter((l) => l.id > this.lastId);
    if (!fresh.length) return;
    const out = this.out;
    const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 4;
    const frag = document.createDocumentFragment();
    for (const l of fresh) frag.appendChild(this.render(l));
    out.appendChild(frag);
    this.lines.push(...fresh);
    this.lastId = fresh[fresh.length - 1].id;
    const drop = this.lines.length - LIMIT;
    if (drop > 0) {
      this.lines.splice(0, drop);
      for (let i = 0; i < drop && out.firstChild; i++) out.firstChild.remove();
    }
    if (this.scrollToEnd || atEnd) out.scrollTop = out.scrollHeight;
  }

  private clear(): void {
    this.lines.length = 0;
    this.out.replaceChildren();
  }

  private selection(): string | undefined {
    const sel = document.getSelection();
    return sel && !sel.isCollapsed && this.out.contains(sel.anchorNode) ? sel.toString() : undefined;
  }

  private copy(all: boolean): void {
    const text = this.selection();
    if (!all && text !== undefined) void rpc.call('console.copyText', text);
    else void rpc.call('console.copy', { lines: this.lines, timestamps: true });
  }

  private selectAll(): void {
    const r = document.createRange();
    r.selectNodeContents(this.out);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }

  private menu(x: number, y: number): void {
    const items: MenuItem[] = [
      { label: 'Copy', disabled: this.selection() === undefined, run: () => this.copy(false) },
      { label: 'Copy All', disabled: !this.lines.length, run: () => this.copy(true) },
      { label: 'Select All', run: () => this.selectAll() },
      '-',
      { label: 'Soft-Wrap', checked: this.softWrap, run: () => this.setWrap(!this.softWrap) },
      { label: 'Scroll to End', checked: this.scrollToEnd, run: () => this.setScrollToEnd(!this.scrollToEnd) },
      '-',
      { label: 'Clear All', run: () => void rpc.call('console.clear') },
      '-',
      { label: 'Open in Output Panel', run: () => void rpc.call('console.openOutput') },
    ];
    showContextMenu(items, x, y, { section: 'console' });
  }
}
