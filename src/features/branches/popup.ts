// The "Git Branches" popup ('gitPrism.branches.show'): top actions (Update Project…, Commit…, Push…, New Branch…,
// Checkout Tag or Revision…), then Recent / Local / Remote / Tags sections, per repository or merged across
// repositories ("Group by Repository"). Selecting a ref opens its action list; item buttons toggle favorites.
import * as vscode from 'vscode';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import type { OperationState, Ref } from '../../core/types';
import { showBranchActions } from './actions';
import { type Ctx, isFav, loadState, type PopupSetting, type RepoState, setting, toggleFav, toggleSetting } from './common';
import { branchDir, recentBranches, sortForGrouping, splitRemoteBranch, syncText, syncTooltip } from './logic';
import { checkoutRevision, newBranch } from './ops';

interface Target {
  repo: Repository;
  ref: Ref;
}

interface Item extends vscode.QuickPickItem {
  run?: () => unknown;
  targets?: Target[];
}

interface RepoData extends RepoState {
  recent: string[];
  op: OperationState;
}

async function loadData(repo: Repository): Promise<RepoData> {
  const [s, reflog] = await Promise.all([
    loadState(repo),
    repo.run(['reflog', '--format=%gs', '-n', '500', 'HEAD', '--'], { quiet: true, allowFail: true }).then((r) => r.stdout),
  ]);
  const ls = s.refs.filter((r) => r.type === 'head').map((r) => r.short);
  return { ...s, recent: recentBranches(reflog, ls, s.current), op: repo.operationState() };
}

const SEP = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });

const SETTINGS: { id: PopupSetting; icon: string; label: string; multiOnly?: boolean }[] = [
  { id: 'showOnlyFavorites', icon: 'star-full', label: 'Show Only Favorites' },
  { id: 'showRecent', icon: 'history', label: 'Show Recent Branches' },
  { id: 'showTags', icon: 'tag', label: 'Show Tags' },
  { id: 'groupByDirectory', icon: 'list-tree', label: 'Group by Directory' },
  { id: 'groupByRepository', icon: 'repo', label: 'Group by Repository', multiOnly: true },
];

const FETCH: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('repo-fetch'), tooltip: 'Fetch' };

function favButton(on: boolean): vscode.QuickInputButton {
  return { iconPath: new vscode.ThemeIcon(on ? 'star-full' : 'star-empty'), tooltip: 'Mark/Unmark As Favorite' };
}

/** Opens the Branches popup. `repoRoot` = repository to show first (or only, with a single repository shown). */
export async function showBranchesPopup(ctx: Ctx, repoRoot?: string): Promise<void> {
  await ctx.repos.ready();
  const all = ctx.repos.all;
  if (!all.length) {
    const pick = await vscode.window.showWarningMessage('No Git repository found in the workspace.', 'Create Git Repository…', 'Clone…');
    if (pick === 'Create Git Repository…') vscode.commands.executeCommand('gitPrism.init');
    else if (pick === 'Clone…') vscode.commands.executeCommand('gitPrism.clone');
    return;
  }
  const first =
    (repoRoot && ctx.repos.get(repoRoot)) ||
    (vscode.window.activeTextEditor?.document.uri.scheme === 'file' ? ctx.repos.forUri(vscode.window.activeTextEditor.document.uri) : undefined) ||
    all[0];
  const repos = [first, ...all.filter((r) => r !== first)];
  const multi = repos.length > 1;

  const qp = vscode.window.createQuickPick<Item>();
  qp.placeholder = multi ? 'Search for branches, actions and repositories' : 'Search for branches and actions';
  qp.matchOnDescription = true;
  qp.busy = true;
  qp.title = multi ? 'Git Branches' : `Git Branches in ${first.name}`;
  let data: RepoData[] = [];

  const renderButtons = () => {
    qp.buttons = [
      FETCH,
      ...SETTINGS.filter((s) => !s.multiOnly || multi).map((s) => ({
        iconPath: new vscode.ThemeIcon(s.icon),
        tooltip: s.label,
        toggle: { checked: setting(s.id) },
      })),
    ];
  };

  const render = (keepActive?: string) => {
    const items = buildItems(ctx, data, multi);
    qp.items = items;
    if (keepActive) {
      const a = items.find((i) => i.label === keepActive);
      if (a) qp.activeItems = [a];
    }
    const head = data[0];
    if (head && !multi) {
      const t = syncTooltip(head.refs.find((r) => r.type === 'head' && r.short === head.current)?.ahead, head.refs.find((r) => r.type === 'head' && r.short === head.current)?.behind);
      qp.prompt = head.current ? `Current branch: ${head.current}${t ? ` — ${t}` : ''}` : head.head ? `HEAD detached at ${head.head.slice(0, 8)}` : undefined;
    }
  };

  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    qp.busy = true;
    try {
      const fresh = await Promise.all(repos.map(loadData));
      if (mine !== seq || hidden) return;
      data = fresh;
      render(qp.activeItems[0]?.label);
    } catch (e) {
      if (mine === seq && !hidden) qp.placeholder = `Cannot load branches: ${e instanceof Error ? e.message : e}`;
    } finally {
      if (mine === seq && !hidden) qp.busy = false;
    }
  };
  // keep the popup in sync while it is open (fetch finished, branch created in a terminal, …)
  let hidden = false;
  let timer: NodeJS.Timeout | undefined;
  const sub = ctx.repos.onDidChangeRepository((r) => {
    if (!repos.includes(r)) return;
    clearTimeout(timer);
    timer = setTimeout(load, 200);
  });

  renderButtons();
  qp.onDidTriggerButton(async (b) => {
    if (b === FETCH) {
      qp.hide();
      invoke('gitPrism.fetch', { repoRoot: multi ? undefined : first.root });
      return;
    }
    const s = SETTINGS.find((x) => x.label === b.tooltip);
    if (!s) return;
    await toggleSetting(s.id);
    renderButtons();
    render();
  });
  qp.onDidTriggerItemButton(async (e) => {
    const t = e.item.targets;
    if (!t?.length) return;
    const on = t.every((x) => isFav(ctx, x.repo, x.ref.name));
    for (const x of t) if (isFav(ctx, x.repo, x.ref.name) === on) await toggleFav(ctx, x.repo, x.ref.name);
    render(e.item.label);
  });
  qp.onDidAccept(async () => {
    const it = qp.selectedItems[0];
    if (!it) return;
    qp.hide();
    if (it.run) return Promise.resolve(it.run()).catch((e) => showGitError(e));
    if (!it.targets?.length) return;
    let target = it.targets[0];
    if (it.targets.length > 1) {
      const pick = await vscode.window.showQuickPick(
        it.targets.map((t) => ({ label: t.repo.name, description: t.repo.root, t })),
        { placeHolder: `Select the repository for ${t0(it)}` },
      );
      if (!pick) return;
      target = pick.t;
    }
    await showBranchActions(ctx, target.repo, target.ref.name, () => showBranchesPopup(ctx, repoRoot)).catch((e) => showGitError(e));
  });
  qp.onDidHide(() => {
    hidden = true;
    clearTimeout(timer);
    sub.dispose();
    qp.dispose();
  });
  qp.show();
  await load();
}

