// Data exchanged between the Commit view host (src/features/commit/view.ts) and its webview (src/webview/commit).
// No vscode/node imports: the webview bundles this file too.
import type { ChangeKind, OperationState } from '../../core/types';
import type { HunkView } from './partial';

/** Which tree section an item belongs to. 'changes' = changelist mode; staged/unstaged = staging area mode. */
export type Area = 'changes' | 'staged' | 'unstaged' | 'untracked' | 'ignored' | 'conflict';

export interface Item {
  /** unique: `${area}\0${repo}\0${path}` */
  key: string;
  /** repository root (absolute) */
  repo: string;
  /** repo-relative path */
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  area: Area;
  /** changelist id (area 'changes') */
  list?: string;
  /** included into commit (changelist mode checkboxes) */
  included?: boolean;
  /** included with some changed lines excluded (partially checked checkbox) */
  partial?: boolean;
  /** porcelain conflict code (UU, AA, DU, ...) */
  conflict?: string;
}

export interface RepoInfo {
  root: string;
  name: string;
  branch?: string;
  head?: string;
  /** no commits yet */
  empty: boolean;
  operation: OperationState;
}

export interface ChangelistInfo {
  id: string;
  name: string;
  /** description; also holds the commit message draft of the list (like IntelliJ) */
  comment: string;
  active: boolean;
}

export interface ViewSettings {
  groupByDirectory: boolean;
  groupByModule: boolean;
  groupByRepository: boolean;
  showIgnored: boolean;
  doubleClick: 'diff' | 'source';
  previewDiff: boolean;
  stagingArea: boolean;
  /** staging area: "Commit All when Nothing Is Staged" */
  commitAll: boolean;
}

export interface CommitOptions {
  /** --author; empty = default */
  author: string;
  signOff: boolean;
  gpgSign: boolean;
  runHooks: boolean;
}

export interface ViewModel {
  loading: boolean;
  repos: RepoInfo[];
  lists: ChangelistInfo[];
  items: Item[];
  settings: ViewSettings;
  options: CommitOptions;
  /** commit message draft in staging area mode */
  stagingDraft: string;
}

export interface CommitRequest {
  message: string;
  amend: boolean;
  /** amend a specific (non-HEAD) commit of `amendRepo` */
  amendTarget?: string;
  amendRepo?: string;
  push: boolean;
  /** changelist mode: keys of the included items */
  keys: string[];
  /** changelist whose draft holds the message (cleared after the commit) */
  list?: string;
  options: CommitOptions;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  date: number;
  merge: boolean;
}

/** Context menu / toolbar operations on items, executed by the host. */
export type ItemOp =
  | 'showDiff'
  | 'jumpToSource'
  | 'delete'
  | 'add'
  | 'addNoContent'
  | 'stage'
  | 'unstage'
  | 'acceptTheirs'
  | 'acceptYours'
  | 'merge'
  | 'createPatch'
  | 'copyPatch'
  | 'showHistory'
  | 'annotate'
  | 'shelve'
  | 'stash'
  /** staging area (Git.Stage.*): Show Staged / Local Version, Compare with Staged / Local / HEAD Version, 3 versions */
  | 'showStaged'
  | 'showLocal'
  | 'compareLocalStaged'
  | 'compareStagedLocal'
  | 'compareStagedHead'
  | 'threeWay';

/** A file of the Commit view diff window (src/features/commit/diffPanel.ts ↔ src/webview/commit-diff). */
export interface CommitDiffFile {
  key: string;
  path: string;
  kind: ChangeKind;
}

export interface CommitDiffInit {
  files: CommitDiffFile[];
  index: number;
  isMac: boolean;
}

export interface CommitDiffSide {
  /** undefined: the file doesn't exist on this side */
  text?: string;
  title: string;
  path?: string;
}

export interface CommitDiffPayload {
  index: number;
  key: string;
  path: string;
  language: string;
  type: 'text' | 'message';
  /** 'message': why there's no text diff (binary, too large, not changed anymore, error) */
  message?: string;
  left: CommitDiffSide;
  right: CommitDiffSide & { editable: boolean };
  /** the file is among the commit view's local changes (has an "Include into commit" checkbox) */
  checkable: boolean;
  /** the whole file is included into the commit */
  included: boolean;
  /** changed lines can be included / excluded separately */
  lines: boolean;
  hunks: HunkView[];
  canJump: boolean;
}

/** "Compare HEAD, Staged and Local Versions" window (src/features/commit/threeWay.ts ↔ src/webview/commit-threeway). */
export interface ThreeWayInit {
  files: CommitDiffFile[];
  index: number;
  isMac: boolean;
}

export interface ThreeWayPayload {
  index: number;
  key: string;
  path: string;
  language: string;
  type: 'text' | 'message';
  message?: string;
  head: string;
  staged: string;
  local: string;
  headTitle: string;
  stagedTitle: string;
  localTitle: string;
  /** the staged (middle) side can be edited: changes are written to the index */
  editable: boolean;
  canJump: boolean;
}

export const SEP = '\0';

export function itemKey(area: Area, repo: string, path: string): string {
  return `${area}${SEP}${repo}${SEP}${path}`;
}

/** Key used for inclusion / changelist membership (independent of the area). */
export function fileKey(repo: string, path: string): string {
  return `${repo}${SEP}${path}`;
}

/** IntelliJ validation texts of the commit action. */
export function validateCommit(o: { message: string; hasChanges: boolean; amend: boolean }): string | undefined {
  const noMsg = !o.message.trim();
  const noChanges = !o.hasChanges && !o.amend;
  if (noMsg && noChanges) return 'Select files to commit and specify commit message';
  if (noChanges) return 'Select files to commit';
  if (noMsg) return 'Specify commit message';
  return undefined;
}

/** IntelliJ validation texts of the staging area commit. */
export function validateStagedCommit(o: { message: string; hasStaged: boolean; amend: boolean }): string | undefined {
  const noMsg = !o.message.trim();
  const noChanges = !o.hasStaged && !o.amend;
  if (noMsg && noChanges) return 'Stage files to commit and specify commit message';
  if (noChanges) return 'Stage files to commit';
  if (noMsg) return 'Specify commit message';
  return undefined;
}
