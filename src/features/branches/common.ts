// Shared plumbing of the branches feature: repository resolution, progress, conflict notifications,
// favorites storage, popup settings and a validated input box.
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import { GitError, showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import type { Ref } from '../../core/types';
import { classifyRef, type ClassifiedRef, isFavorite, toggleFavorite } from './logic';

export type Ctx = FeatureContext;

/** Command arguments: a contract object ({ repoRoot, ref }) or, from explorer/editor menus, a resource Uri. */
export interface CmdArgs {
  repoRoot?: string;
  ref?: string;
  uri?: vscode.Uri;
}

export function cmdArgs(a: unknown): CmdArgs {
  if (a instanceof vscode.Uri) return { uri: a };
  if (a && typeof a === 'object') {
    const o = a as Record<string, unknown>;
    return {
      repoRoot: typeof o.repoRoot === 'string' ? o.repoRoot : undefined,
      ref: typeof o.ref === 'string' && o.ref ? o.ref : undefined,
      uri: o.resourceUri instanceof vscode.Uri ? o.resourceUri : undefined,
    };
  }
  return {};
}

/** The repository of `repoRoot` (or `uri`), else the active/only/picked one. */
export async function resolveRepo(ctx: Ctx, repoRoot?: string, uri?: vscode.Uri): Promise<Repository | undefined> {
  await ctx.repos.ready();
  if (repoRoot) {
    const r = ctx.repos.get(repoRoot) ?? (await ctx.repos.open(repoRoot));
    if (r) return r;
  }
  return ctx.repos.pick(uri);
}

/** Snapshot of what branch actions need to know about a repository. */
export interface RepoState {
  repo: Repository;
  refs: Ref[];
  /** current branch (also for an unborn branch in an empty repository); undefined when detached */
  current?: string;
  /** HEAD commit; undefined in an empty repository */
  head?: string;
  remotes: string[];
}

export async function loadState(repo: Repository): Promise<RepoState> {
  const [refs, current, head, remotes] = await Promise.all([repo.refs(), repo.currentBranch(), repo.headHash(), repo.remotes()]);
  return { repo, refs, current, head, remotes: remotes.map((r) => r.name) };
}

export function classify(state: RepoState, ref: string): ClassifiedRef {
  return classifyRef(ref, state.refs);
}

/** "'main'" or the short hash when detached. */
export function currentLabel(state: RepoState): string {
  return state.current ?? (state.head ? state.head.slice(0, 8) : 'HEAD');
}

export function q(name: string): string {
  return `'${name}'`;
}

export function locals(state: RepoState): string[] {
  return state.refs.filter((r) => r.type === 'head').map((r) => r.short);
}

export function remoteBranches(state: RepoState): string[] {
  return state.refs.filter((r) => r.type === 'remote').map((r) => r.short);
}

export function withProgress<T>(title: string, task: (token: vscode.CancellationToken) => Promise<T>, cancellable = false): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable }, (_p, token) => task(token));
}

export function gitMessage(e: unknown): string {
  return e instanceof GitError ? e.stderr || e.stdout || e.message : e instanceof Error ? e.message : String(e);
}

/** Whether the repository is left in a conflicted state (ongoing merge/rebase or unmerged files). */
export async function hasConflicts(repo: Repository): Promise<boolean> {
  const r = await repo.run(['diff', '--name-only', '--diff-filter=U'], { quiet: true, allowFail: true });
  return !!r.stdout.trim() || ['merge', 'rebase', 'cherry-pick', 'revert', 'am'].includes(repo.operationState());
}

/** After a failing merge-like operation: offers "Resolve Conflicts…" when conflicts remain, else shows the error. */
export async function reportOperationFailure(repo: Repository, e: unknown, title: string): Promise<void> {
  if (await hasConflicts(repo)) {
    const pick = await vscode.window.showWarningMessage(`${title}: there are conflicts to resolve.`, 'Resolve Conflicts…');
    if (pick) invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
    return;
  }
  await showGitError(e, title);
}

/** Notifies about unmerged files blocking an operation ("Cannot checkout because of unmerged files"). */
export async function blockedByUnmerged(repo: Repository, operation: string): Promise<boolean> {
  const r = await repo.run(['diff', '--name-only', '--diff-filter=U'], { quiet: true, allowFail: true });
  if (!r.stdout.trim()) return false;
  const pick = await vscode.window.showErrorMessage(
    `Cannot ${operation} because of unmerged files. You need to resolve all merge conflicts before ${operation}.`,
    'Resolve conflicts…',
  );
  if (pick) invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
  return true;
}

// ---- favorites (per repository, workspace state) ----

interface FavMarks {
  add: string[];
  remove: string[];
}

function favKey(repo: Repository): string {
  return `jbGit.branches.favorites:${repo.commonDir}`;
}

