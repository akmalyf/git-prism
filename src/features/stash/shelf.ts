// Shelf (IntelliJ shelve implemented with patches): every shelf lives in <commonDir>/jb-shelf/<id>/ as
// shelved.patch + meta.json. Shelve Changes… / Shelve Silently / Save To Shelf, Unshelve… / Unshelve Silently,
// Delete (Recently Deleted + undo), Rename…, Restore, Create Patch / Copy as Patch, Show Diff, Import Patches….
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { invoke, type ContentRef, type DiffFile } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { openDialog } from './dialogs';
import * as ops from './gitOps';
import { firstLine, newShelfId, patchFileName, uniqueName } from './logic';
import { applyHunks, filterPatchBytes, parsePatch, type PatchFile } from './patch';
import { applyPatchInteractive, deliverPatch, dialogChanges, patchPaths } from './patchOps';
import type { DialogChange, RepoChoice, ShelfDialogInit, ShelfFile, ShelfInfo, ShelveResult, UnshelveResult } from './protocol';

const PATCH = 'shelved.patch';
const META = 'meta.json';

interface ShelfMeta {
  version: 1;
  name: string;
  /** unix seconds */
  date: number;
  repoRoot: string;
  branch?: string;
  baseCommit?: string;
  files: ShelfFile[];
  applied?: boolean;
  deleted?: boolean;
  /** git apply -p */
  strip?: number;
}

export interface Shelf extends ShelfMeta {
  id: string;
  dir: string;
}

const toFiles = (files: PatchFile[]): ShelfFile[] => files.map((f) => ({ path: f.path, oldPath: f.oldPath, kind: f.kind, binary: f.binary || undefined }));

export class ShelfStore implements vscode.Disposable {
  private shelves: Shelf[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChange];
  private loading: Promise<void> | undefined;

  constructor(private readonly ctx: FeatureContext) {
    this.disposables.push(ctx.repos.onDidChangeRepositories(() => void this.load()));
    void this.load();
  }

  get all(): Shelf[] {
    return this.shelves;
  }

  get(id: string): Shelf | undefined {
    return this.shelves.find((s) => s.id === id);
  }

  /** shelf directories of the open repositories (one per common git dir) */
  private roots(): string[] {
    return [...new Set(this.ctx.repos.all.map((r) => path.join(r.commonDir, 'jb-shelf')))];
  }

  rootFor(repo: Repository): string {
    return path.join(repo.commonDir, 'jb-shelf');
  }

