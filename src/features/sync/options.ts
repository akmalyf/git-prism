// "Modify options" of the Merge / Pull / Rebase dialogs (IntelliJ GitMergeOption, GitPullOption, GitRebaseOption):
// flags, descriptions, which options exclude each other, and the git arguments they produce.
// Pure module (no vscode / DOM imports): shared by the host and the dialog webviews.

export interface OptionDef<T extends string> {
  id: T;
  /** command line flag shown in the popup and in the chips below the command row */
  flag: string;
  description: string;
  /** separator above this item in the "Add … Options" popup */
  separatorAbove?: boolean;
}

export type MergeOption = 'no-ff' | 'ff-only' | 'squash' | 'm' | 'no-commit' | 'no-verify' | 'allow-unrelated-histories';
export type PullOption = 'rebase' | 'ff-only' | 'no-ff' | 'squash' | 'no-commit' | 'no-verify';
export type RebaseOption = 'switch-branch' | 'onto' | 'rebase-merges' | 'keep-empty' | 'root' | 'interactive' | 'update-refs' | 'autosquash' | 'no-autosquash';

export const MERGE_OPTIONS: OptionDef<MergeOption>[] = [
  { id: 'no-ff', flag: '--no-ff', description: 'Create a merge commit even if it can be fast-forwarded' },
  { id: 'ff-only', flag: '--ff-only', description: 'Merge only if it can be fast-forwarded' },
  { id: 'squash', flag: '--squash', description: 'Create a single commit for all merged changes' },
  { id: 'm', flag: '-m', description: 'Specify a message for the merge commit' },
  { id: 'no-commit', flag: '--no-commit', description: 'Do not commit the merge result' },
  { id: 'no-verify', flag: '--no-verify', description: 'Bypass the pre-merge and commit message hooks' },
  { id: 'allow-unrelated-histories', flag: '--allow-unrelated-histories', description: 'Allow merging histories that do not share a common ancestor.' },
];

export const PULL_OPTIONS: OptionDef<PullOption>[] = [
  { id: 'rebase', flag: '--rebase', description: 'Rebase the current branch on top of incoming changes' },
  { id: 'ff-only', flag: '--ff-only', description: 'Merge only if it can be fast-forwarded' },
  { id: 'no-ff', flag: '--no-ff', description: 'Create a merge commit even if it can be fast-forwarded' },
  { id: 'squash', flag: '--squash', description: 'Create a single commit for all pulled changes' },
  { id: 'no-commit', flag: '--no-commit', description: 'Merge, but do not commit the result' },
  { id: 'no-verify', flag: '--no-verify', description: 'Bypass the pre-merge and commit message hooks' },
];

export const REBASE_OPTIONS: OptionDef<RebaseOption>[] = [
  { id: 'switch-branch', flag: '', description: 'Select another branch to rebase' },
  { id: 'onto', flag: '--onto', description: 'Specify a new base for the rebased commits' },
  { id: 'rebase-merges', flag: '--rebase-merges', description: 'Recreate commits topology' },
  { id: 'keep-empty', flag: '--keep-empty', description: 'Do not remove empty commits during rebase' },
  { id: 'root', flag: '--root', description: 'Rebase all commits in the branch' },
  { id: 'interactive', flag: '--interactive', description: 'Edit commits before rebasing', separatorAbove: true },
  { id: 'update-refs', flag: '--update-refs', description: 'Auto-update branches pointing to rebased commits' },
  { id: 'autosquash', flag: '--autosquash', description: 'Auto-squash commits marked for fixup or squash' },
  { id: 'no-autosquash', flag: '--no-autosquash', description: 'Do not auto-squash commits marked for fixup or squash' },
];

/** Rebase options that are plain flags (shown as chips); the others change the command row fields. */
export const REBASE_FLAGS: RebaseOption[] = ['interactive', 'rebase-merges', 'keep-empty', 'root', 'update-refs', 'autosquash', 'no-autosquash'];

const MERGE_INCOMPATIBLE: Partial<Record<MergeOption, MergeOption[]>> = {
  'no-ff': ['ff-only', 'squash'],
  'ff-only': ['no-ff', 'squash', 'm'],
  squash: ['no-ff', 'ff-only', 'm'],
  m: ['ff-only', 'squash', 'no-commit'],
  'no-commit': ['m'],
};

const PULL_INCOMPATIBLE: Partial<Record<PullOption, PullOption[]>> = {
  rebase: ['ff-only', 'no-ff', 'squash', 'no-commit'],
  'ff-only': ['no-ff', 'squash', 'rebase'],
  'no-ff': ['ff-only', 'squash', 'rebase'],
  squash: ['no-ff', 'ff-only', 'rebase'],
  'no-commit': ['rebase'],
};

