// The 3-way merge window ("Merge Revisions for <file>") for one conflicted file, and the Accept Yours / Accept
// Theirs prompt for conflicts that can't be merged as text (deleted on one side, binary, symlink, too large).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FeatureContext } from '../../core/context';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import { RpcBridge, webviewHtml, webviewOptions } from '../../core/webview';
import { decode, DEFAULT_META, languageOf, MAX_TEXT_SIZE, type Decoded } from './content';
import { writeWorktree } from './files';
import { conflictType, discardConfirmation, isRegularMode, mergeMsgRef, mergeTitles, parseUnmerged, pickBranch, sideStages, unprocessedMessage, type MergeTitleInfo, type Stage, type StageEntry } from './mergeLogic';
import type { MergeInit, MergeStatusMsg } from './protocol';

type Stages = Partial<Record<Stage, StageEntry>>;

const open = new Map<string, Promise<boolean>>();

/** Pathspecs are literal file names here (a file called "[a].txt" must not match "a.txt"). */
const LITERAL = '--literal-pathspecs';

async function unmergedStages(repo: Repository, rel: string): Promise<Stages> {
  return parseUnmerged((await repo.run([LITERAL, 'ls-files', '-u', '-z', '--', rel], { quiet: true })).stdout, rel);
}

/** Modal yes/no with IntelliJ's button captions; resolves true for `yes`. */
async function ask(title: string, detail: string, yes: string, no: string): Promise<boolean> {
  const yesItem: vscode.MessageItem = { title: yes };
  const pick = await vscode.window.showWarningMessage(title, { modal: true, detail }, yesItem, { title: no, isCloseAffordance: true });
  return pick === yesItem;
}

/** jbGit.conflicts.mergeFile: resolves to true when the file was resolved (and staged), false when cancelled. */
export function mergeFile(ctx: FeatureContext, args: { repoRoot: string; path: string }): Promise<boolean> {
  const key = `${path.normalize(args.repoRoot ?? '')}\0${args.path}`;
  const running = open.get(key);
  if (running) {
    MergePanel.reveal(key);
    return running;
  }
  const p = doMerge(ctx, args, key).finally(() => open.delete(key));
  open.set(key, p);
  return p;
}

async function doMerge(ctx: FeatureContext, args: { repoRoot: string; path: string }, key: string): Promise<boolean> {
  if (!args.repoRoot || !args.path) return false;
  const repo = ctx.repos.get(args.repoRoot) ?? (await ctx.repos.open(args.repoRoot));
  if (!repo) {
    vscode.window.showErrorMessage(`${args.repoRoot} is not a Git repository`);
    return false;
  }
  const rel = args.path;
  try {
    const stages = await unmergedStages(repo, rel);
    if (!stages[1] && !stages[2] && !stages[3]) {
      vscode.window.showInformationMessage(`${rel} has no unresolved conflicts.`);
      return false;
    }
    const reverse = repo.operationState() === 'rebase';
    const sides = sideStages(reverse);
    const titles = mergeTitles(await titleInfo(repo));
    const reason = await textMergeBlocker(repo, stages);
    if (reason) return await acceptPrompt(repo, rel, stages, reverse, reason);
    const [base, left, right] = await Promise.all([1, sides.left, sides.right].map((s) => loadStage(repo, rel, stages, s as Stage)));
    if (left.binary || right.binary || base.binary) return await acceptPrompt(repo, rel, stages, reverse, 'binary file');
    const init: MergeInit = {
      path: rel,
      language: languageOf(rel),
      left: left.text ?? '',
      base: base.text ?? '',
      right: right.text ?? '',
      leftTitle: titles.left,
      rightTitle: titles.right,
      noBase: !stages[1],
    };
    // the merged result keeps the line separators/encoding of the version in the working tree (HEAD side)
    const meta = (stages[2] ? (sides.left === 2 ? left : right) : left).meta;
    return await new Promise<boolean>((resolve) => new MergePanel(ctx, repo, key, init, meta, sides, resolve));
  } catch (e) {
    showGitError(e, 'Cannot Resolve Conflict');
    return false;
  }
}

