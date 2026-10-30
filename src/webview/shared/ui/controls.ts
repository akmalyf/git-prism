// Form controls in IntelliJ style: buttons, icon/toggle buttons, tri-state checkbox, radio group (with descriptions),
// text field/area, combo box (dropdown button + menu), links, badges, ref labels, shortcut hints.
import { h, uid, type Child } from './dom';
import { icon } from './icons';
import { formatShortcut } from './format';
import { setTooltip } from './tooltip';
import { showDropdownMenu, type MenuItem } from './menu';
import { ensureStyles } from './styles';

export interface ButtonOptions {
  label: string;
  primary?: boolean;
  small?: boolean;
  icon?: string;
  disabled?: boolean;
  title?: string;
  onClick?(e: MouseEvent): void;
}

export function button(o: ButtonOptions): HTMLButtonElement {
  ensureStyles();
  return h('button.jb-btn', {
    type: 'button',
    class: { 'jb-btn-primary': o.primary, 'jb-btn-small': o.small },
    disabled: !!o.disabled,
    title: o.title,
    onClick: o.onClick,
  }, o.icon ? icon(o.icon) : null, o.label);
}

export interface IconButtonOptions {
  icon: string;
  tooltip?: string;
  shortcut?: string;
  /** defined → toggle button (selected state shown) */
  toggled?: boolean;
  disabled?: boolean;
  label?: string;
  /** show a small ▾ after the icon */
  dropdown?: boolean;
  onClick?(e: MouseEvent): void;
}

export function iconButton(o: IconButtonOptions): HTMLButtonElement {
  ensureStyles();
  const b = h('button.jb-icon-btn', {
    type: 'button',
    class: { 'jb-on': !!o.toggled },
    disabled: !!o.disabled,
    attrs: { 'aria-pressed': o.toggled !== undefined ? String(!!o.toggled) : undefined, 'aria-label': o.tooltip },
    onClick: o.onClick,
  },
    o.icon ? icon(o.icon) : null,
    o.label ? h('span.jb-btn-label', null, o.label) : null,
    o.dropdown ? h('span.jb-chevron') : null,
  );
  if (o.tooltip) setTooltip(b, o.tooltip, { shortcut: o.shortcut });
  return b;
}

export type CheckValue = boolean | 'mixed';

export interface CheckboxOptions {
  label?: Child;
  checked?: CheckValue;
  disabled?: boolean;
  title?: string;
  onChange?(checked: boolean): void;
}

export interface CheckboxControl {
  element: HTMLElement;
  input: HTMLInputElement;
  readonly checked: boolean;
  readonly value: CheckValue;
  set(v: CheckValue): void;
  setDisabled(d: boolean): void;
}

export function checkbox(o: CheckboxOptions = {}): CheckboxControl {
  ensureStyles();
  const input = h('input.jb-check', { type: 'checkbox', disabled: !!o.disabled });
  const set = (v: CheckValue) => {
    input.indeterminate = v === 'mixed';
    input.checked = v === true;
    input.setAttribute('aria-checked', v === 'mixed' ? 'mixed' : String(v));
  };
  set(o.checked ?? false);
  input.addEventListener('change', () => {
    input.setAttribute('aria-checked', String(input.checked));
    o.onChange?.(input.checked);
  });
  const element = o.label !== undefined
    ? h('label.jb-checkbox', { class: { 'jb-disabled': o.disabled }, title: o.title }, input, h('span', null, o.label))
    : input;
  return {
    element,
    input,
    get checked() {
      return input.checked;
    },
    get value(): CheckValue {
      return input.indeterminate ? 'mixed' : input.checked;
    },
    set,
    setDisabled(d) {
      input.disabled = d;
      element.classList.toggle('jb-disabled', d);
    },
  };
}

export interface RadioOption<V> {
  value: V;
  label: Child;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupControl<V> {
  element: HTMLElement;
  readonly value: V | undefined;
  set(v: V): void;
  setDisabled(v: V, d: boolean): void;
}

export function radioGroup<V>(o: { options: RadioOption<V>[]; value?: V; name?: string; orientation?: 'vertical' | 'horizontal'; onChange?(v: V): void }): RadioGroupControl<V> {
  ensureStyles();
  const name = o.name ?? uid('radio');
  let value = o.value;
  const inputs: HTMLInputElement[] = [];
  const element = h('div.jb-radio-group', { class: { 'jb-horizontal': o.orientation === 'horizontal' }, attrs: { role: 'radiogroup' } });
  o.options.forEach((opt, i) => {
    const input = h('input.jb-radio', { type: 'radio', name, checked: opt.value === value, disabled: !!opt.disabled });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      value = opt.value;
      o.onChange?.(opt.value);
    });
    inputs[i] = input;
    element.append(
      h('div.jb-radio-option', null,
        h('label.jb-radio-label', { class: { 'jb-disabled': opt.disabled } }, input, h('span', null, opt.label)),
        opt.description ? h('div.jb-radio-desc', null, opt.description) : null,
      ),
    );
  });
  return {
    element,
    get value() {
      return value;
    },
    set(v) {
      value = v;
      o.options.forEach((opt, i) => (inputs[i].checked = opt.value === v));
    },
    setDisabled(v, d) {
      const i = o.options.findIndex((opt) => opt.value === v);
      if (i < 0) return;
      inputs[i].disabled = d;
      inputs[i].closest('.jb-radio-label')?.classList.toggle('jb-disabled', d);
    },
  };
}

export interface TextFieldOptions {
  value?: string;
  placeholder?: string;
  monospace?: boolean;
  width?: number | string;
  disabled?: boolean;
  onInput?(value: string): void;
  onChange?(value: string): void;
}

