// Selection model shared by Tree and Table (pure): selected keys + anchor (Shift ranges) + lead (focused row).
import { Emitter } from './events';

export interface SelectionNav<K> {
  indexOf(key: K): number;
  keyAt(index: number): K | undefined;
  readonly count: number;
}

export class SelectionModel<K> {
  private sel = new Set<K>();
  anchor: K | undefined;
  lead: K | undefined;
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(readonly multi = true) {}

  get selected(): ReadonlySet<K> {
    return this.sel;
  }

  get size(): number {
    return this.sel.size;
  }

  isSelected(key: K): boolean {
    return this.sel.has(key);
  }

  /** Selected keys in view order. */
  ordered(nav: SelectionNav<K>): K[] {
    return [...this.sel].map((k) => [k, nav.indexOf(k)] as const).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  }

  /** Replaces the selection. */
  set(keys: Iterable<K>, lead?: K): void {
    const arr = [...keys];
    const next = new Set(this.multi ? arr : arr.slice(0, 1));
    const newLead = lead ?? arr[arr.length - 1];
    const same = next.size === this.sel.size && [...next].every((k) => this.sel.has(k)) && newLead === this.lead;
    this.sel = next;
    this.lead = newLead;
    this.anchor = newLead;
    if (!same) this.changed.fire();
  }

  clear(): void {
    if (!this.sel.size && this.lead === undefined) return;
    this.sel.clear();
    this.lead = this.anchor = undefined;
    this.changed.fire();
  }

  /** Mouse click semantics: plain = single, toggle (Cmd/Ctrl) = add/remove, shift = range from anchor. */
  click(key: K, nav: SelectionNav<K>, mods: { shift?: boolean; toggle?: boolean } = {}): void {
    if (this.multi && mods.shift && this.anchor !== undefined && nav.indexOf(this.anchor) >= 0) {
      const anchor = this.anchor;
      const range = this.range(anchor, key, nav);
      const next = mods.toggle ? new Set([...this.sel, ...range]) : new Set(range);
      this.sel = next;
      this.lead = key;
      this.anchor = anchor;
      this.changed.fire();
      return;
    }
    if (this.multi && mods.toggle) {
      if (this.sel.has(key)) this.sel.delete(key);
      else this.sel.add(key);
      this.lead = key;
      this.anchor = key;
      this.changed.fire();
      return;
    }
    this.set([key], key);
  }

  /** Keyboard move: moves the lead; with extend, selects anchor..key. */
  moveTo(key: K, nav: SelectionNav<K>, extend = false): void {
    if (extend && this.multi && this.anchor !== undefined && nav.indexOf(this.anchor) >= 0) {
      const anchor = this.anchor;
      this.sel = new Set(this.range(anchor, key, nav));
      this.lead = key;
      this.anchor = anchor;
      this.changed.fire();
    } else {
      this.set([key], key);
    }
  }

  selectAll(nav: SelectionNav<K>, selectable: (k: K) => boolean = () => true): void {
    if (!this.multi) return;
    const all: K[] = [];
    for (let i = 0; i < nav.count; i++) {
      const k = nav.keyAt(i);
      if (k !== undefined && selectable(k)) all.push(k);
    }
    const lead = this.lead;
    this.sel = new Set(all);
    this.lead = lead !== undefined && this.sel.has(lead) ? lead : all[0];
    this.changed.fire();
  }

  /** Drops keys that no longer exist (after a data refresh); fires only when something changed. */
  retain(exists: (k: K) => boolean): void {
    let changed = false;
    for (const k of [...this.sel]) {
      if (!exists(k)) {
        this.sel.delete(k);
        changed = true;
      }
    }
    if (this.lead !== undefined && !exists(this.lead)) {
      this.lead = [...this.sel][0];
      changed = true;
    }
    if (this.anchor !== undefined && !exists(this.anchor)) this.anchor = this.lead;
    if (changed) this.changed.fire();
  }

  private range(a: K, b: K, nav: SelectionNav<K>): K[] {
    let i = nav.indexOf(a);
    let j = nav.indexOf(b);
    if (i < 0) i = j;
    if (i > j) [i, j] = [j, i];
    const out: K[] = [];
    for (let x = i; x <= j; x++) {
      const k = nav.keyAt(x);
      if (k !== undefined) out.push(k);
    }
    return out;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** SelectionNav over an array of keys (builds an index map). */
export function arrayNav<K>(keys: readonly K[]): SelectionNav<K> {
  const map = new Map<K, number>();
  keys.forEach((k, i) => map.set(k, i));
  return { indexOf: (k) => map.get(k) ?? -1, keyAt: (i) => keys[i], count: keys.length };
}
