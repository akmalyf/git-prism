// Pure parsers for git plumbing output (no vscode/node imports, unit-testable).
import type { BranchInfo, ChangeKind, Commit, FileChange, Ref, RefType, Status, StatusEntry } from './types';

/** `git status --porcelain=v2 -z --branch --untracked-files=all` */
export function parseStatusV2(out: string): Status {
  const branch: BranchInfo = {};
  const entries: StatusEntry[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') branch.oid = val === '(initial)' ? undefined : val;
      else if (key === 'branch.head') branch.head = val === '(detached)' ? undefined : val;
      else if (key === 'branch.upstream') branch.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) {
          branch.ahead = +m[1];
          branch.behind = +m[2];
        }
      }
      continue;
    }
    const type = line[0];
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = line.split(' ');
      const xy = f[1];
      const path = f.slice(8).join(' ');
      entries.push(entry(path, xy, undefined, f[2][0] === 'S'));
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath
      const f = line.split(' ');
      const xy = f[1];
      const path = f.slice(9).join(' ');
      const oldPath = parts[++i];
      entries.push(entry(path, xy, oldPath, f[2][0] === 'S'));
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = line.split(' ');
      const path = f.slice(10).join(' ');
      entries.push({ path, kind: 'U', index: 'U', worktree: 'U', conflict: f[1] });
    } else if (type === '?') {
      entries.push({ path: line.slice(2), kind: '?', index: '.', worktree: '?' });
    } else if (type === '!') {
      entries.push({ path: line.slice(2), kind: '!', index: '.', worktree: '!' });
    }
  }
  return { branch, entries };
}

function entry(path: string, xy: string, oldPath: string | undefined, submodule: boolean): StatusEntry {
  const index = xy[0] as ChangeKind | '.';
  const worktree = xy[1] as ChangeKind | '.';
  const kind: ChangeKind = index === 'A' ? 'A' : index === 'R' || index === 'C' ? index : worktree !== '.' ? (worktree as ChangeKind) : (index as ChangeKind);
  return { path, oldPath, kind, index, worktree, submodule: submodule || undefined };
}

/** `git diff --name-status -z [-M]` / `git diff-tree --name-status -z -r` output */
export function parseNameStatus(out: string): FileChange[] {
  const parts = out.split('\0');
  const res: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    const k = status[0] as ChangeKind;
    if (k === 'R' || k === 'C') {
      const oldPath = parts[++i];
      const path = parts[++i];
      res.push({ path, oldPath, kind: k });
    } else {
      res.push({ path: parts[++i], kind: k });
    }
  }
  return res;
}

/** Field separator / record separator used by LOG_FORMAT. */
export const FS = '\x1f';
export const RS = '\x1e';
/** `git log --format=...` producing records parsed by parseLog (hash, parents, author, email, adate, committer, cemail, cdate, subject, body). */
export const LOG_FORMAT = `--format=${['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s', '%b'].join('%x1f')}%x1e`;
/** Same as LOG_FORMAT without the body (much faster for big logs). */
export const LOG_FORMAT_NO_BODY = `--format=${['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s'].join('%x1f')}%x1e`;

export function parseLog(out: string): Commit[] {
  const res: Commit[] = [];
  for (const rec of out.split(RS)) {
    const r = rec.replace(/^\n+/, '');
    if (!r) continue;
    const f = r.split(FS);
    res.push({
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      authorEmail: f[3],
      authorDate: +f[4],
      committer: f[5],
      committerEmail: f[6],
      commitDate: +f[7],
      subject: f[8],
      body: f.length > 9 ? f[9].replace(/\n+$/, '') : undefined,
    });
  }
  return res;
}

/** for-each-ref format consumed by parseRefs */
export const REF_FORMAT = `--format=${[
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(committerdate:unix)',
  '%(*committerdate:unix)',
  '%(contents:subject)',
].join('%1f')}`;

export function parseRefs(out: string): Ref[] {
  const res: Ref[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [name, oid, peeled, upstream, track, date, peeledDate, subject] = line.split(FS);
    let type: RefType = 'other';
    let short = name;
    let remote: string | undefined;
    if (name.startsWith('refs/heads/')) {
      type = 'head';
      short = name.slice(11);
    } else if (name.startsWith('refs/remotes/')) {
      type = 'remote';
      short = name.slice(13);
      remote = short.split('/')[0];
      if (short.endsWith('/HEAD')) continue;
    } else if (name.startsWith('refs/tags/')) {
      type = 'tag';
      short = name.slice(10);
    } else if (name === 'refs/stash') {
      type = 'stash';
      short = 'stash';
    }
    const ref: Ref = { name, short, type, hash: peeled || oid, remote, subject };
    const d = +(peeledDate || date);
    if (d) ref.date = d;
    if (upstream) ref.upstream = upstream;
    if (track) {
      const a = /ahead (\d+)/.exec(track);
      const b = /behind (\d+)/.exec(track);
      if (a) ref.ahead = +a[1];
      if (b) ref.behind = +b[1];
    }
    res.push(ref);
  }
  return res;
}
