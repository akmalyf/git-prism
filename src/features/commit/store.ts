// Persistence of the Commit tool window in workspaceState: changelists + inclusion, view settings, commit options,
// the commit message history, the staging area draft and the changed lines excluded from the commit (partial commit). The staging area mode itself is a setting.
import * as vscode from 'vscode';
import { ChangelistModel, type ChangelistData } from './changelists';
import { pushHistory } from './logic';
import type { CommitOptions, ViewSettings } from './protocol';

const K = {
  lists: 'jbGit.commit.changelists',
  settings: 'jbGit.commit.settings',
  options: 'jbGit.commit.options',
  history: 'jbGit.commit.messageHistory',
  stagingDraft: 'jbGit.commit.stagingDraft',
  excludedLines: 'jbGit.commit.excludedLines',
};

const DEFAULT_SETTINGS: Omit<ViewSettings, 'stagingArea'> = {
  groupByDirectory: true,
  groupByModule: false,
  groupByRepository: true,
  showIgnored: false,
  doubleClick: 'diff',
  previewDiff: false,
  commitAll: true,
};

const DEFAULT_OPTIONS: CommitOptions = { author: '', signOff: false, gpgSign: false, runHooks: true };

export class CommitStore {
  readonly model: ChangelistModel;

  constructor(private readonly state: vscode.Memento) {
    this.model = new ChangelistModel(state.get<ChangelistData>(K.lists));
  }

  saveLists(): Thenable<void> {
    return this.state.update(K.lists, this.model.toJSON());
  }

  get settings(): ViewSettings {
    const s = { ...DEFAULT_SETTINGS, ...this.state.get<Partial<ViewSettings>>(K.settings, {}) };
    const stagingArea = vscode.workspace.getConfiguration('jbGit.commit').get<boolean>('useStagingArea', false);
    return { ...s, stagingArea };
  }

  async setSetting<K extends keyof ViewSettings>(key: K, value: ViewSettings[K]): Promise<void> {
    if (key === 'stagingArea') {
      const cfg = vscode.workspace.getConfiguration('jbGit.commit');
      const inspect = cfg.inspect<boolean>('useStagingArea');
      const target = inspect?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await cfg.update('useStagingArea', value, target);
      return;
    }
    const { stagingArea: _s, ...cur } = this.settings;
    await this.state.update(K.settings, { ...cur, [key]: value });
  }

  get options(): CommitOptions {
    return { ...DEFAULT_OPTIONS, ...this.state.get<Partial<CommitOptions>>(K.options, {}) };
  }

  setOptions(o: CommitOptions): Thenable<void> {
    return this.state.update(K.options, o);
  }

  get history(): string[] {
    return this.state.get<string[]>(K.history, []);
  }

  addHistory(message: string): Thenable<void> {
    return this.state.update(K.history, pushHistory(this.history, message));
  }

  get stagingDraft(): string {
    return this.state.get<string>(K.stagingDraft, '');
  }

  setStagingDraft(text: string): Thenable<void> {
    return this.state.update(K.stagingDraft, text);
  }

  /** Partial commit: fileKey → line keys (see partial.ts) excluded from the commit. */
  get excludedLines(): Record<string, string[]> {
    return this.state.get<Record<string, string[]>>(K.excludedLines, {});
  }

  excludedOf(fileKey: string): Set<string> {
    return new Set(this.excludedLines[fileKey] ?? []);
  }

  /** Stores the excluded lines of files; an empty list clears the file's entry. */
  setExcludedLines(entries: Record<string, readonly string[]>): Thenable<void> {
    const all = { ...this.excludedLines };
    for (const [k, v] of Object.entries(entries)) {
      if (v.length) all[k] = [...new Set(v)];
      else delete all[k];
    }
    return this.state.update(K.excludedLines, all);
  }

  clearExcludedLines(fileKeys: Iterable<string>): Thenable<void> | undefined {
    const cur = this.excludedLines;
    const del = [...fileKeys].filter((k) => k in cur);
    if (!del.length) return undefined;
    return this.setExcludedLines(Object.fromEntries(del.map((k) => [k, []])));
  }
}
