// Messages between the conflicts host (ConflictsPanel) and the "Conflicts" webview.
// Type-only module: imported by both sides, no vscode/node imports.
import type { OperationState } from '../../core/types';

export type SideStatus = 'Modified' | 'Deleted';

export interface ConflictFileInfo {
  repoRoot: string;
  /** repo-relative path */
  path: string;
  yours: SideStatus;
  theirs: SideStatus;
  /** "both modified", "deleted by them", … (tooltip) */
  type: string;
}

/** A piece of the description label ("Merging branch <b>feature</b> into branch <b>main</b>"). */
export interface DescPart {
  text: string;
  bold?: boolean;
  code?: boolean;
}

export interface ConflictsRepo {
  root: string;
  name: string;
  op: OperationState;
}

export interface ConflictsState {
  /** increases with every computed state: the page drops states older than the one it shows */
  seq: number;
  repos: ConflictsRepo[];
  files: ConflictFileInfo[];
  description: DescPart[];
  /** commit message preview shown under the description (monospace) */
  message?: string;
  yoursTitle: string;
  theirsTitle: string;
  /** shown when `files` is empty: what to do next */
  done?: { text: string; action?: { id: 'commit' | 'continue'; label: string } };
  /** an error while loading */
  error?: string;
}

export interface ConflictsInit {
  locale?: string;
}

/** webview → host */
export interface AcceptParams {
  files: { repoRoot: string; path: string }[];
  accept: 'yours' | 'theirs';
}
