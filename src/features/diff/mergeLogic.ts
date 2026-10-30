// Pure merge-conflict logic: unmerged index entries, conflict type, IntelliJ's merge window titles and messages.
// No vscode imports (unit-tested in mergeLogic.test.ts).

export type Stage = 1 | 2 | 3;

export interface StageEntry {
  mode: string;
  hash: string;
}

/** Stages of one conflicted path from `git ls-files -u -z -- <path>` (1 base, 2 ours, 3 theirs); other paths are ignored. */
export function parseUnmerged(out: string, path?: string): Partial<Record<Stage, StageEntry>> {
  const stages: Partial<Record<Stage, StageEntry>> = {};
  for (const rec of out.split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]*)$/.exec(rec);
    if (m && (path === undefined || m[4] === path)) stages[+m[3] as Stage] = { mode: m[1], hash: m[2] };
  }
  return stages;
}

/** Regular file modes; symlinks (120000) and submodules (160000) can't be merged as text. */
export function isRegularMode(mode: string): boolean {
  return mode === '100644' || mode === '100755';
}

/**
 * Index stage shown on each side. During a rebase git's "ours" (stage 2) is the branch being rebased onto, so
 * IntelliJ reverses the sides: left/"Yours" = the commit being replayed (stage 3).
 */
export function sideStages(reverse: boolean): { left: Stage; right: Stage } {
  return reverse ? { left: 3, right: 2 } : { left: 2, right: 3 };
}

/** GitBundle conflicts.type.* label, from the user's ("yours") point of view. */
export function conflictType(stages: Partial<Record<Stage, unknown>>, reverse: boolean): string {
  const { left, right } = sideStages(reverse);
  const yours = !!stages[left];
  const theirs = !!stages[right];
  const base = !!stages[1];
  if (!yours && !theirs) return 'both deleted';
  if (!yours) return base ? 'deleted by you' : 'added by them';
  if (!theirs) return base ? 'deleted by them' : 'added by you';
  return base ? 'both modified' : 'both added';
}

export interface MergeTitleInfo {
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'other';
  /** current branch (merge) or the branch being rebased; short hash when detached */
  currentBranch?: string;
  /** merge: the merged branch; rebase: the onto branch */
  otherBranch?: string;
  /** merge: MERGE_HEAD; rebase: onto hash; cherry-pick: CHERRY_PICK_HEAD; revert: REVERT_HEAD (full or short) */
  otherHash?: string;
  /** rebase: REBASE_HEAD, the commit being replayed */
  rebaseHead?: string;
}

const short = (h: string): string => h.slice(0, 8);

/**
 * GitDefaultMergeDialogCustomizer titles of the left and right merge panes. Without the data an operation needs
 * (MERGE_HEAD, REBASE_HEAD + onto, CHERRY_PICK_HEAD) IntelliJ falls back to the MergeDialogCustomizer defaults.
 */
export function mergeTitles(info: MergeTitleInfo): { left: string; right: string } {
  const fallback = { left: 'Your version', right: 'Changes from server' };
  switch (info.operation) {
    case 'merge':
      if (!info.otherHash) return fallback;
      return {
        left: `Changes from ${info.currentBranch ?? 'HEAD'}`,
        right: `Changes from ${info.otherBranch ?? short(info.otherHash)}`,
      };
    case 'rebase':
      if (!info.rebaseHead || !info.otherHash) return fallback;
      return {
        left: `Rebasing ${short(info.rebaseHead)} from ${info.currentBranch ?? 'HEAD'}`,
        right: info.otherBranch ? `Already rebased commits and commits from ${info.otherBranch}` : 'Already rebased commits',
      };
    case 'cherry-pick':
      if (!info.otherHash) return fallback;
      return { left: 'Local Changes', right: `Changes from cherry-pick ${short(info.otherHash)}` };
    default:
      return fallback;
  }
}

/** DiffBundle merge.dialog.apply.partially.resolved.changes.confirmation.message (first line). */
export function unprocessedMessage(changes: number, conflicts: number): string {
  const verb = changes === 0 ? (conflicts === 1 ? 'is' : 'are') : changes === 1 ? 'is' : 'are';
  const c = changes === 0 ? '' : changes === 1 ? 'one change' : `${changes} changes`;
  const and = changes > 0 && conflicts > 0 ? ' and ' : '';
  const k = conflicts === 0 ? '' : conflicts === 1 ? 'one conflict' : `${conflicts} conflicts`;
  return `There ${verb} ${c}${and}${k} left unprocessed.`;
}

/** Branch name git recorded in MERGE_MSG ("Merge branch 'main' into feature" → main). */
export function mergeMsgRef(msg: string): string | undefined {
  const first = msg.split('\n', 1)[0] ?? '';
  return /'([^']+)'/.exec(first)?.[1];
}

/**
 * IntelliJ's resolveBranchName: the single local branch pointing at the hash, else the single remote one;
 * with several candidates `preferred` (from MERGE_MSG) breaks the tie.
 */
export function pickBranch(local: string[], remote: string[], preferred?: string): string | undefined {
  const list = local.length ? local : remote;
  if (list.length === 1) return list[0];
  if (preferred && list.includes(preferred)) return preferred;
  if (preferred && list.some((b) => b.endsWith(`/${preferred}`))) return list.find((b) => b.endsWith(`/${preferred}`));
  return undefined;
}

/** MergeUtil.showConfirmDiscardChangesDialog texts for "Accept Left", "Accept Right" and "Cancel Merge". */
export function discardConfirmation(action: string): { title: string; message: string; yes: string; no: string } {
  return {
    title: action,
    message: `There are unsaved changes in the result file. Discard changes and ${action.toLowerCase()} anyway?`,
    yes: `Discard Changes and ${action}`,
    no: 'Continue Merge',
  };
}
