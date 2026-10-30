// Messages and init payloads shared by the compare feature's host side and its webviews
// (changes, compare-branches, history-selection, repo-at-revision). Type-only, no vscode imports.
import type { Commit, FileChange } from '../../core/types';

/** Two sides of a changes list. `to` undefined = working tree. */
export interface ChangesSource {
  from: string;
  to?: string;
  /** show the changes from `to` towards `from` (the Swap button) */
  swapped?: boolean;
  /** limit to these repo-relative paths */
  paths?: string[];
}

/** RPC of every changes tree (changes panel, compare-branches Files tab and commit changes). */
export interface ChangesRpc {
  /** changes from → to, already inverted when swapped */
  'changes.load': (p: ChangesSource) => FileChange[];
  'changes.diff': (p: ChangesSource & { files: FileChange[]; index: number }) => void;
  'changes.compareWithLocal': (p: ChangesSource & { file: FileChange }) => void;
  /** returns false when cancelled */
  'changes.get': (p: ChangesSource & { files: FileChange[] }) => boolean;
  'changes.history': (p: { path: string }) => void;
  'changes.jumpToSource': (p: { files: FileChange[] }) => void;
}

export interface ChangesInit {
  repoRoot: string;
  source: ChangesSource;
  fromLabel: string;
  /** undefined = working tree */
  toLabel?: string;
}

export interface CompareInit {
  repoRoot: string;
  /** current branch short name, or the short hash when detached */
  current: string;
  /** commit-ish of the current side used in git commands ('HEAD') */
  currentRev: string;
  ref: string;
}

export interface CompareLogData {
  /** in ref, not in current */
  head: Commit[];
  /** in current, not in ref */
  base: Commit[];
}

export interface CommitDetails {
  commit: Commit;
  /** branches containing the commit (short names) */
  branches: string[];
  /** first parent ('' for a root commit → empty tree) */
  parent: string;
}

export interface HistorySelectionInit {
  repoRoot: string;
  path: string;
  start: number;
  end: number;
  language: string;
  /** set when the selection was made in a read-only revision document */
  rev?: string;
}

export interface BlockRevisionView {
  /** '' for the "Local Changes" row */
  hash: string;
  parent?: string;
  author: string;
  authorEmail: string;
  date: number;
  subject: string;
  body: string;
  path: string;
  oldPath?: string;
  before: string;
  after: string;
  local?: boolean;
}

export interface RepoAtRevisionInit {
  repoRoot: string;
  rev: string;
  short: string;
  subject: string;
  author: string;
  date: number;
}

export interface RepoEntryView {
  type: 'blob' | 'tree' | 'commit';
  path: string;
  name: string;
  size?: number;
}
