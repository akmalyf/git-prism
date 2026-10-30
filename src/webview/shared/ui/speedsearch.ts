// IntelliJ speed search for lists/trees/tables: typing while the component is focused opens a small search box,
// matches are highlighted, ↑/↓ jump between matches, Backspace edits, Esc closes.
import { h } from './dom';
import { icon } from './icons';

export interface SpeedSearchHost {
  /** pattern changed (empty string when closed) */
  onPattern(pattern: string): void;
  /** ↑/↓ while searching: move to the previous/next match */
  onNavigate(dir: 1 | -1): void;
}

export class SpeedSearch {
  readonly element: HTMLElement;
  private text = '';
  private readonly label: HTMLElement;

  constructor(container: HTMLElement, private readonly host: SpeedSearchHost) {
    this.label = h('span.jb-speedsearch-text');
    this.element = h('div.jb-speedsearch.jb-hidden', null, icon('search'), this.label);
    container.appendChild(this.element);
  }

  get active(): boolean {
    return this.text.length > 0;
  }

  get pattern(): string {
    return this.text;
  }

  setNoMatch(noMatch: boolean): void {
    this.element.classList.toggle('jb-nomatch', noMatch);
  }

  /** Returns true when the key was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key.length === 1 && (e.key !== ' ' || this.active)) {
      this.set(this.text + e.key);
      return true;
    }
    if (!this.active) return false;
    switch (e.key) {
      case 'Backspace':
        this.set(this.text.slice(0, -1));
        return true;
      case 'Escape':
        this.close();
        return true;
      case 'ArrowDown':
        this.host.onNavigate(1);
        return true;
      case 'ArrowUp':
        this.host.onNavigate(-1);
        return true;
      default:
        return false;
    }
  }

  close(): void {
    if (this.active) this.set('');
  }

  private set(t: string): void {
    this.text = t;
    this.label.textContent = t;
    this.element.classList.toggle('jb-hidden', !t);
    if (!t) this.element.classList.remove('jb-nomatch');
    this.host.onPattern(t);
  }
}
