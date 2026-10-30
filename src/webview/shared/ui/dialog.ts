// Dialogs: dialogLayout() fills a WebviewPanel used as a dialog (title, scrollable body, bottom buttons);
// openModal() shows an in-page modal overlay; confirmDialog()/promptDialog() helpers; form rows/sections.
// Enter triggers the primary button (Cmd/Ctrl+Enter inside a textarea), Esc triggers the cancel button.
import { h, listen, DisposableStore, isCtrlCmd, type Child } from './dom';
import { icon } from './icons';
import { button, textField } from './controls';
import { setTooltip } from './tooltip';
import { spinner } from './loading';
import { ensureStyles } from './styles';

export interface DialogButton {
  id: string;
  label?: string;
  /** icon-only button (left side "?" help etc.) */
  icon?: string;
  tooltip?: string;
  primary?: boolean;
  cancel?: boolean;
  disabled?: boolean;
  /** return false (or resolve false) to keep a modal open */
  run?(): void | boolean | Promise<void | boolean>;
}

export interface DialogLayoutOptions {
  title?: string;
  body: Child;
  buttons: DialogButton[];
  leftButtons?: DialogButton[];
  className?: string;
}

export interface DialogLayout {
  element: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  setEnabled(id: string, enabled: boolean): void;
  setLabel(id: string, label: string): void;
  setError(message: string | undefined): void;
  setBusy(busy: boolean, text?: string): void;
  click(id: string): void;
  dispose(): void;
}

function buildLayout(o: DialogLayoutOptions, onButton: (b: DialogButton) => void): DialogLayout {
  ensureStyles();
  const store = new DisposableStore();
  const btnEls = new Map<string, HTMLButtonElement>();
  const mk = (b: DialogButton) => {
    const el = b.label
      ? button({ label: b.label, primary: b.primary, disabled: b.disabled, onClick: () => onButton(b) })
      : h('button.jb-icon-btn', { type: 'button', disabled: !!b.disabled, onClick: () => onButton(b) }, icon(b.icon ?? 'question'));
    if (b.tooltip) store.add(setTooltip(el, b.tooltip));
    btnEls.set(b.id, el);
    return el;
  };
  const error = h('div.jb-dialog-error', { attrs: { role: 'alert' } });
  const busy = h('div.jb-dialog-busy');
  const body = h('div.jb-dialog-body', null, o.body);
  const footer = h('div.jb-dialog-footer', null,
    h('div.jb-dialog-left', null, (o.leftButtons ?? []).map(mk), busy),
    h('div.jb-dialog-buttons', null, o.buttons.map(mk)),
  );
  const element = h('div.jb-dialog', { class: o.className, attrs: { role: 'dialog', 'aria-label': o.title } },
    o.title ? h('div.jb-dialog-title', null, o.title) : null,
    body,
    error,
    footer,
  );
  const all = [...o.buttons, ...(o.leftButtons ?? [])];
  return {
    element,
    body,
    footer,
    setEnabled(id, enabled) {
      const b = all.find((x) => x.id === id);
      if (b) b.disabled = !enabled;
      const el = btnEls.get(id);
      if (el) el.disabled = !enabled;
    },
    setLabel(id, label) {
      const el = btnEls.get(id);
      if (el) el.textContent = label;
    },
    setError(message) {
      error.textContent = message ?? '';
      error.classList.toggle('jb-visible', !!message);
    },
    setBusy(b, text) {
      busy.replaceChildren(...(b ? [spinner(), h('span', null, text ?? '')] : []));
      for (const [id, el] of btnEls) {
        const def = all.find((x) => x.id === id);
        el.disabled = b ? !def?.cancel : !!def?.disabled;
      }
    },
    click(id) {
      const b = all.find((x) => x.id === id);
      if (b && !b.disabled) onButton(b);
    },
    dispose() {
      store.dispose();
      element.remove();
    },
  };
}

