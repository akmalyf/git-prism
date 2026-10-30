// Messages and data shapes shared by the stash / shelf / patch host code and its webviews
// (src/webview/stash, src/webview/shelf, src/webview/unstash). No vscode/node imports here.
import type { ChangeKind } from '../../core/types';

/** A file of a stash; `source` says which stash commit holds the change. */
export interface StashFile {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  /** tracked = stash^1..stash (working tree), index = stash^1..stash^2 only, untracked = stash^3 */
  source: 'tracked' | 'index' | 'untracked';
}

export interface StashItem {
  index: number;
  /** stash@{n} */
  ref: string;
  hash: string;
  message: string;
  branch?: string;
  /** unix seconds */
  date: number;
}

export interface StashRepo {
  root: string;
  name: string;
  /** current branch, undefined when detached */
  branch?: string;
  stashes: StashItem[];
}

export interface StashViewModel {
  repos: StashRepo[];
  previewDiff: boolean;
  locale: string;
}

/** stash view → host */
export interface StashTarget {
  repoRoot: string;
  hash: string;
}

export interface ShelfFile {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  binary?: boolean;
}

export interface ShelfInfo {
  id: string;
  name: string;
  /** unix seconds */
  date: number;
  repoRoot: string;
  repoName: string;
  branch?: string;
  baseCommit?: string;
  files: ShelfFile[];
  applied: boolean;
  deleted: boolean;
}

export interface ShelfViewModel {
  shelves: ShelfInfo[];
  showApplied: boolean;
  groupByDirectory: boolean;
  multiRepo: boolean;
  locale: string;
}

/** A change offered in a dialog's file tree. */
export interface DialogChange {
  repoRoot: string;
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  checked: boolean;
  /** grey trailing text, e.g. "Already applied" */
  status?: string;
}

export interface RepoChoice {
  root: string;
  name: string;
  branch?: string;
}

/** init of the `shelf` bundle in dialog mode */
export type ShelfDialogInit =
  | { mode: 'shelve'; title: string; okLabel: string; repos: RepoChoice[]; changes: DialogChange[]; message: string; keep: boolean; locale: string }
  | { mode: 'unshelve'; title: string; name: string; changes: DialogChange[]; removeApplied: boolean; locale: string }
  | { mode: 'createPatch'; title: string; repos: RepoChoice[]; changes: DialogChange[]; file: string; clipboard: boolean; locale: string }
  | { mode: 'applyPatch'; title: string; repos: RepoChoice[]; repoRoot: string; file: string; changes: DialogChange[]; error?: string; locale: string };

export type ShelfInit = { mode: 'view'; locale: string } | ShelfDialogInit;

/** results posted by the dialogs */
export interface ShelveResult {
  message: string;
  keep: boolean;
  files: { repoRoot: string; path: string }[];
}
export interface UnshelveResult {
  paths: string[];
  removeApplied: boolean;
}
export interface CreatePatchResult {
  files: { repoRoot: string; path: string }[];
  file: string;
  clipboard: boolean;
  reverse: boolean;
}
export interface ApplyPatchResult {
  repoRoot: string;
  file: string;
  paths: string[];
}

/** init of the `unstash` bundle */
export type UnstashInit =
  | { mode: 'unstash'; repos: RepoChoice[]; repoRoot: string; locale: string }
  | { mode: 'stash'; repos: RepoChoice[]; repoRoot: string; paths?: string[]; locale: string }
  | { mode: 'unstashAs'; repoRoot: string; repoName: string; branch?: string; stash: StashItem; locale: string };

export interface UnstashRequest {
  repoRoot: string;
  hash: string;
  pop: boolean;
  index: boolean;
  branch?: string;
}

export interface StashRequest {
  repoRoot: string;
  message: string;
  keepIndex: boolean;
  untracked: boolean;
  paths?: string[];
}
