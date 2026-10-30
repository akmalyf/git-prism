// Unified / git diff patches (pure): parse a patch into per-file chunks (paths, change kind, blob ids, hunks), filter
// a patch down to some files, and apply hunks to a base text (used for shelf diffs and the Apply Patch preview).
import type { ChangeKind } from '../../core/types';

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** body lines including their first char (' ', '-', '+', '\\') */
  lines: string[];
}

export interface PatchFile {
  /** path after the change (the old path for deletions), repo-relative, forward slashes */
  path: string;
  /** source path of renames / copies */
  oldPath?: string;
  kind: Extract<ChangeKind, 'A' | 'M' | 'D' | 'R' | 'C'>;
  binary: boolean;
  /** preimage / postimage blob ids from the "index" line (abbreviated or full) */
  oldBlob?: string;
  newBlob?: string;
  hunks: Hunk[];
  /** the raw text of this file's part of the patch, ending with a newline */
  raw: string;
}

export interface ParsedPatch {
  files: PatchFile[];
  /** leading path components to strip (git apply -p): 1 for a/ b/ prefixed patches, 0 otherwise */
  strip: number;
}

const NULL_PATH = '/dev/null';
const ZERO_BLOB = /^0+$/;

/** Decodes a C-quoted git path ("a/f\303\266o\tx") or returns the input unchanged. */
export function unquotePath(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const esc: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const n = body[i + 1];
    if (/[0-7]/.test(n ?? '')) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Path from a ---/+++ line: strips the quoting, a trailing tab + timestamp/revision, and `strip` components. */
function headerPath(raw: string, strip: number): string {
  let s = raw.trim();
  if (s.startsWith('"')) {
    const end = findQuoteEnd(s);
    s = unquotePath(s.slice(0, end + 1));
  } else {
    const tab = s.indexOf('\t');
    if (tab >= 0) s = s.slice(0, tab);
    // "--- path (revision 123)" / "(date 1700000000000)" as written by IntelliJ
    s = s.replace(/\s+\((revision|date|working copy|nonexistent)[^)]*\)$/, '');
  }
  if (s === NULL_PATH) return s;
  return stripComponents(s, strip);
}

function findQuoteEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return s.length - 1;
}

function stripComponents(p: string, n: number): string {
  let s = p.replace(/\\/g, '/');
  for (let i = 0; i < n; i++) {
    const k = s.indexOf('/');
    if (k < 0) break;
    s = s.slice(k + 1);
  }
  return s;
}

