// Shared by the Commit tool window's diff windows (commit-diff, commit-threeway): theme detection, the CSS that maps
// ide-diff's variables to the VS Code theme, and the file navigation chrome (Previous/Next File, "2/5 files" chooser).
import { getIcon, type IconName } from '@ide-diff/viewer';
import type { ChangeKind } from '../../core/types';

export type Theme = 'dark' | 'light';

export const theme = (): Theme => (/\bvscode-(light|high-contrast-light)\b/.test(document.body.className) ? 'light' : 'dark');
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const key = (mac: string, other: string): string => (IS_MAC ? mac : other);

/** Calls `cb` whenever VS Code switches between a light and a dark theme. */
export function onThemeChange(cb: (t: Theme) => void): void {
  let last = theme();
  new MutationObserver(() => {
    const t = theme();
    if (t !== last) cb((last = t));
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

export function injectCss(css: string): void {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const BASE_CSS = `
:root {
  --jb-border: var(--vscode-editorGroup-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
  --jb-added: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
  --jb-modified: var(--vscode-gitDecoration-modifiedResourceForeground, #6c9ef8);
  --jb-deleted: var(--vscode-gitDecoration-deletedResourceForeground, #8c8c8c);
  --jb-untracked: var(--vscode-gitDecoration-untrackedResourceForeground, #d2a668);
  --jb-conflict: var(--vscode-gitDecoration-conflictingResourceForeground, #e4676b);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; padding: 0; overflow: hidden; font-family: var(--vscode-font-family); font-size: 13px;
  color: var(--vscode-foreground); background: var(--vscode-editor-background); }
#app { height: 100%; display: flex; flex-direction: column; min-height: 0; }
body .idd-theme-dark, body .idd-theme-light {
  --idd-font-family: var(--vscode-editor-font-family);
  --idd-font-size: var(--vscode-editor-font-size);
  --idd-line-height: calc(var(--vscode-editor-font-size) * 1.6);
  --idd-ui-font-family: var(--vscode-font-family);
  --idd-ui-font-size: 13px;
  --idd-editor-bg: var(--vscode-editor-background);
  --idd-editor-fg: var(--vscode-editor-foreground);
  --idd-gutter-bg: var(--vscode-editorGutter-background, var(--vscode-editor-background));
  --idd-divider-bg: var(--vscode-editorGutter-background, var(--vscode-editor-background));
  --idd-caret: var(--vscode-editorCursor-foreground);
  --idd-caret-row-bg: var(--vscode-editor-lineHighlightBackground, transparent);
  --idd-selection-bg: var(--vscode-editor-selectionBackground);
  --idd-line-number: var(--vscode-editorLineNumber-foreground);
  --idd-line-number-caret-row: var(--vscode-editorLineNumber-activeForeground);
  --idd-whitespace: var(--vscode-editorWhitespace-foreground);
  --idd-search-result-bg: var(--vscode-editor-findMatchHighlightBackground);
  --idd-matched-brace-bg: var(--vscode-editorBracketMatch-background);
  --idd-panel-bg: var(--vscode-editor-background);
  --idd-toolbar-bg: var(--vscode-editor-background);
  --idd-window-bg: var(--vscode-editorWidget-background);
  --idd-border: var(--jb-border);
  --idd-fg: var(--vscode-foreground);
  --idd-title-fg: var(--vscode-foreground);
  --idd-fg-muted: var(--vscode-descriptionForeground);
  --idd-fg-disabled: var(--vscode-disabledForeground);
  --idd-button-hover-bg: var(--vscode-toolbar-hoverBackground);
  --idd-button-pressed-bg: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground));
  --idd-popup-bg: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  --idd-popup-border: var(--vscode-menu-border, var(--vscode-widget-border, var(--jb-border)));
  --idd-list-selection-bg: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
  --idd-list-hover-bg: var(--vscode-list-hoverBackground);
  --idd-focus: var(--vscode-focusBorder);
  --idd-accent: var(--vscode-focusBorder);
  --idd-link: var(--vscode-textLink-foreground);
  --idd-tooltip-bg: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
  --idd-tooltip-fg: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  --idd-scrollbar-thumb: var(--vscode-scrollbarSlider-background);
  --idd-scrollbar-thumb-hover: var(--vscode-scrollbarSlider-hoverBackground);
}
.jb-btn { height: 28px; padding: 0 14px; border-radius: 6px; font: inherit; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--vscode-button-border, var(--jb-border)); background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
.jb-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
.jb-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.jb-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.jb-btn:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
.jb-btn:disabled { opacity: .5; cursor: default; }
.k-A { color: var(--jb-added); } .k-M, .k-R, .k-C, .k-T { color: var(--jb-modified); } .k-D { color: var(--jb-deleted); }
.k-\\? { color: var(--jb-untracked); } .k-U { color: var(--jb-conflict); } .k-\\! { color: var(--vscode-disabledForeground); }
#stage { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
#stage > .viewer { flex: 1; min-height: 0; }
.fb { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fb-body { flex: 1; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; white-space: pre-wrap; }
.fb-body a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
.fb-body a:hover { text-decoration: underline; }
.files-btn { padding: 0 6px !important; }
.files-btn .label { white-space: nowrap; }
.jb-hint { position: absolute; top: 48px; left: 50%; transform: translateX(-50%); z-index: 500; padding: 6px 10px; border-radius: 6px;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)); color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--jb-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.25));
  white-space: nowrap; pointer-events: none; }
.jb-popup { position: fixed; z-index: 100; min-width: 280px; max-width: min(640px, 90vw); max-height: 60vh; display: flex; flex-direction: column;
  background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-widget-border, var(--jb-border)); border-radius: 8px; box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0,0,0,.35)); overflow: hidden; }
.jb-popup .head { padding: 6px 10px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
.jb-popup input { margin: 6px; height: 26px; padding: 0 8px; border-radius: 4px; font: inherit; outline: none;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--jb-border)); }
.jb-popup input:focus { border-color: var(--vscode-focusBorder); }
.jb-popup .list { overflow-y: auto; padding: 0 4px 4px; }
.jb-popup .item { height: 24px; display: flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
.jb-popup .item .dir { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; }
.jb-popup .item.current { font-weight: 600; }
.jb-popup .item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.jb-popup .item.active .dir { color: inherit; opacity: .8; }
.jb-popup .empty { padding: 6px 10px; color: var(--vscode-descriptionForeground); }
`;

export function iconButton(icon: IconName, tooltip: string, onClick: () => void, id?: string): HTMLButtonElement {
  const b = el('button', 'idd-btn');
  b.type = 'button';
  if (id) b.id = id;
  b.title = tooltip;
  b.setAttribute('aria-label', tooltip);
  const i = el('span', 'idd-icon jb-ic');
  i.dataset.icon = icon;
  i.innerHTML = getIcon(icon, theme());
  b.append(i);
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => !b.disabled && onClick());
  return b;
}

/** Re-renders the ide-diff icons of the extra toolbar buttons after a theme switch. */
export function rethemeIcons(): void {
  for (const i of document.querySelectorAll<HTMLElement>('.jb-ic')) i.innerHTML = getIcon(i.dataset.icon as IconName, theme());
}

export const sep = (): HTMLElement => el('span', 'idd-sep');

export interface NavFile {
  path: string;
  kind?: ChangeKind;
}

const splitPath = (p: string): [string, string] => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)];
};