async function loadStage(repo: Repository, rel: string, stages: Stages, s: Stage): Promise<Decoded> {
  if (!stages[s]) return { binary: false, text: '', meta: { ...DEFAULT_META } };
  const bytes = await repo.buffer(['cat-file', 'blob', stages[s]!.hash], { quiet: true });
  return decode(bytes);
}

/** Why the conflict can't be resolved in the text merge window (undefined = it can). */
async function textMergeBlocker(repo: Repository, stages: Stages): Promise<string | undefined> {
  if (!stages[2] || !stages[3]) return 'deleted';
  for (const s of [1, 2, 3] as Stage[]) {
    const e = stages[s];
    if (!e) continue;
    if (e.mode === '160000') return 'submodule';
    if (!isRegularMode(e.mode)) return 'symbolic link';
    const size = +(await repo.run(['cat-file', '-s', e.hash], { quiet: true })).stdout.trim();
    if (size > MAX_TEXT_SIZE) return 'The file is too big to be loaded';
  }
  return undefined;
}

/** "Accept Yours" / "Accept Theirs" without an editor (modify/delete, binary, symlink, submodule, too large). */
async function acceptPrompt(repo: Repository, rel: string, stages: Stages, reverse: boolean, reason: string): Promise<boolean> {
  const type = conflictType(stages, reverse);
  const detail = reason === 'deleted' ? `${rel}: ${type}` : `${rel}: ${type} (${reason})`;
  const pick = await vscode.window.showWarningMessage(`Merge Revisions for ${rel}`, { modal: true, detail }, 'Accept Yours', 'Accept Theirs');
  if (!pick) return false;
  const sides = sideStages(reverse);
  return acceptStage(repo, rel, stages, pick === 'Accept Yours' ? sides.left : sides.right);
}

/** Resolves the conflict with one stage's version (removing the file if that side deleted it) and stages it. */
export async function acceptStage(repo: Repository, rel: string, stages: Stages, stage: Stage): Promise<boolean> {
  try {
    if (!stages[stage]) {
      await repo.exec([LITERAL, 'rm', '--quiet', '--force', '--ignore-unmatch', '--', rel]);
    } else {
      await repo.exec([LITERAL, 'checkout', stage === 2 ? '--ours' : '--theirs', '--', rel]);
      await repo.exec([LITERAL, 'add', '--force', '--', rel]);
    }
    return true;
  } catch (e) {
    showGitError(e, 'Cannot Resolve Conflict');
    return false;
  }
}

async function revOk(repo: Repository, ref: string): Promise<string | undefined> {
  const r = await repo.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true, quiet: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

function readGitFile(repo: Repository, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(repo.gitDir, rel), 'utf8');
  } catch {
    return undefined;
  }
}

/** Branch names pointing at `hash`: local first, then remote. */
async function branchesAt(repo: Repository, hash: string, preferred?: string): Promise<string | undefined> {
  const r = await repo.run(['for-each-ref', '--points-at', hash, '--format=%(refname)', 'refs/heads', 'refs/remotes'], { quiet: true, allowFail: true });
  const refs = r.stdout.split('\n').filter((s) => s && !s.endsWith('/HEAD'));
  const local = refs.filter((s) => s.startsWith('refs/heads/')).map((s) => s.slice(11));
  const remote = refs.filter((s) => s.startsWith('refs/remotes/')).map((s) => s.slice(13));
  return pickBranch(local, remote, preferred);
}