export function textField(o: TextFieldOptions = {}): HTMLInputElement {
  ensureStyles();
  const el = h('input.jb-input', {
    type: 'text',
    value: o.value ?? '',
    placeholder: o.placeholder ?? '',
    disabled: !!o.disabled,
    spellcheck: false,
    class: { 'jb-mono': o.monospace },
    style: o.width !== undefined ? { width: typeof o.width === 'number' ? `${o.width}px` : o.width } : undefined,
  });
  if (o.onInput) el.addEventListener('input', () => o.onInput!(el.value));
  if (o.onChange) el.addEventListener('change', () => o.onChange!(el.value));
  return el;
}

export function textArea(o: TextFieldOptions & { rows?: number; spellcheck?: boolean } = {}): HTMLTextAreaElement {
  ensureStyles();
  const el = h('textarea.jb-textarea', {
    value: o.value ?? '',
    placeholder: o.placeholder ?? '',
    rows: o.rows ?? 4,
    disabled: !!o.disabled,
    spellcheck: o.spellcheck ?? false,
    class: { 'jb-mono': o.monospace },
    style: o.width !== undefined ? { width: typeof o.width === 'number' ? `${o.width}px` : o.width } : undefined,
  });
  if (o.onInput) el.addEventListener('input', () => o.onInput!(el.value));
  if (o.onChange) el.addEventListener('change', () => o.onChange!(el.value));
  return el;
}

export interface ComboOption<V> {
  value: V;
  label: string;
  icon?: string;
  iconColor?: string;
  description?: string;
  disabled?: boolean;
}

export interface ComboBoxControl<V> {
  element: HTMLButtonElement;
  readonly value: V | undefined;
  set(v: V): void;
  setOptions(options: (ComboOption<V> | '-')[]): void;
  setDisabled(d: boolean): void;
}

/** IntelliJ ComboBox: a button showing the current value that opens a menu of options. */
export function comboBox<V>(o: { options: (ComboOption<V> | '-')[]; value?: V; width?: number | string; placeholder?: string; disabled?: boolean; onChange?(v: V): void }): ComboBoxControl<V> {
  ensureStyles();
  let options = o.options;
  let value = o.value;
  const text = h('span.jb-combo-text');
  const iconSlot = h('span.jb-combo-icon');
  const element = h('button.jb-combo', {
    type: 'button',
    disabled: !!o.disabled,
    attrs: { 'aria-haspopup': 'listbox' },
    style: o.width !== undefined ? { width: typeof o.width === 'number' ? `${o.width}px` : o.width } : undefined,
  }, iconSlot, text, h('span.jb-chevron'));
  const render = () => {
    const cur = options.find((x): x is ComboOption<V> => x !== '-' && x.value === value);
    text.textContent = cur ? cur.label : (o.placeholder ?? '');
    text.classList.toggle('jb-muted', !cur);
    iconSlot.replaceChildren(cur?.icon ? icon(cur.icon, { color: cur.iconColor }) : '');
    iconSlot.style.display = cur?.icon ? '' : 'none';
  };
  const open = () => {
    if (element.disabled) return;
    element.classList.add('jb-open');
    const items: MenuItem[] = options.map((x) =>
      x === '-' ? '-' : { label: x.label, icon: x.icon, iconColor: x.iconColor, description: x.description, disabled: x.disabled, checked: x.value === value ? true : undefined, run: () => {
        value = x.value;
        render();
        o.onChange?.(x.value);
      } },
    );
    showDropdownMenu(items, element, { minWidth: element.offsetWidth, selectFirst: true });
  };
  element.addEventListener('click', open);
  element.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.altKey) return open();
      const opts = options.filter((x): x is ComboOption<V> => x !== '-' && !x.disabled);
      const i = opts.findIndex((x) => x.value === value);
      const next = opts[Math.max(0, Math.min(opts.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next && next.value !== value) {
        value = next.value;
        render();
        o.onChange?.(next.value);
      }
    }
  });
  render();
  return {
    element,
    get value() {
      return value;
    },
    set(v) {
      value = v;
      render();
    },
    setOptions(opts) {
      options = opts;
      render();
    },
    setDisabled(d) {
      element.disabled = d;
    },
  };
}

export function link(text: string, run: (e: MouseEvent) => void, title?: string): HTMLButtonElement {
  ensureStyles();
  return h('button.jb-link', { type: 'button', title, onClick: (e: MouseEvent) => run(e) }, text);
}

export function badge(text: string | number, muted = false): HTMLSpanElement {
  ensureStyles();
  return h('span.jb-badge', { class: { 'jb-badge-muted': muted } }, String(text));
}

export type RefLabelType = 'head' | 'local' | 'remote' | 'tag' | 'stash' | 'other';

const REF_ICON: Record<RefLabelType, string> = {
  head: 'tag',
  local: 'tag',
  remote: 'tag',
  tag: 'tag',
  stash: 'archive',
  other: 'tag',
};

/** Log-style ref label: colored ref icon + name (`chip` adds a rounded background). */
export function refLabel(name: string, type: RefLabelType, opts: { chip?: boolean; title?: string; iconName?: string } = {}): HTMLSpanElement {
  ensureStyles();
  return h('span.jb-ref', { class: [`jb-ref-${type}`, { 'jb-ref-chip': opts.chip }], title: opts.title ?? name },
    icon(opts.iconName ?? REF_ICON[type]),
    h('span.jb-ref-text', null, name),
  );
}

export function kbd(shortcut: string): HTMLSpanElement {
  ensureStyles();
  return h('span.jb-kbd', null, formatShortcut(shortcut));
}

export function separator(vertical = false): HTMLElement {
  ensureStyles();
  return h(vertical ? 'div.jb-sep-v' : 'div.jb-sep', { attrs: { role: 'separator' } });
}
