// Builds the Commit view tree (IntelliJ ChangesListView) from the host view model: changelists / Unversioned /
// Ignored Files, or Unmerged / Staged / Unstaged / Untracked in staging area mode, grouped by repository,
// module and directory.
import { buildPathTree, gitStatusClass, gitStatusLabel, pathTreeToNodes, pluralize, type PathGroupNode, type TreeNode } from '../shared/ui';
import type { Area, ChangelistInfo, Item, ViewModel } from '../../features/commit/protocol';

export type NodeData =
  | { t: 'file'; item: Item }
  | { t: 'list'; list: ChangelistInfo }
  | { t: 'section'; area: Area }
  | { t: 'dir'; path: string }
  | { t: 'group' };

export type CNode = TreeNode<NodeData>;

export interface BuiltTree {
  roots: CNode[];
  /** item key → tree node id */
  nodeOf: Map<string, string>;
  /** partially included files (some changed lines excluded) and their ancestors: drawn with a partial checkbox */
  partial: Set<string>;
}

export interface NodeActions {
  stage(node: CNode): void;
  unstage(node: CNode): void;
}

const basename = (p: string) => p.slice(p.replace(/\/+$/, '').lastIndexOf('/') + 1);
const dirname = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** "- renamed from a.txt" / "- moved from old/dir" (IntelliJ change node suffix). */
export function renameText(it: Item): string | undefined {
  if (!it.oldPath || it.oldPath === it.path) return undefined;
  const od = dirname(it.oldPath);
  if (od === dirname(it.path)) return `- renamed from ${basename(it.oldPath)}`;
  return `- moved from ${od || '/'}`;
}

export function sectionTitle(area: Area): string {
  switch (area) {
    case 'untracked':
      return 'Unversioned Files';
    case 'ignored':
      return 'Ignored Files';
    case 'conflict':
      return 'Merge Conflicts';
    case 'staged':
      return 'Staged';
    case 'unstaged':
      return 'Unstaged';
    default:
      return 'Changes';
  }
}

const STAGING_TITLES: Partial<Record<Area, string>> = { conflict: 'Unmerged', untracked: 'Untracked', ignored: 'Ignored' };

