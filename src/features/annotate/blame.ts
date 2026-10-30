// Parser for `git blame --porcelain` output (pure, no vscode imports; tested in blame.test.ts).

/** The all-zero hash git uses for lines that are not committed yet (`--contents` / working tree). */
export const UNCOMMITTED = '0000000000000000000000000000000000000000';

export interface BlameCommit {
  hash: string;
  author: string;
  authorMail: string;
  /** unix seconds */
  authorTime: number;
  authorTz: string;
  committer: string;
  committerMail: string;
  committerTime: number;
  committerTz: string;
  summary: string;
  /** parent commit + the file's path there (absent for root/boundary commits) */
  previous?: { hash: string; path: string };
  boundary: boolean;
  /** path of the file in this commit */
  filename: string;
}

export interface BlameLine {
  hash: string;
  /** 1-based line number in the original (commit's) file */
  origLine: number;
  /** path of the file in that commit (can differ per line with -C) */
  filename: string;
}

export interface BlameResult {
  /** index = 0-based final line */
  lines: BlameLine[];
  commits: Map<string, BlameCommit>;
}

function emptyCommit(hash: string): BlameCommit {
  return {
    hash,
    author: '',
    authorMail: '',
    authorTime: 0,
    authorTz: '',
    committer: '',
    committerMail: '',
    committerTime: 0,
    committerTz: '',
    summary: '',
    boundary: false,
    filename: '',
  };
}

const HEADER = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Undoes git's C-style path quoting ("dir \303\251/a.txt" → "dir é/a.txt"); unquoted paths are returned as is. */
export function unquotePath(s: string): string {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const bytes: number[] = [];
  for (let i = 1; i < s.length - 1; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const n = s[++i];
    if (/^[0-7]{3}$/.test(s.slice(i, i + 3))) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(ESCAPES[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

export function isUncommitted(hash: string): boolean {
  return /^0+$/.test(hash);
}

/** Parses `git blame --porcelain` (also accepts --line-porcelain). */
export function parseBlamePorcelain(out: string): BlameResult {
  const commits = new Map<string, BlameCommit>();
  const lines: BlameLine[] = [];
  const rows = out.split('\n');
  let cur: BlameCommit | undefined;
  let orig = 0;
  let final = 0;
  for (const row of rows) {
    if (row.startsWith('\t')) {
      if (cur) lines[final - 1] = { hash: cur.hash, origLine: orig, filename: cur.filename };
      cur = undefined;
      continue;
    }
    const h = HEADER.exec(row);
    if (h && !cur) {
      cur = commits.get(h[1]);
      if (!cur) commits.set(h[1], (cur = emptyCommit(h[1])));
      orig = +h[2];
      final = +h[3];
      continue;
    }
    if (!cur || !row) continue;
    const sp = row.indexOf(' ');
    const key = sp < 0 ? row : row.slice(0, sp);
    const val = sp < 0 ? '' : row.slice(sp + 1);
    switch (key) {
      case 'author': cur.author = val; break;
      case 'author-mail': cur.authorMail = val.replace(/^<|>$/g, ''); break;
      case 'author-time': cur.authorTime = +val; break;
      case 'author-tz': cur.authorTz = val; break;
      case 'committer': cur.committer = val; break;
      case 'committer-mail': cur.committerMail = val.replace(/^<|>$/g, ''); break;
      case 'committer-time': cur.committerTime = +val; break;
      case 'committer-tz': cur.committerTz = val; break;
      case 'summary': cur.summary = val; break;
      case 'boundary': cur.boundary = true; break;
      case 'filename': cur.filename = unquotePath(val); break;
      case 'previous': {
        const s = val.indexOf(' ');
        if (s > 0) cur.previous = { hash: val.slice(0, s), path: unquotePath(val.slice(s + 1)) };
        break;
      }
    }
  }
  // holes can only come from malformed output; keep the array dense
  for (let i = 0; i < lines.length; i++) if (!lines[i]) lines[i] = { hash: UNCOMMITTED, origLine: i + 1, filename: '' };
  return { lines, commits };
}

/**
 * Shifts an existing blame through an edit (lines [start, start+removed) replaced by `added` lines) so annotations
 * stay on the right lines until the debounced re-blame arrives. New lines are uncommitted.
 */
export function shiftLines(lines: BlameLine[], start: number, removed: number, added: number): BlameLine[] {
  const fresh: BlameLine[] = [];
  for (let i = 0; i < added; i++) fresh.push({ hash: UNCOMMITTED, origLine: 0, filename: '' });
  return [...lines.slice(0, start), ...fresh, ...lines.slice(start + removed)];
}
