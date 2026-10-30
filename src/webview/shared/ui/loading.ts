// Loading indicators: spinner, indeterminate progress line, overlay with spinner + text.
import { h } from './dom';
import { icon } from './icons';
import { ensureStyles } from './styles';

export function spinner(size = 16): HTMLElement {
  ensureStyles();
  const s = icon('loading', { spin: true, className: 'jb-spinner' });
  if (size !== 16) {
    s.style.fontSize = `${size}px`;
    s.style.width = s.style.height = `${size}px`;
  }
  return s;
}

export interface ProgressLine {
  element: HTMLElement;
  show(): void;
  hide(): void;
  readonly visible: boolean;
}

/** Thin indeterminate progress bar (IntelliJ tool window loading line). Place it at the top of a panel. */
export function progressLine(): ProgressLine {
  ensureStyles();
  const element = h('div.jb-progress-line', { attrs: { role: 'progressbar' } }, h('div.jb-progress-bar'));
  let count = 0;
  return {
    element,
    show() {
      count++;
      element.classList.add('jb-active');
    },
    hide() {
      count = Math.max(0, count - 1);
      if (!count) element.classList.remove('jb-active');
    },
    get visible() {
      return count > 0;
    },
  };
}

const overlays = new WeakMap<HTMLElement, HTMLElement>();

/** Covers `container` (must be positioned or will become relative) with a spinner + text. */
export function setLoading(container: HTMLElement, loading: boolean, text = 'Loading…'): void {
  ensureStyles();
  let ov = overlays.get(container);
  if (!loading) {
    ov?.remove();
    overlays.delete(container);
    return;
  }
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  if (!ov) {
    ov = h('div.jb-loading-overlay');
    overlays.set(container, ov);
  }
  ov.replaceChildren(spinner(), h('span', null, text));
  if (!ov.isConnected) container.appendChild(ov);
}
