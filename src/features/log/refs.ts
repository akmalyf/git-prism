// Pure reference helpers for the Git Log (no vscode/node imports): IntelliJ GitRefManager ordering of reference
// labels (HEAD, local, remote, tags; main/master first) and the default favorites. Graph head order and lane colors
// live in intellisort.ts / data.ts.
import type { Ref } from '../../core/types';
import type { RefItem, RefLabel } from './protocol';

const MAIN_NAMES = ['main', 'master'];

function typeRank(kind: RefLabel['kind']): number {
  return kind === 'HEAD' ? 0 : kind === 'local' ? 1 : kind === 'remote' ? 2 : 3;
}

function nameRank(l: { name: string; kind: RefLabel['kind']; current?: boolean }): number {
  if (l.current) return 0;
  const base = l.kind === 'remote' ? l.name.slice(l.name.indexOf('/') + 1) : l.name;
  if (l.kind === 'local' || l.kind === 'remote') {
    const i = MAIN_NAMES.indexOf(base);
    if (i >= 0) return 1 + i + (l.kind === 'remote' && !l.name.startsWith('origin/') ? 2 : 0);
  }
  return 9;
}

export function compareLabels(a: RefLabel, b: RefLabel): number {
  return typeRank(a.kind) - typeRank(b.kind) || nameRank(a) - nameRank(b) || a.name.localeCompare(b.name);
}

/** IntelliJ default favorites: main/master and origin/main / origin/master. */
export function isDefaultFavorite(short: string): boolean {
  return MAIN_NAMES.includes(short) || MAIN_NAMES.some((m) => short === `origin/${m}`);
}

export function toLabel(r: Ref, current: string | undefined, favorites: ReadonlySet<string>): RefLabel | undefined {
  const kind = r.type === 'head' ? 'local' : r.type === 'remote' ? 'remote' : r.type === 'tag' ? 'tag' : undefined;
  if (!kind) return undefined;
  const l: RefLabel = { name: r.short, full: r.name, kind };
  if (kind === 'local' && r.short === current) l.current = true;
  if (kind === 'local' && r.upstream) l.upstream = r.upstream;
  if (kind === 'remote' && r.remote) l.remote = r.remote;
  if (kind !== 'tag' && favorites.has(r.short)) l.favorite = true;
  return l;
}

/** Reference labels per commit hash, sorted; a detached HEAD gets a 'HEAD' label. */
export function labelsByHash(refs: readonly Ref[], head: string | undefined, current: string | undefined, favorites: ReadonlySet<string>): Map<string, RefLabel[]> {
  const map = new Map<string, RefLabel[]>();
  const add = (hash: string, l: RefLabel) => {
    const list = map.get(hash);
    if (list) list.push(l);
    else map.set(hash, [l]);
  };
  if (head && !current) add(head, { name: 'HEAD', full: 'HEAD', kind: 'HEAD' });
  for (const r of refs) {
    const l = toLabel(r, current, favorites);
    if (l) add(r.hash, l);
  }
  for (const list of map.values()) list.sort(compareLabels);
  return map;
}

export function toRefItem(r: Ref, current: string | undefined, favorites: ReadonlySet<string>): RefItem {
  const it: RefItem = { name: r.short, full: r.name, hash: r.hash };
  if (r.upstream) it.upstream = r.upstream;
  if (r.ahead) it.ahead = r.ahead;
  if (r.behind) it.behind = r.behind;
  if (r.remote) it.remote = r.remote;
  if (r.type !== 'tag' && favorites.has(r.short)) it.favorite = true;
  if (r.type === 'head' && r.short === current) it.current = true;
  return it;
}
