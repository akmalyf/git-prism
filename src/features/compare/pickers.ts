// Quick picks of the compare feature: branches & tags ("Select Branch to Compare") and a file's revisions
// ("Compare with Revision…", like IntelliJ's history popup: hash, date, author, subject).
import * as vscode from 'vscode';
import type { Repository } from '../../core/repository';
import type { Ref } from '../../core/types';
import { FOLLOW_FORMAT, parseFollowLog, type FileRevision } from './parse';
import { LITERAL } from './util';

interface RefItem extends vscode.QuickPickItem {
  ref?: string;
}

function fmtDate(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** Local branches, remote branches and tags grouped like IntelliJ's branch popup; the current branch first and marked. */
export async function pickRef(repo: Repository, opts: { title: string; tags?: boolean; excludeCurrent?: boolean }): Promise<string | undefined> {
  const [refs, current] = await Promise.all([repo.refs(), repo.currentBranch()]);
  const byName = (a: Ref, b: Ref) => (a.short === current ? -1 : b.short === current ? 1 : a.short.localeCompare(b.short));
  const items: RefItem[] = [];
  // a branch and a tag with the same short name: use the full ref name so git doesn't guess
  const counts = new Map<string, number>();
  for (const r of refs) counts.set(r.short, (counts.get(r.short) ?? 0) + 1);
  const section = (label: string, list: Ref[], iconName: string) => {
    if (!list.length) return;
    items.push({ label, kind: vscode.QuickPickItemKind.Separator });
    for (const r of list.sort(byName)) {
      const isCurrent = r.type === 'head' && r.short === current;
      items.push({
        label: `$(${isCurrent ? 'star-full' : iconName}) ${r.short}`,
        description: [isCurrent ? 'current' : '', r.type === 'head' && r.upstream ? `→ ${r.upstream}` : ''].filter(Boolean).join('  '),
        ref: (counts.get(r.short) ?? 0) > 1 ? r.name : r.short,
      });
    }
  };
  section('Local', refs.filter((r) => r.type === 'head' && !(opts.excludeCurrent && r.short === current)), 'git-branch');
  section('Remote', refs.filter((r) => r.type === 'remote'), 'git-branch');
  if (opts.tags !== false) section('Tags', refs.filter((r) => r.type === 'tag'), 'tag');
  if (!items.length) {
    vscode.window.showInformationMessage('No branches or tags to compare with.');
    return undefined;
  }
  const sel = await vscode.window.showQuickPick(items, {
    title: opts.title,
    placeHolder: opts.tags === false ? 'Search for branches' : 'Search for branches and tags',
    matchOnDescription: true,
  });
  return sel?.ref;
}

interface RevItem extends vscode.QuickPickItem {
  rev?: FileRevision;
}

/** History of one file (`git log --follow`) as a quick pick; resolves with the chosen revision. */
export async function pickFileRevision(repo: Repository, rel: string, name: string): Promise<FileRevision | undefined> {
  const qp = vscode.window.createQuickPick<RevItem>();
  qp.title = `Compare ${name} with Revision`;
  qp.placeholder = 'Select a revision (hash, author or commit message)';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;
  qp.show();
  const cts = new vscode.CancellationTokenSource();
  qp.onDidHide(() => cts.cancel());
  repo
    .run([LITERAL, 'log', '--follow', '--name-status', '-z', '--no-show-signature', FOLLOW_FORMAT, '--', rel], { quiet: true, token: cts.token })
    .then((r) => {
      const revs = parseFollowLog(r.stdout, rel);
      qp.items = revs.map((v) => ({
        label: `${v.hash.slice(0, 8)}  ${v.subject}`,
        description: `${v.author}  ${fmtDate(v.date)}`,
        detail: v.path !== rel ? v.path : undefined,
        rev: v,
      }));
      if (!revs.length) qp.placeholder = 'No revisions found for this file';
    })
    .catch((e) => {
      if (!cts.token.isCancellationRequested) qp.placeholder = `Cannot load history: ${e instanceof Error ? e.message : e}`;
    })
    .finally(() => (qp.busy = false));
  return new Promise((resolve) => {
    let done = false;
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.selectedItems[0]?.rev);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
      cts.dispose();
    });
  });
}