export function favorites(ctx: Ctx, repo: Repository): FavMarks {
  return ctx.extension.workspaceState.get<FavMarks>(favKey(repo)) ?? { add: [], remove: [] };
}

export function isFav(ctx: Ctx, repo: Repository, fullName: string): boolean {
  return isFavorite(fullName, favorites(ctx, repo));
}

export async function toggleFav(ctx: Ctx, repo: Repository, fullName: string): Promise<void> {
  await ctx.extension.workspaceState.update(favKey(repo), toggleFavorite(fullName, favorites(ctx, repo)));
}

// ---- popup settings ----

export type PopupSetting = 'showTags' | 'showRecent' | 'groupByDirectory' | 'groupByRepository' | 'showOnlyFavorites';

const DEFAULTS: Record<PopupSetting, boolean> = {
  showTags: true,
  showRecent: true,
  groupByDirectory: true,
  groupByRepository: false,
  showOnlyFavorites: false,
};

export function setting(name: PopupSetting): boolean {
  return vscode.workspace.getConfiguration('jbGit.branches').get<boolean>(name, DEFAULTS[name]);
}

export async function toggleSetting(name: PopupSetting): Promise<void> {
  await vscode.workspace.getConfiguration('jbGit.branches').update(name, !setting(name), vscode.ConfigurationTarget.Global);
}

// ---- input box with toggle buttons ----

export interface Toggle {
  id: string;
  label: string;
  value: boolean;
  /** codicon of the toggle button */
  icon?: string;
  /** hidden toggles (e.g. "Overwrite existing branch" until the name exists) */
  visible?: (value: string) => boolean;
}

export interface InputOptions {
  title: string;
  prompt?: string;
  value?: string;
  placeholder?: string;
  toggles?: Toggle[];
  /** returns an error message (blocks accept), a warning ({ warning }) or undefined */
  validate?: (value: string, toggles: Record<string, boolean>) => Promise<string | { warning: string } | undefined> | string | { warning: string } | undefined;
  back?: boolean;
}

export type InputResult = { value: string; toggles: Record<string, boolean> } | 'back' | undefined;

/** An InputBox with live validation and checkbox-like toggle buttons (IntelliJ dialog checkboxes). */
export function inputBox(o: InputOptions): Promise<InputResult> {
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = o.title;
    box.value = o.value ?? '';
    box.placeholder = o.placeholder;
    box.ignoreFocusOut = true;
    const toggles = o.toggles ?? [];
    const values = (): Record<string, boolean> => Object.fromEntries(toggles.map((t) => [t.id, t.value]));
    let error = false;
    let seq = 0;
    const render = async () => {
      const visible = toggles.filter((t) => !t.visible || t.visible(box.value));
      const buttons: vscode.QuickInputButton[] = visible.map((t) => ({
        iconPath: new vscode.ThemeIcon(t.icon ?? (t.value ? 'pass-filled' : 'circle-large-outline')),
        tooltip: t.label,
        toggle: { checked: t.value },
        location: vscode.QuickInputButtonLocation.Inline,
      }));
      box.buttons = o.back ? [vscode.QuickInputButtons.Back, ...buttons] : buttons;
      const state = visible.map((t) => `${t.value ? '☑' : '☐'} ${t.label}`).join('    ');
      box.prompt = [o.prompt, state].filter(Boolean).join('  —  ');
      const mine = ++seq;
      const res = o.validate ? await o.validate(box.value.trim(), values()) : undefined;
      if (mine !== seq) return;
      if (typeof res === 'string') {
        error = true;
        box.validationMessage = { message: res, severity: vscode.InputBoxValidationSeverity.Error };
      } else {
        error = false;
        box.validationMessage = res ? { message: res.warning, severity: vscode.InputBoxValidationSeverity.Warning } : undefined;
      }
    };
    let done = false;
    const finish = (r: InputResult) => {
      if (done) return;
      done = true;
      resolve(r);
      box.dispose();
    };
    box.onDidChangeValue(() => render());
    box.onDidTriggerButton((b) => {
      if (b === vscode.QuickInputButtons.Back) return finish('back');
      const visible = toggles.filter((t) => !t.visible || t.visible(box.value));
      const t = visible[box.buttons.indexOf(b) - (o.back ? 1 : 0)];
      if (t) {
        t.value = !t.value;
        render();
      }
    });
    box.onDidAccept(async () => {
      await render();
      if (error) return;
      finish({ value: box.value.trim(), toggles: values() });
    });
    box.onDidHide(() => finish(undefined));
    render();
    box.show();
  });
}

/** A modal confirmation; resolves with the chosen button label. */
export async function confirm(message: string, detail: string | undefined, ...buttons: string[]): Promise<string | undefined> {
  return vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons);
}

export function fmtDate(sec?: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
