// Action toolbars (horizontal or thin vertical): icon / text buttons with tooltips + shortcut hints, toggle buttons,
// dropdown buttons (▾), separators, spacers, custom elements; items that do not fit go into an overflow menu.
import { h, DisposableStore } from './dom';
import { icon } from './icons';
import { setTooltip } from './tooltip';
import { showDropdownMenu, type MenuItem, type MenuAction } from './menu';
import { ensureStyles } from './styles';

export interface ToolbarButton {
  id: string;
  icon?: string;
  iconColor?: string;
  label?: string;
  tooltip?: string;
  shortcut?: string;
  disabled?: boolean;
  /** defined → toggle button; true shows the selected state */
  toggled?: boolean;
  hidden?: boolean;
  /** function → clicking opens this menu; true → only shows ▾ and calls run */
  dropdown?: boolean | (() => MenuItem[]);
  run?(item: ToolbarButton, el: HTMLElement, e: MouseEvent | KeyboardEvent): void;
}
export type ToolbarItem = ToolbarButton | '-' | { type: 'spacer' } | { type: 'custom'; id?: string; element: HTMLElement };

export interface ToolbarOptions {
  items: ToolbarItem[];
  orientation?: 'horizontal' | 'vertical';
  overflow?: boolean;
  className?: string;
  ariaLabel?: string;
}

const isButton = (i: ToolbarItem): i is ToolbarButton => typeof i === 'object' && !('type' in i);

export class Toolbar {
  readonly element: HTMLElement;
  private items: ToolbarItem[] = [];
  private els = new Map<string, HTMLElement>();
  private readonly store = new DisposableStore();
  private itemStore = new DisposableStore();
  private overflowBtn: HTMLButtonElement;
  private ro: ResizeObserver | undefined;
  private readonly vertical: boolean;

  constructor(parent: HTMLElement | null, private readonly opts: ToolbarOptions) {
    ensureStyles();
    this.vertical = opts.orientation === 'vertical';
    this.element = h('div.jb-toolbar', {
      class: [this.vertical ? 'jb-toolbar-v' : 'jb-toolbar-h', opts.className],
      attrs: { role: 'toolbar', 'aria-label': opts.ariaLabel, 'aria-orientation': this.vertical ? 'vertical' : 'horizontal' },
      onKeydown: (e: KeyboardEvent) => this.onKey(e),
    });
    this.overflowBtn = h('button.jb-icon-btn.jb-toolbar-overflow', { type: 'button', tabIndex: -1, onClick: () => this.showOverflow() }, icon(this.vertical ? 'ellipsis' : 'chevron-right'));
    this.store.add(setTooltip(this.overflowBtn, 'More'));
    this.setItems(opts.items);
    if (opts.overflow !== false && typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(this.element);
    }
    parent?.appendChild(this.element);
  }

  setItems(items: ToolbarItem[]): void {
    this.items = items;
    this.render();
  }

  getItem(id: string): ToolbarButton | undefined {
    return this.items.find((i): i is ToolbarButton => isButton(i) && i.id === id);
  }

  getElement(id: string): HTMLElement | undefined {
    return this.els.get(id);
  }

  /** Patches a button (disabled, toggled, hidden, icon, label, tooltip …) and re-renders it. */
  update(id: string, patch: Partial<ToolbarButton>): void {
    const i = this.items.findIndex((x) => isButton(x) && x.id === id);
    if (i < 0) return;
    this.items[i] = { ...(this.items[i] as ToolbarButton), ...patch };
    this.render();
  }