/** Compare Previous/Next File buttons, the "2/5 files" chooser popup and the "Press again…" hint of F7. */
export class FileNav {
  private popup: HTMLElement | undefined;
  private hint: { el: HTMLElement; dir: 1 | -1; timer: number } | undefined;

  constructor(
    private readonly files: readonly NavFile[],
    private readonly current: () => number,
    private readonly switchTo: (i: number, reveal?: 'first' | 'last') => void,
    private readonly host: HTMLElement,
  ) {
    document.addEventListener('mousedown', (e) => {
      if (this.popup && !this.popup.contains(e.target as Node)) this.closePopup();
    });
  }

  get popupOpen(): boolean {
    return !!this.popup;
  }

  /** Toolbar buttons (none for a single file). */
  buttons(): HTMLElement[] {
    if (this.files.length < 2) return [];
    const chooser = el('button', 'idd-btn files-btn');
    chooser.type = 'button';
    chooser.id = 'filesBtn';
    chooser.title = 'Select File to Compare';
    const label = el('span', 'label', this.label());
    const chev = el('span', 'idd-icon idd-icon-14 jb-ic');
    chev.dataset.icon = 'generalChevronDown';
    chev.innerHTML = getIcon('generalChevronDown', theme());
    chooser.append(label, chev);
    chooser.addEventListener('mousedown', (e) => e.preventDefault());
    chooser.addEventListener('click', () => (this.popup ? this.closePopup() : this.openPopup(chooser)));
    return [
      sep(),
      iconButton('generalLeft', `Compare Previous File (${key('⌃⇧←', 'Alt+Shift+Left')})`, () => this.move(-1), 'prevFile'),
      iconButton('generalRight', `Compare Next File (${key('⌃⇧→', 'Alt+Shift+Right')})`, () => this.move(1), 'nextFile'),
      chooser,
    ];
  }

