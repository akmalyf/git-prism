// Runs a scripted `git rebase -i` for a prepared plan: writes the todo and message files, passes the todo through
// GIT_SEQUENCE_EDITOR, uses --autostash, handles --root and `--onto` (replaying commits onto a rewritten one; an
// empty plan is a `noop` that only moves HEAD), reports conflicts / stops and offers Undo afterwards.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import { autostashConflict, notifyRebaseStopped, reportError, warnAutostashConflict } from './common';
import { buildTodo, shQuote, type RebaseEntry } from './todo';

export interface RebaseRun {
  /** first commit of the plan is the root commit → `--root`, else the base is its parent */
  root: boolean;
  /** full hash of the oldest commit in the plan */
  oldest: string;
  entries: RebaseEntry[];
  /** replay `entries` (the commits after `upstream`, may be empty) onto `commit` instead of `oldest^` */
  onto?: { commit: string; upstream: string };
  /** HEAD the plan was made for (refuses when the repository changed meanwhile) */
  expectedHead: string;
  progressTitle: string;
  successTitle: string;
  failureTitle: string;
  /** undo notification texts; omitted = no Undo button */
  undo?: UndoTexts;
}

export interface UndoTexts {
  progress: string;
  notAllowed: string;
  failed: string;
  /** the new HEAD has the same tree (reword, in-memory squash): only the ref is moved back */
  soft?: boolean;
}

const posix = (p: string) => p.split(path.sep).join('/');

/** Returns true when the rebase completed. */
export async function runRebase(repo: Repository, o: RebaseRun): Promise<boolean> {
  const head = await repo.headHash();
  if (head !== o.expectedHead) {
    vscode.window.showErrorMessage(`${o.failureTitle}: repository state was changed`);
    return false;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitprism-rebase-'));
  let result: { code: number; stdout: string; stderr: string } | undefined;
  try {
    const todo = o.onto && !o.entries.length ? { text: 'noop\n', messages: [] } : buildTodo(o.entries, (id) => posix(path.join(dir, `msg-${id}.txt`)));
    for (const m of todo.messages) fs.writeFileSync(path.join(dir, `msg-${m.id}.txt`), m.text, 'utf8');
    const todoFile = path.join(dir, 'git-rebase-todo');
    fs.writeFileSync(todoFile, todo.text, 'utf8');
    const args = [
      '-c', 'rebase.autoSquash=false',
      '-c', 'rebase.updateRefs=false',
      '-c', 'rebase.missingCommitsCheck=ignore',
      '-c', 'rebase.abbreviateCommands=false',
      // --empty=drop: commits whose changes are already there (after a drop/reorder) vanish instead of stopping
      'rebase', '-i', '--autostash', '--empty=drop',
      ...(o.onto ? ['--onto', o.onto.commit, o.onto.upstream] : o.root ? ['--root'] : [`${o.oldest}^`]),
    ];
    result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: o.progressTitle }, () =>
      repo.exec(args, { allowFail: true, env: { GIT_SEQUENCE_EDITOR: `cp ${shQuote(posix(todoFile))}`, GIT_EDITOR: 'true' } }),
    );
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    await reportError(e, o.failureTitle);
    return false;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (repo.operationState() === 'rebase') {
    // message files are still needed by the remaining `exec` lines; the OS temp dir cleans them up eventually
    await notifyRebaseStopped(repo, output);
    return false;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (result.code !== 0) {
    await reportError(new Error(result.stderr.trim() || result.stdout.trim()), o.failureTitle);
    return false;
  }
  if (autostashConflict(output)) warnAutostashConflict(repo);
  const newHead = await repo.headHash();
  if (o.undo && newHead) offerUndo(repo, o.successTitle, o.expectedHead, newHead, o.undo);
  else vscode.window.showInformationMessage(o.successTitle);
  return true;
}

/** Success notification with an "Undo" button that resets back while HEAD is unchanged. */
export function offerUndo(repo: Repository, title: string, oldHead: string, newHead: string, t: UndoTexts): void {
  vscode.window.showInformationMessage(title, 'Undo').then(async (pick) => {
    if (pick !== 'Undo') return;
    const head = await repo.headHash();
    if (head !== newHead || repo.operationState() !== 'none') {
      vscode.window.showErrorMessage(`${t.notAllowed}: Repository has already been changed`);
      return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t.progress }, () =>
        // same tree (reword, in-memory squash): just move the ref back; otherwise reset --keep like IntelliJ
        t.soft ? repo.exec(['update-ref', '-m', 'undo', 'HEAD', oldHead, newHead]) : repo.exec(['reset', '--keep', oldHead]),
      );
    } catch (e) {
      await reportError(e, t.failed);
    }
  });
}
