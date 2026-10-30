// Pure helpers of the Compare & History feature: parsers for `git log --follow`, `git log -L`, `git ls-tree`,
// line-range mapping between the working tree and HEAD, change inversion (swap sides), language lookup and the
// jbgit-rev uri query. No vscode/node imports: unit-tested and shared with the webviews.
import type { ChangeKind, FileChange } from '../../core/types';

export const FOLLOW_FORMAT = '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s';

/** One revision of a file history (`git log --follow --name-status -z`). */
export interface FileRevision {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  date: number;
  subject: string;
  /** path of the file at this revision */
  path: string;
  /** path before the rename/copy made by this revision */
  oldPath?: string;
  kind: ChangeKind;
}

function header(h: string): Omit<FileRevision, 'path' | 'kind' | 'oldPath'> {
  const f = h.split('\x1f');
  return { hash: f[0], parents: f[1] ? f[1].split(' ') : [], author: f[2] ?? '', authorEmail: f[3] ?? '', date: +(f[4] ?? 0), subject: f[5] ?? '' };
}

/**
 * `git log --follow --name-status -z FOLLOW_FORMAT -- path`, newest first. Revisions without a status entry (merges)
 * get the path the file had at that point, carried over from the newer revisions (`current` = path in the working tree).
 */
export function parseFollowLog(out: string, current = ''): FileRevision[] {
  const res: FileRevision[] = [];
  let carry = current;
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const nul = rec.indexOf('\0');
    const head = header(nul < 0 ? rec : rec.slice(0, nul));
    const parts = (nul < 0 ? '' : rec.slice(nul + 1)).replace(/^\n+/, '').split('\0').filter((p) => p !== '');
    let path = '';
    let oldPath: string | undefined;
    let kind: ChangeKind = 'M';
    for (let i = 0; i < parts.length; i++) {
      const k = parts[i][0] as ChangeKind;
      if (k === 'R' || k === 'C') {
        oldPath = parts[i + 1];
        path = parts[i + 2] ?? '';
        i += 2;
      } else {
        path = parts[i + 1] ?? '';
        oldPath = undefined;
        i += 1;
      }
      kind = k;
    }
    if (!path) path = carry;
    res.push({ ...head, path, oldPath, kind });
    // older revisions see the file under its name before the rename
    carry = kind === 'R' && oldPath ? oldPath : path;
  }
  return res;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** lines with their ' ', '-', '+' prefix */
  lines: string[];
}

/** One revision of `git log -L` output: commit header plus the patch of the tracked block. */
export interface BlockRevision {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  date: number;
  subject: string;
  body: string;
  /** path at this revision ('+++ b/' side) */
  path: string;
  /** path at the parent ('--- a/' side); undefined when the block was introduced (file added) */
  oldPath?: string;
  hunks: Hunk[];
}

export const LINE_LOG_FORMAT = '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1d';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  try {
    // git C-quotes paths with special characters (octal escapes are UTF-8 bytes)
    const bytes: number[] = [];
    const s = p.slice(1, -1);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\\') {
        bytes.push(...new TextEncoder().encode(c));
        continue;
      }
      const n = s[++i];
      if (/[0-7]/.test(n)) {
        bytes.push(parseInt(s.slice(i, i + 3), 8));
        i += 2;
      } else bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return p;
  }
}

/** `git log -L<s>,<e>:<path> LINE_LOG_FORMAT` */
export function parseLineLog(out: string): BlockRevision[] {
  const res: BlockRevision[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const end = rec.indexOf('\x1d');
    const f = (end < 0 ? rec : rec.slice(0, end)).split('\x1f');
    const rev: BlockRevision = {
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2] ?? '',
      authorEmail: f[3] ?? '',
      date: +(f[4] ?? 0),
      subject: f[5] ?? '',
      body: (f.slice(6).join('\x1f') ?? '').replace(/\n+$/, ''),
      path: '',
      hunks: [],
    };
    const patch = end < 0 ? '' : rec.slice(end + 1);
    let hunk: Hunk | undefined;
    for (const line of patch.split('\n')) {
      if (hunk) {
        const c = line[0];
        if (c === ' ' || c === '-' || c === '+') {
          hunk.lines.push(line);
          continue;
        }
        if (c === '\\') continue;
        hunk = undefined;
      }
      const m = HUNK_RE.exec(line);
      if (m) {
        hunk = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], lines: [] };
        rev.hunks.push(hunk);
      } else if (line.startsWith('--- ')) {
        const p = line.slice(4);
        rev.oldPath = p === '/dev/null' ? undefined : unquote(p).replace(/^"?a\//, '');
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        rev.path = p === '/dev/null' ? '' : unquote(p).replace(/^"?b\//, '');
      }
    }
    res.push(rev);
  }
  return res;
}

/** Text of the block before / after a revision, rebuilt from its hunks. */
export function blockTexts(hunks: readonly Hunk[]): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      const t = l.slice(1);
      if (l[0] !== '+') before.push(t);
      if (l[0] !== '-') after.push(t);
    }
  }
  return { before: before.join('\n'), after: after.join('\n') };
}

/** `@@` headers of a `git diff -U0` output. */
export function parseHunkHeaders(diff: string): Hunk[] {
  const res: Hunk[] = [];
  for (const line of diff.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) res.push({ oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], lines: [] });
  }
  return res;
}

/**
 * Maps a 1-based inclusive line range of the new side (working tree) to the old side (HEAD) using `-U0` hunks.
 * Lines inside changed regions map to the whole changed old region. Undefined when the range lies completely
 * inside lines that don't exist on the old side.
 */