  private render(): void {
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.tbId;
    this.itemStore.dispose();
    this.itemStore = new DisposableStore();
    this.els.clear();
    this.element.replaceChildren();
    let firstFocusable = true;
    for (const it of this.items) {
      if (it === '-') this.element.append(h(this.vertical ? 'div.jb-sep.jb-toolbar-sep' : 'div.jb-sep-v.jb-toolbar-sep'));
      else if (!isButton(it)) {
        if (it.type === 'spacer') this.element.append(h('div.jb-toolbar-spacer'));
        else {
          it.element.classList.add('jb-toolbar-custom');
          this.element.append(it.element);
          if (it.id) this.els.set(it.id, it.element);
        }
      } else {
        if (it.hidden) continue;
        const b = h('button.jb-icon-btn', {
          type: 'button',
          class: { 'jb-on': !!it.toggled, 'jb-has-label': !!it.label },
          disabled: !!it.disabled,
          tabIndex: firstFocusable && !it.disabled ? 0 : -1,
          dataset: { tbId: it.id },
          attrs: { 'aria-pressed': it.toggled !== undefined ? String(!!it.toggled) : undefined, 'aria-label': it.tooltip ?? it.label, 'aria-haspopup': it.dropdown ? 'menu' : undefined },
          onClick: (e: MouseEvent) => this.invoke(it, b, e),
        },
          it.icon ? icon(it.icon, { color: it.iconColor }) : null,
          it.label ? h('span.jb-btn-label', null, it.label) : null,
          it.dropdown ? h('span.jb-chevron') : null,
        );
        if (!it.disabled) firstFocusable = false;
        if (it.tooltip) this.itemStore.add(setTooltip(b, it.tooltip, { shortcut: it.shortcut, placement: this.vertical ? 'right' : 'below' }));
        this.els.set(it.id, b);
        this.element.append(b);
      }
    }
    this.element.append(this.overflowBtn);
    if (focusedId) this.els.get(focusedId)?.focus();
    this.layout();
  }

  private invoke(it: ToolbarButton, el: HTMLElement, e: MouseEvent | KeyboardEvent): void {
    if (it.disabled) return;
    if (typeof it.dropdown === 'function') {
      showDropdownMenu(it.dropdown(), el, { align: 'start' });
      return;
    }
    it.run?.(it, el, e);
  }

  private hiddenByOverflow: ToolbarButton[] = [];

  /** Re-measures and moves items that do not fit into the overflow menu. */
  layout(): void {
    if (this.opts.overflow === false || !this.element.isConnected) return;
    const children = [...this.element.children] as HTMLElement[];
    for (const c of children) c.classList.remove('jb-overflowed');
    this.overflowBtn.style.display = 'none';
    this.hiddenByOverflow = [];
    const size = () => (this.vertical ? this.element.scrollHeight > this.element.clientHeight + 1 : this.element.scrollWidth > this.element.clientWidth + 1);
    if (!size()) return;
    this.overflowBtn.style.display = '';
    const candidates = children.filter((c) => c !== this.overflowBtn && !c.classList.contains('jb-toolbar-spacer'));
    for (let i = candidates.length - 1; i >= 0 && size(); i--) {
      const c = candidates[i];
      c.classList.add('jb-overflowed');
      const id = c.dataset.tbId;
      const it = id ? this.getItem(id) : undefined;
      if (it) this.hiddenByOverflow.unshift(it);
    }
  }

  private showOverflow(): void {
    const items: MenuItem[] = this.hiddenByOverflow.map((it): MenuAction => ({
      label: it.tooltip ?? it.label ?? it.id,
      icon: it.icon,
      shortcut: it.shortcut,
      disabled: it.disabled,
      checked: it.toggled === undefined ? undefined : it.toggled,
      submenu: typeof it.dropdown === 'function' ? it.dropdown : undefined,
      run: () => it.run?.(it, this.overflowBtn, new MouseEvent('click')),
    }));
    showDropdownMenu(items, this.overflowBtn, { align: this.vertical ? 'start' : 'end' });
  }

  /** Roving focus with arrow keys between enabled buttons. */
  private onKey(e: KeyboardEvent): void {
    const next = this.vertical ? 'ArrowDown' : 'ArrowRight';
    const prev = this.vertical ? 'ArrowUp' : 'ArrowLeft';
    if (e.key !== next && e.key !== prev && e.key !== 'Home' && e.key !== 'End') return;
    const btns = ([...this.element.querySelectorAll('button.jb-icon-btn')] as HTMLButtonElement[]).filter((b) => !b.disabled && !b.classList.contains('jb-overflowed') && b.offsetParent !== null);
    if (!btns.length) return;
    const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
    let i = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : cur + (e.key === next ? 1 : -1);
    i = (i + btns.length) % btns.length;
    btns.forEach((b, k) => (b.tabIndex = k === i ? 0 : -1));
    btns[i].focus();
    e.preventDefault();
  }

  dispose(): void {
    this.ro?.disconnect();
    this.itemStore.dispose();
    this.store.dispose();
    this.element.remove();
  }
}
