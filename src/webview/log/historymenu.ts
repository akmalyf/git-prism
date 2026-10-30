// The row context menu and toolbar of a "History: <file>" tab (pure): IntelliJ Vcs.FileHistory.ContextMenu with
// Dvcs.FileHistory.ContextMenu (Cherry-Pick) and Git.FileHistory.ContextMenu merged in as the plugin.xml files do,
// and Vcs.FileHistory.Toolbar. Commit-level enablement is shared with the log menu (buildCommitMenu).
import type { HistoryAction, HistoryFileInfo } from '../../features/log/protocol';
import { buildCommitMenu, type CommitAction, type CommitMenuAction, type MenuCommit, type MenuRoot } from './commitmenu';

export type FileHistoryAction = HistoryAction | Extract<CommitAction, 'copyHash' | 'createPatch' | 'cherryPick' | 'revert' | 'fixup' | 'squashInto' | 'newTag'>;

export interface FileHistoryMenuAction {
  id: FileHistoryAction;
  label: string;
  disabled: boolean;
  reason?: string;
  shortcut?: string;
}

export type FileHistoryMenuEntry = '-' | FileHistoryMenuAction;

/** Labels (VcsBundle / VcsLogBundle / DiffBundle). "Show in VCS Log" is "Show in {0} Log" with the VCS name. */
const LABELS: Record<HistoryAction, string> = {
  showDiff: 'Show Diff',
  showDiffNewTab: 'Show Diff in a New Tab',
  compareWithLocal: 'Compare with Local',
  openFile: 'Show File at Revision',
  annotate: 'Annotate',
  get: 'Get',
  showAllAffected: 'Show All Affected Files',
  selectInLog: 'Show in Git Log',
};

const SHORTCUTS: Partial<Record<HistoryAction, string>> = {
  showDiff: 'CmdOrCtrl+D',
};

/**
 * `info` describes the history file in the single selected commit (undefined while loading / several rows):
 * file-only actions need it.
 */
export function buildFileHistoryMenu(sel: readonly MenuCommit[], roots: readonly MenuRoot[], info?: HistoryFileInfo): FileHistoryMenuEntry[] {
  const n = sel.length;
  const one = n === 1;
  const sameRoot = n > 0 && sel.every((c) => c.root === sel[0].root);
  const log = buildCommitMenu(sel, roots);
  const fromLog = (id: FileHistoryMenuAction['id']): FileHistoryMenuAction => {
    const a = log.find((e): e is CommitMenuAction => typeof e === 'object' && 'id' in e && e.id === id);
    const out: FileHistoryMenuAction = { id, label: a?.label ?? id, disabled: a?.disabled ?? true };
    if (a?.reason) out.reason = a.reason;
    if (a?.shortcut) out.shortcut = a.shortcut;
    return out;
  };
  const act = (id: HistoryAction, enabled: boolean, label = LABELS[id]): FileHistoryMenuAction => {
    const a: FileHistoryMenuAction = { id, label, disabled: !enabled };
    if (SHORTCUTS[id]) a.shortcut = SHORTCUTS[id];
    return a;
  };
  const file = one && !!info && !info.dir;
  const exists = file && !info!.deleted && !!info!.path;
  const two = n === 2 && sameRoot;
  return [
    fromLog('copyHash'),
    fromLog('createPatch'),
    fromLog('cherryPick'),
    '-',
    act('get', file),
    act('openFile', exists),
    act('compareWithLocal', one),
    // Diff.ShowDiff: CompareRevisionsFromFileHistoryActionProvider → "Compare" for two revisions
    act('showDiff', one || two, two ? 'Compare' : LABELS.showDiff),
    act('showDiffNewTab', one || two),
    act('showAllAffected', one),
    act('annotate', exists),
    act('selectInLog', one),
    '-',
    fromLog('revert'),
    fromLog('fixup'),
    fromLog('squashInto'),
    '-',
    fromLog('newTag'),
  ];
}

export interface FileHistoryToolbarState {
  showDiff: { enabled: boolean; label: string };
  showAllAffected: boolean;
  selectInLog: boolean;
}

/** Vcs.FileHistory.Toolbar (Refresh, Show Diff, Show All Affected Files | View Options) + right corner (Show in Git Log). */
export function fileHistoryToolbar(sel: readonly MenuCommit[]): FileHistoryToolbarState {
  const one = sel.length === 1;
  const two = sel.length === 2 && sel[0].root === sel[1].root;
  return {
    showDiff: { enabled: one || two, label: two ? 'Compare' : LABELS.showDiff },
    showAllAffected: one,
    selectInLog: one,
  };
}
