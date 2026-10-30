// IntelliJ-like hover tooltips (single floating element): text + grey shortcut, delayed, kept within the viewport.
import { h, listen, DisposableStore, type Disposable } from './dom';
import { formatShortcut } from './format';
import { ensureStyles } from './styles';

export type TooltipContent = string | Node | undefined | null;

export interface TooltipOptions {
  shortcut?: string;
  /** ms before showing (default 600) */
  delay?: number;
  placement?: 'below' | 'above' | 'right';
}

let tipEl: HTMLElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastHidden = 0;
let current: Element | undefined;

function el(): HTMLElement {
  if (!tipEl) {
    ensureStyles();
    tipEl = h('div.jb-tooltip', { attrs: { role: 'tooltip' } });
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

type Anchor = Element | { x: number; y: number };

/** Shows a tooltip immediately at an element or point. */
export function showTooltip(anchor: Anchor, content: TooltipContent, opts: TooltipOptions = {}): void {
  if (content === undefined || content === null || content === '') return hideTooltip();
  const t = el();
  t.replaceChildren();
  t.append(typeof content === 'string' ? h('span.jb-tooltip-text', null, content) : content);
  if (opts.shortcut) t.append(h('span.jb-tooltip-shortcut', null, formatShortcut(opts.shortcut)));
  t.style.visibility = 'hidden';
  t.classList.add('jb-visible');
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : new DOMRect(anchor.x, anchor.y, 0, 16);
  const tw = t.offsetWidth;
  const th = t.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x: number;
  let y: number;
  if (opts.placement === 'right') {
    x = r.right + 6;
    y = r.top + (r.height - th) / 2;
  } else {
    // small anchors (buttons): centered below; wide anchors / points: left-aligned
    x = anchor instanceof Element ? (r.width < 80 ? r.left + (r.width - tw) / 2 : r.left) : r.left + 10;
    y = opts.placement === 'above' ? r.top - th - 6 : r.bottom + 6;
    if (y + th > vh - 4) y = r.top - th - 6;
    if (y < 4) y = Math.min(vh - th - 4, r.bottom + 6);
  }
  x = Math.max(4, Math.min(x, vw - tw - 4));
  y = Math.max(4, Math.min(y, vh - th - 4));
  t.style.left = `${Math.round(x)}px`;
  t.style.top = `${Math.round(y)}px`;
  t.style.visibility = '';
  current = anchor instanceof Element ? anchor : undefined;
}

export function hideTooltip(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (tipEl?.classList.contains('jb-visible')) {
    tipEl.classList.remove('jb-visible');
    lastHidden = Date.now();
  }
  current = undefined;
}

/** Shows `content` when hovering `target` (content may be computed lazily). Returns a Disposable. */
export function setTooltip(target: HTMLElement, content: TooltipContent | (() => TooltipContent), opts: TooltipOptions = {}): Disposable {
  const store = new DisposableStore();
  const resolve = () => (typeof content === 'function' ? content() : content);
  if (typeof content === 'string' && !target.hasAttribute('aria-label')) target.setAttribute('aria-label', content);
  store.add(
    listen(target, 'mouseenter', () => {
      if (timer) clearTimeout(timer);
      const delay = Date.now() - lastHidden < 400 ? 0 : (opts.delay ?? 600);
      timer = setTimeout(() => {
        if (target.isConnected) showTooltip(target, resolve(), opts);
      }, delay);
    }),
  );
  store.add(listen(target, 'mouseleave', () => hideTooltip()));
  store.add(listen(target, 'mousedown', () => hideTooltip()));
  store.add({ dispose: () => current === target && hideTooltip() });
  return store;
}

/** Hover tooltip whose content depends on the hovered descendant (tables/trees): resolve(target, event). */
export function delegateTooltip(container: HTMLElement, resolve: (e: MouseEvent) => { anchor: Anchor; content: TooltipContent; key: unknown } | undefined, delay = 600): Disposable {
  const store = new DisposableStore();
  let key: unknown;
  store.add(
    listen(container, 'mousemove', (e) => {
      const r = resolve(e);
      if (!r) {
        key = undefined;
        hideTooltip();
        return;
      }
      if (r.key === key) return;
      key = r.key;
      hideTooltip();
      timer = setTimeout(() => showTooltip(r.anchor, r.content), Date.now() - lastHidden < 400 ? 0 : delay);
    }),
  );
  store.add(
    listen(container, 'mouseleave', () => {
      key = undefined;
      hideTooltip();
    }),
  );
  store.add(listen(container, 'mousedown', () => hideTooltip()));
  store.add(listen(container, 'wheel', () => {
    key = undefined;
    hideTooltip();
  }, { passive: true }));
  return store;
}
