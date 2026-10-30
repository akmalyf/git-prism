// Builds IntelliJ-style change trees (pure): optional group levels (repository/changelist/module), "group by
// directory" with folder compaction ("Service/Controllers") and file counts, or a flat list sorted by file name.
import type { TreeNode } from './tree';
import { fileIconName } from './icons';
import { pluralize } from './format';

export interface PathGroupLevel<T> {
  /** group key for an item; undefined puts the item directly under the parent level */
  key(item: T): string | undefined;
  label?(key: string): string;
  /** sort order of groups (default: by label, case-insensitive) */
  compare?(a: string, b: string): number;
}

export interface PathTreeOptions<T> {
  path(item: T): string;
  groupByDirectory?: boolean;
  compact?: boolean;
  groups?: PathGroupLevel<T>[];
  idPrefix?: string;
}

export interface PathGroupNode<T> {
  kind: 'group';
  id: string;
  key: string;
  name: string;
  level: number;
  children: PathNode<T>[];
  fileCount: number;
}

export interface PathDirNode<T> {
  kind: 'dir';
  id: string;
  name: string;
  /** full directory path (repo-relative) */
  path: string;
  children: PathNode<T>[];
  fileCount: number;
}

export interface PathFileNode<T> {
  kind: 'file';
  id: string;
  name: string;
  path: string;
  /** parent directory path ('' for the root) */
  dir: string;
  item: T;
}

export type PathNode<T> = PathGroupNode<T> | PathDirNode<T> | PathFileNode<T>;

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const cmp = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

function split(path: string): { dir: string; name: string } {
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
}

export function buildPathTree<T>(items: readonly T[], opts: PathTreeOptions<T>): PathNode<T>[] {
  const prefix = opts.idPrefix ?? '';
  const levels = opts.groups ?? [];
  const byDir = opts.groupByDirectory ?? true;
  const compact = opts.compact ?? true;

  const build = (list: readonly T[], level: number, scope: string): PathNode<T>[] => {
    if (level < levels.length) {
      const lv = levels[level];
      const buckets = new Map<string, T[]>();
      const loose: T[] = [];
      for (const it of list) {
        const k = lv.key(it);
        if (k === undefined) loose.push(it);
        else {
          let b = buckets.get(k);
          if (!b) buckets.set(k, (b = []));
          b.push(it);
        }
      }
      const groups: PathGroupNode<T>[] = [...buckets].map(([key, its]) => {
        const id = `${scope}g${level}:${key}|`;
        return { kind: 'group', id: prefix + id, key, name: lv.label ? lv.label(key) : key, level, children: build(its, level + 1, id), fileCount: its.length };
      });
      groups.sort((a, b) => (lv.compare ? lv.compare(a.key, b.key) : cmp(a.name, b.name)));
      return [...groups, ...build(loose, level + 1, scope)];
    }
    return byDir ? buildDirs(list, scope) : buildFlat(list, scope);
  };

  const fileNode = (it: T, scope: string, used: Map<string, number>): PathFileNode<T> => {
    const path = opts.path(it);
    const { dir, name } = split(path);
    const n = used.get(path) ?? 0;
    used.set(path, n + 1);
    return { kind: 'file', id: `${prefix}${scope}f:${path}${n ? '#' + n : ''}`, name, path, dir, item: it };
  };

  const buildFlat = (list: readonly T[], scope: string): PathNode<T>[] => {
    const used = new Map<string, number>();
    return list.map((it) => fileNode(it, scope, used)).sort((a, b) => cmp(a.name, b.name) || cmp(a.dir, b.dir));
  };

  const buildDirs = (list: readonly T[], scope: string): PathNode<T>[] => {
    interface Dir {
      dirs: Map<string, Dir>;
      files: PathFileNode<T>[];
      count: number;
    }
    const root: Dir = { dirs: new Map(), files: [], count: 0 };
    const used = new Map<string, number>();
    for (const it of list) {
      const f = fileNode(it, scope, used);
      let d = root;
      d.count++;
      if (f.dir) {
        for (const seg of f.dir.split('/')) {
          let next = d.dirs.get(seg);
          if (!next) d.dirs.set(seg, (next = { dirs: new Map(), files: [], count: 0 }));
          d = next;
          d.count++;
        }
      }
      d.files.push(f);
    }
    const convert = (d: Dir, base: string): PathNode<T>[] => {
      const dirs: PathDirNode<T>[] = [];
      for (const [seg, sub] of d.dirs) {
        let name = seg;
        let path = base ? `${base}/${seg}` : seg;
        let cur = sub;
        while (compact && cur.files.length === 0 && cur.dirs.size === 1) {
          const [nseg, nsub] = cur.dirs.entries().next().value as [string, Dir];
          name += '/' + nseg;
          path += '/' + nseg;
          cur = nsub;
        }
        dirs.push({ kind: 'dir', id: `${prefix}${scope}d:${path}`, name, path, children: convert(cur, path), fileCount: cur.count });
      }
      dirs.sort((a, b) => cmp(a.name, b.name));
      const files = d.files.sort((a, b) => cmp(a.name, b.name));
      return [...dirs, ...files];
    };
    return convert(root, '');
  };

  return build(items, 0, '');
}

/** All file nodes under the given nodes, in tree order. */
export function pathTreeFiles<T>(nodes: readonly PathNode<T>[]): PathFileNode<T>[] {
  const out: PathFileNode<T>[] = [];
  const walk = (ns: readonly PathNode<T>[]) => {
    for (const n of ns) {
      if (n.kind === 'file') out.push(n);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export interface PathTreeNodeOptions<T, D> {
  file?(n: PathFileNode<T>): Partial<TreeNode<D>>;
  dir?(n: PathDirNode<T>): Partial<TreeNode<D>>;
  group?(n: PathGroupNode<T>): Partial<TreeNode<D>>;
  /** show the parent directory as grey description of file nodes (default: true when the file has no dir parent node) */
  fileDirDescription?: boolean;
}

/**
 * Converts PathNodes into TreeNodes with IntelliJ defaults: folder icon + "11 files" for directories, file-type icon
 * for files (+ grey directory path in flat mode), repo icon for groups. Overrides are merged on top.
 */
export function pathTreeToNodes<T, D = unknown>(nodes: readonly PathNode<T>[], o: PathTreeNodeOptions<T, D> = {}): TreeNode<D>[] {
  const conv = (n: PathNode<T>, underDir: boolean): TreeNode<D> => {
    if (n.kind === 'file') {
      const spec = fileIconName(n.path);
      const showDir = o.fileDirDescription ?? !underDir;
      return {
        id: n.id,
        label: n.name,
        icon: spec.name,
        iconColor: spec.color,
        description: showDir && n.dir ? n.dir : undefined,
        tooltip: n.path,
        ...o.file?.(n),
      };
    }
    if (n.kind === 'dir') {
      return {
        id: n.id,
        label: n.name,
        icon: 'folder',
        description: pluralize(n.fileCount, 'file'),
        tooltip: n.path,
        children: n.children.map((c) => conv(c, true)),
        ...o.dir?.(n),
      };
    }
    return {
      id: n.id,
      label: n.name,
      icon: 'repo',
      description: pluralize(n.fileCount, 'file'),
      children: n.children.map((c) => conv(c, false)),
      ...o.group?.(n),
    };
  };
  return nodes.map((n) => conv(n, false));
}
