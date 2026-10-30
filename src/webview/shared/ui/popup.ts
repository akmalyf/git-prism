// Anchored list popup with speed-search field and optional multi-select checkboxes (IntelliJ list popups used by
// the Log filters Branch/User/Date/Paths, "last commit ▾", branch pickers…). Resolves with the picked values.
import { h, listen, DisposableStore, highlightText } from './dom';
import { icon } from './icons';
import { matchText } from './match';
import { ensureStyles } from './styles';
import { closeMenus } from './menu';
import { hideTooltip } from './tooltip';

export interface PopupItem<V> {
  value: V;
  label: string;
  icon?: string;
  iconColor?: string;
  /** grey text after the label */
  description?: string;
  /** right-aligned grey text */
  trailing?: string;
  checked?: boolean;
  disabled?: boolean;
  searchText?: string;
  tooltip?: string;
  /** in multi-select popups: selecting it applies immediately (e.g. "Select…", "All") */
  action?: boolean;
}
export type PopupEntry<V> = PopupItem<V> | { header: string } | '-';

export interface ListPopupOptions<V> {
  items: PopupEntry<V>[];
  title?: string;
  multiSelect?: boolean;
  /** show the search field (default: true when more than 10 items) */
  search?: boolean;
  placeholder?: string;
  emptyText?: string;
  width?: number;
  maxHeight?: number;
  align?: 'start' | 'end';
  /** initially active value */
  active?: V;
}

const isItem = <V>(e: PopupEntry<V>): e is PopupItem<V> => typeof e === 'object' && 'value' in e;

let openPopup: { cancel(): void } | undefined;

