// The log filter bar (IntelliJ VcsLogClassicFilterUi): "Text or hash" field with history, Regex and Match Case;
// Branch / User / Date / Paths (/ Roots for several repositories) filter buttons whose popups have search and
// multi-select, a selected filter showing "Branch: main" with an × to clear it; a right-side toolbar slot.
import type { LogFilters, LogState, PathSuggestion, RefsInfo, UsersResult } from '../../features/log/protocol';
import { rpc, viewState } from '../shared/rpc';
import {
  DisposableStore,
  formatDate,
  h,
  icon,
  openModal,
  promptDialog,
  SearchField,
  setTooltip,
  showListPopup,
  type PopupEntry,
} from '../shared/ui';

const ALL = '\0all';
const SELECT = '\0select';
const TREE = '\0tree';
const DAY = 86400;

export interface FilterBarHost {
  state(): LogState;
  refs(): RefsInfo[];
  setFilters(f: LogFilters): void;
  /** history view: the fixed paths (shown read-only) */
  historyPaths?: string[];
}

const base = (p: string) => p.replace(/\/+$/, '').slice(p.replace(/\/+$/, '').lastIndexOf('/') + 1) || p;

function join(values: string[]): string {
  return values.join(', ');
}

export class FilterBar {
  readonly element: HTMLElement;
  readonly text: SearchField;
  private readonly store = new DisposableStore();
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly filtersEl: HTMLElement;
  readonly rightSlot: HTMLElement;
  /** after the filter buttons (IntelliSort / graph options chooser) */
  readonly sortSlot: HTMLElement;

  constructor(private readonly host: FilterBarHost) {
    this.text = new SearchField(null, { placeholder: 'Text or hash', regex: false, matchCase: false, historyKey: 'log.text', debounce: 700, ariaLabel: 'Log text or hash filter' });
    this.text.element.classList.add('lg-text-filter');
    this.store.add(setTooltip(this.text.input, 'Filter by Commit Message or Hashes'));
    const apply = () => {
      const f = { ...this.host.state().filters };
      const v = this.text.value.trim();
      if (v) f.text = this.text.value;
      else delete f.text;
      if (this.text.regex) f.regex = true;
      else delete f.regex;
      if (this.text.matchCase) f.matchCase = true;
      else delete f.matchCase;
      const cur = this.host.state().filters;
      if ((f.text ?? '') === (cur.text ?? '') && !!f.regex === !!cur.regex && !!f.matchCase === !!cur.matchCase) return;
      this.host.setFilters(f);
    };
    this.store.add(this.text.onDidChange(apply));
    this.store.add(this.text.onDidSubmit(apply));
    this.filtersEl = h('div.lg-filters');
    this.rightSlot = h('div.lg-filterbar-right');
    this.sortSlot = h('div.lg-filterbar-sort');
    this.element = h('div.lg-filterbar', null, this.text.element, this.filtersEl, this.sortSlot, h('div.lg-filterbar-spacer'), this.rightSlot);
    this.mk('branch', 'Branch', 'Filter by Branch', (el) => this.branchPopup(el), () => this.patch({ branches: undefined }));
    this.mk('user', 'User', 'Filter by User', (el) => this.userPopup(el), () => this.patch({ users: undefined }));
    this.mk('date', 'Date', 'Filter by Date', (el) => this.datePopup(el), () => this.patch({ since: undefined, until: undefined }));
    this.mk('paths', 'Paths', 'Paths', (el) => this.pathsPopup(el), () => this.patch({ paths: undefined }));
    this.mk('roots', 'Roots', 'Roots', (el) => this.rootsPopup(el), () => this.patch({ roots: undefined }));
  }