export function buildTree(vm: ViewModel, actions: NodeActions): BuiltTree {
  const s = vm.settings;
  const nodeOf = new Map<string, string>();
  const multiRepo = vm.repos.length > 1;
  const repoName = new Map(vm.repos.map((r) => [r.root, r.name]));

  const files = (items: Item[], prefix: string, opts: { checkable: boolean; area: Area }): CNode[] => {
    const groups = [];
    if (multiRepo && s.groupByRepository) groups.push({ key: (i: Item) => i.repo, label: (k: string) => repoName.get(k) ?? basename(k) });
    if (s.groupByModule) groups.push({ key: (i: Item) => (i.path.includes('/') ? i.path.slice(0, i.path.indexOf('/')) : undefined), label: (k: string) => k });
    const tree = buildPathTree(items, { path: (i) => i.path, groupByDirectory: s.groupByDirectory, compact: true, groups, idPrefix: prefix });
    const repoLevel = multiRepo && s.groupByRepository ? 0 : -1;
    const nodes = pathTreeToNodes<Item, NodeData>(tree, {
      file: (n) => {
        const it = n.item;
        const desc = [!s.groupByDirectory && n.dir ? n.dir : '', renameText(it) ?? ''].filter(Boolean).join(' ');
        const node: Partial<CNode> = {
          className: gitStatusClass(it.area === 'conflict' ? 'conflict' : it.kind),
          description: desc || undefined,
          tooltip: `${it.path}${it.oldPath && it.oldPath !== it.path ? ` ← ${it.oldPath}` : ''}\n${gitStatusLabel(it.area === 'conflict' ? 'conflict' : it.kind)}`,
          checkable: opts.checkable,
          checked: opts.checkable ? !!it.included : undefined,
          data: { t: 'file', item: it },
        };
        if (s.stagingArea && opts.area === 'staged') node.actions = [{ icon: 'remove', tooltip: 'Unstage', run: (x) => actions.unstage(x) }];
        else if (s.stagingArea && (opts.area === 'unstaged' || opts.area === 'untracked')) node.actions = [{ icon: 'add', tooltip: 'Stage', run: (x) => actions.stage(x) }];
        return node;
      },
      dir: (n) => ({ data: { t: 'dir', path: n.path } }),
      group: (n: PathGroupNode<Item>) => ({ icon: n.level === repoLevel ? 'repo' : 'package', data: { t: 'group' } }),
    });
    const index = (list: CNode[]) => {
      for (const n of list) {
        if (n.data?.t === 'file') nodeOf.set(n.data.item.key, n.id);
        if (n.children) index(n.children);
      }
    };
    index(nodes);
    return nodes;
  };

  const section = (area: Area, items: Item[], o: { checkable?: boolean; expanded?: boolean; title?: string; actions?: CNode['actions'] } = {}): CNode => ({
    id: `sec:${area}`,
    label: o.title ?? sectionTitle(area),
    description: pluralize(items.length, 'file'),
    expanded: o.expanded,
    children: files(items, `${area}:`, { checkable: !!o.checkable, area }),
    data: { t: 'section', area },
    actions: o.actions,
  });

  const by = (area: Area) => vm.items.filter((i) => i.area === area);
  const roots: CNode[] = [];
  const conflicts = by('conflict');
  const untracked = by('untracked');
  const ignored = s.showIgnored ? by('ignored') : [];

  if (!s.stagingArea) {
    if (conflicts.length) roots.push(section('conflict', conflicts));
    const changes = by('changes');
    const showLists = changes.length > 0 || vm.lists.length > 1 || conflicts.length > 0 || untracked.length > 0 || ignored.length > 0;
    if (showLists) {
      for (const l of vm.lists) {
        const items = changes.filter((i) => i.list === l.id);
        roots.push({
          id: `list:${l.id}`,
          label: l.name,
          bold: l.active,
          description: items.length ? pluralize(items.length, 'file') : undefined,
          tooltip: l.comment ? l.comment.split('\n')[0] : undefined,
          children: files(items, `list:${l.id}:`, { checkable: true, area: 'changes' }),
          data: { t: 'list', list: l },
        });
      }
    }
    if (untracked.length) roots.push(section('untracked', untracked, { checkable: true, expanded: false }));
    if (ignored.length) roots.push(section('ignored', ignored, { expanded: false }));
  } else {
    if (conflicts.length) roots.push(section('conflict', conflicts, { title: STAGING_TITLES.conflict }));
    const staged = by('staged');
    const unstaged = by('unstaged');
    if (staged.length) roots.push(section('staged', staged, { actions: [{ icon: 'remove', tooltip: 'Unstage All', run: (x) => actions.unstage(x) }] }));
    if (unstaged.length) roots.push(section('unstaged', unstaged, { actions: [{ icon: 'add', tooltip: 'Stage All Tracked', run: (x) => actions.stage(x) }] }));
    if (untracked.length) roots.push(section('untracked', untracked, { title: STAGING_TITLES.untracked, expanded: false, actions: [{ icon: 'add', tooltip: 'Stage', run: (x) => actions.stage(x) }] }));
    if (ignored.length) roots.push(section('ignored', ignored, { title: STAGING_TITLES.ignored, expanded: false }));
  }
  const partial = new Set<string>();
  const mark = (n: CNode): boolean => {
    let has = n.data?.t === 'file' && !!n.data.item.partial && !!n.data.item.included;
    for (const c of n.children ?? []) if (mark(c)) has = true;
    if (has) partial.add(n.id);
    return has;
  };
  roots.forEach(mark);
  return { roots, nodeOf, partial };
}

/** File items below (or at) a node, in tree order. */
export function filesOf(node: CNode): Item[] {
  const out: Item[] = [];
  const walk = (n: CNode) => {
    if (n.data?.t === 'file') out.push(n.data.item);
    n.children?.forEach(walk);
  };
  walk(node);
  return out;
}

/** Unique file items of several nodes, in the given order. */
export function filesOfNodes(nodes: readonly CNode[]): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const n of nodes) {
    for (const it of filesOf(n)) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      out.push(it);
    }
  }
  return out;
}