function t0(it: Item): string {
  return it.targets?.[0]?.ref.short ?? it.label;
}

function buildItems(ctx: Ctx, data: RepoData[], multi: boolean): Item[] {
  const items: Item[] = [];
  const main = data[0];
  const repoRoot = multi ? undefined : main?.repo.root;
  // ongoing operation actions (Git.Ongoing.Rebase.Actions)
  for (const d of data) {
    const suffix = multi ? ` (${d.repo.name})` : '';
    if (d.op === 'rebase') {
      items.push({ label: `$(debug-continue) Continue Rebase${suffix}`, run: () => invoke('gitPrism.operation.continue', { repoRoot: d.repo.root }) });
      items.push({ label: `$(debug-step-over) Skip Commit${suffix}`, run: () => invoke('gitPrism.operation.skip', { repoRoot: d.repo.root }) });
      items.push({ label: `$(close) Abort Rebase${suffix}`, run: () => invoke('gitPrism.operation.abort', { repoRoot: d.repo.root }) });
    } else if (d.op === 'merge') {
      items.push({ label: `$(close) Abort Merge${suffix}`, run: () => invoke('gitPrism.operation.abort', { repoRoot: d.repo.root }) });
    } else if (d.op === 'cherry-pick' || d.op === 'revert') {
      const op = d.op === 'cherry-pick' ? 'Cherry-Pick' : 'Revert';
      items.push({ label: `$(debug-continue) Continue ${op}${suffix}`, run: () => invoke('gitPrism.operation.continue', { repoRoot: d.repo.root }) });
      items.push({ label: `$(close) Abort ${op}${suffix}`, run: () => invoke('gitPrism.operation.abort', { repoRoot: d.repo.root }) });
    }
  }
  items.push(
    { label: '$(sync) Update Project…', run: () => invoke('gitPrism.updateProject', { repoRoot }) },
    { label: '$(check) Commit…', run: () => invoke('gitPrism.commit.focus', { repoRoot }) },
    { label: '$(arrow-up) Push…', run: () => invoke('gitPrism.push', { repoRoot }) },
    {
      label: '$(add) New Branch…',
      run: async () => {
        const repo = multi ? await ctx.repos.pick(undefined, 'Select the repository for the new branch') : main?.repo;
        if (repo) await newBranch(repo);
      },
    },
    {
      label: 'Checkout Tag or Revision…',
      run: async () => {
        const repo = multi ? await ctx.repos.pick(undefined, 'Select the repository') : main?.repo;
        if (repo) await checkoutRevision(repo);
      },
    },
  );
  if (!data.length) return items;
  if (multi && setting('groupByRepository')) {
    for (const d of data) sections(ctx, [d], `${d.repo.name} › `, items, true);
  } else {
    sections(ctx, data, '', items, multi);
  }
  return items;
}

