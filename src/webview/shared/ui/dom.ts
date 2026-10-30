// DOM helpers: h() element builder, class names, escaping, listeners, match highlighting.
import { toDisposable, type Disposable } from './events';
import type { MatchRange } from './match';
import { isMacPlatform } from './format';

export * from './events';

export type Child = Node | string | number | null | undefined | false | Child[];
export type ClassValue = string | null | undefined | false | ClassValue[] | Record<string, boolean | undefined>;

export interface Props {
  class?: ClassValue;
  style?: string | Partial<Record<keyof CSSStyleDeclaration | `--${string}`, string | number>>;
  dataset?: Record<string, string | undefined>;
  attrs?: Record<string, string | number | boolean | undefined>;
  [key: string]: unknown;
}

/** Joins class names: cls('a', cond && 'b', { c: true }) → 'a b c'. */
export function cls(...args: ClassValue[]): string {
  const out: string[] = [];
  const add = (v: ClassValue) => {
    if (!v) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(add);
    else for (const k in v) if (v[k]) out.push(k);
  };
  args.forEach(add);
  return out.join(' ');
}

export function append(el: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, ...c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * Element builder. `tag` may carry classes ('div.jb-island.foo'). Props: class, style, dataset, attrs,
 * on<Event> handlers (onClick → 'click'), anything else is assigned as a DOM property.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K | `${K}.${string}`, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const key in props) {
      const v = props[key];
      if (v === undefined) continue;
      if (key === 'class') {
        const c = cls(v as ClassValue);
        if (c) el.className = el.className ? `${el.className} ${c}` : c;
      } else if (key === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else
          for (const [k, sv] of Object.entries(v as object)) {
            if (sv === undefined) continue;
            if (k.startsWith('--')) el.style.setProperty(k, String(sv));
            else (el.style as unknown as Record<string, string>)[k] = typeof sv === 'number' && !/^(opacity|zIndex|flex|flexGrow|flexShrink|order|fontWeight|lineHeight)$/.test(k) ? `${sv}px` : String(sv);
          }
      } else if (key === 'dataset') {
        for (const [k, dv] of Object.entries(v as Record<string, string | undefined>)) if (dv !== undefined) el.dataset[k] = dv;
      } else if (key === 'attrs') {
        for (const [k, av] of Object.entries(v as Record<string, unknown>)) {
          if (av === undefined || av === false) continue;
          el.setAttribute(k, av === true ? '' : String(av));
        }
      } else if (key.length > 2 && key.startsWith('on') && typeof v === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), v as EventListener);
      } else {
        (el as unknown as Record<string, unknown>)[key] = v;
      }
    }
  }
  append(el, ...children);
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function setChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, ...children);
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

/** addEventListener returning a Disposable. */
export function listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions | boolean): Disposable;
export function listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions | boolean): Disposable;
export function listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions | boolean): Disposable;
export function listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions | boolean): Disposable;
export function listen(target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions | boolean): Disposable {
  target.addEventListener(type, fn as EventListener, opts);
  return toDisposable(() => target.removeEventListener(type, fn as EventListener, opts));
}

/** Text with <mark class="jb-match"> around the given [start,end) ranges. */
export function highlightText(text: string, ranges: readonly MatchRange[] | null | undefined): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!ranges || !ranges.length) {
    frag.append(text);
    return frag;
  }
  let pos = 0;
  for (const [a, b] of ranges) {
    const s = Math.max(a, pos);
    const e = Math.min(b, text.length);
    if (e <= s) continue;
    if (s > pos) frag.append(text.slice(pos, s));
    const m = document.createElement('mark');
    m.className = 'jb-match';
    m.textContent = text.slice(s, e);
    frag.append(m);
    pos = e;
  }
  if (pos < text.length) frag.append(text.slice(pos));
  return frag;
}

export const isMac = isMacPlatform();

/** Cmd on macOS, Ctrl elsewhere. */
export function isCtrlCmd(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** True when the key event targets an editable control (inputs, textareas, contenteditable). */
export function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit'].includes(t.type);
  return t instanceof HTMLSelectElement;
}

let idSeq = 0;
export function uid(prefix = 'jb'): string {
  return `${prefix}-${++idSeq}`;
}

/** Calls fn at most once per animation frame. */
export function rafThrottle(fn: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn();
    });
  };
}