export function mapRangeToOld(hunks: readonly Hunk[], start: number, end: number): { start: number; end: number } | undefined {
  const map = (n: number, edge: 'start' | 'end'): number => {
    let offset = 0;
    for (const h of hunks) {
      const newFirst = h.newCount ? h.newStart : h.newStart + 1;
      const oldFirst = h.oldCount ? h.oldStart : h.oldStart + 1;
      if (n < newFirst) return n + offset;
      if (n < newFirst + h.newCount) {
        if (h.oldCount === 0) return edge === 'start' ? oldFirst : oldFirst - 1;
        return edge === 'start' ? oldFirst : oldFirst + h.oldCount - 1;
      }
      offset = oldFirst + h.oldCount - (newFirst + h.newCount);
    }
    return n + offset;
  };
  const s = map(start, 'start');
  const e = map(end, 'end');
  if (e < s || e < 1) return undefined;
  return { start: Math.max(1, s), end: e };
}

/** True when the -U0 hunks touch the new-side line range. */
export function hunksTouch(hunks: readonly Hunk[], start: number, end: number): boolean {
  return hunks.some((h) =>
    h.newCount ? h.newStart <= end && h.newStart + h.newCount - 1 >= start : h.newStart >= start && h.newStart < end,
  );
}

export interface TreeEntry {
  /** blob, tree or commit (submodule) */
  type: 'blob' | 'tree' | 'commit';
  mode: string;
  hash: string;
  /** size in bytes for blobs (with -l) */
  size?: number;
  /** repo-relative path */
  path: string;
  name: string;
}

/** `git ls-tree -z [-l] <rev> [-- dir/]` */
export function parseLsTree(out: string): TreeEntry[] {
  const res: TreeEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).trim().split(/\s+/);
    const path = rec.slice(tab + 1);
    const type = meta[1] as TreeEntry['type'];
    const size = meta[3] && meta[3] !== '-' ? +meta[3] : undefined;
    res.push({ type, mode: meta[0], hash: meta[2], size, path, name: path.slice(path.lastIndexOf('/') + 1) });
  }
  const rank = (e: TreeEntry) => (e.type === 'blob' ? 1 : 0);
  return res.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** Changes seen from the other direction (to → from): added ↔ deleted, renames reversed. */
export function invertChanges(changes: readonly FileChange[]): FileChange[] {
  return changes.map((c) => {
    if (c.kind === 'A') return { path: c.path, kind: 'D' };
    if (c.kind === 'D') return { path: c.path, kind: 'A' };
    if (c.kind === 'R' && c.oldPath) return { path: c.oldPath, oldPath: c.path, kind: 'R' };
    if (c.kind === 'C' && c.oldPath) return { path: c.path, kind: 'D' };
    return { ...c };
  });
}

export interface LanguageContribution {
  id: string;
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`, 'i');
}

/** VS Code language id for a file name from the extensions' `contributes.languages` (filename > pattern > longest extension). */
export function findLanguage(langs: readonly LanguageContribution[], path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const lower = name.toLowerCase();
  for (const l of langs) if (l.filenames?.some((f) => f.toLowerCase() === lower)) return l.id;
  for (const l of langs) {
    if (l.filenamePatterns?.some((p) => globToRegExp(p.includes('/') ? p : `**/${p}`).test(path) || globToRegExp(p).test(name))) return l.id;
  }
  let best: { id: string; len: number } | undefined;
  for (const l of langs) {
    for (const e of l.extensions ?? []) {
      const ext = e.toLowerCase();
      if (lower.endsWith(ext) && (!best || ext.length > best.len)) best = { id: l.id, len: ext.length };
    }
  }
  return best?.id;
}

export interface RevUriData {
  repoRoot: string;
  rev: string;
  path: string;
}

/** Path + query of a `jbgit-rev:` uri; the path ends with "<file> (<short>)" so the editor tab reads like IntelliJ. */
export function revUriParts(d: RevUriData, label: string): { path: string; query: string } {
  return { path: `/${d.path} (${label})`, query: JSON.stringify(d) };
}

export function parseRevQuery(query: string): RevUriData | undefined {
  try {
    const d = JSON.parse(query) as RevUriData;
    return typeof d.repoRoot === 'string' && typeof d.rev === 'string' && typeof d.path === 'string' ? d : undefined;
  } catch {
    return undefined;
  }
}

/** IntelliJ shows 8-character hashes. */
export function shortRev(rev: string): string {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(rev) ? rev.slice(0, 8) : rev;
}

export interface DirEntry {
  type: 'blob' | 'tree' | 'commit';
  /** repo-relative path */
  path: string;
  name: string;
}

function compareEntries(a: DirEntry, b: DirEntry): number {
  const rank = (e: DirEntry) => (e.type === 'tree' ? 0 : 1);
  return rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
}

/**
 * Directory index of a recursive `git ls-tree -r` listing (blobs and submodules only): directory path ('' = root)
 * → its entries, folders first. Folders are synthesized from the file paths.
 */
export function buildDirIndex(files: readonly { type: 'blob' | 'commit'; path: string }[]): Map<string, DirEntry[]> {
  const index = new Map<string, DirEntry[]>([['', []]]);
  const add = (dir: string, e: DirEntry) => {
    let list = index.get(dir);
    if (!list) index.set(dir, (list = []));
    list.push(e);
  };
  for (const f of files) {
    const segs = f.path.split('/');
    let dir = '';
    for (let i = 0; i < segs.length - 1; i++) {
      const sub = dir ? `${dir}/${segs[i]}` : segs[i];
      if (!index.has(sub)) {
        index.set(sub, []);
        add(dir, { type: 'tree', path: sub, name: segs[i] });
      }
      dir = sub;
    }
    add(dir, { type: f.type, path: f.path, name: segs[segs.length - 1] });
  }
  for (const list of index.values()) list.sort(compareEntries);
  return index;
}
