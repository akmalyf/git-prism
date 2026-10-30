// Messages between the diff/merge panels (extension host) and their webviews (src/webview/diff, src/webview/merge).
// Type-only module: no imports, safe for both sides.

/** One file of the diff window's file list. */
export interface DiffFileInfo {
  path: string;
  oldPath?: string;
  /** git status letter (A, M, D, R, C, T, U, ?) for the status color */
  kind?: string;
}

export interface DiffInit {
  files: DiffFileInfo[];
  index: number;
  /** right-side line (0-based) to put the caret on in the first shown file (Show Diff for Lines); default: first change */
  line?: number;
  /** viewer settings shared by every diff window (mode, ignore/highlight policy, whitespaces, ...) */
  settings?: DiffViewSettings;
}

/** Diff viewer settings remembered globally, like IntelliJ's TextDiffSettings. */
export interface DiffViewSettings {
  viewer?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
}

export interface DiffSide {
  exists: boolean;
  /** revision label ("a1b2c3d4", "Current version", ...) */
  title: string;
  /** repo-relative path shown next to the revision label */
  path?: string;
  /** text contents, '\n' line endings (type 'text') */
  text?: string;
  /** data: URI (type 'image') */
  image?: string;
  /** byte size (binary/image placeholders) */
  size?: number;
  /** the right side is the working tree file and can be edited/saved */
  editable?: boolean;
}

export interface DiffPayload {
  index: number;
  path: string;
  language: string;
  type: 'text' | 'binary' | 'image' | 'tooLarge' | 'error';
  left: DiffSide;
  right: DiffSide;
  /** binary: contents identical */
  identical?: boolean;
  /** placeholder / error text */
  message?: string;
  /** replaces ide-diff's "Contents are identical" notice (differences only in line separators / encoding) */
  notice?: string;
  /** a working tree file exists to jump to */
  canJump: boolean;
}

export interface MergeInit {
  path: string;
  language: string;
  left: string;
  base: string;
  right: string;
  leftTitle: string;
  rightTitle: string;
  /** the base stage is missing (add/add conflict) */
  noBase: boolean;
}

export interface MergeStatusMsg {
  changes: number;
  conflicts: number;
}
