// Pure logic of conflict resolution (no vscode/node imports): unmerged index parsing, IntelliJ's Yours/Theirs
// mapping (sides are swapped while rebasing), accept plans, dialog description and the ongoing-operation actions.
import type { OperationState } from '../../core/types';
import type { ConflictFileInfo, DescPart, SideStatus } from './protocol';

/** IntelliJ's short hash length (VcsLogUtil.SHORT_HASH_LENGTH). */
export const SHORT_HASH = 8;

export const short = (hash: string): string => hash.slice(0, SHORT_HASH);

export interface UnmergedEntry {
  path: string;
  /** index stages present: 1 base, 2 ours, 3 theirs */
  stages: Set<number>;
}

/** Parses `git ls-files -u -z` ("<mode> <hash> <stage>\t<path>\0"…). Paths keep their order of first appearance. */
export function parseUnmerged(out: string): UnmergedEntry[] {
  const map = new Map<string, UnmergedEntry>();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(' ');
    const stage = Number(meta[2]);
    const path = rec.slice(tab + 1);
    let e = map.get(path);
    if (!e) map.set(path, (e = { path, stages: new Set() }));
    if (stage >= 1 && stage <= 3) e.stages.add(stage);
  }
  return [...map.values()];
}

/** Git-side (unswapped) status of one conflict side: like GitMergeProvider, a missing stage means deleted. */
export function gitSideStatus(e: UnmergedEntry, side: 'ours' | 'theirs'): SideStatus {
  return e.stages.has(side === 'ours' ? 2 : 3) ? 'Modified' : 'Deleted';
}

/** Conflict type in git terms (git status "both modified", "deleted by them", …), from the user's point of view. */
export function conflictType(e: UnmergedEntry, reversed: boolean): string {
  const base = e.stages.has(1);
  let ours = e.stages.has(2);
  let theirs = e.stages.has(3);
  if (reversed) [ours, theirs] = [theirs, ours];
  if (ours && theirs) return base ? 'both modified' : 'both added';
  if (ours) return base ? 'deleted by them' : 'added by you';
  if (theirs) return base ? 'deleted by you' : 'added by them';
  return 'both deleted';
}

/** Conflict file as shown in the dialog: Yours/Theirs columns are swapped for reversed (rebasing) repositories. */
export function toConflictFile(repoRoot: string, e: UnmergedEntry, reversed: boolean): ConflictFileInfo {
  const ours = gitSideStatus(e, 'ours');
  const theirs = gitSideStatus(e, 'theirs');
  return {
    repoRoot,
    path: e.path,
    yours: reversed ? theirs : ours,
    theirs: reversed ? ours : theirs,
    type: conflictType(e, reversed),
  };
}

/** IntelliJ swaps sides while rebasing (GitMergeUtil.isReverseRoot) so "Yours" are the user's own commits. */
export const isReversed = (op: OperationState): boolean => op === 'rebase';

export interface AcceptPlan {
  /** git side to take: `git checkout --ours|--theirs` */
  side: 'ours' | 'theirs';
  /** paths that exist on that side: checkout + add */
  checkout: string[];
  /** paths deleted on that side: git rm */
  remove: string[];
}

/** What "Accept Yours" / "Accept Theirs" does in git terms (GitMergeUtil.acceptOneVersion + markConflictResolved). */
export function acceptPlan(entries: UnmergedEntry[], accept: 'yours' | 'theirs', reversed: boolean): AcceptPlan {
  const yoursIsOurs = !reversed;
  const side: 'ours' | 'theirs' = (accept === 'yours') === yoursIsOurs ? 'ours' : 'theirs';
  const plan: AcceptPlan = { side, checkout: [], remove: [] };
  for (const e of entries) {
    if (gitSideStatus(e, side) === 'Deleted') plan.remove.push(e.path);
    else plan.checkout.push(e.path);
  }
  return plan;
}

