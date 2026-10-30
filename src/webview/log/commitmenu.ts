// The commit context menu of the log table (pure): IntelliJ Vcs.Log.ContextMenu order (+ Dvcs/Git groups merged
// in as plugin.xml does) and enablement rules (single/multi selection, current branch, merges, HEAD-only).
import type { OperationState } from '../../core/types';
import type { RefLabel } from '../../features/log/protocol';

export type CommitAction =
  | 'copyHash'
  | 'createPatch'
  | 'cherryPick'
  | 'checkoutRevision'
  | 'repoAtRevision'
  | 'compareVersions'
  | 'compareWithLocal'
  | 'resetToHere'
  | 'revert'
  | 'undo'
  | 'reword'
  | 'fixup'
  | 'squashInto'
  | 'drop'
  | 'squash'
  | 'interactiveRebase'
  | 'pushUpTo'
  | 'newBranch'
  | 'newTag'
  | 'goToChild'
  | 'goToParent';

export interface MenuCommit {
  root: number;
  hash: string;
  parents: string[];
  head?: boolean;
  onCurrentBranch?: boolean;
  childRows: number[];
  parentRows: number[];
  refs: RefLabel[];
}

export interface MenuRoot {
  detached: boolean;
  branch?: string;
  operation: OperationState;
}

export interface CommitMenuAction {
  id: CommitAction;
  label: string;
  disabled: boolean;
  /** why it is disabled (shown as tooltip-like description) */
  reason?: string;
  shortcut?: string;
  /** checkoutRevision: branches at the commit → IntelliJ shows a "Checkout" submenu (branches + "Revision 'h'") */
  checkoutBranches?: RefLabel[];
  /** checkoutRevision: "Revision 'h'" item text inside that submenu */
  revisionLabel?: string;
}

/** A "Branch 'x'" submenu (Git.BranchOperationGroup) for a branch pointing at the selected commit. */
export interface CommitMenuBranch {
  branch: RefLabel;
}

export type CommitMenuEntry = '-' | CommitMenuAction | CommitMenuBranch;

const LABELS: Record<CommitAction, string> = {
  copyHash: 'Copy Revision Number',
  createPatch: 'Create Patch…',
  cherryPick: 'Cherry-Pick',
  checkoutRevision: 'Checkout Revision',
  repoAtRevision: 'Show Repository at Revision',
  compareVersions: 'Compare Versions',
  compareWithLocal: 'Compare with Local',
  resetToHere: 'Reset Current Branch to Here…',
  revert: 'Revert Commit',
  undo: 'Undo Commit…',
  reword: 'Edit Commit Message…',
  fixup: 'Fixup…',
  squashInto: 'Squash Into…',
  drop: 'Drop Commits',
  squash: 'Squash Commits…',
  interactiveRebase: 'Interactively Rebase from Here…',
  pushUpTo: 'Push All up to Here…',
  newBranch: 'New Branch…',
  newTag: 'New Tag…',
  goToChild: 'Go to Child Commit',
  goToParent: 'Go to Parent Commit',
};

const SHORTCUTS: Partial<Record<CommitAction, string>> = {
  copyHash: 'CmdOrCtrl+Alt+Shift+C',
  compareVersions: 'CmdOrCtrl+D',
  goToChild: 'Right',
  goToParent: 'Left',
};

export function actionLabel(id: CommitAction): string {
  return LABELS[id];
}

export function buildCommitMenu(sel: readonly MenuCommit[], roots: readonly MenuRoot[]): CommitMenuEntry[] {
  const n = sel.length;
  const one = n === 1 ? sel[0] : undefined;
  const sameRoot = n > 0 && sel.every((c) => c.root === sel[0].root);
  const root = sameRoot ? roots[sel[0].root] : undefined;
  const anyMerge = sel.some((c) => c.parents.length > 1);
  const allOnCurrent = n > 0 && sel.every((c) => c.onCurrentBranch);
  const busy = !!root && root.operation !== 'none';

  const act = (id: CommitAction, disabled: boolean, reason?: string): CommitMenuAction => {
    const a: CommitMenuAction = { id, label: LABELS[id], disabled };
    if (disabled && reason) a.reason = reason;
    if (SHORTCUTS[id]) a.shortcut = SHORTCUTS[id];
    return a;
  };
  // history rewriting (reword, fixup, squash, drop, interactive rebase): commits of the current branch, no merges
  const rewrite = (id: CommitAction, ok: boolean): CommitMenuAction => {
    if (!sameRoot || !root) return act(id, true, 'Select commits from a single repository');
    if (root.detached && (id === 'interactiveRebase' || id === 'squash' || id === 'drop' || id === 'reword')) return act(id, true, 'Not possible in the detached HEAD state');
    if (busy) return act(id, true, `Not possible during ${root.operation}`);
    if (!allOnCurrent) return act(id, true, 'The commit is not in the current branch');
    return act(id, !ok);
  };

  // Git.CheckoutGroup (GitCheckoutActionGroup): "Checkout Revision 'h'", or a "Checkout" submenu when branches
  // (other than the current one) point at the commit
  const checkout = (): CommitMenuAction => {
    const a = act('checkoutRevision', !one);
    if (!one) return a;
    const h8 = one.hash.slice(0, 8);
    a.label = `Checkout Revision '${h8}'`;
    const branches = one.refs.filter((r) => (r.kind === 'local' && !r.current) || r.kind === 'remote');
    if (branches.length) {
      a.label = 'Checkout';
      a.checkoutBranches = branches;
      a.revisionLabel = `Revision '${h8}'`;
    }
    return a;
  };

  const out: CommitMenuEntry[] = [
    act('copyHash', n === 0),
    act('createPatch', n === 0 || !sameRoot),
    act('cherryPick', n === 0 || !sameRoot || allOnCurrent || busy, allOnCurrent ? 'The commit is already in the current branch' : undefined),
    '-',
    checkout(),
    act('repoAtRevision', !one),
    act('compareVersions', !(n === 2 && sameRoot)),
    act('compareWithLocal', !one),
    '-',
    act('resetToHere', !one || busy),
    act('revert', n === 0 || !sameRoot || anyMerge || busy, anyMerge ? 'Reverting merge commits is not supported' : undefined),
    act('undo', !one || !one.head || one.parents.length !== 1 || !!root?.detached || busy, one && !one.head ? 'The selected commit is not the last commit' : undefined),
    '-',
    rewrite('reword', !!one && !anyMerge),
    rewrite('fixup', !!one && !anyMerge),
    rewrite('squashInto', !!one && !anyMerge),
    rewrite('drop', n > 0 && !anyMerge),
    rewrite('squash', n > 1 && !anyMerge),
    rewrite('interactiveRebase', !!one),
    act('pushUpTo', !one || !root || root.detached || !one.onCurrentBranch),
    '-',
  ];
  if (one) for (const r of one.refs) if (r.kind === 'local' || r.kind === 'remote') out.push({ branch: r });
  out.push(act('newBranch', !one), act('newTag', !one), '-');
  out.push(act('goToChild', !one || !one.childRows.some((r) => r >= 0)), act('goToParent', !one || !one.parentRows.some((r) => r >= 0)));
  return out;
}
