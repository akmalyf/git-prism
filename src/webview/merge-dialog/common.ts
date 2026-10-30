// Building blocks shared by the sync dialogs (merge, pull/update, rebase, reset, push): IntelliJ-sized dialog page
// styles, the "git merge" command label, a ref text field with completion popup, the "Modify options" popup + option
// chips, and the Git Root combo for multi-repository projects.
import { comboBox, ensureStyles, h, highlightText, icon, isMac, listen, matchText, showDropdownMenu, type ComboBoxControl, type MenuItem } from '../shared/ui';
import type { OptionDef } from '../../features/sync/options';
import type { RefItem, RepoItem } from '../../features/sync/protocol';

const CSS = `
html, body, #app { height: 100%; margin: 0; }
body { background: var(--jb-editor-bg); overflow: auto; }
.sd-page { box-sizing: border-box; min-height: 100%; display: flex; align-items: flex-start; justify-content: center; padding: 48px 16px; }
.sd-page > .jb-dialog { height: auto; width: var(--sd-width, 600px); max-width: 100%; background: var(--jb-popup-bg); color: var(--jb-popup-fg);
  border: 1px solid var(--jb-popup-border); border-radius: 10px; box-shadow: var(--jb-shadow); }
.sd-page > .jb-dialog .jb-dialog-body { overflow: visible; }
.sd-head { display: flex; align-items: center; justify-content: flex-end; margin: -2px 0 6px; min-height: 18px; }
.sd-modify { display: inline-flex; align-items: center; gap: 2px; color: var(--jb-link); cursor: pointer; background: none; border: none; padding: 0; font: inherit; }
.sd-modify:hover { text-decoration: underline; }
.sd-modify:focus-visible { outline: 1px solid var(--jb-focus); border-radius: 3px; }
.sd-modify .sd-kbd { color: var(--jb-fg-muted); margin-left: 6px; text-decoration: none; }
.sd-cmd-row { display: flex; align-items: stretch; gap: 0; min-width: 0; }
.sd-cmd-row + .sd-cmd-row { margin-top: 6px; }
.sd-cmd-row > * { min-width: 0; }
.sd-cmd { flex: none; display: inline-flex; align-items: center; padding: 0 8px; height: var(--jb-control-h); box-sizing: border-box; font-family: var(--jb-mono);
  font-size: var(--jb-mono-size); color: var(--jb-fg-muted); background: var(--vscode-input-background); border: 1px solid var(--jb-input-border);
  border-right: none; border-radius: var(--jb-radius-sm) 0 0 var(--jb-radius-sm); white-space: nowrap; }
.sd-cmd-row > .sd-root { flex: 0 0 160px; margin-right: 6px; }
.sd-cmd-row > .sd-field, .sd-cmd-row > .jb-combo.sd-attached { flex: 1 1 0; }
.sd-cmd-row > .sd-field:not(.sd-first) .jb-input, .sd-cmd-row > .jb-combo.sd-attached { border-radius: 0; }
.sd-cmd-row > .sd-field.sd-last .jb-input, .sd-cmd-row > .jb-combo.sd-attached.sd-last { border-radius: 0 var(--jb-radius-sm) var(--jb-radius-sm) 0; }
.sd-cmd-row > .sd-field.sd-first:not(.sd-last) .jb-input { border-radius: var(--jb-radius-sm) 0 0 var(--jb-radius-sm); }
.sd-cmd-row > .sd-field.sd-first.sd-last .jb-input { border-radius: var(--jb-radius-sm); }
.sd-row2 { gap: 6px; }
.sd-cmd-row:not(.sd-row2) > .sd-field + .sd-field .jb-input, .sd-cmd-row > .jb-combo.sd-attached + .sd-field .jb-input { border-left: none; }
.sd-cmd-row > .sd-cmd.sd-mid { border-radius: 0; }
.sd-field { position: relative; display: flex; }
.sd-field .jb-input { width: 100%; height: var(--jb-control-h); box-sizing: border-box; padding-right: 24px; font-family: var(--jb-mono); font-size: var(--jb-mono-size); }
.sd-field .sd-drop { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; display: flex; align-items: center;
  justify-content: center; border: none; background: none; color: var(--jb-fg-muted); cursor: pointer; border-radius: 3px; padding: 0; }
.sd-field .sd-drop:hover { background: var(--jb-hover); }
.sd-field.sd-disabled .jb-input { opacity: .6; }
.sd-complete { position: fixed; z-index: 1000; max-height: 260px; overflow: auto; background: var(--jb-popup-bg); color: var(--jb-popup-fg);
  border: 1px solid var(--jb-popup-border); border-radius: var(--jb-radius); box-shadow: var(--jb-shadow); padding: 4px 0; box-sizing: border-box; }
.sd-complete-head { padding: 4px 10px 2px; color: var(--jb-fg-muted); font-size: var(--jb-font-size-sm); }
.sd-complete-item { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 10px; margin: 0 4px; border-radius: var(--jb-radius-sm); cursor: default; white-space: nowrap; }
.sd-complete-item.sd-active { background: var(--jb-sel-bg); color: var(--jb-sel-fg); }
.sd-complete-item .codicon { font-size: 14px; }
.sd-complete-empty { padding: 4px 12px; color: var(--jb-fg-muted); }
.sd-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.sd-chips:empty { display: none; }
.sd-chip { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 4px 0 8px; border-radius: 11px; font-family: var(--jb-mono);
  font-size: var(--jb-font-size-sm); background: var(--jb-toggle-bg); color: var(--jb-fg); border: 1px solid var(--jb-toggle-border); }
.sd-chip button { border: none; background: none; color: var(--jb-fg-muted); cursor: pointer; display: flex; padding: 0; border-radius: 50%; }
.sd-chip button:hover { color: var(--jb-fg); background: var(--jb-hover); }
.sd-hint { margin-top: 8px; color: var(--jb-fg-muted); font-size: var(--jb-font-size-sm); }
.sd-label { display: block; margin: 10px 0 4px; }
.sd-subtle { color: var(--jb-fg-muted); }
`;