/** One logical entry (possibly present in several repositories). */
interface Entry {
  short: string;
  targets: Target[];
}

function merge(data: RepoData[], pick: (d: RepoData) => Ref[]): Entry[] {
  const map = new Map<string, Entry>();
  for (const d of data) {
    for (const r of pick(d)) {
      const e = map.get(r.short) ?? { short: r.short, targets: [] };
      e.targets.push({ repo: d.repo, ref: r });
      map.set(r.short, e);
    }
  }
  return [...map.values()];
}

function sections(ctx: Ctx, data: RepoData[], prefix: string, out: Item[], showRepos: boolean): void {
  const onlyFav = setting('showOnlyFavorites');
  const byDir = setting('groupByDirectory');
  const fav = (e: Entry) => e.targets.every((t) => isFav(ctx, t.repo, t.ref.name));
  const isCurrent = (e: Entry) => e.targets.every((t) => data.find((d) => d.repo === t.repo)?.current === e.short);
  const reposDesc = (e: Entry) => (showRepos && data.length > 1 ? e.targets.map((t) => t.repo.name).join(', ') : '');

  const item = (e: Entry, label: string, kind: 'local' | 'remote' | 'tag'): Item => {
    const r = e.targets.length === 1 ? e.targets[0].ref : undefined;
    const current = kind === 'local' && isCurrent(e);
    const favorite = kind !== 'tag' && fav(e);
    const icon = kind === 'tag' ? 'tag' : current ? 'check' : favorite ? 'star-full' : 'git-branch';
    const sync = r ? syncText(r.ahead, r.behind) : '';
    const desc = [current ? 'current' : '', sync, kind === 'local' ? r?.upstream ?? '' : '', reposDesc(e)].filter(Boolean).join('  ');
    return {
      label: `$(${icon}) ${label}`,
      description: desc || undefined,
      targets: e.targets,
      buttons: kind === 'tag' ? undefined : [favButton(favorite)],
    };
  };

  const emitGrouped = (header: string, entries: Entry[], kind: 'local' | 'remote' | 'tag', name: (e: Entry) => string) => {
    if (!entries.length) return;
    out.push(SEP(header));
    if (kind === 'tag') {
      for (const e of entries.sort((a, b) => b.short.localeCompare(a.short, undefined, { numeric: true }))) out.push(item(e, e.short, kind));
      return;
    }
    const top = entries.filter((e) => (kind === 'local' && isCurrent(e)) || fav(e));
    top.sort((a, b) => (kind === 'local' && isCurrent(a) ? -1 : kind === 'local' && isCurrent(b) ? 1 : name(a).localeCompare(name(b))));
    for (const e of top) out.push(item(e, name(e), kind));
    if (onlyFav) return;
    const rest = entries.filter((e) => !top.includes(e));
    const byName = new Map(rest.map((e) => [name(e), e]));
    let dir = '';
    for (const n of byDir ? sortForGrouping([...byName.keys()]) : [...byName.keys()].sort()) {
      const d = byDir ? branchDir(n) : '';
      if (d !== dir) {
        dir = d;
        if (d) out.push(SEP(`${header} › ${d.split('/').join(' › ')}`));
      }
      out.push(item(byName.get(n)!, n, kind));
    }
  };

  // Recent
  if (setting('showRecent') && !onlyFav) {
    const recent = merge(data, (d) => d.recent.map((n) => d.refs.find((r) => r.type === 'head' && r.short === n)!).filter(Boolean));
    const order = data[0].recent;
    recent.sort((a, b) => order.indexOf(a.short) - order.indexOf(b.short));
    if (recent.length) {
      out.push(SEP(`${prefix}Recent`));
      for (const e of recent) out.push(item(e, e.short, 'local'));
    }
  }
  // Local
  emitGrouped(`${prefix}Local`, merge(data, (d) => d.refs.filter((r) => r.type === 'head')), 'local', (e) => e.short);
  // Remote, per remote
  const remotes = [...new Set(data.flatMap((d) => d.remotes))];
  for (const remote of remotes) {
    const entries = merge(data, (d) => d.refs.filter((r) => r.type === 'remote' && r.remote === remote));
    emitGrouped(`${prefix}Remote › ${remote}`, entries, 'remote', (e) => splitRemoteBranch(e.short, remotes).branch);
  }
  // Tags
  if (setting('showTags') && !onlyFav) {
    emitGrouped(`${prefix}Tags`, merge(data, (d) => d.refs.filter((r) => r.type === 'tag')), 'tag', (e) => e.short);
  }
}
