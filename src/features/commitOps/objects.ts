// Pure helpers for in-memory history editing (like IntelliJ's in-memory reword/squash): raw commit objects are
// rewritten (parents, tree, committer, message) and written back with `git hash-object`, so the working tree and
// the index are never touched. Raw objects are handled as 'latin1' strings, which round-trip bytes losslessly.
// No vscode/node imports (unit-tested).

export interface RawCommit {
  /** header lines (continuation lines of multi-line headers such as gpgsig start with a space) */
  headers: string[];
  /** message bytes as a latin1 string */
  message: string;
}

export function parseRawCommit(raw: string): RawCommit {
  const i = raw.indexOf('\n\n');
  const head = i < 0 ? raw.replace(/\n$/, '') : raw.slice(0, i);
  return { headers: head ? head.split('\n') : [], message: i < 0 ? '' : raw.slice(i + 2) };
}

export function formatRawCommit(c: RawCommit): string {
  return `${c.headers.join('\n')}\n\n${c.message}`;
}

/** UTF-8 text → byte-preserving latin1 string (the form raw objects are kept in). */
export function utf8ToBytes(s: string): string {
  return unescape(encodeURIComponent(s));
}

export interface CommitRewrite {
  tree?: string;
  parents?: string[];
  /** full committer header value: "Name <email> 1700000000 +0100" (latin1 bytes) */
  committer?: string;
  /** new message as UTF-8 text (the encoding header is dropped) */
  message?: string;
}

/**
 * Rewrites a raw commit object. Signatures (gpgsig, gpgsig-sha256) are removed because they no longer match;
 * the author is kept; parent lines are replaced in place (all at the position of the first one).
 */
export function rewriteCommit(raw: string, o: CommitRewrite): string {
  const c = parseRawCommit(raw);
  const out: string[] = [];
  let skipping = false;
  let parentsDone = false;
  const pushParents = () => {
    if (parentsDone) return;
    parentsDone = true;
    for (const p of o.parents ?? []) out.push(`parent ${p}`);
  };
  for (const line of c.headers) {
    if (line.startsWith(' ')) {
      if (!skipping) out.push(line);
      continue;
    }
    skipping = false;
    const key = line.slice(0, line.indexOf(' ') < 0 ? line.length : line.indexOf(' '));
    if (key === 'gpgsig' || key === 'gpgsig-sha256' || (key === 'encoding' && o.message !== undefined)) {
      skipping = true;
      continue;
    }
    if (key === 'tree') {
      out.push(o.tree ? `tree ${o.tree}` : line);
      continue;
    }
    if (key === 'parent') {
      if (o.parents) pushParents();
      else out.push(line);
      continue;
    }
    if (key === 'author' && o.parents && !parentsDone) pushParents();
    if (key === 'committer' && o.committer) {
      if (o.parents && !parentsDone) pushParents();
      out.push(`committer ${o.committer}`);
      continue;
    }
    out.push(line);
  }
  if (o.parents && !parentsDone) {
    // a root commit gets parents: they go right after the tree line
    const t = out.findIndex((l) => l.startsWith('tree '));
    out.splice(t + 1, 0, ...o.parents.map((p) => `parent ${p}`));
  }
  const message = o.message !== undefined ? utf8ToBytes(o.message.endsWith('\n') ? o.message : o.message + '\n') : c.message;
  return formatRawCommit({ headers: out, message });
}

export function headerValues(raw: string, key: string): string[] {
  return parseRawCommit(raw)
    .headers.filter((l) => l.startsWith(key + ' '))
    .map((l) => l.slice(key.length + 1));
}

/** Given commits oldest-first with their parents, true when every one is the single parent of the next. */
export function isConsecutiveChain(commits: { hash: string; parents: string[] }[]): boolean {
  for (let i = 1; i < commits.length; i++) {
    const p = commits[i].parents;
    if (p.length !== 1 || p[0] !== commits[i - 1].hash) return false;
  }
  return commits.every((c) => c.parents.length <= 1);
}