  update(): void {
    const i = this.current();
    const prev = document.getElementById('prevFile') as HTMLButtonElement | null;
    const next = document.getElementById('nextFile') as HTMLButtonElement | null;
    if (prev) prev.disabled = i <= 0;
    if (next) next.disabled = i >= this.files.length - 1;
    const label = document.querySelector('#filesBtn .label');
    if (label) label.textContent = this.label();
  }

  move(delta: number): void {
    const t = this.current() + delta;
    if (t >= 0 && t < this.files.length) this.switchTo(t);
  }

  private label(): string {
    return `${this.current() + 1}/${this.files.length} files`;
  }

  hideHint(): boolean {
    if (!this.hint) return false;
    window.clearTimeout(this.hint.timer);
    this.hint.el.remove();
    this.hint = undefined;
    return true;
  }

  /** F7 / Shift+F7 past the last / first difference: "Press again…", then the next / previous file. */
  pastEnd(dir: 1 | -1): void {
    const target = this.current() + dir;
    if (target < 0 || target >= this.files.length) return;
    if (this.hint?.dir === dir) {
      this.hideHint();
      this.switchTo(target, dir > 0 ? 'first' : 'last');
      return;
    }
    this.hideHint();
    const e = el('div', 'jb-hint', dir > 0 ? 'Press again to go to the next file' : 'Press again to go to the previous file');
    this.host.append(e);
    this.hint = { el: e, dir, timer: window.setTimeout(() => this.hideHint(), 3000) };
  }

  closePopup(): void {
    this.popup?.remove();
    this.popup = undefined;
  }

  private openPopup(anchor: HTMLElement): void {
    this.closePopup();
    const box = el('div', 'jb-popup');
    const input = el('input');
    input.placeholder = 'Search';
    input.setAttribute('aria-label', 'Search files');
    const list = el('div', 'list');
    list.setAttribute('role', 'listbox');
    box.append(el('div', 'head', 'Select File to Compare'), input, list);
    let shown: number[] = [];
    let active = Math.max(0, this.current());
    const pick = (fi: number | undefined) => {
      this.closePopup();
      if (fi !== undefined) this.switchTo(fi);
    };
    const render = (): void => {
      const q = input.value.trim().toLowerCase();
      shown = this.files.map((_, i) => i).filter((i) => !q || this.files[i].path.toLowerCase().includes(q));
      active = Math.max(0, Math.min(active, shown.length - 1));
      list.replaceChildren();
      if (!shown.length) list.append(el('div', 'empty', 'Nothing found'));
      shown.forEach((fi, n) => {
        const f = this.files[fi];
        const [dir, name] = splitPath(f.path);
        const item = el('div', `item${fi === this.current() ? ' current' : ''}${n === active ? ' active' : ''}`);
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(n === active));
        item.append(el('i', 'codicon codicon-file'), el('span', `k-${f.kind ?? 'M'}`, name));
        if (dir) item.append(el('span', 'dir', dir));
        item.title = f.path;
        item.addEventListener('mousedown', (e) => e.preventDefault());
        item.addEventListener('click', () => pick(fi));
        item.addEventListener('mousemove', () => {
          if (active === n) return;
          active = n;
          render();
        });
        list.append(item);
      });
      list.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') active = Math.min(shown.length - 1, active + 1);
      else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
      else if (e.key === 'PageDown') active = Math.min(shown.length - 1, active + 10);
      else if (e.key === 'PageUp') active = Math.max(0, active - 10);
      else if (e.key === 'Enter') {
        e.preventDefault();
        return pick(shown[active]);
      } else if (e.key === 'Escape') {
        this.closePopup();
        e.preventDefault();
        e.stopPropagation();
        return;
      } else return;
      e.preventDefault();
      render();
    });
    document.body.append(box);
    this.popup = box;
    const r = anchor.getBoundingClientRect();
    box.style.top = `${r.bottom + 4}px`;
    box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - box.offsetWidth - 4))}px`;
    render();
    input.focus();
  }
}
