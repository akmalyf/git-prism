// Messages between the sync dialogs (push, pull, update, merge, rebase, reset webviews) and the extension host.
// Type-only module: imported by both sides.
import type { ChangeKind } from '../../core/types';
import type { MergeOption, PullOption, RebaseOption } from './options';

export interface RepoItem {
  root: string;
  name: string;
}

export type RefKind = 'local' | 'remote' | 'tag';

export interface RefItem {
  name: string;
  kind: RefKind;
}

/** Branch data of one repository for the Merge / Rebase / Pull / Reset dialogs. */
export interface RepoData {
  root: string;
  /** current branch; undefined when detached */
  branch?: string;
  head?: string;
  refs: RefItem[];
  remotes: string[];
  /** upstream of the current branch, e.g. origin/main */
  upstream?: string;
  /** refs already merged into HEAD (Merge dialog validation) */
  merged?: string[];
}

export interface RefDialogInit {
  title: string;
  repos: RepoItem[];
  data: RepoData;
  /** prefilled ref (branch field / upstream) */
  ref?: string;
  locale?: string;
}

export interface MergeRequest {
  root: string;
  ref: string;
  options: MergeOption[];
  message?: string;
}

export interface PullInit extends RefDialogInit {
  remote?: string;
  /** remote branches (without the remote prefix) of the selected remote */
  branches: string[];
}

export interface PullRequest {
  root: string;
  remote: string;
  branches: string[];
  options: PullOption[];
}

export interface RebaseRequest {
  root: string;
  upstream?: string;
  onto?: string;
  branch?: string;
  options: RebaseOption[];
}

export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep';

export interface ResetInit extends RefDialogInit {
  /** true when opened with a target (log "Reset Current Branch to Here…") */
  fromLog: boolean;
  /** dirty working tree (hard reset asks first) */
  hasChanges: boolean;
}

export interface ResetRequest {
  root: string;
  commit: string;
  mode: ResetMode;
}

/** Answer of the "To Commit" validation. */
export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  date: number;
}

export type UpdateMethod = 'merge' | 'rebase';
export type SavePolicy = 'stash' | 'shelve';

export interface UpdateInit {
  kind: 'update';
  title: string;
  method: UpdateMethod;
  policy: SavePolicy;
}

export interface UpdateRequest {
  method: UpdateMethod;
  policy: SavePolicy;
  dontShowAgain: boolean;
}

// ---------- push ----------

export interface PushCommit {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  authorEmail: string;
  date: number;
}

/** One repository row of the push tree: "<branch> → <remote> : <target>". */
export interface PushRepo {
  root: string;
  name: string;
  /** local branch; undefined when detached */
  branch?: string;
  /** commit pushed (HEAD or the "Push All up to Here" commit) */
  source: string;
  remotes: string[];
  remote?: string;
  target?: string;
  /** target doesn't exist on the remote yet ("New" badge) */
  isNew: boolean;
  /** the branch has no upstream: it is set after a successful push */
  setUpstream: boolean;
  /** remote branch names (without remote prefix) of `remote`, for completion */
  remoteBranches: string[];
  commits: PushCommit[];
  /** "Empty repository" / "Cannot push" */
  problem?: string;
  /** checked in a multi-repository push */
  selected: boolean;
}

export interface PushInit {
  title: string;
  repos: PushRepo[];
  pushTags: boolean;
  tagMode: 'all' | 'current';
  runHooks: boolean;
  forceDefault: boolean;
  /** protected branch patterns (Force Push disabled for those targets) */
  protectedPatterns: string[];
  locale?: string;
}

export interface PushTargetQuery {
  root: string;
  remote: string;
  target: string;
}

export interface PushTargetInfo {
  isNew: boolean;
  commits: PushCommit[];
  remoteBranches: string[];
}

export interface PushChange {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
}

export interface PushRequest {
  repos: { root: string; remote: string; target: string }[];
  force: boolean;
  pushTags: boolean;
  tagMode: 'all' | 'current';
  runHooks: boolean;
}
