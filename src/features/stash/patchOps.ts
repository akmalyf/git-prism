// Patches: "Create Patch…" (changes tree, To file / To clipboard, Reverse patch), "Copy as Patch to Clipboard",
// "Apply Patch…" / "Apply Patch from Clipboard…" (preview of the files with their status, then plain → 3-way → rejects),
// and applyPatchInteractive() shared with the stash and shelf actions.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { openDialog } from './dialogs';
import * as ops from './gitOps';
import { patchFileName } from './logic';
import { filterPatchBytes, parsePatch, splitPatchBytes, type ParsedPatch } from './patch';
import type { ApplyPatchResult, CreatePatchResult, DialogChange, RepoChoice, ShelfDialogInit } from './protocol';

export type ApplyStatus = 'ok' | 'conflict' | 'failed';

/**
 * Applies `patch` with progress, asking before falling back to rejects, then reports like IntelliJ. After a clean
 * 3-way apply the changes are unstaged again (except `newFiles`), so they show up as ordinary local changes.
 */
export async function applyPatchInteractive(repo: Repository, patch: Buffer, strip: number, title: string, newFiles: string[] = []): Promise<ApplyStatus> {
  if (repo.operationState() === 'rebase' || repo.operationState() === 'am') {
    vscode.window.showErrorMessage(`Cannot Apply Patch Now: ${repo.name} is in the middle of a ${repo.operationState()}.`);
    return 'failed';
  }
  let res: ops.PatchApplyResult;
  try {
    res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Applying patches…' }, () =>
      ops.applyPatch(repo, patch, strip, async () => {
        const pick = await vscode.window.showWarningMessage(
          'Patch Applying Partly Failed',
          { modal: true, detail: 'The patch does not apply cleanly and cannot be merged automatically.\n\nApply the hunks that fit and save the rejected ones next to the files as .rej?' },
          'Apply with Rejects',
        );
        return pick === 'Apply with Rejects';
      }),
    );
  } catch (e) {
    await showGitError(e, `${title} failed`);
    return 'failed';
  }
  const err = (res.stderr || res.stdout).trim();
  switch (res.outcome) {
    case 'ok':
      if (res.threeWay && (await repo.headHash())) {
        const keep = new Set(newFiles);
        await ops.unstagePaths(repo, parsePatch(patch.toString('utf8')).files.map((f) => f.path).filter((p) => !keep.has(p)));
      }
      vscode.window.setStatusBarMessage('$(check) Patch successfully applied', 4000);
      return 'ok';
    case 'conflict':
      void invoke('jbGit.conflicts.resolve', { repoRoot: repo.root });
      vscode.window
        .showWarningMessage(`${title}: Apply patch conflict. Resolve the conflicts to complete applying the patch.`, 'Resolve Conflicts…')
        .then((p) => p && invoke('jbGit.conflicts.resolve', { repoRoot: repo.root }));
      return 'conflict';
    case 'rejected': {
      const rej = res.rejected;
      vscode.window
        .showWarningMessage(
          `Patch Applying Partly Failed: rejected hunks were saved to ${rej.length ? rej.map((p) => `${p}.rej`).join(', ') : '.rej files'}`,
          ...(rej.length ? ['Open .rej'] : []),
        )
        .then((p) => {
          if (p) void vscode.window.showTextDocument(vscode.Uri.file(repo.abs(`${rej[0]}.rej`)));
        });
      return 'failed';
    }
    case 'local-changes':
      await showGitError(new Error(err), `${title} failed: the patch touches files with local (unstaged) changes`);
      return 'failed';
    default:
      if (err) await showGitError(new Error(err), `${title} failed`);
      return 'failed';
  }
}

async function choices(ctx: FeatureContext): Promise<RepoChoice[]> {
  await ctx.repos.ready();
  return ctx.repos.all.map((r) => ({ root: r.root, name: r.name }));
}

/**
 * Local changes of a repository as dialog rows; `paths` (files or folders) preselects, untracked are off by default.
 * `files` leaves out submodules (they cannot be shelved: a patch cannot restore a submodule's checkout).
 */