  private mk(id: string, label: string, tooltip: string, open: (el: HTMLElement) => void, clear: () => void): void {
    const clearBtn = h('span.lg-filter-clear', {
      attrs: { role: 'button', 'aria-label': 'Clear' },
      onMousedown: (e: MouseEvent) => e.stopPropagation(),
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        clear();
      },
    }, icon('close'));
    const btn = h('button.lg-filter', {
      type: 'button',
      dataset: { id },
      onClick: () => open(btn),
      onKeydown: (e: KeyboardEvent) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && btn.classList.contains('lg-set')) {
          e.preventDefault();
          clear();
        }
      },
    }, h('span.lg-filter-name', null, label), h('span.lg-filter-value'), h('span.jb-chevron'), clearBtn);
    this.store.add(setTooltip(btn, tooltip));
    this.store.add(setTooltip(clearBtn, 'Clear'));
    this.buttons.set(id, btn);
    this.filtersEl.append(btn);
  }

  private patch(p: Partial<LogFilters>): void {
    const f: LogFilters = { ...this.host.state().filters, ...p };
    for (const k of Object.keys(f) as (keyof LogFilters)[]) if (f[k] === undefined) delete f[k];
    this.host.setFilters(f);
  }

  /** Re-renders the button values from the state. */
  update(): void {
    const s = this.host.state();
    const f = s.filters;
    if (document.activeElement !== this.text.input || !this.text.value) {
      this.text.setValue(f.text ?? '');
      this.text.setToggles({ regex: !!f.regex, matchCase: !!f.matchCase });
    }
    const set = (id: string, value: string | undefined, opts: { hidden?: boolean; disabled?: boolean } = {}) => {
      const b = this.buttons.get(id)!;
      b.classList.toggle('jb-hidden', !!opts.hidden);
      b.classList.toggle('lg-set', !!value);
      b.classList.toggle('lg-readonly', !!opts.disabled);
      b.disabled = !!opts.disabled;
      const name = b.querySelector('.lg-filter-name')!;
      name.textContent = `${{ branch: 'Branch', user: 'User', date: 'Date', paths: 'Paths', roots: 'Roots' }[id]}${value ? ':' : ''}`;
      b.querySelector('.lg-filter-value')!.textContent = value ? ` ${value}` : '';
      b.title = value ?? '';
    };
    set('branch', f.branches?.length ? join(f.branches.map((b) => (b === 'HEAD' ? 'HEAD' : b))) : undefined);
    set('user', f.users?.length ? join(f.users) : undefined);
    set('date', dateText(f));
    if (this.host.historyPaths?.length) set('paths', join(this.host.historyPaths.map(base)), { disabled: true });
    else set('paths', f.paths?.length ? join(f.paths.map(base)) : undefined);
    const roots = s.roots;
    set('roots', f.roots?.length ? join(f.roots.map((r) => roots.find((x) => x.root === r)?.name ?? base(r))) : undefined, { hidden: roots.length < 2 });
  }

  focusText(): void {
    this.text.focus();
  }

  // ---------------------------------------------------------------- popups

  private async branchPopup(anchor: HTMLElement): Promise<void> {
    const f = this.host.state().filters;
    const sel = new Set(f.branches ?? []);
    const refs = this.host.refs();
    const items: PopupEntry<string>[] = [
      { value: ALL, label: 'All', action: true },
      { value: SELECT, label: 'Select…', action: true },
      '-',
      { value: 'HEAD', label: 'HEAD (Current Branch)', icon: 'tag', checked: sel.has('HEAD') },
    ];
    const uniq = (list: string[]) => [...new Set(list)];
    const section = (title: string, names: string[], ic: string) => {
      if (!names.length) return;
      items.push({ header: title });
      for (const n of names) items.push({ value: n, label: n, icon: ic, checked: sel.has(n) });
    };
    section('Favorites', uniq(refs.flatMap((r) => r.favorites)), 'star-full');
    section('Recent', uniq(refs.flatMap((r) => r.recent)).slice(0, 5), 'history');
    section('Local', uniq(refs.flatMap((r) => r.local.map((x) => x.name))), 'git-branch');
    section('Remote', uniq(refs.flatMap((r) => r.remote.map((x) => x.name).filter((n) => !n.endsWith('/HEAD')))), 'cloud');
    section('Tags', uniq(refs.flatMap((r) => r.tags.map((x) => x.name))), 'tag');
    const picked = await showListPopup(anchor, { items, multiSelect: true, search: true, placeholder: 'Search', width: 320, emptyText: 'No items' });
    if (!picked) return;
    if (picked.includes(ALL)) return this.patch({ branches: undefined });
    if (picked.includes(SELECT)) {
      const v = await promptDialog({ title: 'Select Branches', label: 'Select one or more values separated with | or new lines', value: (f.branches ?? []).join('|') });
      if (v === undefined) return;
      const list = uniq(v.split(/[|\n]/).map((x) => x.trim()).filter(Boolean));
      return this.patch({ branches: list.length ? list : undefined });
    }
    const list = uniq(picked);
    this.patch({ branches: list.length ? list : undefined });
  }

  private async userPopup(anchor: HTMLElement): Promise<void> {
    const f = this.host.state().filters;
    const sel = new Set(f.users ?? []);
    let users: UsersResult = { users: [], me: [] };
    try {
      users = await rpc.call<UsersResult>('users');
    } catch {
      /* empty list */
    }
    const items: PopupEntry<string>[] = [
      { value: ALL, label: 'All', action: true },
      { value: SELECT, label: 'Select…', action: true },
      '-',
      { value: 'me', label: 'me', icon: 'account', checked: sel.has('me'), description: users.me.map((m) => m.name ?? m.email).filter(Boolean).join(', ') },
      '-',
    ];
    for (const u of users.users) items.push({ value: u.name, label: u.name, checked: sel.has(u.name), searchText: `${u.name} ${u.email}`, tooltip: `${u.name} <${u.email}>`, trailing: String(u.count) });
    for (const v of sel) if (v !== 'me' && !users.users.some((u) => u.name === v)) items.push({ value: v, label: v, checked: true });
    const picked = await showListPopup(anchor, { items, multiSelect: true, search: true, placeholder: 'Search', width: 300, emptyText: 'No items' });
    if (!picked) return;
    if (picked.includes(ALL)) return this.patch({ users: undefined });
    if (picked.includes(SELECT)) {
      const v = await promptDialog({ title: 'Select Users', label: 'Select one or more values separated with | or new lines', value: (f.users ?? []).join('|') });
      if (v === undefined) return;
      const list = [...new Set(v.split(/[|\n]/).map((x) => x.trim()).filter(Boolean))];
      return this.patch({ users: list.length ? list : undefined });
    }
    const list = [...new Set(picked)];
    this.patch({ users: list.length ? list : undefined });
  }

  private async datePopup(anchor: HTMLElement): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const items: PopupEntry<string>[] = [
      { value: ALL, label: 'All' },
      { value: SELECT, label: 'Select…' },
      '-',
      { value: 'day', label: 'Last 24 hours' },
      { value: 'week', label: 'Last 7 days' },
    ];
    const picked = (await showListPopup(anchor, { items, search: false, width: 200 }))?.[0];
    if (!picked) return;
    if (picked === ALL) return this.patch({ since: undefined, until: undefined });
    if (picked === 'day') return this.patch({ since: now - DAY, until: undefined });
    if (picked === 'week') return this.patch({ since: now - 7 * DAY, until: undefined });
    const f = this.host.state().filters;
    const r = await selectPeriod(f.since, f.until);
    if (r) this.patch({ since: r.since, until: r.until });
  }

  private async pathsPopup(anchor: HTMLElement): Promise<void> {
    const f = this.host.state().filters;
    const recent = viewState.get<string[][]>('log.recentPaths', []);
    const items: PopupEntry<string>[] = [
      { value: ALL, label: 'All' },
      { value: SELECT, label: 'Select…' },
      { value: TREE, label: 'Select in Tree…' },
    ];
    if (recent.length) {
      items.push({ header: 'Recent' });
      recent.forEach((r, i) => items.push({ value: `r${i}`, label: join(r.map(base)), tooltip: r.join('\n'), icon: 'folder' }));
    }
    const picked = (await showListPopup(anchor, { items, search: false, width: 300 }))?.[0];
    if (!picked) return;
    let paths: string[] | undefined;
    if (picked === ALL) return this.patch({ paths: undefined });
    if (picked === SELECT) paths = await selectPaths(f.paths ?? []);
    else if (picked === TREE) {
      const r = await rpc.call<string[]>('selectFolders').catch(() => [] as string[]);
      paths = r.length ? r : undefined;
    } else paths = recent[Number(picked.slice(1))];
    if (!paths) return;
    if (paths.length) {
      const key = paths.join('\n');
      viewState.set('log.recentPaths', [paths, ...recent.filter((r) => r.join('\n') !== key)].slice(0, 5));
    }
    this.patch({ paths: paths.length ? paths : undefined });
  }

  private async rootsPopup(anchor: HTMLElement): Promise<void> {
    const s = this.host.state();
    const sel = new Set(s.filters.roots ?? s.roots.map((r) => r.root));
    const items: PopupEntry<string>[] = [{ value: ALL, label: 'All', action: true }, '-'];
    for (const r of s.roots) items.push({ value: r.root, label: r.name, icon: 'repo', checked: sel.has(r.root), tooltip: r.root });
    const picked = await showListPopup(anchor, { items, multiSelect: true, search: s.roots.length > 10, width: 260, emptyText: 'No roots' });
    if (!picked) return;
    if (picked.includes(ALL) || !picked.length || picked.length === s.roots.length) return this.patch({ roots: undefined });
    this.patch({ roots: [...new Set(picked)] });
  }

  dispose(): void {
    this.store.dispose();
    this.text.dispose();
  }
}

