// IntelliJ-like changelists and commit inclusion (pure, persisted as JSON in workspaceState): named lists with a
// comment and one active list, file → list membership (new changes land in the active list), and the checkbox
// state (tracked changes included by default, unversioned files excluded by default).
import type { ChangelistInfo } from './protocol';

export interface ChangelistData {
  lists: ChangelistInfo[];
  /** fileKey → list id */
  files: Record<string, string>;
  /** tracked changes the user unchecked */
  excluded: string[];
  /** unversioned files the user checked */
  includedUnversioned: string[];
}

export const DEFAULT_LIST_NAME = 'Changes';

export class ChangelistModel {
  lists: ChangelistInfo[];
  private files: Map<string, string>;
  private excluded: Set<string>;
  private includedUnversioned: Set<string>;
  private seq = 0;

  constructor(data?: Partial<ChangelistData>) {
    this.lists = (data?.lists ?? []).map((l) => ({ ...l }));
    this.files = new Map(Object.entries(data?.files ?? {}));
    this.excluded = new Set(data?.excluded ?? []);
    this.includedUnversioned = new Set(data?.includedUnversioned ?? []);
    this.normalize();
  }

  private newId(): string {
    let id: string;
    do id = `cl${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    while (this.lists.some((l) => l.id === id));
    return id;
  }

  /** At least one list, exactly one active, files only in existing lists. */
  private normalize(): void {
    if (!this.lists.length) this.lists.push({ id: 'default', name: DEFAULT_LIST_NAME, comment: '', active: true });
    const active = this.lists.filter((l) => l.active);
    if (active.length !== 1) this.lists.forEach((l, i) => (l.active = active.length ? l === active[0] : i === 0));
    const ids = new Set(this.lists.map((l) => l.id));
    for (const [k, v] of this.files) if (!ids.has(v)) this.files.set(k, this.active.id);
  }

  get active(): ChangelistInfo {
    return this.lists.find((l) => l.active) ?? this.lists[0];
  }

  get(id: string): ChangelistInfo | undefined {
    return this.lists.find((l) => l.id === id);
  }

  /** Lists in display order: active first, then by name. */
  sorted(): ChangelistInfo[] {
    return [...this.lists].sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
  }

  /**
   * Updates membership with the current changes: new tracked changes go to the active list, files that are no
   * longer changed are forgotten (also their checkbox state). Returns true when something changed.
   */
  sync(tracked: Iterable<string>, unversioned: Iterable<string>): boolean {
    let changed = false;
    const t = new Set(tracked);
    const u = new Set(unversioned);
    const active = this.active.id;
    for (const k of t) {
      if (!this.files.has(k)) {
        this.files.set(k, active);
        changed = true;
      }
    }
    for (const k of [...this.files.keys()]) {
      if (!t.has(k)) {
        this.files.delete(k);
        changed = true;
      }
    }
    for (const k of [...this.excluded]) {
      if (!t.has(k)) {
        this.excluded.delete(k);
        changed = true;
      }
    }
    for (const k of [...this.includedUnversioned]) {
      if (!u.has(k)) {
        this.includedUnversioned.delete(k);
        changed = true;
      }
    }
    return changed;
  }

  listOf(key: string): string {
    return this.files.get(key) ?? this.active.id;
  }

  isIncluded(key: string, unversioned: boolean): boolean {
    return unversioned ? this.includedUnversioned.has(key) : !this.excluded.has(key);
  }

  setIncluded(keys: Iterable<string>, included: boolean, unversioned: (key: string) => boolean): void {
    for (const k of keys) {
      if (unversioned(k)) {
        if (included) this.includedUnversioned.add(k);
        else this.includedUnversioned.delete(k);
      } else if (included) this.excluded.delete(k);
      else this.excluded.add(k);
    }
  }

  /** Includes exactly `keys` (Commit File…): everything else is excluded. */
  includeOnly(keys: Iterable<string>, tracked: Iterable<string>, unversioned: Iterable<string>): void {
    const only = new Set(keys);
    this.excluded = new Set([...tracked].filter((k) => !only.has(k)));
    this.includedUnversioned = new Set([...unversioned].filter((k) => only.has(k)));
  }

  validateName(name: string, exceptId?: string): string | undefined {
    const n = name.trim();
    if (!n) return 'Cannot create new changelist with empty name';
    if (this.lists.some((l) => l.id !== exceptId && l.name === n)) return 'A changelist with that name already exists';
    return undefined;
  }

  add(name: string, comment = '', setActive = false): ChangelistInfo {
    const err = this.validateName(name);
    if (err) throw new Error(err);
    const l: ChangelistInfo = { id: this.newId(), name: name.trim(), comment, active: false };
    this.lists.push(l);
    if (setActive) this.setActive(l.id);
    return l;
  }

  edit(id: string, name: string, comment: string, setActive?: boolean): void {
    const l = this.get(id);
    if (!l) return;
    const err = this.validateName(name, id);
    if (err) throw new Error(err);
    l.name = name.trim();
    l.comment = comment;
    if (setActive) this.setActive(id);
  }

  setComment(id: string, comment: string): void {
    const l = this.get(id);
    if (l) l.comment = comment;
  }

  setActive(id: string): void {
    if (!this.get(id)) return;
    for (const l of this.lists) l.active = l.id === id;
  }

  /** Deletes lists; their files move to the active list (a new active list is chosen when the active one goes). */
  remove(ids: Iterable<string>): void {
    const del = new Set(ids);
    this.lists = this.lists.filter((l) => !del.has(l.id));
    this.normalize();
  }

  move(keys: Iterable<string>, listId: string): void {
    if (!this.get(listId)) return;
    for (const k of keys) this.files.set(k, listId);
  }

  toJSON(): ChangelistData {
    return {
      lists: this.lists.map((l) => ({ ...l })),
      files: Object.fromEntries(this.files),
      excluded: [...this.excluded],
      includedUnversioned: [...this.includedUnversioned],
    };
  }
}
