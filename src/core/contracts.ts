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
  'gitPrism.diff.show': DiffRequest;
  // conflicts
  'gitPrism.conflicts.resolve': { repoRoot?: string };
  'gitPrism.conflicts.mergeFile': { repoRoot: string; path: string };
  // log
  'gitPrism.log.show': LogShowArgs;
  // commitOps (log context menu operations)
  'gitPrism.commit.checkoutRevision': CommitsArgs;
  'gitPrism.commit.resetToHere': CommitsArgs;
  'gitPrism.commit.revert': CommitsArgs;
  'gitPrism.commit.cherryPick': CommitsArgs;
  'gitPrism.commit.undo': CommitsArgs;
  'gitPrism.commit.reword': CommitsArgs;
  'gitPrism.commit.fixup': CommitsArgs;
  'gitPrism.commit.squashInto': CommitsArgs;
  'gitPrism.commit.squash': CommitsArgs;
  'gitPrism.commit.drop': CommitsArgs;
  'gitPrism.commit.interactiveRebase': CommitsArgs;
  'gitPrism.commit.pushUpTo': CommitsArgs;
  'gitPrism.commit.newBranch': CommitsArgs;
  'gitPrism.commit.newTag': CommitsArgs;
  'gitPrism.commit.createPatch': CommitsArgs;
  'gitPrism.commit.copyHash': CommitsArgs;
  // compare
  'gitPrism.changes.show': ChangesShowArgs;
  'gitPrism.compare.withCurrent': RefArgs;
  'gitPrism.repoAtRevision': CommitsArgs;
  'gitPrism.compare.fileWithRevision': { repoRoot: string; path: string; rev: string };
  /** opens a read-only editor with the file content at `rev` */
  'gitPrism.openFileAtRevision': { repoRoot: string; path: string; rev: string };
  // sync dialogs
  'gitPrism.push': { repoRoot?: string; upTo?: string; force?: boolean };
  'gitPrism.pull': { repoRoot?: string };
  'gitPrism.fetch': { repoRoot?: string };
  'gitPrism.merge': RefArgs;
  'gitPrism.rebase': RefArgs;
  'gitPrism.updateProject': { repoRoot?: string };
  /** Reset HEAD dialog; `target` prefills "To commit" (used by the log's "Reset Current Branch to Here…") */
  'gitPrism.resetHead': { repoRoot?: string; target?: string };
  // branches
  'gitPrism.branches.show': { repoRoot?: string };
  'gitPrism.branch.new': RefArgs;
  'gitPrism.branch.checkout': RefArgs;
  'gitPrism.tag.new': RefArgs;
  'gitPrism.branch.rename': RefArgs;
  'gitPrism.branch.delete': RefArgs;
  'gitPrism.tag.delete': RefArgs;
  /** the per-branch action list of the Branches popup (Checkout, New Branch from…, Compare with…, Merge…, …) */
  'gitPrism.branch.actions': RefArgs;
  // conflicts (ongoing merge/rebase/cherry-pick/revert)
  'gitPrism.operation.continue': { repoRoot?: string };
  'gitPrism.operation.abort': { repoRoot?: string };
  'gitPrism.operation.skip': { repoRoot?: string };
  // commit tool window
  /** reveals the Commit view; `message` prefills the commit message (e.g. "fixup! …") */
  'gitPrism.commit.focus': { repoRoot?: string; message?: string };
  // stash
  /** Stash Changes dialog; `paths` limits the stash to these repo-relative paths */
  'gitPrism.stash.create': { repoRoot?: string; paths?: string[] };
  'gitPrism.stash.unstash': { repoRoot?: string };
  'gitPrism.patch.create': { repoRoot?: string; paths?: string[] };
  'gitPrism.patch.apply': { repoRoot?: string };
  // core
  'gitPrism.console.show': undefined;
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