/** "Yours" / "Yours (main)" / "Theirs (feature)" (GitMergeProvider.calcColumnName). */
export function columnTitle(isTheirs: boolean, branch: string | undefined): string {
  const base = isTheirs ? 'Theirs' : 'Yours';
  return branch ? `${base} (${branch})` : base;
}

/** What the host knows about one repository's in-progress operation (filled from files in the git dir). */
export interface RepoOpInfo {
  name: string;
  op: OperationState;
  /** current branch, or short HEAD hash when detached (rebase: the branch being rebased) */
  current?: string;
  /** merge: MERGE_HEAD resolved to a branch name, or its short hash */
  mergeBranch?: string;
  /** rebase: onto commit and the single branch pointing at it */
  ontoHash?: string;
  ontoBranch?: string;
  /** rebase: rebasing branch name (undefined when a detached HEAD is rebased) */
  rebasingBranch?: string;
  /** rebase: the commit being applied (REBASE_HEAD) */
  rebaseHead?: CommitMeta;
  /** cherry-pick: CHERRY_PICK_HEAD */
  cherryPick?: CommitMeta;
  /** revert: REVERT_HEAD */
  revertHead?: CommitMeta;
  /** interactive rebase stopped at an `edit` (rebase-merge/amend exists) */
  editStop?: boolean;
}

export interface CommitMeta {
  hash: string;
  author: string;
  message: string;
}

/** Branch name of the "Theirs" column (resolveMergeBranchOrCherryPick). */
export function theirsBranch(r: RepoOpInfo): string | undefined {
  if (r.op === 'merge' && r.mergeBranch) return r.mergeBranch;
  if (r.op === 'rebase' && r.ontoHash) return r.ontoBranch ?? short(r.ontoHash);
  if (r.op === 'cherry-pick' && r.cherryPick) return 'cherry-pick';
  return undefined;
}

const single = <T>(xs: (T | undefined)[]): T | undefined => {
  const s = new Set(xs.filter((x): x is T => x !== undefined));
  return s.size === 1 ? [...s][0] : undefined;
};

/** Column titles for the repositories shown together (a name only when it is the same everywhere). */
export function columnTitles(repos: RepoOpInfo[]): { yours: string; theirs: string } {
  return {
    yours: columnTitle(false, single(repos.map((r) => r.current))),
    theirs: columnTitle(true, single(repos.map(theirsBranch))),
  };
}

/** First 3 lines of a commit message, "..." when longer (CommitMessagePreview). */
export function messagePreview(message: string): string {
  const m = message.replace(/\s+$/, '');
  const lines = m.split('\n');
  if (lines.length <= 3) return m;
  const head = lines.slice(0, 3);
  while (head.length && !head[head.length - 1].trim()) head.pop();
  return head.join('\n') + '...';
}

const t = (text: string): DescPart => ({ text });
const b = (text: string): DescPart => ({ text, bold: true });
const code = (text: string): DescPart => ({ text, code: true });

/**
 * Description above the conflicts table (GitDefaultMergeDialogCustomizer.getMultipleFileMergeDescription):
 * "Merging branch X into branch Y", "Rebasing branch X onto branch Y, revision h. Current commit h made by A:",
 * "Conflicts during cherry-picking commit h made by A", else "The following files have conflicts:".
 */
