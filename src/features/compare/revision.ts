// Read-only file contents at a revision: the `gitprism-rev:` TextDocumentContentProvider and 'gitPrism.openFileAtRevision'
// (editor tab "<file> (<short hash>)" with the language of the file name).
import * as vscode from 'vscode';
import type { RepositoryManager } from '../../core/repository';
import { findLanguage, parseRevQuery, revUriParts, shortRev, type LanguageContribution } from './parse';
import { REV_SCHEME } from './util';

let languages: LanguageContribution[] | undefined;

function allLanguages(): LanguageContribution[] {
  if (!languages) {
    languages = [];
    for (const ext of vscode.extensions.all) {
      const contrib = (ext.packageJSON as { contributes?: { languages?: LanguageContribution[] } })?.contributes?.languages;
      if (Array.isArray(contrib)) languages.push(...contrib.filter((l) => l && typeof l.id === 'string'));
    }
  }
  return languages;
}

/** VS Code language id for a repo-relative path (by file name / extension). */
export function languageIdFor(rel: string): string {
  return findLanguage(allLanguages(), rel) ?? 'plaintext';
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repos: RepositoryManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const d = parseRevQuery(uri.query);
    if (!d) return '';
    await this.repos.ready();
    const repo = this.repos.get(d.repoRoot) ?? (await this.repos.open(d.repoRoot));
    if (!repo) return `Repository ${d.repoRoot} is not available.`;
    const buf = await repo.show(d.rev, d.path);
    if (!buf) return `File ${d.path} doesn't exist in revision ${shortRev(d.rev)}.`;
    if (buf.subarray(0, 8000).includes(0)) return `Binary file ${d.path} (${buf.length} bytes) cannot be shown as text.`;
    return new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
  }
}

export function revisionUri(repoRoot: string, rev: string, rel: string, label = shortRev(rev)): vscode.Uri {
  const p = revUriParts({ repoRoot, rev, path: rel }, label);
  return vscode.Uri.from({ scheme: REV_SCHEME, path: p.path, query: p.query });
}

/** Opens the read-only content of `rel` at `rev` (resolved to a commit hash for a stable title). */
export async function openFileAtRevision(repos: RepositoryManager, args: { repoRoot: string; path: string; rev: string }, opts: { preview?: boolean } = {}): Promise<void> {
  await repos.ready();
  const repo = repos.get(args.repoRoot) ?? (await repos.open(args.repoRoot));
  if (!repo) throw new Error(`Repository ${args.repoRoot} is not available.`);
  let rev = args.rev;
  try {
    rev = await repo.revParse(args.rev);
  } catch {
    /* index (":0") or tree-ish: keep as is */
  }
  if (!(await repo.show(rev, args.path))) {
    vscode.window.showWarningMessage(`File ${args.path} doesn't exist in revision ${shortRev(args.rev)}.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(revisionUri(repo.root, rev, args.path));
  const lang = languageIdFor(args.path);
  const shown = lang !== doc.languageId ? await vscode.languages.setTextDocumentLanguage(doc, lang).then((d) => d, () => doc) : doc;
  await vscode.window.showTextDocument(shown, { preview: opts.preview ?? true });
}
