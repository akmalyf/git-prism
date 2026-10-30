// Git Log host ⇄ webview protocol: payload types of every RPC method and event (see PROTOCOL.md).
// Keep this file free of vscode/node imports: the log webview (src/webview/log) imports it.
import type { ChangeKind, FileChange, OperationState } from '../../core/types';

export type { ChangeKind, FileChange };

/** "Topologically" (IntelliSort: incoming commits directly below the merge) or "By Commit Date". */
export type SortType = 'topological' | 'date';
export type LogColumn = 'author' | 'subject' | 'date' | 'hash' | 'root';
export type DiffPreviewLocation = 'right' | 'bottom';

/** VS Code settings jbGit.log.* (global presentation settings). */
export interface LogSettings {
  sortType: SortType;
  /** graph option "First Parent" */
  firstParent: boolean;
  /** "Long Edges" */
  showLongEdges: boolean;
  /** visible table columns in display order ('subject' contains the graph and the reference labels) */
  columns: LogColumn[];
  /** "Commit Timestamp": show commit date instead of author date */
  preferCommitDate: boolean;
  /** '' = locale default; otherwise a pattern with yyyy yy MM M dd d HH H mm ss */
  dateFormat: string;
  /** "Today 11.19" / "Yesterday 14.53" for recent dates */
  prettyDates: boolean;
  highlightMyCommits: boolean;
  highlightMergeCommits: boolean;
  highlightCurrentBranch: boolean;
  showTagNames: boolean;
  compactReferences: boolean;
  referencesOnLeft: boolean;
  showDetails: boolean;
  showDiffPreview: boolean;
  diffPreviewLocation: DiffPreviewLocation;
  /** the branches tree on the left of the log */
  showBranches: boolean;
}

export type LogSettingKey = keyof LogSettings;

/** Log filters. Unset / empty = no filter. */
export interface LogFilters {
  /** branch filter: 'HEAD' or short ref names (main, origin/main, v1.0) */
  branches?: string[];
  /** user filter: 'me', a name, an email or 'Name <email>' */
  users?: string[];
  /** date filter, unix seconds (inclusive) */
  since?: number;
  until?: number;
  /** path filter: ABSOLUTE paths (forward slashes); each root only gets the paths inside it */
  paths?: string[];
  /** roots filter: absolute repository roots to show (multi-repository workspaces) */
  roots?: string[];
  /** text or hash filter */
  text?: string;
  /** "Regex" */
  regex?: boolean;
  /** "Match Case" */
  matchCase?: boolean;
}

/** Per-log options persisted in workspaceState together with the filters. */
export interface LogViewOptions {
  /** "Show Changes to Parents" for merge commits */
  showChangesToParents: boolean;
  /** history view: "Show Only Affected Changes" (limit the changes to the filtered paths) */
  showOnlyAffectedChanges: boolean;
}

export interface LogInit {
  /** 'log' = the Git tool window tab / "Show Git Log for …"; 'history' = "History: <file>" */
  mode: 'log' | 'history';
  /** editor tab or view title */
  title: string;
  /** hide the branches tree (history view) */
  hideBranches: boolean;
  /** history view: absolute paths whose history is shown */
  historyPaths?: string[];
  /** true when shown as an editor tab */
  editorTab: boolean;
  /** show the collapsible Git Console pane at the bottom (the Log view in the Git panel) */
  console?: boolean;
}

export interface UserIdentity {
  name?: string;
  email?: string;
}

export interface RootInfo {
  /** index used by LogRow.root */
  index: number;
  /** absolute repository root */
  root: string;
  name: string;
  /** current branch short name; undefined when detached or empty */
  branch?: string;
  /** HEAD commit; undefined in an empty repository */
  head?: string;
  detached: boolean;
  empty: boolean;
  operation: OperationState;
  /** user.name / user.email of this repository ("me", "My Commits") */
  me: UserIdentity;
}