/** "a/x b/y" of a diff --git line (quoted or not); undefined when ambiguous. */
function gitHeaderPaths(rest: string): [string, string] | undefined {
  const s = rest.trim();
  if (s.startsWith('"')) {
    const e = findQuoteEnd(s);
    const a = unquotePath(s.slice(0, e + 1));
    const b = s.slice(e + 1).trim();
    return [a, b.startsWith('"') ? unquotePath(b) : b];
  }
  if (s.endsWith('"')) {
    const start = s.lastIndexOf(' "');
    return [s.slice(0, start), unquotePath(s.slice(start + 1))];
  }
  // unquoted: both halves are equal for non-renames, "a/<p> b/<p>"
  const half = (s.length - 1) / 2;
  if (Number.isInteger(half) && s[half] === ' ' && s.slice(2, half) === s.slice(half + 3)) return [s.slice(0, half), s.slice(half + 1)];
  const m = / b\//.exec(s);
  return m ? [s.slice(0, m.index), s.slice(m.index + 1)] : undefined;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses a git (diff --git) or plain unified patch. Unknown leading text (mail headers, "Index:" lines) is ignored. */
export function parsePatch(text: string): ParsedPatch {
  // `rawLines` keep their '\r' so `raw` reproduces the input exactly (CRLF files); parsing ignores it
  const rawLines = text.split('\n');
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const isGit = lines.some((l) => l.startsWith('diff --git '));
  // plain unified diffs: a/ b/ prefixes → -p1, otherwise -p0
  let strip = 1;
  if (!isGit) {
    const minus = lines.find((l) => l.startsWith('--- ') && !l.startsWith('--- /dev/null'));
    const plus = lines.find((l) => l.startsWith('+++ ') && !l.startsWith('+++ /dev/null'));
    const sample = (minus ?? plus ?? '').slice(4).replace(/^"/, '');
    strip = /^[ab]\//.test(sample) || (minus?.slice(4).startsWith('a/') && plus?.slice(4).startsWith('b/')) ? 1 : 0;
  }
  const files: PatchFile[] = [];
  let i = 0;
  const startsFile = (k: number) =>
    isGit ? lines[k].startsWith('diff --git ') : lines[k].startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');

  while (i < lines.length) {
    if (!startsFile(i)) {
      i++;
      continue;
    }
    const begin = i;
    let oldPath: string | undefined;
    let newPath: string | undefined;
    let kind: PatchFile['kind'] = 'M';
    let binary = false;
    let oldBlob: string | undefined;
    let newBlob: string | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let copy = false;
    if (isGit) {
      const hp = gitHeaderPaths(lines[i].slice('diff --git '.length));
      if (hp) {
        oldPath = stripComponents(hp[0], 1);
        newPath = stripComponents(hp[1], 1);
      }
      i++;
      while (i < lines.length && !lines[i].startsWith('diff --git ') && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ')) {
        const l = lines[i];
        if (l.startsWith('new file mode')) kind = 'A';
        else if (l.startsWith('deleted file mode')) kind = 'D';
        else if (l.startsWith('rename from ')) renameFrom = unquotePath(l.slice(12));
        else if (l.startsWith('rename to ')) renameTo = unquotePath(l.slice(10));
        else if (l.startsWith('copy from ')) (renameFrom = unquotePath(l.slice(10))), (copy = true);
        else if (l.startsWith('copy to ')) (renameTo = unquotePath(l.slice(8))), (copy = true);
        else if (l.startsWith('index ')) {
          const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(l);
          if (m) {
            oldBlob = ZERO_BLOB.test(m[1]) ? undefined : m[1];
            newBlob = ZERO_BLOB.test(m[2]) ? undefined : m[2];
          }
        } else if (l === 'GIT binary patch' || (l.startsWith('Binary files ') && l.endsWith(' differ'))) binary = true;
        i++;
      }
    }
    if (i < lines.length && lines[i].startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const a = headerPath(lines[i].slice(4), strip);
      const b = headerPath(lines[i + 1].slice(4), strip);
      if (a === NULL_PATH) kind = 'A';
      else oldPath = a;
      if (b === NULL_PATH) kind = 'D';
      else newPath = b;
      i += 2;
    }
    const hunks: Hunk[] = [];
    while (i < lines.length && !startsFile(i)) {
      const l = lines[i];
      const m = HUNK_RE.exec(l);
      if (m) {
        const h: Hunk = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], lines: [] };
        i++;
        let oldLeft = h.oldCount;
        let newLeft = h.newCount;
        while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith('\\'))) {
          const b = lines[i];
          const c = b[0];
          if (c === '\\') h.lines.push(b);
          else if (c === '-') (h.lines.push(b), oldLeft--);
          else if (c === '+') (h.lines.push(b), newLeft--);
          else if (c === ' ' || b === '') (h.lines.push(b === '' ? ' ' : b), oldLeft--, newLeft--);
          else break;
          i++;
        }
        hunks.push(h);
        continue;
      }
      if (l === 'GIT binary patch') binary = true;
      if (!isGit && !l.startsWith('\\') && !l.startsWith('@@') && hunks.length && l !== '') break;
      i++;
    }
    if (renameFrom !== undefined && renameTo !== undefined) {
      oldPath = renameFrom;
      newPath = renameTo;
      if (kind === 'M') kind = copy ? 'C' : 'R';
    }
    const path = kind === 'D' ? (oldPath ?? newPath) : (newPath ?? oldPath);
    if (path) {
      files.push({
        path,
        oldPath: kind === 'R' || kind === 'C' ? oldPath : undefined,
        kind,
        binary,
        oldBlob,
        newBlob,
        hunks,
        raw: rawLines.slice(begin, i).join('\n') + '\n',
      });
    }
  }
  return { files, strip };
}

/** The patch text restricted to the given file paths (in patch order). */
export function filterPatch(patch: ParsedPatch, paths: Iterable<string>): string {
  const keep = new Set(paths);
  return patch.files.filter((f) => keep.has(f.path)).map((f) => f.raw).join('');
}

/**
 * The bytes of `patch` restricted to the given file paths, without re-encoding the content (patches of files in a
 * non-UTF-8 encoding stay applicable). Paths are matched on the UTF-8 decoded patch; the bytes are cut from a latin1
 * decoding, which maps every byte to one char. Both decodings keep the same line structure, so file i matches file i.
 */