let styled = false;

/** Injects the dialog page styles; `width` = dialog width in px (IntelliJ dialogs are compact). */
export function dialogStyles(width = 600): void {
  ensureStyles();
  document.documentElement.style.setProperty('--sd-width', `${width}px`);
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** #app wrapped in the centered dialog page; returns the element to lay the dialog out in. */
export function dialogPage(width?: number): HTMLElement {
  dialogStyles(width);
  const app = document.getElementById('app')!;
  app.classList.add('sd-page');
  return app;
}

/** Grey "git merge" prefix attached to the first field (IntelliJ CmdLabel). */
export function cmdLabel(text: string, mid = false): HTMLElement {
  return h('span.sd-cmd', { class: { 'sd-mid': mid } }, text);
}

const KIND_ICON: Record<RefItem['kind'], { icon: string; color: string }> = {
  local: { icon: 'git-branch', color: 'var(--jb-ref-local)' },
  remote: { icon: 'git-branch', color: 'var(--jb-ref-remote)' },
  tag: { icon: 'tag', color: 'var(--jb-ref-tag)' },
};
const KIND_TITLE: Record<RefItem['kind'], string> = { local: 'Local', remote: 'Remote', tag: 'Tags' };

export interface RefFieldOptions {
  items: RefItem[];
  value?: string;
  placeholder?: string;
  /** comma-separated multiple values (Pull: several branches) */
  multi?: boolean;
  onChange?(value: string): void;
}

/** Text field with an IntelliJ-like completion popup (grouped Local / Remote / Tags) and a ▾ button showing all. */
export class RefField {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  private items: RefItem[];
  private popup: HTMLElement | undefined;
  private active = -1;
  private shown: RefItem[] = [];
  private outside: { dispose(): void } | undefined;

  constructor(private readonly o: RefFieldOptions) {
    this.items = o.items;
    this.input = h('input.jb-input', { type: 'text', value: o.value ?? '', placeholder: o.placeholder ?? '', spellcheck: false, attrs: { 'aria-autocomplete': 'list' } });
    const drop = h('button.sd-drop', { type: 'button', tabIndex: -1, attrs: { 'aria-label': 'Show all' }, onClick: () => (this.popup ? this.close() : this.open(true)) }, h('span.jb-chevron'));
    this.element = h('div.sd-field', null, this.input, drop);
    this.input.addEventListener('input', () => {
      this.open(false);
      o.onChange?.(this.value);
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => setTimeout(() => {
      if (document.activeElement !== this.input) this.close();
    }, 120));
  }

  get value(): string {
    return this.input.value.trim();
  }

  /** the values of a multi field */
  get values(): string[] {
    return this.input.value.split(',').map((s) => s.trim()).filter(Boolean);
  }

  setValue(v: string): void {
    this.input.value = v;
    this.o.onChange?.(this.value);
  }

  setItems(items: RefItem[]): void {
    this.items = items;
    if (this.popup) this.open(false);
  }

  setPlaceholder(p: string): void {
    this.input.placeholder = p;
  }

  setDisabled(d: boolean): void {
    this.input.disabled = d;
    this.element.classList.toggle('sd-disabled', d);
    if (d) this.close();
  }

  setInvalid(b: boolean): void {
    this.input.classList.toggle('jb-invalid', b);
  }

  focus(): void {
    this.input.focus();
    this.input.select();
  }

  private query(): string {
    if (!this.o.multi) return this.input.value.trim();
    const parts = this.input.value.split(',');
    return parts[parts.length - 1].trim();
  }

  private open(all: boolean): void {
    if (this.input.disabled) return;
    const q = all ? '' : this.query();
    const scored = this.items
      .map((it) => ({ it, m: q ? matchText(q, it.name) : [] }))
      .filter((x) => x.m !== null);
    this.shown = scored.map((x) => x.it);
    if (!this.popup) {
      this.popup = h('div.sd-complete', { attrs: { role: 'listbox' } });
      document.body.appendChild(this.popup);
      this.outside = listen(document, 'mousedown', (e) => {
        if (!this.element.contains(e.target as Node) && !this.popup?.contains(e.target as Node)) this.close();
      });
    }
    const p = this.popup;
    p.replaceChildren();
    if (!this.shown.length) p.append(h('div.sd-complete-empty', null, this.items.length ? 'No matches' : 'No branches'));
    let kind: RefItem['kind'] | undefined;
    const multiKind = new Set(this.items.map((i) => i.kind)).size > 1;
    scored.forEach(({ it, m }, i) => {
      if (multiKind && it.kind !== kind) {
        kind = it.kind;
        p.append(h('div.sd-complete-head', null, KIND_TITLE[it.kind]));
      }
      const ic = KIND_ICON[it.kind];
      const row = h('div.sd-complete-item', {
        attrs: { role: 'option' },
        onMouseDown: (e: MouseEvent) => {
          e.preventDefault();
          this.accept(i);
        },
        onMouseMove: () => this.setActive(i),
      }, icon(ic.icon, { color: ic.color }), h('span', null, highlightText(it.name, m)));
      p.append(row);
    });
    this.active = this.shown.length ? 0 : -1;
    if (!q) this.active = Math.max(0, this.shown.findIndex((x) => x.name === this.query()));
    this.setActive(this.active);
    const r = this.element.getBoundingClientRect();
    p.style.left = `${r.left}px`;
    p.style.top = `${r.bottom + 2}px`;
    p.style.minWidth = `${r.width}px`;
    p.style.maxHeight = `${Math.max(120, Math.min(260, window.innerHeight - r.bottom - 12))}px`;
  }

  private setActive(i: number): void {
    this.active = i;
    const rows = this.popup?.querySelectorAll('.sd-complete-item') ?? [];
    rows.forEach((el, j) => el.classList.toggle('sd-active', j === i));
    (rows[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  private accept(i: number): void {
    const it = this.shown[i];
    if (!it) return;
    if (this.o.multi) {
      const parts = this.input.value.split(',').map((s) => s.trim());
      parts[parts.length - 1] = it.name;
      this.input.value = parts.filter(Boolean).join(', ');
    } else {
      this.input.value = it.name;
    }
    this.close();
    this.o.onChange?.(this.value);
  }

  close(): void {
    this.popup?.remove();
    this.popup = undefined;
    this.outside?.dispose();
    this.outside = undefined;
  }

  private onKey(e: KeyboardEvent): void {
    const n = this.shown.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.popup) return this.open(true);
      if (!n) return;
      this.setActive((this.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter' && this.popup && this.active >= 0 && !(e.metaKey || e.ctrlKey)) {
      const it = this.shown[this.active];
      if (it && it.name !== this.query()) {
        e.preventDefault();
        this.accept(this.active);
      } else this.close();
    } else if (e.key === 'Escape' && this.popup) {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'Tab' && this.popup) {
      this.close();
    } else if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.open(true);
    }
  }
}

export interface OptionsBarOptions<T extends string> {
  defs: OptionDef<T>[];
  selected: T[];
  /** popup title, e.g. "Add Merge Options" */
  title: string;
  enabled(option: T, selected: readonly T[]): boolean;
  onChange(selected: T[]): void;
  /** options shown as chips (default all) */
  chips?: T[];
}

/** "Modify options ⌥M" link (popup of options with descriptions) + the chips of the selected flags. */
export class OptionsBar<T extends string> {
  readonly link: HTMLButtonElement;
  readonly chips: HTMLElement;
  private selected: T[];

  constructor(private readonly o: OptionsBarOptions<T>) {
    this.selected = [...o.selected];
    this.link = h('button.sd-modify', { type: 'button', onClick: () => this.openMenu() }, 'Modify options', h('span.jb-chevron'), h('span.sd-kbd', null, isMac ? '⌥M' : 'Alt+M'));
    this.chips = h('div.sd-chips');
    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) {
        e.preventDefault();
        this.openMenu();
      }
    });
    this.render();
  }

  get value(): T[] {
    return [...this.selected];
  }

  has(o: T): boolean {
    return this.selected.includes(o);
  }

  set(sel: T[]): void {
    this.selected = this.o.defs.map((d) => d.id).filter((id) => sel.includes(id));
    this.render();
    this.o.onChange(this.value);
  }

  toggle(opt: T): void {
    this.set(this.selected.includes(opt) ? this.selected.filter((x) => x !== opt) : [...this.selected, opt]);
  }

  private openMenu(): void {
    const items: MenuItem[] = [{ header: this.o.title }];
    for (const d of this.o.defs) {
      if (d.separatorAbove) items.push('-');
      items.push({
        label: d.flag || d.description,
        description: d.flag ? d.description : undefined,
        checked: this.selected.includes(d.id),
        disabled: !this.o.enabled(d.id, this.selected),
        run: () => this.toggle(d.id),
      });
    }
    showDropdownMenu(items, this.link, { align: 'end' });
  }

  private render(): void {
    const chipIds = this.o.chips ?? this.o.defs.map((d) => d.id);
    this.chips.replaceChildren(
      ...this.selected
        .filter((id) => chipIds.includes(id))
        .map((id) => {
          const d = this.o.defs.find((x) => x.id === id)!;
          return h('span.sd-chip', { title: d.description }, d.flag, h('button', { type: 'button', tabIndex: -1, attrs: { 'aria-label': `Remove ${d.flag}` }, onClick: () => this.toggle(id) }, icon('close')));
        }),
    );
  }
}

/** Git Root combo (only shown with several repositories). */
export function rootCombo(repos: RepoItem[], root: string, onChange: (root: string) => void): ComboBoxControl<string> | undefined {
  if (repos.length < 2) return undefined;
  const c = comboBox<string>({ options: repos.map((r) => ({ value: r.root, label: r.name, icon: 'repo', description: undefined })), value: root, onChange });
  c.element.classList.add('sd-root');
  c.element.title = 'Git Root';
  return c;
}

/** Whether `name` is one of the refs (exact). */
export function hasRef(items: RefItem[], name: string): boolean {
  return items.some((r) => r.name === name);
}