/** Opens the popup below the anchor (or at a point). Resolves with picked values, or undefined when cancelled. */
export function showListPopup<V>(anchor: Element | { x: number; y: number }, o: ListPopupOptions<V>): Promise<V[] | undefined> {
  ensureStyles();
  closeMenus();
  hideTooltip();
  openPopup?.cancel();
  return new Promise((resolve) => {
    const store = new DisposableStore();
    const restore = document.activeElement as HTMLElement | null;
    const multi = !!o.multiSelect;
    const checked = new Set<number>();
    const entries = o.items;
    entries.forEach((e, i) => isItem(e) && e.checked && checked.add(i));
    const showSearch = o.search ?? entries.filter(isItem).length > 10;

    const input = h('input.jb-popup-search-input', { type: 'text', placeholder: o.placeholder ?? '', spellcheck: false });
    const list = h('div.jb-popup-list', { attrs: { role: 'listbox', 'aria-multiselectable': multi ? 'true' : undefined } });
    const empty = h('div.jb-popup-empty', null, o.emptyText ?? 'Nothing to show');
    const el = h('div.jb-popup.jb-popup-surface', { tabIndex: -1, style: { width: o.width ? `${o.width}px` : undefined } },
      o.title ? h('div.jb-popup-title', null, o.title) : null,
      showSearch ? h('div.jb-popup-search', null, icon('search'), input) : null,
      list,
    );
    let rows: { idx: number; el: HTMLElement }[] = [];
    let active = -1;

    const render = () => {
      const q = input.value.trim();
      list.replaceChildren();
      rows = [];
      let pendingHeader: HTMLElement | null = null;
      let pendingSep = false;
      let any = false;
      entries.forEach((e, idx) => {
        if (e === '-') {
          pendingSep = any;
          return;
        }
        if (!isItem(e)) {
          pendingHeader = h('div.jb-popup-header', null, e.header);
          return;
        }
        const ranges = q ? matchText(q, e.searchText ?? e.label) : [];
        if (!ranges) return;
        const labelRanges = e.searchText ? matchText(q, e.label) : ranges;
        if (pendingSep) list.append(h('div.jb-menu-sep'));
        if (pendingHeader) list.append(pendingHeader);
        pendingSep = false;
        pendingHeader = null;
        any = true;
        const box = multi && !e.action ? h('input.jb-check', { type: 'checkbox', tabIndex: -1, checked: checked.has(idx), disabled: !!e.disabled }) : null;
        const row = h('div.jb-popup-item', {
          class: { 'jb-disabled': e.disabled },
          title: e.tooltip,
          attrs: { role: 'option', 'aria-selected': multi ? String(checked.has(idx)) : undefined, 'aria-disabled': e.disabled ? 'true' : undefined },
          onMousemove: () => setActive(rows.findIndex((r) => r.idx === idx)),
          onMousedown: (ev: MouseEvent) => ev.preventDefault(),
          onClick: () => pick(idx),
        },
          box,
          e.icon ? icon(e.icon, { color: e.iconColor }) : multi ? null : h('span.jb-popup-noicon'),
          h('span.jb-popup-label', null, highlightText(e.label, labelRanges)),
          e.description ? h('span.jb-popup-desc', null, e.description) : null,
          e.trailing ? h('span.jb-popup-trailing', null, e.trailing) : null,
        );
        rows.push({ idx, el: row });
        list.append(row);
      });
      if (!any) list.append(empty);
      const want = o.active !== undefined && !q ? rows.findIndex((r) => (entries[r.idx] as PopupItem<V>).value === o.active) : -1;
      active = -1;
      setActive(want >= 0 ? want : rows.findIndex((r) => !(entries[r.idx] as PopupItem<V>).disabled));
    };

    const setActive = (i: number) => {
      if (i === active) return;
      rows[active]?.el.classList.remove('jb-active');
      active = i;
      const r = rows[i];
      if (r) {
        r.el.classList.add('jb-active');
        r.el.scrollIntoView({ block: 'nearest' });
      }
    };

    let done = false;
    const finish = (result: V[] | undefined) => {
      if (done) return;
      done = true;
      store.dispose();
      el.remove();
      if (openPopup === handle) openPopup = undefined;
      if (restore?.isConnected) restore.focus({ preventScroll: true });
      resolve(result);
    };
    const checkedValues = () => [...checked].sort((a, b) => a - b).map((i) => (entries[i] as PopupItem<V>).value);
    const apply = () => finish(checkedValues());
    const handle = { cancel: () => finish(undefined) };
    openPopup = handle;

    const pick = (idx: number) => {
      const e = entries[idx] as PopupItem<V>;
      if (e.disabled) return;
      if (!multi || e.action) return finish([e.value]);
      if (checked.has(idx)) checked.delete(idx);
      else checked.add(idx);
      const r = rows.find((x) => x.idx === idx);
      const cb = r?.el.querySelector('input') as HTMLInputElement | null;
      if (cb) cb.checked = checked.has(idx);
      r?.el.setAttribute('aria-selected', String(checked.has(idx)));
    };

    const move = (d: number) => {
      if (!rows.length) return;
      let i = active;
      for (let k = 0; k < rows.length; k++) {
        i = (i + d + rows.length) % rows.length;
        if (!(entries[rows[i].idx] as PopupItem<V>).disabled) return setActive(i);
      }
    };

    store.add(listen(el, 'keydown', (e) => {
      e.stopPropagation();
      const pageRows = Math.max(1, Math.floor(list.clientHeight / 24) - 1);
      switch (e.key) {
        case 'ArrowDown':
          move(1);
          break;
        case 'ArrowUp':
          move(-1);
          break;
        case 'PageDown':
          setActive(Math.min(rows.length - 1, active + pageRows));
          break;
        case 'PageUp':
          setActive(Math.max(0, active - pageRows));
          break;
        case 'Enter':
          if (multi) {
            const cur = rows[active] ? (entries[rows[active].idx] as PopupItem<V>) : undefined;
            if (checked.size) apply();
            else if (cur && !cur.disabled) finish([cur.value]);
            else finish(undefined);
          } else if (rows[active]) pick(rows[active].idx);
          break;
        case ' ':
          if (multi && rows[active] && (!showSearch || !input.value || document.activeElement !== input)) pick(rows[active].idx);
          else return;
          break;
        case 'Escape':
          if (showSearch && input.value) {
            input.value = '';
            render();
          } else finish(undefined);
          break;
        case 'Tab':
          break;
        default:
          if (showSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && document.activeElement !== input) {
            input.focus();
          }
          return;
      }
      e.preventDefault();
    }));
    store.add(listen(input, 'input', render));
    const outside = (e: Event) => {
      if (!el.contains(e.target as Node)) multi ? apply() : finish(undefined);
    };
    store.add(listen(document, 'mousedown', outside, true));
    store.add(listen(window, 'blur', () => (multi ? apply() : finish(undefined))));
    store.add(listen(window, 'resize', () => finish(undefined)));

    document.body.appendChild(el);
    render();
    // position
    const maxH = o.maxHeight ?? 420;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : new DOMRect(anchor.x, anchor.y, 0, 0);
    if (!o.width && anchor instanceof Element) el.style.minWidth = `${Math.max(220, r.width)}px`;
    const below = vh - r.bottom - 6;
    const above = r.top - 6;
    const room = Math.max(below, above);
    el.style.maxHeight = `${Math.min(maxH, room)}px`;
    const w = el.offsetWidth;
    const hh = el.offsetHeight;
    let x = o.align === 'end' ? r.right - w : r.left;
    let y = r.bottom + 2;
    if (hh > below && above > below) y = r.top - hh - 2;
    x = Math.max(4, Math.min(x, vw - w - 4));
    y = Math.max(4, Math.min(y, vh - hh - 4));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    if (showSearch) input.focus();
    else el.focus();
  });
}
