// Search box (IntelliJ SearchTextField): magnifier with history dropdown, clear button, optional '.*' regex,
// 'Cc' match case and 'W' whole words toggles. History is persisted per historyKey.
import { h, listen, DisposableStore, Emitter } from './dom';
import { icon } from './icons';
import { setTooltip } from './tooltip';
import { showDropdownMenu } from './menu';
import { loadState, saveState } from './persist';
import { ensureStyles } from './styles';

export interface SearchState {
  value: string;
  regex: boolean;
  matchCase: boolean;
  wholeWords: boolean;
}

export interface SearchFieldOptions {
  placeholder?: string;
  value?: string;
  /** undefined hides the toggle */
  regex?: boolean;
  matchCase?: boolean;
  wholeWords?: boolean;
  historyKey?: string;
  historySize?: number;
  /** ms to debounce onDidChange for typing (toggles fire immediately); default 0 */
  debounce?: number;
  monospace?: boolean;
  ariaLabel?: string;
}

export class SearchField {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly store = new DisposableStore();
  private readonly changed = new Emitter<SearchState>();
  private readonly submitted = new Emitter<SearchState>();
  readonly onDidChange = this.changed.event;
  readonly onDidSubmit = this.submitted.event;
  private regexOn: boolean;
  private caseOn: boolean;
  private wordsOn: boolean;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private history: string[];
  private clearBtn: HTMLElement;
  private toggles = new Map<string, HTMLElement>();
  private lastFired = '';

