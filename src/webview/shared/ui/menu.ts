// Context / dropdown menus (IntelliJ action popups): icons, shortcuts, checked & radio items, disabled, separators,
// headers, nested submenus, keyboard navigation, closes on Esc / blur / outside click, positioned within the viewport.
import { h, listen, DisposableStore } from './dom';
import { icon } from './icons';
import { formatShortcut } from './format';
import { ensureStyles } from './styles';
import { hideTooltip } from './tooltip';

export interface MenuAction {
  label: string;
  id?: string;
  icon?: string;
  iconColor?: string;
  shortcut?: string;
  checked?: boolean;
  /** render the checked mark as a radio dot */
  radio?: boolean;
  disabled?: boolean;
  /** grey text after the label */
  description?: string;
  run?(): void;
  submenu?: MenuItem[] | (() => MenuItem[]);
}
export type MenuItem = '-' | { header: string } | MenuAction;

export interface MenuHandle {
  readonly element: HTMLElement;
  close(): void;
  readonly closed: Promise<void>;
}

export interface MenuOptions {
  minWidth?: number;
  onClose?(): void;
}

const isAction = (i: MenuItem): i is MenuAction => typeof i === 'object' && 'label' in i;

let openRoot: MenuPopup | undefined;

class MenuPopup {
  readonly element: HTMLElement;
  private rows: { item: MenuAction; el: HTMLElement }[] = [];
  private active = -1;
  private sub: MenuPopup | undefined;
  private subTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly store = new DisposableStore();
  private closedResolve!: () => void;
  readonly closed = new Promise<void>((r) => (this.closedResolve = r));
  private isClosed = false;
  private restoreFocus: HTMLElement | null = null;

  constructor(
    items: MenuItem[],
    private readonly parent: MenuPopup | undefined,
    private readonly opts: MenuOptions,
  ) {
    ensureStyles();
    hideTooltip();
    this.element = h('div.jb-menu.jb-popup-surface', { tabIndex: -1, attrs: { role: 'menu' } });
    if (opts.minWidth) this.element.style.minWidth = `${opts.minWidth}px`;
    const hasGutter = items.some((i) => isAction(i) && (i.icon || i.checked !== undefined));
    const cleaned = items.filter((it, i, arr) => it !== '-' || (i > 0 && i < arr.length - 1 && arr[i - 1] !== '-'));
    for (const it of cleaned) {
      if (it === '-') this.element.append(h('div.jb-menu-sep', { attrs: { role: 'separator' } }));
      else if (!isAction(it)) this.element.append(h('div.jb-menu-header', null, it.header));
      else {
        const idx = this.rows.length;
        const gutter = hasGutter
          ? h('span.jb-menu-gutter', null,
              it.checked ? icon(it.radio ? 'circle-small-filled' : 'check') : it.icon ? icon(it.icon, { color: it.iconColor }) : null)
          : null;
        const row = h('div.jb-menu-item', {
          class: { 'jb-disabled': it.disabled },
          attrs: { role: it.checked !== undefined ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem', 'aria-disabled': it.disabled ? 'true' : undefined, 'aria-checked': it.checked !== undefined ? String(!!it.checked) : undefined, 'aria-haspopup': it.submenu ? 'menu' : undefined },
          onMouseenter: () => this.hover(idx),
          onMousedown: (e: MouseEvent) => e.preventDefault(),
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            this.activate(idx, false);
          },
        },
          gutter,
          h('span.jb-menu-label', null, it.label, it.description ? h('span.jb-menu-desc', null, ` ${it.description}`) : null),
          it.shortcut ? h('span.jb-menu-shortcut', null, formatShortcut(it.shortcut)) : null,
          it.submenu ? icon('chevron-right', { className: 'jb-menu-arrow' }) : null,
        );
        this.rows.push({ item: it, el: row });
        this.element.append(row);
      }
    }
    if (!this.rows.length) this.element.append(h('div.jb-menu-header', null, 'Nothing here'));
    this.store.add(listen(this.element, 'keydown', (e) => this.onKey(e)));
    this.store.add(listen(this.element, 'contextmenu', (e) => e.preventDefault()));
    this.store.add(listen(this.element, 'mouseleave', () => {
      if (!this.sub) this.setActive(-1);
    }));
    document.body.appendChild(this.element);
    if (!parent) {
      this.restoreFocus = document.activeElement as HTMLElement | null;
      const outside = (e: Event) => {
        const t = e.target as Node;
        for (let m: MenuPopup | undefined = this; m; m = m.sub) if (m.element.contains(t)) return;
        this.close();
      };
      this.store.add(listen(document, 'mousedown', outside, true));
      this.store.add(listen(document, 'contextmenu', outside, true));
      this.store.add(listen(window, 'blur', () => this.close()));
      this.store.add(listen(window, 'resize', () => this.close()));
      this.store.add(listen(document, 'wheel', (e) => outside(e), { capture: true, passive: true }));
    }
  }