export interface LogState {
  /** increments on every rebuild of the commit list (rows of an older version are stale) */
  version: number;
  roots: RootInfo[];
  /** roots shown with the current roots/paths filters */
  visibleRoots: string[];
  rowCount: number;
  /** more commits can be loaded with loadMore() */
  hasMore: boolean;
  loading: boolean;
  /** "Error loading commits" / "Error filtering commits" details */
  error?: string;
  /** structure-changing filters (text/user/date) are active: the graph is a plain line of the matching commits */
  linear: boolean;
  /** any filter set (for the "No commits matching filters" / "Reset filters" empty state) */
  filtered: boolean;
  filters: LogFilters;
  options: LogViewOptions;
  settings: LogSettings;
  /** widest graph row seen so far (positions), for the initial graph column width */
  graphWidth: number;
}

export type RefKind = 'HEAD' | 'local' | 'remote' | 'tag';

/** A reference label of a commit, in IntelliJ order: HEAD (detached), local (current first), remote, tags. */
export interface RefLabel {
  /** short name: main, origin/main, v1.0, HEAD */
  name: string;
  /** full name: refs/heads/main …, 'HEAD' for detached HEAD */
  full: string;
  kind: RefKind;
  /** the current branch (local) */
  current?: boolean;
  /** local branch: its upstream (e.g. origin/main) — lets the UI render "origin & main" */
  upstream?: string;
  /** remote branch: remote name */
  remote?: string;
  favorite?: boolean;
}

/**
 * Graph print elements of one row (IntelliJ PrintElement semantics). Positions are lane slots (0 = leftmost).
 * - node: the commit's circle at (node, middle of the row)
 * - edges: flat tuples of EDGE_TUPLE (= 6) numbers [position, toPosition, type, color, flags, target]:
 *     type 0 = UP:   line from (position, row middle) to ((position + toPosition) / 2, row top)
 *     type 1 = DOWN: line from (position, row middle) to ((position + toPosition) / 2, row bottom)
 *     flags 1 = arrow (arrow head at the far end of this half segment)
 *     flags 2 = terminal (the edge is cut here: short stub from the middle towards the top/bottom with an arrow;
 *               toPosition = position; target = row of the other end, click → jump there)
 *     flags 4 = dotted (edge to a parent that is not loaded)
 *     target  = row index of the other end for terminal arrows, else -1
 * - color: color id (non-negative int) → palette[color % palette.length]
 */
export interface GraphRowPrint {
  node: number;
  color: number;
  /** number of lane slots in this row */
  width: number;
  edges: number[];
}

/** One commit row of the log table. */
export interface LogRow {
  index: number;
  /** index into LogState.roots */
  root: number;
  hash: string;
  parents: string[];
  /** rows of the children / parents in the current list (-1 = parent not loaded) — "Go to Child/Parent Commit" */
  childRows: number[];
  parentRows: number[];
  subject: string;
  author: string;
  authorEmail: string;
  /** unix seconds */
  authorDate: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  refs: RefLabel[];
  /** HEAD of its repository (drawn as a ring) */
  head?: boolean;
  /** authored by the repository user ("My Commits" → bold) */
  mine?: boolean;
  /** reachable from the current branch ("Current Branch" highlighter) */
  onCurrentBranch?: boolean;
  graph: GraphRowPrint;
}

/** Identifies a commit independent of row indices. */
export interface CommitId {
  /** absolute repository root */
  root: string;
  hash: string;
}

export interface RowsRequest {
  /** LogState.version the webview has; rows are returned for the current version (check `version`) */
  version?: number;
  from: number;
  to: number;
}

export interface RowsResult {
  version: number;
  rowCount: number;
  rows: LogRow[];
}

export interface CommitDetails {
  root: string;
  hash: string;
  parents: string[];
  subject: string;
  /** full commit message (subject + body) */
  message: string;
  author: string;
  authorEmail: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  refs: RefLabel[];
}