export function describe(repos: RepoOpInfo[], fileCount: number): { parts: DescPart[]; message?: string } {
  const merging = repos.filter((r) => r.op === 'merge' && r.mergeBranch);
  if (merging.length) {
    const mergeSet = [...new Set(merging.map((r) => r.mergeBranch!))];
    const currentSet = [...new Set(merging.map((r) => r.current).filter((x): x is string => !!x))];
    const parts: DescPart[] = [t('Merging ')];
    if (mergeSet.length === 1) parts.push(t('branch '), b(mergeSet[0]));
    else parts.push(t('diverging branches'));
    parts.push(t(' into '));
    if (currentSet.length <= 1) parts.push(t('branch '), b(currentSet[0] ?? 'HEAD'));
    else parts.push(t('diverging branches'));
    return { parts };
  }

  const rebasing = repos.filter((r) => r.op === 'rebase' && r.ontoHash);
  if (rebasing.length) {
    const current = single(repos.map((r) => r.current));
    const ontoKeys = new Set(rebasing.map((r) => `${r.ontoBranch ?? ''}\0${r.ontoHash}`));
    const onto = ontoKeys.size === 1 ? rebasing[0] : undefined;
    const parts: DescPart[] = [t('Rebasing')];
    if (current) parts.push(t(' branch '), b(current));
    if (onto?.ontoBranch) parts.push(t(' onto branch '), b(onto.ontoBranch), t(`, revision ${short(onto.ontoHash!)}`));
    else if (onto) parts.push(t(' onto '), b(short(onto.ontoHash!)));
    else parts.push(t(' onto diverging branches'));
    const head = repos.length === 1 ? repos[0].rebaseHead : undefined;
    if (!head) return { parts };
    parts.push(t('. Current commit '), code(short(head.hash)), t(` made by ${head.author}:`));
    return { parts, message: messagePreview(head.message) };
  }

  const picks = repos.map((r) => (r.op === 'cherry-pick' ? r.cherryPick : undefined)).filter((x): x is CommitMeta => !!x);
  if (picks.length) {
    const distinct = new Set(picks.map((p) => `${p.author}\0${p.message}`));
    const parts: DescPart[] = [t('Conflicts during cherry-picking ')];
    if (picks.length === 1) parts.push(t('commit '), code(short(picks[0].hash)));
    else parts.push(t('multiple commits'));
    if (distinct.size === 1) {
      parts.push(t(` made by ${picks[0].author}`));
      return { parts, message: messagePreview(picks[0].message) };
    }
    return { parts };
  }

  return { parts: [t(`The following ${fileCount === 1 ? 'file has' : 'files have'} conflicts:`)] };
}

/** Status bar text of the Merge/Rebase widget (git.status.bar.widget.text.*). */
export function widgetText(op: OperationState, branch: string | undefined): string | undefined {
  const name = branch ?? '<unknown>';
  switch (op) {
    case 'rebase':
      return `Rebasing ${name}`;
    case 'merge':
      return `Merging ${name}`;
    case 'cherry-pick':
      return `Cherry-picking in ${name}`;
    case 'revert':
      return `Reverting in ${name}`;
    default:
      return undefined;
  }
}

export type OpAction =
  | 'resolve'
  | 'rebaseContinue'
  | 'rebaseSkip'
  | 'rebaseAbort'
  | 'mergeCommit'
  | 'mergeAbort'
  | 'cherryPickContinue'
  | 'cherryPickAbort'
  | 'revertAbort';

export const OP_ACTION_LABELS: Record<OpAction, string> = {
  resolve: 'Resolve Conflicts…',
  rebaseContinue: 'Continue Rebase',
  rebaseSkip: 'Skip Commit',
  rebaseAbort: 'Abort Rebase',
  mergeCommit: 'Commit merge',
  mergeAbort: 'Abort Merge',
  cherryPickContinue: 'Continue Cherry-Pick',
  cherryPickAbort: 'Abort Cherry-Pick',
  revertAbort: 'Abort Revert',
};

/**
 * Actions of the ongoing operation, like the Git menu groups / Merge-Rebase widget: Resolve Conflicts… while
 * there are unmerged files (it replaces Commit merge / Continue Cherry-Pick), Continue / Skip / Abort Rebase.
 */
export function opActions(op: OperationState, hasConflicts: boolean): OpAction[] {
  const resolve: OpAction[] = hasConflicts ? ['resolve'] : [];
  switch (op) {
    case 'rebase':
      return [...resolve, 'rebaseContinue', 'rebaseSkip', 'rebaseAbort'];
    case 'merge':
      return [...resolve, ...(hasConflicts ? [] : (['mergeCommit'] as OpAction[])), 'mergeAbort'];
    case 'cherry-pick':
      return [...resolve, ...(hasConflicts ? [] : (['cherryPickContinue'] as OpAction[])), 'cherryPickAbort'];
    case 'revert':
      return [...resolve, 'revertAbort'];
    default:
      return resolve;
  }
}

