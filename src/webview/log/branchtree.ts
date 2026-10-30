// Builds the branches tree of the log (IntelliJ BranchesDashboard) from the refs of every root (pure):
// "HEAD (Current Branch)", Local, Remote › <remote>, Tags; '/' prefixes become folders with Group by Directory,
// optional repository level, same-named branches of several repositories merged into one node, favorites and the
// current branch first, ahead/behind counts, filtering by the "Branch or tag" search.
import type { RefItem, RefsInfo } from '../../features/log/protocol';
import type { TreeNode } from '../shared/ui/tree';

export type BranchKind = 'head' | 'local' | 'remote' | 'tag';

/** One ref of a node in one repository. */
export interface BranchRef {
  root: string;
  item: RefItem;
}

export interface BranchNodeData {
  /** leaf ref nodes */
  kind?: BranchKind;
  /** short ref name (origin/main for remotes) */
  name?: string;
  refs?: BranchRef[];
  /** section / folder / remote / repository nodes */
  group?: 'section' | 'folder' | 'remote' | 'repo';
  /** remote name of a 'remote' group; root of a 'repo' group */
  value?: string;
  roots?: string[];
}

export interface BranchTreeOptions {
  groupByDirectory: boolean;
  groupByRepository: boolean;
  showTags: boolean;
  /** search filter on the ref name; undefined = everything */
  filter?: (name: string) => boolean;
}

type Node = TreeNode<BranchNodeData>;

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

interface Leaf {
  /** name inside its section (remote branches without the remote prefix) */
  path: string;
  kind: BranchKind;
  name: string;
  refs: BranchRef[];
}

function leafNode(l: Leaf, label: string, idPrefix: string): Node {
  const it = l.refs[0].item;
  const current = l.refs.some((r) => r.item.current);
  const favorite = l.refs.some((r) => r.item.favorite);
  const ahead = l.refs.reduce((s, r) => s + (r.item.ahead ?? 0), 0);
  const behind = l.refs.reduce((s, r) => s + (r.item.behind ?? 0), 0);
  const tips: string[] = [];
  if (behind) tips.push(`${behind} incoming ${behind === 1 ? 'commit' : 'commits'}`);
  if (ahead) tips.push(`${ahead} outgoing ${ahead === 1 ? 'commit' : 'commits'}`);
  const arrows = [behind ? `↓${behind}` : '', ahead ? `↑${ahead}` : ''].filter(Boolean).join(' ');
  return {
    id: `${idPrefix}${l.kind}:${l.name}`,
    label,
    icon: favorite ? 'star-full' : l.kind === 'tag' ? 'tag' : current ? 'tag' : 'git-branch',
    iconClass: favorite ? 'lg-fav' : current ? 'lg-current' : l.kind === 'tag' ? 'lg-tag' : 'lg-branch',
    bold: current,
    description: arrows || undefined,
    tooltip: [l.name + (it.upstream ? ` → ${it.upstream}` : ''), ...tips].join('\n'),
    searchText: l.name,
    data: { kind: l.kind, name: l.name, refs: l.refs },
  };
}

function rank(l: Leaf): number {
  if (l.refs.some((r) => r.item.current)) return 0;
  if (l.refs.some((r) => r.item.favorite)) return 1;
  return 2;
}

/** Leaves → nodes, folders by '/' segments when grouping by directory. */
function buildLevel(leaves: Leaf[], o: BranchTreeOptions, idPrefix: string): Node[] {
  if (!o.groupByDirectory) {
    return leaves
      .sort((a, b) => rank(a) - rank(b) || collator.compare(a.path, b.path))
      .map((l) => leafNode(l, l.path, idPrefix));
  }
  interface Dir {
    dirs: Map<string, Dir>;
    leaves: Leaf[];
  }
  const root: Dir = { dirs: new Map(), leaves: [] };
  for (const l of leaves) {
    const segs = l.path.split('/');
    let d = root;
    for (const s of segs.slice(0, -1)) {
      let nd = d.dirs.get(s);
      if (!nd) d.dirs.set(s, (nd = { dirs: new Map(), leaves: [] }));
      d = nd;
    }
    d.leaves.push(l);
  }
  const convert = (d: Dir, base: string): Node[] => {
    const top = d.leaves.filter((l) => rank(l) < 2).sort((a, b) => rank(a) - rank(b) || collator.compare(a.path, b.path));
    const rest = d.leaves.filter((l) => rank(l) === 2);
    const items: { key: string; node: () => Node }[] = [];
    for (const [seg, sub] of d.dirs) {
      const path = base ? `${base}/${seg}` : seg;
      items.push({
        key: seg,
        node: () => ({ id: `${idPrefix}folder:${path}`, label: seg, icon: 'folder:', searchText: seg, data: { group: 'folder', value: path }, children: convert(sub, path) }),
      });
    }
    for (const l of rest) items.push({ key: l.path.slice(l.path.lastIndexOf('/') + 1), node: () => leafNode(l, l.path.slice(l.path.lastIndexOf('/') + 1), idPrefix) });
    items.sort((a, b) => collator.compare(a.key, b.key));
    return [...top.map((l) => leafNode(l, l.path.slice(l.path.lastIndexOf('/') + 1), idPrefix)), ...items.map((i) => i.node())];
  };
  return convert(root, '');
}