/** Enter → primary button, Esc → cancel button. Returns a Disposable. */
function bindKeys(root: HTMLElement | Document, layout: () => DialogLayout, buttons: () => DialogButton[]) {
  return listen(root as HTMLElement, 'keydown', (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    if (root === document && (e.target as HTMLElement).closest?.('.jb-modal-overlay, .jb-menu, .jb-popup')) return;
    if (e.key === 'Escape') {
      const c = buttons().find((b) => b.cancel);
      if (c) {
        e.preventDefault();
        layout().click(c.id);
      }
    } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLTextAreaElement || t.isContentEditable) {
        if (!isCtrlCmd(e)) return;
      } else if (t instanceof HTMLButtonElement && !t.classList.contains('jb-check')) {
        return; // native button activation
      }
      if (t.closest('.jb-tree, .jb-table, .jb-menu, .jb-popup') && !isCtrlCmd(e)) return;
      const p = buttons().find((b) => b.primary);
      if (p) {
        e.preventDefault();
        layout().click(p.id);
      }
    }
  });
}

/**
 * Lays out a whole-webview dialog inside `parent` (usually #app). Buttons run their `run` handlers; the host
 * typically closes the panel from there. Enter/Esc are bound document-wide.
 */
export function dialogLayout(parent: HTMLElement, o: DialogLayoutOptions): DialogLayout {
  let running = false;
  const layout = buildLayout(o, async (b) => {
    if (running || b.disabled) return;
    running = true;
    try {
      await b.run?.();
    } finally {
      running = false;
    }
  });
  layout.element.classList.add('jb-dialog-page');
  parent.appendChild(layout.element);
  const keys = bindKeys(document, () => layout, () => [...o.buttons, ...(o.leftButtons ?? [])]);
  const dispose = layout.dispose;
  layout.dispose = () => {
    keys.dispose();
    dispose();
  };
  return layout;
}

export interface ModalOptions extends Omit<DialogLayoutOptions, 'buttons'> {
  buttons?: DialogButton[];
  width?: number;
  /** element to focus initially (default: first input, else primary button) */
  initialFocus?: HTMLElement;
  onClose?(result: string | undefined): void;
}

export interface ModalHandle {
  element: HTMLElement;
  layout: DialogLayout;
  /** resolves with the id of the button that closed it, or undefined (Esc without a cancel button / close()) */
  result: Promise<string | undefined>;
  close(result?: string): void;
}

/** In-page modal overlay. A button closes the modal unless its run returns false. */
export function openModal(o: ModalOptions): ModalHandle {
  ensureStyles();
  const buttons = o.buttons ?? [{ id: 'ok', label: 'OK', primary: true }];
  let resolve!: (v: string | undefined) => void;
  const result = new Promise<string | undefined>((r) => (resolve = r));
  const restore = document.activeElement as HTMLElement | null;
  let closed = false;
  let running = false;
  const close = (r?: string) => {
    if (closed) return;
    closed = true;
    keys.dispose();
    trap.dispose();
    overlay.remove();
    layout.dispose();
    if (restore?.isConnected) restore.focus({ preventScroll: true });
    o.onClose?.(r);
    resolve(r);
  };
  const layout = buildLayout({ ...o, buttons }, async (b) => {
    if (running || b.disabled) return;
    running = true;
    try {
      const r = await b.run?.();
      if (r !== false) close(b.id);
    } finally {
      running = false;
    }
  });
  layout.element.classList.add('jb-dialog-modal');
  if (o.width) layout.element.style.width = `${o.width}px`;
  const overlay = h('div.jb-modal-overlay', null, layout.element);
  document.body.appendChild(overlay);
  const keys = bindKeys(overlay, () => layout, () => [...buttons, ...(o.leftButtons ?? [])]);
  const escFallback = listen(overlay, 'keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !buttons.some((b) => b.cancel)) {
      e.preventDefault();
      close(undefined);
    }
  });
  // focus trap
  const trap = new DisposableStore();
  trap.add(escFallback);
  trap.add(listen(overlay, 'keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...layout.element.querySelectorAll<HTMLElement>('input, textarea, select, button, [tabindex]:not([tabindex="-1"])')].filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null && x.tabIndex >= 0);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && (i <= 0)) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && i === f.length - 1) {
      e.preventDefault();
      f[0].focus();
    }
  }));
  trap.add(listen(overlay, 'mousedown', (e) => {
    if (e.target === overlay) e.preventDefault();
  }));
  const first = o.initialFocus ?? layout.element.querySelector<HTMLElement>('.jb-dialog-body input:not([type=checkbox]):not([type=radio]), .jb-dialog-body textarea') ?? layout.element.querySelector<HTMLElement>('.jb-btn-primary') ?? layout.element;
  if (first === layout.element) layout.element.tabIndex = -1;
  requestAnimationFrame(() => {
    first.focus();
    if (first instanceof HTMLInputElement) first.select();
  });
  return { element: overlay, layout, result, close };
}