/** "Since 27/10/26" / "Until 27/10/26" / "between 27/10/26 and 28/10/26". */
export function dateText(f: LogFilters): string | undefined {
  if (f.since && f.until) return `between ${formatDate(f.since)} and ${formatDate(f.until)}`;
  if (f.since) return `Since ${formatDate(f.since)}`;
  if (f.until) return `Until ${formatDate(f.until)}`;
  return undefined;
}

const toInput = (t: number | undefined) => {
  if (!t) return '';
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fromInput = (v: string, endOfDay: boolean): number | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  return Math.floor(d.getTime() / 1000);
};

/** "Select Period" dialog: optional From / To dates. */
async function selectPeriod(since?: number, until?: number): Promise<{ since?: number; until?: number } | undefined> {
  const from = h('input.jb-input', { type: 'date', value: toInput(since) });
  const to = h('input.jb-input', { type: 'date', value: toInput(until) });
  const body = h('div.lg-period', null, h('label', null, 'From:'), from, h('label', null, 'To:'), to);
  const r = await openModal({
    title: 'Select Period',
    body,
    width: 360,
    initialFocus: from,
    buttons: [
      { id: 'ok', label: 'OK', primary: true },
      { id: 'cancel', label: 'Cancel', cancel: true },
    ],
  }).result;
  if (r !== 'ok') return undefined;
  return { since: fromInput(from.value, false), until: fromInput(to.value, true) };
}

