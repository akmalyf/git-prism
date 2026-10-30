// Messages between the commitOps host and its webviews (rebase, commitops-message, commitops-smart).
// Type-only module: imported by both sides, no vscode/node imports.
import type { FileChange } from '../../core/types';
import type { RebaseAction } from './todo';

/** commitops-message: Edit Commit Message / Squashed Commit Message */
export interface MessageDialogInit {
  title: string;
  label: string;
  message: string;
  okLabel: string;
  /** shown above the editor (e.g. the commit is already pushed) */
  warning?: string;
}

/** commitops-smart: "Git Checkout Problem" (local changes would be overwritten) */
export interface SmartDialogInit {
  title: string;
  /** first paragraph, second paragraph */
  text: [string, string];
  files: string[];
  smartLabel: string;
  smartTooltip: string;
  forceLabel: string;
  dontLabel: string;
}
export type SmartChoice = 'smart' | 'force' | 'dont';

/** rebase: one commit row (oldest first in `rows`) */
export interface RebaseRow {
  hash: string;
  subject: string;
  /** full message */
  message: string;
  author: string;
  authorEmail: string;
  /** unix seconds */
  authorDate: number;
  committer: string;
  commitDate: number;
}

export interface RebaseInit {
  repoName: string;
  /** branch name or undefined (detached HEAD) */
  branch?: string;
  rows: RebaseRow[];
  /** locale for dates */
  locale?: string;
  /** shown as a warning bar (e.g. merge commits in range will be linearized) */
  notice?: string;
}

export interface RebaseDetails {
  hash: string;
  message: string;
  author: string;
  authorEmail: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  commitDate: number;
  parents: string[];
  files: FileChange[];
}

/** rebase → host `start` */
export interface RebaseStartEntry {
  hash: string;
  action: RebaseAction;
  newMessage?: string;
}
