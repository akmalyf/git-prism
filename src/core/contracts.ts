// Cross-feature contract: command ids one feature calls and another implements, with their argument
// shapes. Features never import each other; they call these through `invoke()`.
// The owning feature registers the command (and its palette entry in its contributes.json).
import * as vscode from 'vscode';
import type { ChangeKind } from './types';

/** Where one side of a diff comes from. */
export type ContentRef =
  /** a file at a commit-ish (hash, branch, tag, HEAD~1, stash@{0}, ...) */
  | { rev: string; path: string }
  /** the staged (index) version; stage 0 normally, 1/2/3 base/ours/theirs while conflicted */
  | { index: true; path: string; stage?: 0 | 1 | 2 | 3 }
  /** the file on disk (editable in the diff) */
  | { worktree: true; path: string }
  /** file doesn't exist on this side (added/deleted) */
  | { empty: true }
  /** literal text */
  | { text: string; label?: string };

export interface DiffFile {
  repoRoot: string;
  /** repo-relative path shown in the file list / title */
  path: string;
  oldPath?: string;
  kind?: ChangeKind;
  left: ContentRef;
  right: ContentRef;
  /** titles above the editors, e.g. "a1b2c3d" / "Your version" (defaults derived from refs) */
  leftTitle?: string;
  rightTitle?: string;
}

export interface DiffRequest {
  /** editor tab title; default derived from the selected file */
  title?: string;
  /** several files → the diff window gets previous/next file navigation and a file list (like IntelliJ) */
  files: DiffFile[];
  /** which file to show first */
  index?: number;
  /** open beside instead of in the active group */
  beside?: boolean;
}

export interface LogShowArgs {
  repoRoot?: string;
  /** select (and scroll to) this commit */
  revision?: string;
  /** path filter (repo-relative); with editorTab this is the "Show History" view */
  paths?: string[];
  /** branch filter (short names); default all branches */
  branches?: string[];
  text?: string;
  /** open as an editor tab (History / "Show Git Log for ...") instead of the bottom Git panel */
  editorTab?: boolean;
  title?: string;
}

/** Arguments of every commit-level operation (log context menu). Hashes are full hashes, newest first. */
export interface CommitsArgs {
  repoRoot: string;
  hashes: string[];
}

export interface RefArgs {
  repoRoot?: string;
  /** branch/tag/commit-ish */
  ref?: string;
}

export interface ChangesShowArgs {
  repoRoot: string;
  /** base commit-ish */
  from: string;
  /** target commit-ish; undefined = working tree */
  to?: string;
  paths?: string[];
  title?: string;
}

/** Command ids → argument type. Owner feature in the comment. */
export interface Commands {
  // diff
  'jbGit.diff.show': DiffRequest;
  // conflicts
  'jbGit.conflicts.resolve': { repoRoot?: string };
  'jbGit.conflicts.mergeFile': { repoRoot: string; path: string };
  // log
  'jbGit.log.show': LogShowArgs;
  // commitOps (log context menu operations)
  'jbGit.commit.checkoutRevision': CommitsArgs;
  'jbGit.commit.resetToHere': CommitsArgs;
  'jbGit.commit.revert': CommitsArgs;
  'jbGit.commit.cherryPick': CommitsArgs;
  'jbGit.commit.undo': CommitsArgs;
  'jbGit.commit.reword': CommitsArgs;
  'jbGit.commit.fixup': CommitsArgs;
  'jbGit.commit.squashInto': CommitsArgs;
  'jbGit.commit.squash': CommitsArgs;
  'jbGit.commit.drop': CommitsArgs;
  'jbGit.commit.interactiveRebase': CommitsArgs;
  'jbGit.commit.pushUpTo': CommitsArgs;
  'jbGit.commit.newBranch': CommitsArgs;
  'jbGit.commit.newTag': CommitsArgs;
  'jbGit.commit.createPatch': CommitsArgs;
  'jbGit.commit.copyHash': CommitsArgs;
  // compare
  'jbGit.changes.show': ChangesShowArgs;
  'jbGit.compare.withCurrent': RefArgs;
  'jbGit.repoAtRevision': CommitsArgs;
  'jbGit.compare.fileWithRevision': { repoRoot: string; path: string; rev: string };
  /** opens a read-only editor with the file content at `rev` */
  'jbGit.openFileAtRevision': { repoRoot: string; path: string; rev: string };
  // sync dialogs
  'jbGit.push': { repoRoot?: string; upTo?: string; force?: boolean };
  'jbGit.pull': { repoRoot?: string };
  'jbGit.fetch': { repoRoot?: string };
  'jbGit.merge': RefArgs;
  'jbGit.rebase': RefArgs;
  'jbGit.updateProject': { repoRoot?: string };
  /** Reset HEAD dialog; `target` prefills "To commit" (used by the log's "Reset Current Branch to Here…") */
  'jbGit.resetHead': { repoRoot?: string; target?: string };
  // branches
  'jbGit.branches.show': { repoRoot?: string };
  'jbGit.branch.new': RefArgs;
  'jbGit.branch.checkout': RefArgs;
  'jbGit.tag.new': RefArgs;
  'jbGit.branch.rename': RefArgs;
  'jbGit.branch.delete': RefArgs;
  'jbGit.tag.delete': RefArgs;
  /** the per-branch action list of the Branches popup (Checkout, New Branch from…, Compare with…, Merge…, …) */
  'jbGit.branch.actions': RefArgs;
  // conflicts (ongoing merge/rebase/cherry-pick/revert)
  'jbGit.operation.continue': { repoRoot?: string };
  'jbGit.operation.abort': { repoRoot?: string };
  'jbGit.operation.skip': { repoRoot?: string };
  // commit tool window
  /** reveals the Commit view; `message` prefills the commit message (e.g. "fixup! …") */
  'jbGit.commit.focus': { repoRoot?: string; message?: string };
  // stash
  /** Stash Changes dialog; `paths` limits the stash to these repo-relative paths */
  'jbGit.stash.create': { repoRoot?: string; paths?: string[] };
  'jbGit.stash.unstash': { repoRoot?: string };
  'jbGit.shelf.shelve': { repoRoot?: string; paths?: string[] };
  'jbGit.patch.create': { repoRoot?: string; paths?: string[] };
  'jbGit.patch.apply': { repoRoot?: string };
  // core
  'jbGit.console.show': undefined;
}

export type CommandId = keyof Commands;

/** Executes a contract command. */
export function invoke<K extends CommandId>(id: K, args: Commands[K]): Thenable<unknown> {
  return vscode.commands.executeCommand(id, args);
}

/** Registers a contract command with a typed handler. */
export function implement<K extends CommandId>(id: K, handler: (args: Commands[K]) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(id, (args: Commands[K]) => handler(args ?? ({} as Commands[K])));
}