/** Operation names used in IntelliJ's messages: [lower case, capitalised]. */
export function opName(op: OperationState): [string, string] {
  switch (op) {
    case 'rebase':
      return ['rebase', 'Rebase'];
    case 'merge':
      return ['merge', 'Merge'];
    case 'cherry-pick':
      return ['cherry-pick', 'Cherry-pick'];
    case 'revert':
      return ['revert', 'Revert'];
    case 'am':
      return ['apply mailbox', 'Apply mailbox'];
    default:
      return [op, op];
  }
}

/**
 * Abort confirmation: GitRebaseAbort asks "Abort rebase in <repo>?" (always naming the repository), the other
 * GitAbortOperationAction subclasses "Abort <op><mention>?" under "Abort <Op>" (StringUtil.capitalizeWords → "Cherry-pick").
 */
export function abortConfirmation(op: OperationState, repoName: string, mention: string): { title: string; message: string } {
  const [name, Name] = opName(op);
  if (op === 'rebase') return { title: 'Abort Rebase', message: `Abort rebase in ${repoName}?` };
  return { title: `Abort ${Name}`, message: `Abort ${name}${mention}?` };
}

/** MERGE_MSG as the commit message: comment lines (git's "# Conflicts:" block) dropped, trailing blank lines trimmed. */
export function cleanMergeMessage(msg: string, commentChar = '#'): string {
  return msg
    .split('\n')
    .filter((l) => !l.startsWith(commentChar))
    .join('\n')
    .replace(/\s+$/, '');
}

/** First quoted ref of MERGE_MSG's first line ("Merge branch 'main' into feature" → main). */
export function mergedRefName(msg: string | undefined): string | undefined {
  const first = msg?.split('\n')[0] ?? '';
  return /'([^']+)'/.exec(first)?.[1];
}

/** rebase-merge/head-name → branch short name; undefined for "detached HEAD". */
export function headNameBranch(headName: string | undefined): string | undefined {
  const h = headName?.trim();
  if (!h || !h.startsWith('refs/')) return undefined;
  return h.replace(/^refs\/heads\//, '');
}

/**
 * Picks the branch name for a commit like IntelliJ's resolveBranchName: the single local branch pointing at it,
 * else the single remote one, else `preferred` when it is among them.
 */
export function pickBranchName(local: string[], remote: string[], preferred?: string): string | undefined {
  const branches = local.length ? local : remote;
  if (branches.length === 1) return branches[0];
  if (preferred && branches.includes(preferred)) return preferred;
  return undefined;
}

/** Kind of stop after `git rebase --continue/--skip` (or any step) left the rebase in progress. */
export type RebaseStop = 'conflicts' | 'edit' | 'exec' | 'other';

export function rebaseStopKind(hasConflicts: boolean, editStop: boolean, output: string): RebaseStop {
  if (hasConflicts) return 'conflicts';
  if (/execution failed|Could not execute/i.test(output)) return 'exec';
  if (editStop || /Stopped at|You can amend the commit now/i.test(output)) return 'edit';
  return 'other';
}

/** `git cherry-pick/revert --continue` refusing because the result is empty. */
export const isEmptyPickError = (output: string): boolean => /previous (cherry-pick|revert) is now empty|nothing to commit/i.test(output);

/**
 * `git rebase --continue` refusing because tracked files have unstaged changes (with no unmerged files left git
 * still says "You must edit all merge conflicts and then mark them as resolved using git add").
 */
export const isUnstagedChangesError = (output: string): boolean =>
  /You have unstaged changes|mark them as resolved using git add|commit or stash them/i.test(output);