function collect(infos: readonly RefsInfo[], pick: (r: RefsInfo) => RefItem[], kind: BranchKind, o: BranchTreeOptions): Leaf[] {
  const byName = new Map<string, Leaf>();
  for (const info of infos) {
    for (const item of pick(info)) {
      if (kind === 'remote' && item.name.endsWith('/HEAD')) continue;
      if (o.filter && !o.filter(item.name)) continue;
      let l = byName.get(item.name);
      if (!l) byName.set(item.name, (l = { path: item.name, kind, name: item.name, refs: [] }));
      l.refs.push({ root: info.root, item });
    }
  }
  return [...byName.values()];
}

export function buildBranchTree(infos: readonly RefsInfo[], o: BranchTreeOptions): Node[] {
  const out: Node[] = [];
  const multi = infos.length > 1 && o.groupByRepository;
  const sets = multi ? infos.map((i) => ({ prefix: `repo:${i.root}|`, infos: [i], repo: i })) : [{ prefix: '', infos, repo: undefined as RefsInfo | undefined }];
  const repoWrap = (section: string, make: (list: readonly RefsInfo[], prefix: string) => Node[]): Node[] => {
    if (!multi) return make(infos, `${section}|`);
    return sets
      .map((s) => ({ s, children: make(s.infos, `${section}|${s.prefix}`) }))
      .filter((x) => x.children.length)
      .map(({ s, children }) => ({ id: `${section}|${s.prefix}`, label: s.repo!.name, icon: 'repo', data: { group: 'repo' as const, value: s.repo!.root }, children }));
  };

  const headMatches = !o.filter || o.filter('HEAD');
  if (headMatches && infos.some((i) => i.head)) {
    out.push({
      id: 'head',
      label: 'HEAD (Current Branch)',
      icon: 'tag',
      iconClass: 'lg-head',
      tooltip: infos.map((i) => `${infos.length > 1 ? `${i.name}: ` : ''}${i.current ?? `detached at ${i.head?.slice(0, 8)}`}`).join('\n'),
      searchText: 'HEAD',
      data: { kind: 'head', name: 'HEAD', refs: infos.filter((i) => i.head).map((i) => ({ root: i.root, item: { name: 'HEAD', full: 'HEAD', hash: i.head! } })) },
    });
  }

  const local = repoWrap('local', (list, prefix) => buildLevel(collect(list, (r) => r.local, 'local', o), o, prefix));
  if (local.length) out.push({ id: 'local', label: 'Local', icon: 'folder:', data: { group: 'section', value: 'local' }, children: local, expanded: true });

  const remote = repoWrap('remote', (list, prefix) => {
    const remotes = new Map<string, Leaf[]>();
    for (const l of collect(list, (r) => r.remote, 'remote', o)) {
      const rn = l.refs[0].item.remote ?? l.name.slice(0, l.name.indexOf('/'));
      l.path = l.name.slice(rn.length + 1);
      const arr = remotes.get(rn) ?? [];
      arr.push(l);
      remotes.set(rn, arr);
    }
    return [...remotes]
      .sort((a, b) => (a[0] === 'origin' ? -1 : b[0] === 'origin' ? 1 : collator.compare(a[0], b[0])))
      .map(([rn, leaves]) => ({
        id: `${prefix}remote:${rn}`,
        label: rn,
        icon: 'cloud',
        data: { group: 'remote' as const, value: rn, roots: [...new Set(leaves.flatMap((l) => l.refs.map((r) => r.root)))] },
        children: buildLevel(leaves, o, `${prefix}${rn}/`),
      }));
  });
  if (remote.length) out.push({ id: 'remote', label: 'Remote', icon: 'folder:', data: { group: 'section', value: 'remote' }, children: remote });

  if (o.showTags) {
    const tags = repoWrap('tags', (list, prefix) => buildLevel(collect(list, (r) => r.tags, 'tag', o), o, prefix));
    if (tags.length) out.push({ id: 'tags', label: 'Tags', icon: 'folder:', data: { group: 'section', value: 'tags' }, children: tags, expanded: false });
  }
  return out;
}

/** All ref leaves below (and including) the given nodes. */
export function leavesOf(nodes: readonly Node[]): Node[] {
  const out: Node[] = [];
  const walk = (ns: readonly Node[]) => {
    for (const n of ns) {
      if (n.data?.kind) out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