/** IntelliJ: an option is enabled when every selected option accepts it (selected ones stay enabled to be removed). */
export function mergeOptionEnabled(option: MergeOption, selected: readonly MergeOption[]): boolean {
  return selected.includes(option) || selected.every((s) => !(MERGE_INCOMPATIBLE[s] ?? []).includes(option));
}

export function pullOptionEnabled(option: PullOption, selected: readonly PullOption[]): boolean {
  return selected.includes(option) || selected.every((s) => !(PULL_INCOMPATIBLE[s] ?? []).includes(option));
}

/** `rebaseMergesWithInteractive`: git ≥ 2.18 allows --rebase-merges together with --interactive. */
export function rebaseOptionEnabled(option: RebaseOption, selected: readonly RebaseOption[], rebaseMergesWithInteractive = true): boolean {
  if (selected.includes(option)) return true;
  switch (option) {
    case 'autosquash':
      return !selected.includes('no-autosquash');
    case 'no-autosquash':
      return !selected.includes('autosquash');
    case 'rebase-merges':
      return rebaseMergesWithInteractive || !selected.includes('interactive');
    case 'interactive':
      return rebaseMergesWithInteractive || !selected.includes('rebase-merges');
    default:
      return true;
  }
}

/** Adds or removes an option, keeping the definition order. */
export function toggleOption<T extends string>(defs: readonly OptionDef<T>[], selected: readonly T[], option: T): T[] {
  const set = new Set(selected);
  if (set.has(option)) set.delete(option);
  else set.add(option);
  return defs.map((d) => d.id).filter((id) => set.has(id));
}

export interface MergeParams {
  ref: string;
  options: MergeOption[];
  message?: string;
}

/**
 * Whether the result of the merge/pull stays uncommitted. git's --autostash would then keep the local changes in
 * MERGE_AUTOSTASH until the merge is committed, so the host stashes / pops around the command itself instead.
 */
export function leavesUncommitted(options: readonly string[]): boolean {
  return options.includes('squash') || options.includes('no-commit');
}

/** `git merge …` arguments (without "git"). Local changes are auto-stashed like IntelliJ's smart merge. */
export function mergeArgs(p: MergeParams): string[] {
  const args = ['merge'];
  for (const o of p.options) {
    if (o === 'm') continue;
    args.push(MERGE_OPTIONS.find((d) => d.id === o)!.flag);
  }
  if (p.options.includes('m') && p.message?.trim()) args.push('-m', p.message);
  else args.push('--no-edit');
  if (!leavesUncommitted(p.options)) args.push('--autostash');
  args.push(p.ref);
  return args;
}

export interface PullParams {
  remote: string;
  /** branch names on the remote (without the remote prefix) */
  branches: string[];
  options: PullOption[];
}

/** `git pull …` arguments. Without --rebase an explicit --no-rebase overrides pull.rebase / branch.<name>.rebase like IntelliJ. */
export function pullArgs(p: PullParams): string[] {
  const args = ['pull', '--no-edit'];
  if (!p.options.includes('rebase')) args.push('--no-rebase');
  for (const o of p.options) args.push(PULL_OPTIONS.find((d) => d.id === o)!.flag);
  if (!leavesUncommitted(p.options)) args.push('--autostash');
  args.push(p.remote, ...p.branches);
  return args;
}

export interface RebaseParams {
  /** upstream (or old base with --onto); ignored with --root */
  upstream?: string;
  /** new base, only with the 'onto' option */
  onto?: string;
  /** branch to check out first, only with the 'switch-branch' option */
  branch?: string;
  options: RebaseOption[];
}

/** `git rebase …` arguments for a non-interactive rebase. */
export function rebaseArgs(p: RebaseParams): string[] {
  const args = ['rebase', '--autostash'];
  for (const o of p.options) {
    if (REBASE_FLAGS.includes(o) && o !== 'interactive' && o !== 'root') args.push(REBASE_OPTIONS.find((d) => d.id === o)!.flag);
  }
  if (p.options.includes('onto') && p.onto) args.push('--onto', p.onto);
  if (p.options.includes('root')) args.push('--root');
  else if (p.upstream) args.push(p.upstream);
  if (p.options.includes('switch-branch') && p.branch) args.push(p.branch);
  return args;
}

/** "origin/feature/x" → { remote: 'origin', branch: 'feature/x' } using the known remote names (longest match). */
export function splitRemoteRef(ref: string, remotes: readonly string[]): { remote?: string; branch: string } {
  const r = remotes.filter((x) => ref.startsWith(x + '/')).sort((a, b) => b.length - a.length)[0];
  return r ? { remote: r, branch: ref.slice(r.length + 1) } : { branch: ref };
}
