// Data types of the file-level commit actions (Rollback…). No vscode/node imports.
import type { ChangeKind } from '../../core/types';

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
}