/** Yes/No style confirmation. Resolves true when the OK button was pressed. */
export async function confirmDialog(o: { title: string; message: Child; ok?: string; cancel?: string; width?: number; danger?: boolean }): Promise<boolean> {
  const r = await openModal({
    title: o.title,
    width: o.width ?? 420,
    body: h('div.jb-dialog-message', null, o.message),
    buttons: [
      { id: 'cancel', label: o.cancel ?? 'Cancel', cancel: true },
      { id: 'ok', label: o.ok ?? 'OK', primary: true },
    ],
  }).result;
  return r === 'ok';
}

/** Single text input dialog with validation. Resolves with the value, or undefined when cancelled. */
export async function promptDialog(o: { title: string; label: string; value?: string; placeholder?: string; ok?: string; width?: number; validate?(v: string): string | undefined }): Promise<string | undefined> {
  const input = textField({ value: o.value, placeholder: o.placeholder });
  input.style.width = '100%';
  let value: string | undefined;
  const handle = openModal({
    title: o.title,
    width: o.width ?? 400,
    body: formRow(o.label, input, { stacked: true }),
    initialFocus: input,
    buttons: [
      { id: 'cancel', label: 'Cancel', cancel: true },
      {
        id: 'ok',
        label: o.ok ?? 'OK',
        primary: true,
        run: () => {
          const err = o.validate?.(input.value);
          handle.layout.setError(err);
          input.classList.toggle('jb-invalid', !!err);
          if (err) return false;
          value = input.value;
        },
      },
    ],
  });
  input.addEventListener('input', () => {
    const err = o.validate?.(input.value);
    input.classList.toggle('jb-invalid', !!err);
    handle.layout.setEnabled('ok', !err);
    handle.layout.setError(undefined);
  });
  if (o.validate?.(input.value)) handle.layout.setEnabled('ok', false);
  const r = await handle.result;
  return r === 'ok' ? value : undefined;
}

/** Label + control row (label column aligned in a form grid); `stacked` puts the label above. */
export function formRow(label: Child, control: Child, opts: { hint?: Child; stacked?: boolean; labelFor?: string } = {}): HTMLElement {
  ensureStyles();
  return h('div.jb-form-row', { class: { 'jb-stacked': opts.stacked } },
    h('label.jb-form-label', { htmlFor: opts.labelFor }, label),
    h('div.jb-form-control', null, control, opts.hint ? h('div.jb-form-hint', null, opts.hint) : null),
  );
}

/** Titled group of rows (IntelliJ titled separator: "Options ────"). */
export function formSection(title: string, ...children: Child[]): HTMLElement {
  ensureStyles();
  return h('div.jb-form-section', null, h('div.jb-form-section-title', null, h('span', null, title), h('div.jb-form-section-line')), ...children);
}

/** Grid container aligning the labels of nested formRows. */
export function formGrid(...rows: Child[]): HTMLElement {
  ensureStyles();
  return h('div.jb-form-grid', null, ...rows);
}