export async function dialogChanges(repo: Repository, paths?: string[], opts: { files?: boolean } = {}): Promise<DialogChange[]> {
  const entries = (await ops.changedEntries(repo)).filter((e) => !opts.files || !e.submodule);
  const sel = (p: string) => !paths?.length || paths.some((q) => q === '.' || p === q || p.startsWith(`${q}/`));
  return entries.map((e) => ({
    repoRoot: repo.root,
    path: e.path,
    oldPath: e.oldPath,
    kind: e.kind,
    checked: paths?.length ? sel(e.path) : e.kind !== '?',
  }));
}

/** All paths a patch must name for these files (both sides of renames). */
export function patchPaths(changes: { path: string; oldPath?: string }[]): string[] {
  return [...new Set(changes.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path])))];
}

/** Writes or copies the patch and reports like IntelliJ. */
export async function deliverPatch(patch: Buffer, file: string | undefined): Promise<void> {
  if (!patch.toString('latin1').trim()) {
    vscode.window.showWarningMessage('No changes to create a patch from');
    return;
  }
  if (!file) {
    await vscode.env.clipboard.writeText(patch.toString('utf8'));
    vscode.window.showInformationMessage('Patch copied to clipboard');
    return;
  }
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, patch);
  } catch (e) {
    vscode.window.showErrorMessage(`Cannot write patch to specified file: ${file}. ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  vscode.window.showInformationMessage(`Successfully created patch ${path.basename(file)}`, 'Open', 'Reveal').then((p) => {
    if (p === 'Open') void vscode.window.showTextDocument(vscode.Uri.file(file));
    else if (p === 'Reveal') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
  });
}

async function browseSave(current: string, title = 'Save Patch File'): Promise<string | undefined> {
  const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(current), title, filters: { Patch: ['patch', 'diff'], 'All files': ['*'] } });
  return uri?.fsPath;
}

export class PatchActions {
  constructor(private readonly ctx: FeatureContext) {}

  private async repo(root?: string, uri?: vscode.Uri): Promise<Repository | undefined> {
    await this.ctx.repos.ready();
    if (root) return this.ctx.repos.get(root) ?? (await this.ctx.repos.open(root));
    return this.ctx.repos.pick(uri);
  }

  /** "Create Patch…" for local changes (preselected `paths`, all when empty). */
  async create(args: { repoRoot?: string; paths?: string[] }): Promise<void> {
    const repo = await this.repo(args.repoRoot);
    if (!repo) return;
    let changes: DialogChange[];
    try {
      changes = await dialogChanges(repo, args.paths);
    } catch (e) {
      return showGitError(e, 'Patch Creation Failed');
    }
    if (!changes.length) {
      vscode.window.showInformationMessage('No local changes');
      return;
    }
    const init: ShelfDialogInit = {
      mode: 'createPatch',
      title: 'Create Patch',
      repos: await choices(this.ctx),
      changes,
      file: path.join(repo.root, patchFileName('Changes')),
      clipboard: false,
      locale: vscode.env.language,
    };
    const res = await openDialog<CreatePatchResult>(this.ctx, { key: `createPatch:${repo.root}`, bundle: 'shelf', title: 'Create Patch', icon: 'diff', init }, (done) => ({
      browse: (p: { file: string }) => browseSave(p.file),
      ok: (r: CreatePatchResult) => done(r),
    }));
    if (!res || !res.files.length) return;
    try {
      const picked = new Set(res.files.map((f) => f.path));
      const text = await ops.localChangesPatch(repo, patchPaths(changes.filter((c) => picked.has(c.path))), { reverse: res.reverse });
      await deliverPatch(text, res.clipboard ? undefined : res.file);
    } catch (e) {
      showGitError(e, 'Patch Creation Failed');
    }
  }

  /** "Copy as Patch to Clipboard" for files/folders (all local changes when none). */
  async copyToClipboard(repoRoot: string | undefined, paths: string[]): Promise<void> {
    const repo = await this.repo(repoRoot);
    if (!repo) return;
    try {
      const entries = await ops.changedEntries(repo, paths.length ? paths : undefined);
      await deliverPatch(await ops.localChangesPatch(repo, patchPaths(entries)), undefined);
    } catch (e) {
      showGitError(e, 'Patch Creation Failed');
    }
  }

  /** "Apply Patch…": choose a patch file, preview its files, apply the checked ones. */
  async apply(args: { repoRoot?: string; file?: string }): Promise<void> {
    let file = args.file;
    if (!file) {
      const picked = await vscode.window.showOpenDialog({ title: 'Select Patch File', canSelectMany: false, filters: { Patch: ['patch', 'diff'], 'All files': ['*'] } });
      if (!picked?.length) return;
      file = picked[0].fsPath;
    }
    let text: Buffer;
    try {
      text = await fs.promises.readFile(file);
    } catch (e) {
      vscode.window.showErrorMessage(`Cannot read patch ${file}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await this.applyText(args.repoRoot, text, file);
  }

  /** "Apply Patch from Clipboard…" */
  async applyFromClipboard(args: { repoRoot?: string }): Promise<void> {
    const text = await vscode.env.clipboard.readText();
    if (!parsePatch(text).files.length) {
      vscode.window.showWarningMessage('Clipboard content is not a patch');
      return;
    }
    await this.applyText(args.repoRoot, Buffer.from(text, 'utf8'), '');
  }

  private async preview(repo: Repository, bytes: Buffer, parsed: ParsedPatch): Promise<DialogChange[]> {
    const status = await ops.patchFileStatus(repo, splitPatchBytes(bytes), parsed.strip);
    return parsed.files.map((f) => {
      const s = status.get(f.path);
      return {
        repoRoot: repo.root,
        path: f.path,
        oldPath: f.oldPath,
        kind: f.kind,
        checked: s !== 'applied',
        status: s === 'applied' ? 'Already applied' : s === 'fail' ? 'Patch Conflict' : undefined,
      };
    });
  }

  private async applyText(repoRoot: string | undefined, text: Buffer, file: string): Promise<void> {
    let parsed = parsePatch(text.toString('utf8'));
    if (!parsed.files.length) {
      vscode.window.showErrorMessage(file ? `Selected file ${path.basename(file)} is not patch type file` : 'Content is not a patch');
      return;
    }
    const repo = await this.repo(repoRoot, file ? vscode.Uri.file(file) : undefined);
    if (!repo) return;
    let target = repo;
    let changes: DialogChange[];
    try {
      changes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Applying patches…' }, () => this.preview(repo, text, parsed));
    } catch (e) {
      return showGitError(e, 'Apply Patch');
    }
    if (changes.every((c) => c.status === 'Already applied')) {
      vscode.window.showInformationMessage('All changes in the specified patch are already contained in the code');
      return;
    }
    const init: ShelfDialogInit = { mode: 'applyPatch', title: 'Apply Patch', repos: await choices(this.ctx), repoRoot: repo.root, file, changes, locale: vscode.env.language };
    const res = await openDialog<ApplyPatchResult>(this.ctx, { key: 'applyPatch', bundle: 'shelf', title: 'Apply Patch', icon: 'diff', init }, (done) => ({
      browse: async () => {
        const picked = await vscode.window.showOpenDialog({ title: 'Select Patch File', canSelectMany: false, filters: { Patch: ['patch', 'diff'], 'All files': ['*'] } });
        if (!picked?.length) return undefined;
        const f = picked[0].fsPath;
        const t = await fs.promises.readFile(f);
        const p = parsePatch(t.toString('utf8'));
        if (!p.files.length) throw new Error(`Selected file ${path.basename(f)} is not patch type file`);
        text = t;
        parsed = p;
        return { file: f, changes: await this.preview(target, t, p) };
      },
      setRepo: async (p: { repoRoot: string }) => {
        const r = await this.repo(p.repoRoot);
        if (!r) return undefined;
        target = r;
        return { changes: await this.preview(r, text, parsed) };
      },
      ok: (r: ApplyPatchResult) => done(r),
    }));
    if (!res || !res.paths.length) return;
    const chosen = filterPatchBytes(text, res.paths);
    await applyPatchInteractive(target, chosen, parsed.strip, 'Apply Patch', parsed.files.filter((f) => f.kind === 'A' && res.paths.includes(f.path)).map((f) => f.path));
  }
}
