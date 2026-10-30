// gitPrism.log.* settings: reading them with defaults and writing a single key (View Options toggles in the log).
import * as vscode from 'vscode';
import type { LogColumn, LogSettingKey, LogSettings } from './protocol';

export const DEFAULT_SETTINGS: LogSettings = {
  sortType: 'date',
  firstParent: false,
  showLongEdges: false,
  columns: ['author', 'subject', 'date'],
  preferCommitDate: false,
  dateFormat: '',
  prettyDates: true,
  highlightMyCommits: true,
  highlightMergeCommits: true,
  highlightCurrentBranch: true,
  showTagNames: true,
  compactReferences: false,
  referencesOnLeft: false,
  showDetails: true,
  showDiffPreview: false,
  diffPreviewLocation: 'right',
  showBranches: true,
};

const COLUMNS: LogColumn[] = ['author', 'subject', 'date', 'hash', 'root'];

export function readSettings(): LogSettings {
  const c = vscode.workspace.getConfiguration('gitPrism.log');
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as LogSettingKey[]) {
    const v = c.get(key);
    if (v !== undefined && typeof v === typeof DEFAULT_SETTINGS[key]) out[key] = v;
  }
  const s = out as unknown as LogSettings;
  if (s.sortType !== 'topological' && s.sortType !== 'date') s.sortType = DEFAULT_SETTINGS.sortType;
  if (s.diffPreviewLocation !== 'right' && s.diffPreviewLocation !== 'bottom') s.diffPreviewLocation = 'right';
  s.columns = Array.isArray(s.columns) ? [...new Set(s.columns.filter((x) => COLUMNS.includes(x)))] : [...DEFAULT_SETTINGS.columns];
  if (!s.columns.includes('subject')) s.columns.unshift('subject');
  return s;
}

export async function writeSetting(key: LogSettingKey, value: unknown): Promise<void> {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`unknown setting ${key}`);
  await vscode.workspace.getConfiguration('gitPrism.log').update(key, value, vscode.ConfigurationTarget.Global);
}

/** Settings whose change requires reloading the commit list (git ordering / parents). */
export const RELOAD_KEYS: LogSettingKey[] = ['sortType', 'firstParent'];
