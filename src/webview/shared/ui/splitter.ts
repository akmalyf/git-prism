// Two-pane splitter (IntelliJ OnePixelSplitter): horizontal (side by side) or vertical (stacked), drag / keyboard
// resize, size in px of the fixed pane or a proportion, min sizes, collapse, persisted per stateKey.
import { h, listen, DisposableStore, Emitter } from './dom';
import { loadState, saveState } from './persist';
import { ensureStyles } from './styles';

export interface SplitterOptions {
  orientation?: 'horizontal' | 'vertical';
  first: HTMLElement;
  second: HTMLElement;
  /** px of the fixed pane, or 0..1 of the first pane when proportional */
  size: number;
  fixed?: 'first' | 'second';
  proportional?: boolean;
  /** min px of the fixed (or first, when proportional) pane */
  min?: number;
  /** min px of the other pane */
  minOther?: number;
  stateKey?: string;
  collapsible?: boolean;
  collapsed?: boolean;
}

interface Persisted {
  size: number;
  collapsed: boolean;
}

export class Splitter {
  readonly element: HTMLElement;
  readonly divider: HTMLElement;
  private size: number;
  private collapsed: boolean;
  private readonly horizontal: boolean;
  private readonly fixedFirst: boolean;
  private readonly store = new DisposableStore();
  private readonly resized = new Emitter<number>();
  readonly onDidResize = this.resized.event;
  private ro: ResizeObserver | undefined;

  constructor(parent: HTMLElement | null, private readonly o: SplitterOptions) {
    ensureStyles();
    this.horizontal = (o.orientation ?? 'horizontal') === 'horizontal';
    this.fixedFirst = (o.fixed ?? 'first') === 'first';
    const saved = loadState<Persisted | undefined>(o.stateKey ? `split.${o.stateKey}` : undefined, undefined);
    this.size = saved?.size ?? o.size;
    this.collapsed = saved?.collapsed ?? !!o.collapsed;
    o.first.classList.add('jb-split-pane');
    o.second.classList.add('jb-split-pane');
    this.divider = h('div.jb-split-divider', {
      tabIndex: 0,
      attrs: { role: 'separator', 'aria-orientation': this.horizontal ? 'vertical' : 'horizontal' },
    });
    this.element = h('div.jb-split', { class: this.horizontal ? 'jb-split-h' : 'jb-split-v' }, o.first, this.divider, o.second);
    this.store.add(listen(this.divider, 'pointerdown', (e) => this.startDrag(e)));
    this.store.add(listen(this.divider, 'dblclick', () => o.collapsible && this.setCollapsed(!this.collapsed)));
    this.store.add(listen(this.divider, 'keydown', (e) => this.onKey(e)));
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.apply());
      this.ro.observe(this.element);
    }
    parent?.appendChild(this.element);
    this.apply();
  }

  getSize(): number {
    return this.size;
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  setSize(size: number, persist = true): void {
    this.size = size;
    this.apply();
    if (persist) this.persist();
    this.resized.fire(this.size);
  }

  /** Collapses the fixed pane (the first one when proportional). */
  setCollapsed(c: boolean): void {
    if (this.collapsed === c) return;
    this.collapsed = c;
    this.apply();
    this.persist();
    this.resized.fire(this.size);
  }

  toggleCollapsed(): void {
    this.setCollapsed(!this.collapsed);
  }

  private total(): number {
    const r = this.element.getBoundingClientRect();
    return (this.horizontal ? r.width : r.height) - 1;
  }

  private clamp(px: number, total: number): number {
    const min = this.o.min ?? 40;
    const minOther = this.o.minOther ?? 40;
    if (total <= 0) return px;
    return Math.max(Math.min(min, total), Math.min(px, total - minOther));
  }

  private apply(): void {
    const { first, second } = this.o;
    const prop = this.horizontal ? 'width' : 'height';
    const collapsedPane = this.o.proportional || this.fixedFirst ? first : second;
    const fixedPane = this.fixedFirst || this.o.proportional ? first : second;
    const flexPane = fixedPane === first ? second : first;
    first.classList.toggle('jb-hidden', false);
    second.classList.toggle('jb-hidden', false);
    this.divider.classList.toggle('jb-hidden', this.collapsed);
    if (this.collapsed) {
      collapsedPane.classList.add('jb-hidden');
      flexPane.style.flex = '1 1 0';
      fixedPane.style.flex = '1 1 0';
      return;
    }
    const total = this.total();
    let px = this.o.proportional ? this.size * total : this.size;
    px = this.clamp(px, total);
    fixedPane.style.flex = `0 0 ${Math.round(px)}px`;
    fixedPane.style[prop] = '';
    flexPane.style.flex = '1 1 0';
  }

  private persist(): void {
    if (this.o.stateKey) saveState(`split.${this.o.stateKey}`, { size: this.size, collapsed: this.collapsed } satisfies Persisted);
  }

  private startDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = this.horizontal ? e.clientX : e.clientY;
    const total = this.total();
    const startPx = this.o.proportional ? this.size * total : this.size;
    this.divider.setPointerCapture(e.pointerId);
    this.divider.classList.add('jb-dragging');
    document.body.classList.add(this.horizontal ? 'jb-resizing-h' : 'jb-resizing-v');
    const move = (ev: PointerEvent) => {
      const d = (this.horizontal ? ev.clientX : ev.clientY) - start;
      const px = this.clamp(startPx + (this.fixedFirst || this.o.proportional ? d : -d), total);
      this.size = this.o.proportional ? px / total : px;
      this.apply();
      this.resized.fire(this.size);
    };
    const up = () => {
      this.divider.removeEventListener('pointermove', move);
      this.divider.removeEventListener('pointerup', up);
      this.divider.removeEventListener('pointercancel', up);
      this.divider.classList.remove('jb-dragging');
      document.body.classList.remove('jb-resizing-h', 'jb-resizing-v');
      this.persist();
    };
    this.divider.addEventListener('pointermove', move);
    this.divider.addEventListener('pointerup', up);
    this.divider.addEventListener('pointercancel', up);
  }

  private onKey(e: KeyboardEvent): void {
    const dec = this.horizontal ? 'ArrowLeft' : 'ArrowUp';
    const inc = this.horizontal ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    const total = this.total();
    const step = e.shiftKey ? 50 : 10;
    const sign = (e.key === inc ? 1 : -1) * (this.fixedFirst || this.o.proportional ? 1 : -1);
    const cur = this.o.proportional ? this.size * total : this.size;
    const px = this.clamp(cur + sign * step, total);
    this.setSize(this.o.proportional ? px / total : px);
  }

  dispose(): void {
    this.ro?.disconnect();
    this.store.dispose();
    this.resized.dispose();
    this.element.remove();
  }
}