  constructor(parent: HTMLElement | null, private readonly o: SearchFieldOptions = {}) {
    ensureStyles();
    this.regexOn = !!o.regex;
    this.caseOn = !!o.matchCase;
    this.wordsOn = !!o.wholeWords;
    this.history = loadState<string[]>(o.historyKey ? `search.${o.historyKey}` : undefined, []);
    this.input = h('input.jb-search-input', {
      type: 'text',
      value: o.value ?? '',
      placeholder: o.placeholder ?? '',
      spellcheck: false,
      class: { 'jb-mono': o.monospace },
      attrs: { 'aria-label': o.ariaLabel ?? o.placeholder },
    });
    const histBtn = h('span.jb-search-icon', { class: { 'jb-has-history': !!o.historyKey } }, icon('search'), o.historyKey ? h('span.jb-chevron') : null);
    this.clearBtn = h('button.jb-search-clear', { type: 'button', tabIndex: -1, onClick: () => this.clearValue() }, icon('close'));
    this.store.add(setTooltip(this.clearBtn, 'Clear'));
    const right = h('span.jb-search-toggles', null, this.clearBtn);
    const mkToggle = (id: string, ic: string, tip: string, get: () => boolean, set: (v: boolean) => void) => {
      const b = h('button.jb-search-toggle', {
        type: 'button',
        tabIndex: -1,
        class: { 'jb-on': get() },
        attrs: { 'aria-pressed': String(get()), 'aria-label': tip },
        onMousedown: (e: MouseEvent) => e.preventDefault(),
        onClick: () => {
          set(!get());
          b.classList.toggle('jb-on', get());
          b.setAttribute('aria-pressed', String(get()));
          this.fire(true);
        },
      }, icon(ic));
      this.store.add(setTooltip(b, tip));
      this.toggles.set(id, b);
      right.append(b);
    };
    if (o.regex !== undefined) mkToggle('regex', 'regex', 'Regex', () => this.regexOn, (v) => (this.regexOn = v));
    if (o.matchCase !== undefined) mkToggle('case', 'case-sensitive', 'Match Case', () => this.caseOn, (v) => (this.caseOn = v));
    if (o.wholeWords !== undefined) mkToggle('words', 'whole-word', 'Words', () => this.wordsOn, (v) => (this.wordsOn = v));
    this.element = h('div.jb-search', null, histBtn, this.input, right);
    if (o.historyKey) {
      this.store.add(setTooltip(histBtn, 'Recent Searches'));
      this.store.add(listen(histBtn, 'mousedown', (e) => {
        e.preventDefault();
        this.showHistory();
      }));
    } else this.store.add(listen(histBtn, 'mousedown', (e) => {
      e.preventDefault();
      this.input.focus();
    }));
    this.store.add(listen(this.input, 'input', () => {
      this.updateClear();
      this.fire(false);
    }));
    this.store.add(listen(this.input, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.flush();
        this.addToHistory(this.input.value);
        this.submitted.fire(this.state);
      } else if (e.key === 'Escape' && this.input.value) {
        e.preventDefault();
        e.stopPropagation();
        this.clearValue();
      } else if (e.key === 'ArrowDown' && e.altKey && o.historyKey) {
        e.preventDefault();
        this.showHistory();
      }
    }));
    this.store.add(listen(this.input, 'blur', () => this.addToHistory(this.input.value)));
    this.lastFired = this.key();
    this.updateClear();
    parent?.appendChild(this.element);
  }

  get value(): string {
    return this.input.value;
  }

  get regex(): boolean {
    return this.regexOn;
  }

  get matchCase(): boolean {
    return this.caseOn;
  }

  get wholeWords(): boolean {
    return this.wordsOn;
  }

  get state(): SearchState {
    return { value: this.input.value, regex: this.regexOn, matchCase: this.caseOn, wholeWords: this.wordsOn };
  }

  /** Sets the value (and toggles) without firing onDidChange unless `fire` is true. */
  setValue(value: string, fire = false): void {
    this.input.value = value;
    this.updateClear();
    if (fire) this.fire(true);
    else this.lastFired = this.key();
  }

  setToggles(t: { regex?: boolean; matchCase?: boolean; wholeWords?: boolean }): void {
    if (t.regex !== undefined) this.regexOn = t.regex;
    if (t.matchCase !== undefined) this.caseOn = t.matchCase;
    if (t.wholeWords !== undefined) this.wordsOn = t.wholeWords;
    const sync = (id: string, v: boolean) => {
      const b = this.toggles.get(id);
      b?.classList.toggle('jb-on', v);
      b?.setAttribute('aria-pressed', String(v));
    };
    sync('regex', this.regexOn);
    sync('case', this.caseOn);
    sync('words', this.wordsOn);
    this.lastFired = this.key();
  }

  /** Builds a RegExp for the current state (null for an empty value; throws on an invalid regex). */
  toRegExp(flags = ''): RegExp | null {
    const v = this.input.value;
    if (!v) return null;
    let src = this.regexOn ? v : v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (this.wordsOn) src = `\\b(?:${src})\\b`;
    return new RegExp(src, flags + (this.caseOn ? '' : 'i'));
  }

  setInvalid(invalid: boolean): void {
    this.element.classList.toggle('jb-invalid', invalid);
  }

  focus(select = true): void {
    this.input.focus();
    if (select) this.input.select();
  }

  addToHistory(v: string): void {
    v = v.trim();
    if (!v || !this.o.historyKey) return;
    this.history = [v, ...this.history.filter((x) => x !== v)].slice(0, this.o.historySize ?? 20);
    saveState(`search.${this.o.historyKey}`, this.history);
  }

  private showHistory(): void {
    const items = this.history.length
      ? [
          { header: 'Recent Searches' },
          ...this.history.map((v) => ({ label: v, run: () => {
            this.setValue(v, true);
            this.input.focus();
          } })),
          '-' as const,
          { label: 'Clear History', run: () => {
            this.history = [];
            saveState(`search.${this.o.historyKey}`, []);
          } },
        ]
      : [{ header: 'No recent searches' }];
    showDropdownMenu(items, this.element, { selectFirst: false, minWidth: this.element.offsetWidth });
  }

  private clearValue(): void {
    if (!this.input.value) return;
    this.input.value = '';
    this.updateClear();
    this.fire(true);
    this.input.focus();
  }

  private updateClear(): void {
    this.clearBtn.style.visibility = this.input.value ? 'visible' : 'hidden';
  }

  private key(): string {
    return JSON.stringify(this.state);
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const k = this.key();
    if (k === this.lastFired) return;
    this.lastFired = k;
    this.changed.fire(this.state);
  }

  private fire(immediate: boolean): void {
    if (this.timer) clearTimeout(this.timer);
    if (immediate || !this.o.debounce) this.flush();
    else this.timer = setTimeout(() => this.flush(), this.o.debounce);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.store.dispose();
    this.changed.dispose();
    this.submitted.dispose();
    this.element.remove();
  }
}