async function titleInfo(repo: Repository): Promise<MergeTitleInfo> {
  const state = repo.operationState();
  const head = await repo.headHash();
  const current = (await repo.currentBranch()) ?? head?.slice(0, 8);
  if (state === 'merge') {
    const mergeHead = await revOk(repo, 'MERGE_HEAD');
    const other = mergeHead ? await branchesAt(repo, mergeHead, mergeMsgRef(readGitFile(repo, 'MERGE_MSG') ?? '')) : undefined;
    return { operation: 'merge', currentBranch: current, otherBranch: other, otherHash: mergeHead };
  }
  if (state === 'rebase') {
    const dir = fs.existsSync(path.join(repo.gitDir, 'rebase-merge')) ? 'rebase-merge' : 'rebase-apply';
    const headName = readGitFile(repo, `${dir}/head-name`)?.trim();
    const onto = readGitFile(repo, `${dir}/onto`)?.trim();
    const rebaseHead = await revOk(repo, 'REBASE_HEAD');
    const rebasing = headName && headName !== 'detached HEAD' ? headName.replace(/^refs\/heads\//, '') : head?.slice(0, 8);
    return { operation: 'rebase', currentBranch: rebasing, otherBranch: onto ? await branchesAt(repo, onto) : undefined, otherHash: onto, rebaseHead };
  }
  if (state === 'cherry-pick') return { operation: 'cherry-pick', currentBranch: current, otherHash: await revOk(repo, 'CHERRY_PICK_HEAD') };
  if (state === 'revert') return { operation: 'revert', currentBranch: current, otherHash: await revOk(repo, 'REVERT_HEAD') };
  return { operation: 'other', currentBranch: current };
}

class MergePanel {
  private static readonly panels = new Map<string, MergePanel>();

  static reveal(key: string): void {
    MergePanel.panels.get(key)?.panel.reveal();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly bridge: RpcBridge;
  private done = false;

  constructor(
    ctx: FeatureContext,
    private readonly repo: Repository,
    private readonly key: string,
    private readonly init: MergeInit,
    private readonly meta: ReturnType<typeof decode>['meta'],
    private readonly sides: { left: Stage; right: Stage },
    private readonly resolve: (applied: boolean) => void,
  ) {
    const ext = ctx.extension.extensionUri;
    const title = `Merge Revisions for ${init.path}`;
    this.panel = vscode.window.createWebviewPanel('jbGit.merge', title, vscode.ViewColumn.Active, webviewOptions(ext));
    this.panel.iconPath = new vscode.ThemeIcon('git-merge');
    this.panel.webview.html = webviewHtml(this.panel.webview, ext, 'merge', init, title);
    this.bridge = new RpcBridge(this.panel.webview, {
      apply: (p: { text: string; status: MergeStatusMsg }) => this.apply(p.text, p.status),
      accept: (p: { side: 'left' | 'right'; changed: boolean }) => this.accept(p.side, p.changed),
      cancel: (changed: boolean) => this.cancel(changed),
    });
    MergePanel.panels.set(key, this);
    this.panel.onDidDispose(() => this.finish(false));
  }

  private finish(applied: boolean): void {
    if (this.done) return;
    this.done = true;
    MergePanel.panels.delete(this.key);
    this.bridge.dispose();
    this.resolve(applied);
    this.panel.dispose();
  }

  private async apply(text: string, status: MergeStatusMsg): Promise<boolean> {
    if (status.changes + status.conflicts > 0) {
      const detail = `${unprocessedMessage(status.changes, status.conflicts)}\nSave changes and mark the conflict resolved anyway?`;
      if (!(await ask('Apply Changes', detail, 'Apply Changes and Mark Resolved', 'Continue Merge'))) return false;
    }
    try {
      await writeWorktree(this.repo.abs(this.init.path), text, this.meta);
      await this.repo.exec([LITERAL, 'add', '--force', '--', this.init.path]);
    } catch (e) {
      showGitError(e, 'Error saving merged data');
      return false;
    }
    this.finish(true);
    return true;
  }

  private async accept(side: 'left' | 'right', changed: boolean): Promise<boolean> {
    if (changed) {
      const c = discardConfirmation(side === 'left' ? 'Accept Left' : 'Accept Right');
      if (!(await ask(c.title, c.message, c.yes, c.no))) return false;
    }
    const stages = await unmergedStages(this.repo, this.init.path);
    if (!stages[1] && !stages[2] && !stages[3]) {
      vscode.window.showWarningMessage(`${this.init.path} is no longer in conflict.`);
      this.finish(false);
      return false;
    }
    const ok = await acceptStage(this.repo, this.init.path, stages, this.sides[side]);
    if (ok) this.finish(true);
    return ok;
  }

  private async cancel(changed: boolean): Promise<boolean> {
    if (changed) {
      const c = discardConfirmation('Cancel Merge');
      if (!(await ask(c.title, c.message, c.yes, c.no))) return false;
    }
    this.finish(false);
    return true;
  }
}