  placeAt(x: number, y: number, flipX?: number): void {
    const el = this.element;
    el.style.maxHeight = `${window.innerHeight - 8}px`;
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (x + w > vw - 4) x = flipX !== undefined ? Math.max(4, flipX - w) : Math.max(4, vw - w - 4);
    if (y + hgt > vh - 4) y = Math.max(4, vh - hgt - 4);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  placeBelow(anchor: Element, align: 'start' | 'end'): void {
    const r = anchor.getBoundingClientRect();
    const el = this.element;
    el.style.maxHeight = `${window.innerHeight - 8}px`;
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let x = align === 'end' ? r.right - w : r.left;
    let y = r.bottom + 2;
    if (y + hgt > window.innerHeight - 4 && r.top - hgt - 2 >= 4) y = r.top - hgt - 2;
    else if (y + hgt > window.innerHeight - 4) {
      y = Math.max(4, window.innerHeight - hgt - 4);
    }
    x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  focus(selectFirst: boolean): void {
    this.element.focus({ preventScroll: true });
    if (selectFirst) this.move(1, -1);
  }

  private setActive(i: number): void {
    if (this.active >= 0) this.rows[this.active]?.el.classList.remove('jb-active');
    this.active = i;
    const r = this.rows[i];
    if (r) {
      r.el.classList.add('jb-active');
      r.el.scrollIntoView({ block: 'nearest' });
    }
  }

  private hover(i: number): void {
    this.setActive(i);
    if (this.subTimer) clearTimeout(this.subTimer);
    const it = this.rows[i].item;
    if (this.sub && this.sub.ownerIndex !== i) this.closeSub();
    if (it.submenu && !it.disabled && !this.sub) this.subTimer = setTimeout(() => this.openSub(i, false), 180);
  }

  ownerIndex = -1;

  private openSub(i: number, focus: boolean): void {
    const it = this.rows[i].item;
    if (!it.submenu) return;
    if (this.sub?.ownerIndex === i) {
      if (focus) this.sub.focus(true);
      return;
    }
    this.closeSub();
    const items = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
    const sub = new MenuPopup(items, this, {});
    sub.ownerIndex = i;
    this.sub = sub;
    const r = this.rows[i].el.getBoundingClientRect();
    const mine = this.element.getBoundingClientRect();
    sub.placeAt(mine.right - 2, r.top - 5, mine.left + 2);
    if (focus) sub.focus(true);
  }

  private closeSub(): void {
    if (this.sub) {
      this.sub.dispose();
      this.sub = undefined;
    }
  }

  private activate(i: number, keyboard: boolean): void {
    const it = this.rows[i]?.item;
    if (!it || it.disabled) return;
    if (it.submenu) {
      this.openSub(i, keyboard);
      return;
    }
    this.root().close();
    it.run?.();
  }

  private root(): MenuPopup {
    let m: MenuPopup = this;
    while (m.parent) m = m.parent;
    return m;
  }

  private move(dir: 1 | -1, from = this.active): void {
    const n = this.rows.length;
    if (!n) return;
    let i = from;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (i < 0) i = n - 1;
      if (!this.rows[i].item.disabled) {
        this.setActive(i);
        return;
      }
    }
  }

  private onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
        this.move(1);
        break;
      case 'ArrowUp':
        this.move(-1, this.active < 0 ? 0 : this.active);
        break;
      case 'Home':
        this.move(1, -1);
        break;
      case 'End':
        this.move(-1, 0);
        break;
      case 'ArrowRight':
        if (this.active >= 0 && this.rows[this.active].item.submenu) this.openSub(this.active, true);
        break;
      case 'ArrowLeft':
        if (this.parent) {
          const p = this.parent;
          p.closeSub();
          p.focus(false);
        }
        break;
      case 'Enter':
      case ' ':
        if (this.active >= 0) this.activate(this.active, true);
        break;
      case 'Escape':
        if (this.parent) {
          const p = this.parent;
          p.closeSub();
          p.focus(false);
        } else this.close();
        break;
      case 'Tab':
        this.root().close();
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const n = this.rows.length;
          for (let k = 1; k <= n; k++) {
            const i = (this.active + k + n) % n;
            const r = this.rows[i];
            if (!r.item.disabled && r.item.label.toLowerCase().startsWith(ch)) {
              this.setActive(i);
              break;
            }
          }
        } else return;
    }
    e.preventDefault();
  }

  close(): void {
    if (this.isClosed) return;
    const hadFocus = this.element.contains(document.activeElement) || !!this.sub?.element.contains(document.activeElement);
    this.dispose();
    if (openRoot === this) openRoot = undefined;
    if (hadFocus && this.restoreFocus?.isConnected) this.restoreFocus.focus({ preventScroll: true });
    this.opts.onClose?.();
  }

  dispose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.subTimer) clearTimeout(this.subTimer);
    this.closeSub();
    this.store.dispose();
    this.element.remove();
    this.closedResolve();
  }
}

function handle(m: MenuPopup): MenuHandle {
  return { element: m.element, close: () => m.close(), closed: m.closed };
}

/** Opens a context menu at client coordinates (closes any other open menu). */
export function showContextMenu(items: MenuItem[], x: number, y: number, opts: MenuOptions & { selectFirst?: boolean } = {}): MenuHandle {
  openRoot?.close();
  const m = new MenuPopup(items, undefined, opts);
  openRoot = m;
  m.placeAt(x, y);
  m.focus(!!opts.selectFirst);
  return handle(m);
}

/** Opens a menu below (or above, if no room) an anchor element. */
export function showDropdownMenu(items: MenuItem[], anchor: Element, opts: MenuOptions & { align?: 'start' | 'end'; selectFirst?: boolean } = {}): MenuHandle {
  openRoot?.close();
  const m = new MenuPopup(items, undefined, { minWidth: opts.minWidth, onClose: () => {
    anchor.classList.remove('jb-pressed', 'jb-open');
    opts.onClose?.();
  } });
  openRoot = m;
  anchor.classList.add('jb-pressed');
  m.placeBelow(anchor, opts.align ?? 'start');
  m.focus(opts.selectFirst ?? true);
  return handle(m);
}

export function closeMenus(): void {
  openRoot?.close();
}

/** Position for a keyboard-invoked context menu (Shift+F10 / ContextMenu key) on an element. */
export function contextMenuPoint(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(40, r.width / 2), y: r.bottom - 2 };
}