/** Paths filter "Select…": search tracked files/folders, pick several. */
async function selectPaths(initial: string[]): Promise<string[] | undefined> {
  const chosen = [...initial];
  const input = h('input.jb-input', { type: 'text', placeholder: 'Type a file or folder name', spellcheck: false });
  const list = h('div.lg-paths-list');
  const chosenEl = h('div.lg-paths-chosen');
  const renderChosen = () => {
    chosenEl.replaceChildren(
      ...(chosen.length
        ? chosen.map((p, i) =>
            h('div.lg-paths-item', null, icon('folder'), h('span.lg-paths-text', { title: p }, p), h('button.jb-icon-btn', { type: 'button', title: 'Remove', onClick: () => {
              chosen.splice(i, 1);
              renderChosen();
            } }, icon('close'))),
          )
        : [h('div.jb-muted', null, 'No paths')]),
    );
  };
  let seq = 0;
  const search = async () => {
    const my = ++seq;
    const res = await rpc.call<PathSuggestion[]>('paths', { query: input.value, limit: 60 }).catch(() => [] as PathSuggestion[]);
    if (my !== seq) return;
    list.replaceChildren(
      ...res.map((p) =>
        h('div.lg-paths-item.lg-paths-suggestion', {
          title: p.abs,
          onClick: () => {
            if (!chosen.includes(p.abs)) chosen.push(p.abs);
            renderChosen();
          },
        }, icon(p.dir ? 'folder' : 'file'), h('span.lg-paths-text', null, p.path)),
      ),
    );
    if (!res.length) list.append(h('div.jb-muted', null, 'No paths'));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = list.querySelector<HTMLElement>('.lg-paths-suggestion');
      if (first) {
        e.preventDefault();
        e.stopPropagation();
        first.click();
      }
    }
  });
  renderChosen();
  void search();
  const body = h('div.lg-paths-dialog', null, input, list, h('div.jb-muted.lg-paths-label', null, 'Selected:'), chosenEl);
  const r = await openModal({
    title: 'Select Paths to Filter by',
    body,
    width: 520,
    initialFocus: input,
    buttons: [
      { id: 'ok', label: 'OK', primary: true },
      { id: 'cancel', label: 'Cancel', cancel: true },
    ],
  }).result;
  return r === 'ok' ? chosen : undefined;
}