export interface ContainingBranches {
  root: string;
  hash: string;
  /** local branches first, then remote ones; [] → "Not in any branch" */
  branches: string[];
  /** current branch contains the commit */
  current: boolean;
}

/** Changes of the selected commit(s). */
export interface ChangesRequest {
  commits: CommitId[];
  /** overrides LogViewOptions.showChangesToParents */
  showChangesToParents?: boolean;
}

/** One block of changed files: files between `from` and `to` (diff left = from, right = to). */
export interface ChangeGroup {
  root: string;
  /** commit-ish of the left side; EMPTY_TREE for root commits */
  from: string;
  /** commit of the right side */
  to: string;
  /** 'Changes to <short parent hash>' for merge parents; undefined for a single group */
  title?: string;
  files: FileChange[];
}

export interface ChangesResult {
  groups: ChangeGroup[];
  /** a single merge commit is selected (enables "Show Changes to Parents") */
  merge: boolean;
  /** files were limited to the path filter (history "Show Only Affected Changes") */
  affectedOnly: boolean;
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Diff of a file in a change group. */
export interface ShowDiffRequest {
  group: ChangeGroup;
  /** repo-relative path of the file to show first; all files of the group are passed so next/previous file works */
  path: string;
  /** 'commit' = from → to; 'local' = "Compare with Local" (to → working tree); 'beforeLocal' = "Compare Before with Local" (from → working tree) */
  mode?: 'commit' | 'local' | 'beforeLocal';
  beside?: boolean;
}

export interface FileAtRevision {
  root: string;
  /** repo-relative */
  path: string;
  rev: string;
}

export interface FilesAtRevision {
  root: string;
  /** repo-relative */
  paths: string[];
  /** the commit */
  rev: string;
  /** left side of the change (parent); for revert/cherry-pick of selected changes */
  from?: string;
}

export type CommitOp =
  | 'checkoutRevision'
  | 'resetToHere'
  | 'revert'
  | 'cherryPick'
  | 'undo'
  | 'reword'
  | 'fixup'
  | 'squashInto'
  | 'squash'
  | 'drop'
  | 'interactiveRebase'
  | 'pushUpTo'
  | 'newBranch'
  | 'newTag'
  | 'createPatch'
  | 'copyHash'
  | 'repoAtRevision';

export interface CommitOpRequest {
  op: CommitOp;
  /** newest first (table order) */
  commits: CommitId[];
}

export type RefOp =
  | 'actions'
  | 'checkout'
  | 'newBranch'
  | 'newTag'
  | 'delete'
  | 'deleteTag'
  | 'rename'
  | 'merge'
  | 'rebase'
  | 'compareWithCurrent'
  | 'push'
  | 'fetch'
  | 'pull'
  | 'updateProject'
  /** Checkout and Rebase onto Current (`git rebase <current> <ref>`) */
  | 'checkoutAndRebase'
  /** Show Diff with Working Tree (jbGit.compare.withWorkingTree) */
  | 'showDiffWithWorkingTree'
  /** Update: the current branch → Update Project; another local branch → fast-forward from its tracked branch */
  | 'update'
  /** Pull into Current Using Rebase / Merge (ref = remote branch) */
  | 'pullRebase'
  | 'pullMerge';

export interface RefOpRequest {
  op: RefOp;
  root: string;
  /** short ref name / commit-ish */
  ref?: string;
}

/** Branch filter popup and branches tree data of one root. */
export interface RefsInfo {
  root: string;
  name: string;
  /** current branch, undefined when detached */
  current?: string;
  head?: string;
  detached: boolean;
  local: RefItem[];
  remote: RefItem[];
  tags: RefItem[];
  /** recently checked out branches (reflog), newest first */
  recent: string[];
  /** favorite branch short names */
  favorites: string[];
}

export interface RefItem {
  name: string;
  full: string;
  hash: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  remote?: string;
  favorite?: boolean;
  current?: boolean;
}

export interface UserItem {
  name: string;
  email: string;
  /** commits count (shortlog) */
  count: number;
}

export interface UsersResult {
  /** de-duplicated authors by commit count */
  users: UserItem[];
  me: UserIdentity[];
}

export interface PathSuggestion {
  root: string;
  /** repo-relative */
  path: string;
  /** absolute, forward slashes — the value for LogFilters.paths */
  abs: string;
  dir: boolean;
}

export interface GoToResult {
  /** row index, or -1 when not found in the (filtered) log */
  row: number;
  hash?: string;
  root?: string;
  /** "Commit or reference 'x' not found" / "x doesn't match the filters" */
  message?: string;
}

export interface SearchRequest {
  text: string;
  /** start searching after this row (exclusive); -1 = from the top */
  from: number;
  backward?: boolean;
  regex?: boolean;
  matchCase?: boolean;
}

export interface SearchResult {
  row: number;
}

/** Contents of both sides of a changed file (embedded diff preview). */
export interface FileContentsRequest {
  root: string;
  /** repo-relative path on the right side */
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  /** left commit-ish (EMPTY_TREE for root commits) */
  from: string;
  /** right commit-ish */
  to: string;
}

export interface FileContentsResult {
  original: string;
  modified: string;
  /** one side is binary or too large to show */
  binary?: boolean;
  tooLarge?: boolean;
}

/** History view: the history file in one commit (enablement of Vcs.FileHistory.ContextMenu / toolbar). */
export interface HistoryFileInfo {
  root: string;
  hash: string;
  /** the history shows a directory (or several paths): file-only actions are disabled */
  dir: boolean;
  /** single file: its repo-relative path in that revision (follows renames) */
  path?: string;
  /** single file: absent in that revision (deleted by the commit) */
  deleted: boolean;
  /** the commit changes the history paths (false e.g. for merges that took the file from the first parent) */
  changed: boolean;
}

/** File History actions answered by the host ('historyAction'). */
export type HistoryAction =
  /** Diff.ShowDiff: one row = the file's change in the commit; two rows = "Compare" of the two revisions */
  | 'showDiff'
  /** Diff.ShowStandaloneDiff ("Show Diff in a New Tab") */
  | 'showDiffNewTab'
  /** Vcs.ShowDiffWithLocal */
  | 'compareWithLocal'
  /** Vcs.Log.OpenRepositoryVersion ("Show File at Revision") */
  | 'openFile'
  /** Vcs.Log.AnnotateRevisionAction */
  | 'annotate'
  /** Vcs.GetVersion ("Get") */
  | 'get'
  /** Vcs.Log.ShowAllAffected */
  | 'showAllAffected'
  /** Vcs.Log.SelectInLog ("Show in Git Log") */
  | 'selectInLog';

export interface HistoryActionRequest {
  action: HistoryAction;
  /** newest first (table order) */
  commits: CommitId[];
}

/** Vcs.ShowHistoryForRevision ("History Up to Here"): history of `path` filtered to commits reachable from `revision`. */
export interface HistoryUpToRequest {
  root: string;
  /** repo-relative path in that revision */
  path: string;
  revision: string;
}

/** "Not Cherry-Picked Commits" highlighter: commits of `branch` whose change already exists in HEAD. */
export interface CherryPickedRequest {
  root: string;
  branch: string;
}

/** Events host → webview. */
export interface LogEvents {
  /** the commit list was rebuilt or filters/options/settings changed; re-fetch rows if version changed */
  state: LogState;
  /** settings changed (also included in the next state) */
  settings: LogSettings;
  /** select this commit (jbGit.log.show revision / Go to) */
  select: { row: number; hash: string; root: string };
  /** refs/HEAD changed without the commit list changing; refresh the branches tree */
  refs: undefined;
  /** focus the text filter (Focus Text Filter) */
  focusTextFilter: undefined;
}