export function filterPatchBytes(patch: Buffer, paths: Iterable<string>): Buffer {
  const keep = new Set(paths);
  const named = parsePatch(patch.toString('utf8')).files;
  const bytes = parsePatch(patch.toString('latin1')).files;
  if (named.length !== bytes.length) return Buffer.from(named.filter((f) => keep.has(f.path)).map((f) => f.raw).join(''), 'utf8');
  return Buffer.from(bytes.filter((_, i) => keep.has(named[i].path)).map((f) => f.raw).join(''), 'latin1');
}

/** Each file's part of `patch` as exact bytes, with its (UTF-8 decoded) path. */
export function splitPatchBytes(patch: Buffer): { path: string; raw: Buffer }[] {
  const named = parsePatch(patch.toString('utf8')).files;
  const bytes = parsePatch(patch.toString('latin1')).files;
  if (named.length !== bytes.length) return named.map((f) => ({ path: f.path, raw: Buffer.from(f.raw, 'utf8') }));
  return named.map((f, i) => ({ path: f.path, raw: Buffer.from(bytes[i].raw, 'latin1') }));
}

/** Splits text into lines that keep their line terminator. */
function splitKeep(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** old / new side of a hunk as lines with terminators ("\ No newline at end of file" drops the preceding \n). */
function hunkSides(h: Hunk, eol: string): { old: string[]; new: string[] } {
  const oldL: string[] = [];
  const newL: string[] = [];
  let last: 'old' | 'new' | 'both' | undefined;
  for (const l of h.lines) {
    const c = l[0];
    const body = l.slice(1);
    if (c === '\\') {
      const strip = (arr: string[]) => {
        if (arr.length) arr[arr.length - 1] = arr[arr.length - 1].replace(/\r?\n$/, '');
      };
      if (last === 'old' || last === 'both') strip(oldL);
      if (last === 'new' || last === 'both') strip(newL);
      continue;
    }
    if (c === '-') (oldL.push(body + eol), (last = 'old'));
    else if (c === '+') (newL.push(body + eol), (last = 'new'));
    else (oldL.push(body + eol), newL.push(body + eol), (last = 'both'));
  }
  return { old: oldL, new: newL };
}

const norm = (l: string) => l.replace(/\r?\n$/, '');

/**
 * Applies the hunks of a text patch to `base`. Hunks may be shifted (offset search like GNU patch, no fuzz).
 * Returns undefined when a hunk's context does not match.
 */
export function applyHunks(base: string, hunks: readonly Hunk[]): string | undefined {
  const lines = splitKeep(base);
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  let offset = 0;
  for (const h of hunks) {
    const side = hunkSides(h, eol);
    const want = side.old;
    const expected = Math.max(0, (h.oldCount === 0 ? h.oldStart : h.oldStart - 1) + offset);
    const matchesAt = (pos: number) => {
      if (pos < 0 || pos + want.length > lines.length) return false;
      for (let k = 0; k < want.length; k++) {
        if (norm(lines[pos + k]) !== norm(want[k])) return false;
        // the last line's terminator matters ("\ No newline at end of file")
        if (pos + k === lines.length - 1 && k === want.length - 1 && /\n$/.test(lines[pos + k]) !== /\n$/.test(want[k])) return false;
      }
      return true;
    };
    let found = -1;
    for (let d = 0; d <= lines.length; d++) {
      if (matchesAt(expected - d)) {
        found = expected - d;
        break;
      }
      if (d > 0 && matchesAt(expected + d)) {
        found = expected + d;
        break;
      }
      if (expected - d < 0 && expected + d > lines.length) break;
    }
    if (found < 0) return undefined;
    // keep the base's own terminators on context lines
    lines.splice(found, want.length, ...side.new);
    offset = found - (h.oldCount === 0 ? h.oldStart : h.oldStart - 1) + side.new.length - want.length;
  }
  return lines.join('');
}

/** Reverses a text hunk (patched → base). */
export function reverseHunks(hunks: readonly Hunk[]): Hunk[] {
  return hunks.map((h) => ({
    oldStart: h.newStart,
    oldCount: h.newCount,
    newStart: h.oldStart,
    newCount: h.oldCount,
    lines: h.lines.map((l) => (l[0] === '-' ? '+' + l.slice(1) : l[0] === '+' ? '-' + l.slice(1) : l)),
  }));
}