  load(): Promise<void> {
    return (this.loading = (async () => {
      await this.ctx.repos.ready();
      const out: Shelf[] = [];
      for (const root of this.roots()) {
        let ids: string[] = [];
        try {
          ids = (await fs.promises.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch {
          continue;
        }
        for (const id of ids) {
          const dir = path.join(root, id);
          try {
            const meta = JSON.parse(await fs.promises.readFile(path.join(dir, META), 'utf8')) as ShelfMeta;
            out.push({ ...meta, id, dir });
          } catch {
            /* not a shelf */
          }
        }
      }
      out.sort((a, b) => b.date - a.date || (a.id < b.id ? 1 : -1));
      this.shelves = out;
      void vscode.commands.executeCommand('setContext', 'jbGit.hasShelves', out.some((s) => !s.deleted));
      this._onDidChange.fire();
    })());
  }

  async ready(): Promise<void> {
    await this.loading;
  }

  async create(repo: Repository, name: string, patch: Buffer, extra: { baseCommit?: string; branch?: string; strip?: number; date?: number } = {}): Promise<Shelf> {
    const parsed = parsePatch(patch.toString('utf8'));
    const id = newShelfId();
    const dir = path.join(this.rootFor(repo), id);
    await fs.promises.mkdir(dir, { recursive: true });
    const meta: ShelfMeta = {
      version: 1,
      name: uniqueName(name, this.shelves.filter((s) => !s.deleted).map((s) => s.name)),
      date: extra.date ?? Math.floor(Date.now() / 1000),
      repoRoot: repo.root,
      branch: extra.branch,
      baseCommit: extra.baseCommit,
      files: toFiles(parsed.files),
      strip: extra.strip ?? parsed.strip,
    };
    await fs.promises.writeFile(path.join(dir, PATCH), patch);
    await fs.promises.writeFile(path.join(dir, META), JSON.stringify(meta, null, 2));
    await this.load();
    return { ...meta, id, dir };
  }

  async update(id: string, change: Partial<ShelfMeta>, patch?: Buffer): Promise<void> {
    const s = this.get(id);
    if (!s) throw new Error(`Shelved changeList ${id} not found`);
    const meta: ShelfMeta = { version: 1, name: s.name, date: s.date, repoRoot: s.repoRoot, branch: s.branch, baseCommit: s.baseCommit, files: s.files, applied: s.applied, deleted: s.deleted, strip: s.strip, ...change };
    if (patch !== undefined) {
      await fs.promises.writeFile(path.join(s.dir, PATCH), patch);
      meta.files = toFiles(parsePatch(patch.toString('utf8')).files);
    }
    await fs.promises.writeFile(path.join(s.dir, META), JSON.stringify(meta, null, 2));
    await this.load();
  }

  async remove(id: string): Promise<void> {
    const s = this.get(id);
    if (!s) return;
    await fs.promises.rm(s.dir, { recursive: true, force: true });
    await this.load();
  }

  /** The shelved patch as stored (exact bytes: files in other encodings than UTF-8 must still apply). */
  async patch(id: string): Promise<Buffer> {
    const s = this.get(id);
    if (!s) throw new Error(`Shelved changeList ${id} not found`);
    return fs.promises.readFile(path.join(s.dir, PATCH));
  }

  info(s: Shelf): ShelfInfo {
    return {
      id: s.id,
      name: s.name,
      date: s.date,
      repoRoot: s.repoRoot,
      repoName: path.basename(s.repoRoot),
      branch: s.branch,
      baseCommit: s.baseCommit,
      files: s.files,
      applied: !!s.applied,
      deleted: !!s.deleted,
    };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export class ShelfActions {
  constructor(
    private readonly ctx: FeatureContext,
    private readonly store: ShelfStore,
  ) {}

  /** The repository a shelf belongs to: its recorded root, else any open repository sharing the shelf's git dir. */
  repoOf(s: Shelf): Repository | undefined {
    return this.ctx.repos.get(s.repoRoot) ?? this.ctx.repos.all.find((r) => s.dir.startsWith(this.store.rootFor(r) + path.sep));
  }

  private async choices(): Promise<RepoChoice[]> {
    await this.ctx.repos.ready();
    return this.ctx.repos.all.map((r) => ({ root: r.root, name: r.name }));
  }

  private async revealView(): Promise<void> {
    await this.store.ready();
    setTimeout(() => void vscode.commands.executeCommand('jbGit.shelfView.focus'), 50);
  }

  // ------------------------------------------------------------ shelve

  private async shelveRepo(repo: Repository, name: string, files: { path: string }[], keep: boolean): Promise<boolean> {
    const picked = new Set(files.map((f) => f.path));
    const chosen = (await ops.changedEntries(repo)).filter((e) => picked.has(e.path) && !e.submodule);
    if (!chosen.length) return false;
    const patch = await ops.localChangesPatch(repo, patchPaths(chosen));
    if (!patch.toString('latin1').trim()) throw new Error('The selected changes affect only directories and no files, so they cannot be shelved');
    await this.store.create(repo, name, patch, { baseCommit: await repo.headHash(), branch: await repo.currentBranch() });
    if (keep) return true;
    // never drop local changes the shelf could not restore: the patch must reverse-apply to the working tree
    if (!(await ops.patchMatchesWorkingTree(repo, patch))) {
      vscode.window.showWarningMessage(`Changes were shelved to '${name}' but kept in the working tree: the shelved patch does not reproduce them exactly.`);
      return true;
    }
    await ops.removeLocalChanges(repo, chosen);
    return true;
  }

  /** "Shelve Changes…" (and "Save To Shelf" with keep = true): commit-like dialog with the changes and a message. */
  async shelve(args: { repoRoot?: string; paths?: string[] }, keep = false): Promise<void> {
    await this.ctx.repos.ready();
    const repos = args.repoRoot ? [this.ctx.repos.get(args.repoRoot) ?? (await this.ctx.repos.open(args.repoRoot))].filter((r): r is Repository => !!r) : this.ctx.repos.all;
    if (!repos.length) {
      vscode.window.showWarningMessage('No Git repository found in the workspace.');
      return;
    }
    let changes: DialogChange[] = [];
    try {
      for (const r of repos) changes.push(...(await dialogChanges(r, args.paths, { files: true })));
    } catch (e) {
      return showGitError(e, 'Shelving Failed');
    }
    if (!changes.length) {
      vscode.window.showInformationMessage('No local changes to shelve');
      return;
    }
    if (args.paths?.length) changes = changes.sort((a, b) => Number(b.checked) - Number(a.checked));
    const title = keep ? 'Save To Shelf' : 'Shelve Changes';
    const init: ShelfDialogInit = { mode: 'shelve', title, okLabel: keep ? 'Save To Shelf' : 'Shelve Changes', repos: await this.choices(), changes, message: '', keep, locale: vscode.env.language };
    const res = await openDialog<ShelveResult>(this.ctx, { key: 'shelve', bundle: 'shelf', title, icon: 'archive', init }, (done) => ({
      ok: (r: ShelveResult) => done(r),
    }));
    if (!res || !res.files.length) return;
    const name = firstLine(res.message) || 'Changes';
    await this.runShelve(name, res.files, res.keep);
  }

  private async runShelve(name: string, files: { repoRoot: string; path: string }[], keep: boolean): Promise<void> {
    let any = false;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Shelving changes…' }, async () => {
      for (const root of new Set(files.map((f) => f.repoRoot))) {
        const repo = this.ctx.repos.get(root);
        if (!repo) continue;
        try {
          if (await this.shelveRepo(repo, name, files.filter((f) => f.repoRoot === root), keep)) any = true;
        } catch (e) {
          await showGitError(e, `Shelving changes for changelist [${name}] failed`);
        }
      }
    });
    if (any) {
      vscode.window.setStatusBarMessage('$(archive) Changes shelved successfully', 4000);
      await this.revealView();
    }
  }

  /** "Shelve Silently": all local tracked changes (untracked excluded, like IntelliJ's default changelist). */
  async shelveSilently(args: { repoRoot?: string; paths?: string[] } = {}): Promise<void> {
    await this.ctx.repos.ready();
    const repos = args.repoRoot ? [this.ctx.repos.get(args.repoRoot)].filter((r): r is Repository => !!r) : this.ctx.repos.all;
    const files: { repoRoot: string; path: string }[] = [];
    for (const r of repos) {
      for (const c of await dialogChanges(r, args.paths, { files: true }).catch(() => [])) if (c.checked) files.push({ repoRoot: r.root, path: c.path });
    }
    if (!files.length) {
      vscode.window.showInformationMessage('No local changes to shelve');
      return;
    }
    await this.runShelve('Changes', files, false);
  }

  // ------------------------------------------------------------ unshelve

  async pickShelf(placeHolder: string): Promise<Shelf | undefined> {
    await this.store.ready();
    const list = this.store.all.filter((s) => !s.applied && !s.deleted);
    if (!list.length) {
      vscode.window.showInformationMessage('No shelved changes');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      list.map((s) => ({ label: s.name, description: `${path.basename(s.repoRoot)} · ${new Date(s.date * 1000).toLocaleString(vscode.env.language)}`, detail: `${s.files.length} file(s)`, s })),
      { placeHolder },
    );
    return pick?.s;
  }

  /** "Unshelve…": choose the files, "Remove successfully applied files from the shelf". */
  async unshelve(id: string | undefined, paths?: string[]): Promise<void> {
    const s = id ? this.store.get(id) : await this.pickShelf('Select a shelved changelist to unshelve');
    if (!s) return;
    const changes: DialogChange[] = s.files.map((f) => ({ repoRoot: s.repoRoot, path: f.path, oldPath: f.oldPath, kind: f.kind, checked: !paths?.length || paths.includes(f.path) }));
    const init: ShelfDialogInit = { mode: 'unshelve', title: 'Unshelve Changes', name: s.name, changes, removeApplied: true, locale: vscode.env.language };
    const res = await openDialog<UnshelveResult>(this.ctx, { key: `unshelve:${s.id}`, bundle: 'shelf', title: 'Unshelve Changes', icon: 'archive', init }, (done) => ({
      ok: (r: UnshelveResult) => done(r),
    }));
    if (!res || !res.paths.length) return;
    await this.applyShelf(s, res.paths, res.removeApplied);
  }

  /** "Unshelve Silently": every file of the shelves, removing them from the shelf. */
  async unshelveSilently(ids: string[], paths?: string[]): Promise<void> {
    if (!ids.length) {
      const s = await this.pickShelf('Select a shelved changelist to unshelve');
      if (s) ids = [s.id];
    }
    for (const id of ids) {
      const s = this.store.get(id);
      if (s) await this.applyShelf(s, paths?.length ? paths : s.files.map((f) => f.path), true);
    }
  }

  private async applyShelf(s: Shelf, paths: string[], removeApplied: boolean): Promise<void> {
    const repo = this.repoOf(s);
    if (!repo) {
      vscode.window.showErrorMessage(`Repository ${s.repoRoot} of shelf '${s.name}' is not open`);
      return;
    }
    try {
      const bytes = await this.store.patch(s.id);
      const parsed = parsePatch(bytes.toString('utf8'));
      const wanted = new Set(paths);
      const chosen = filterPatchBytes(bytes, wanted);
      if (!chosen.length) return;
      const status = await applyPatchInteractive(
        repo,
        chosen,
        s.strip ?? parsed.strip,
        'Unshelve Changes',
        parsed.files.filter((f) => f.kind === 'A' && wanted.has(f.path)).map((f) => f.path),
      );
      if (status === 'failed' || !removeApplied) return;
      const rest = parsed.files.filter((f) => !wanted.has(f.path)).map((f) => f.path);
      if (!rest.length) await this.store.update(s.id, { applied: true });
      else {
        // the applied part becomes an applied (recycled) shelf, the rest stays on the shelf
        const done = await this.store.create(repo, s.name, chosen, { baseCommit: s.baseCommit, branch: s.branch, strip: s.strip, date: s.date });
        await this.store.update(done.id, { applied: true, name: s.name });
        await this.store.update(s.id, {}, filterPatchBytes(bytes, rest));
      }
    } catch (e) {
      showGitError(e, 'Unshelve Changes');
    }
  }

  // ------------------------------------------------------------ manage

  async delete(ids: string[]): Promise<void> {
    const list = ids.map((id) => this.store.get(id)).filter((s): s is Shelf => !!s);
    if (!list.length) return;
    const permanent = list.filter((s) => s.deleted);
    const recycle = list.filter((s) => !s.deleted);
    if (permanent.length) {
      const what = permanent.length === 1 ? `the '${permanent[0].name}' changelist` : `${permanent.length} changelists`;
      const pick = await vscode.window.showWarningMessage(`Permanently delete ${what}?`, { modal: true, detail: 'This cannot be undone.' }, 'Delete');
      if (pick === 'Delete') for (const s of permanent) await this.store.remove(s.id);
    }
    if (!recycle.length) return;
    for (const s of recycle) await this.store.update(s.id, { deleted: true });
    const what = recycle.length === 1 ? `the '${recycle[0].name}' changelist` : `${recycle.length} changelists`;
    const undo = await vscode.window.showInformationMessage(`${what[0].toUpperCase()}${what.slice(1)} deleted from shelf successfully`, 'Undo Shelf Deletion');
    if (undo) for (const s of recycle) await this.store.update(s.id, { deleted: false });
  }

  async rename(id: string): Promise<void> {
    const s = this.store.get(id);
    if (!s) return;
    const others = this.store.all.filter((x) => x.id !== id && !x.deleted).map((x) => x.name.toLowerCase());
    const name = await vscode.window.showInputBox({
      title: 'Rename',
      prompt: 'Rename shelved changelist',
      value: s.name,
      validateInput: (v) => (!v.trim() ? 'Name cannot be empty' : others.includes(v.trim().toLowerCase()) ? `Shelved changelist '${v.trim()}' already exists` : undefined),
    });
    if (!name || name.trim() === s.name) return;
    await this.store.update(id, { name: name.trim() });
  }

  /** "Restore": brings applied / deleted shelves back to the active list. */
  async restore(ids: string[]): Promise<void> {
    for (const id of ids) {
      const s = this.store.get(id);
      if (s && (s.applied || s.deleted)) await this.store.update(id, { applied: false, deleted: false });
    }
  }

  /** "Create Patch…" / "Copy as Patch to Clipboard" of shelved changes. */
  async createPatch(id: string, paths: string[] | undefined, clipboard: boolean): Promise<void> {
    const s = this.store.get(id);
    if (!s) return;
    try {
      const bytes = await this.store.patch(id);
      const out = paths?.length ? filterPatchBytes(bytes, paths) : bytes;
      if (clipboard) return deliverPatch(out, undefined);
      const repo = this.repoOf(s);
      const uri = await vscode.window.showSaveDialog({
        title: 'Save Patch File',
        defaultUri: vscode.Uri.file(path.join(repo?.root ?? path.dirname(s.repoRoot), patchFileName(s.name))),
        filters: { Patch: ['patch', 'diff'], 'All files': ['*'] },
      });
      if (uri) await deliverPatch(out, uri.fsPath);
    } catch (e) {
      showGitError(e, 'Patch Creation Failed');
    }
  }

  /** "Import Patches…": each chosen patch file becomes a shelf named after the file. */
  async importPatches(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ title: 'Import Patches into Shelf…', canSelectMany: true, filters: { Patch: ['patch', 'diff'], 'All files': ['*'] } });
    if (!uris?.length) return;
    const repo = uris.length ? (this.ctx.repos.forUri(uris[0]) ?? (await this.ctx.repos.pick(undefined, 'Select the repository the patches belong to'))) : undefined;
    if (!repo) return;
    let n = 0;
    for (const u of uris) {
      try {
        const text = await fs.promises.readFile(u.fsPath);
        const parsed = parsePatch(text.toString('utf8'));
        if (!parsed.files.length) {
          vscode.window.showWarningMessage(`Cannot load patch file: ${path.basename(u.fsPath)} (No patches found)`);
          continue;
        }
        await this.store.create(repo, path.basename(u.fsPath).replace(/\.(patch|diff)$/i, ''), text, { strip: parsed.strip });
        n++;
      } catch (e) {
        vscode.window.showErrorMessage(`Cannot load patch file: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (n) await this.revealView();
  }

  // ------------------------------------------------------------ diffs

  /** Base content of a shelved file: the base commit, else the preimage blob, else the local file. */
  private async base(repo: Repository, s: Shelf, f: PatchFile): Promise<{ text: string; ref: ContentRef; title: string; local: boolean } | undefined> {
    if (f.kind === 'A') return { text: '', ref: { empty: true }, title: 'Base', local: false };
    const p = f.oldPath ?? f.path;
    if (s.baseCommit) {
      const b = await repo.show(s.baseCommit, p);
      if (b) return { text: b.toString('utf8'), ref: { rev: s.baseCommit, path: p }, title: s.baseCommit.slice(0, 8), local: false };
    }
    if (f.oldBlob) {
      const r = await repo.run(['cat-file', 'blob', f.oldBlob], { allowFail: true, quiet: true });
      if (r.code === 0) return { text: r.stdout, ref: { text: r.stdout, label: f.oldBlob.slice(0, 8) }, title: f.oldBlob.slice(0, 8), local: false };
    }
    try {
      const t = await fs.promises.readFile(repo.abs(p), 'utf8');
      return { text: t, ref: { worktree: true, path: p }, title: 'Local version', local: true };
    } catch {
      return undefined;
    }
  }

  async diffFiles(id: string, paths: string[] | undefined, withLocal: boolean): Promise<DiffFile[]> {
    const s = this.store.get(id);
    const repo = s && this.repoOf(s);
    if (!s || !repo) throw new Error('The repository of this shelf is not open');
    const parsed = parsePatch((await this.store.patch(id)).toString('utf8'));
    const files = parsed.files.filter((f) => !paths?.length || paths.includes(f.path));
    const out: DiffFile[] = [];
    let warned = false;
    for (const f of files) {
      const b = await this.base(repo, s, f);
      let shelved: ContentRef;
      if (f.kind === 'D') shelved = { empty: true };
      else if (f.binary) shelved = { text: 'Binary file', label: 'Shelved version' };
      else {
        const patched = b ? applyHunks(b.text, f.hunks) : undefined;
        if (patched === undefined && !warned) {
          warned = true;
          vscode.window.showWarningMessage('Base content not found or not applicable. Showing difference with local version');
        }
        shelved = { text: patched ?? f.hunks.flatMap((h) => h.lines.filter((l) => l[0] !== '-' && l[0] !== '\\').map((l) => l.slice(1))).join('\n'), label: 'Shelved version' };
      }
      if (withLocal) {
        out.push({ repoRoot: repo.root, path: f.path, kind: f.kind, left: shelved, right: { worktree: true, path: f.path }, leftTitle: 'Shelved version', rightTitle: 'Your version' });
      } else {
        out.push({
          repoRoot: repo.root,
          path: f.path,
          oldPath: f.oldPath,
          kind: f.kind,
          left: b?.ref ?? { empty: true },
          right: shelved,
          leftTitle: b?.title ?? 'Base',
          rightTitle: 'Shelved version',
        });
      }
    }
    return out;
  }

  async showDiff(id: string, paths: string[] | undefined, index: number, opts: { withLocal?: boolean; beside?: boolean } = {}): Promise<void> {
    const s = this.store.get(id);
    if (!s) return;
    try {
      const files = await this.diffFiles(id, paths, !!opts.withLocal);
      if (!files.length) return;
      await invoke('jbGit.diff.show', { title: `Shelved: ${s.name}`, files, index, beside: opts.beside });
    } catch (e) {
      showGitError(e, 'Cannot Show Diff');
    }
  }
}
