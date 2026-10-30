// What a document annotates: a working tree file, or a file at a revision (read-only `jbgit-rev:` documents of
// the compare feature, or this feature's own fallback scheme). Pure except for the vscode.Uri type.
import type * as vscode from 'vscode';

/** Schemes of read-only "file at revision" documents whose query carries {repoRoot, rev, path}. */
export const REV_SCHEMES = ['jbgit-rev', 'jbgit-annotate'];
/** this feature's own read-only content scheme, used when jbGit.openFileAtRevision isn't available */
export const OWN_SCHEME = 'jbgit-annotate';

export interface RevisionQuery {
  repoRoot: string;
  rev: string;
  path: string;
}

/**
 * Parses the query of a revision document. Accepts a JSON object (`?{"repoRoot":…,"rev":…,"path":…}`) or
 * URL parameters (`?repoRoot=…&rev=…&path=…`). When `path` is missing it is taken from the uri path relative to
 * repoRoot.
 */
export function parseRevisionQuery(query: string, uriPath: string): RevisionQuery | undefined {
  let o: Record<string, unknown> | undefined;
  const q = query.trim();
  if (q.startsWith('{')) {
    try {
      o = JSON.parse(q);
    } catch {
      o = undefined;
    }
  }
  if (!o) {
    const p = new URLSearchParams(q);
    o = Object.fromEntries(p.entries());
  }
  const repoRoot = typeof o.repoRoot === 'string' ? o.repoRoot : typeof o.root === 'string' ? o.root : undefined;
  const rev = typeof o.rev === 'string' ? o.rev : typeof o.ref === 'string' ? o.ref : undefined;
  let path = typeof o.path === 'string' ? o.path : undefined;
  if (!repoRoot || !rev) return undefined;
  if (!path) {
    const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const up = uriPath.replace(/\\/g, '/');
    path = up.startsWith(root + '/') ? up.slice(root.length + 1) : up.replace(/^\/+/, '');
  }
  return { repoRoot, rev, path: path.replace(/\\/g, '/').replace(/^\/+/, '') };
}

export function revisionQueryOf(uri: vscode.Uri): RevisionQuery | undefined {
  if (!REV_SCHEMES.includes(uri.scheme)) return undefined;
  return parseRevisionQuery(uri.query, uri.path);
}
