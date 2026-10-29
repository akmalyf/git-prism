// Shared data shapes between the git layer, the extension features and (via JSON) the webviews.
// Keep this file free of vscode/node imports: webviews import it too.

/** git status letter, as in `--name-status` / porcelain: A added, M modified, D deleted, R renamed, C copied, T type change, U unmerged, ? untracked, ! ignored */
export type ChangeKind = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';

export interface FileChange {
  /** path relative to the repository root, forward slashes */
  path: string;
  /** previous path for renames/copies */
  oldPath?: string;
  kind: ChangeKind;
}

/** One file in the working tree status (porcelain v2). */
export interface StatusEntry extends FileChange {
  /** change in the index relative to HEAD ('.' none) */
  index: ChangeKind | '.';
  /** change in the working tree relative to the index ('.' none) */
  worktree: ChangeKind | '.';
  /** unmerged entry: conflict code such as 'UU', 'AA', 'DU' */
  conflict?: string;
  submodule?: boolean;
}

export interface BranchInfo {
  /** current branch short name; undefined when detached */
  head?: string;
  /** HEAD commit hash; undefined in an empty repository */
  oid?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface Status {
  branch: BranchInfo;
  entries: StatusEntry[];
}

export type RefType = 'head' | 'remote' | 'tag' | 'stash' | 'other';

export interface Ref {
  /** full ref name, e.g. refs/heads/main */
  name: string;
  /** short name, e.g. main, origin/main, v1.0 */
  short: string;
  type: RefType;
  /** commit hash the ref points to (peeled for annotated tags) */
  hash: string;
  /** for local branches */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** remote name for remote branches */
  remote?: string;
  /** committer date of the target commit, unix seconds */
  date?: number;
  subject?: string;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** unix seconds */
  authorDate: number;
  committer: string;
  committerEmail: string;
  /** unix seconds */
  commitDate: number;
  subject: string;
  /** full message body (without the subject); only filled where requested */
  body?: string;
}

/** In-progress multi-step operation, detected from files in the git dir. */
export type OperationState = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | 'am';

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface Stash {
  index: number;
  /** stash@{n} */
  ref: string;
  hash: string;
  message: string;
  branch?: string;
  date: number;
}
