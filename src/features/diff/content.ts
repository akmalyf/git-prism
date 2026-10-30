// Pure helpers for diff contents: binary/encoding detection, EOL handling, languages, images and side titles.
// No vscode imports (unit-tested in content.test.ts).
import type { ContentRef, DiffFile } from '../../core/contracts';

/** Bigger texts get the "Files are too large to compare" placeholder. */
export const MAX_TEXT_SIZE = 10 * 1024 * 1024;
/** Bigger images aren't inlined. */
export const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** 'windows1252': not valid UTF-8; decoded as Windows-1252, which maps every byte, so unchanged bytes round-trip */
export type Encoding = 'utf8' | 'utf16le' | 'utf16be' | 'windows1252';
export type Eol = '\n' | '\r\n' | '\r';

/** How a file was stored, so an edited text can be written back the same way. */
export interface TextMeta {
  encoding: Encoding;
  bom: boolean;
  eol: Eol;
}

export interface Decoded {
  binary: boolean;
  /** text with '\n' line endings (undefined for binary contents) */
  text?: string;
  meta: TextMeta;
}

export const DEFAULT_META: TextMeta = { encoding: 'utf8', bom: false, eol: '\n' };

function bomOf(buf: Uint8Array): { encoding: Encoding; length: number } | undefined {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: 'utf8', length: 3 };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf16le', length: 2 };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf16be', length: 2 };
  return undefined;
}

/** NUL byte in the first 8000 bytes, like git's own heuristic (UTF-16 with a BOM is text). */
export function isBinary(buf: Uint8Array): boolean {
  if (bomOf(buf)?.encoding.startsWith('utf16')) return false;
  return buf.subarray(0, 8000).includes(0);
}

/** First line separator of a text, '\n' when it has none. */
export function detectEol(text: string): Eol {
  const i = text.search(/\r\n|\r|\n/);
  if (i < 0) return '\n';
  if (text[i] === '\n') return '\n';
  return text[i + 1] === '\n' ? '\r\n' : '\r';
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function decodeUtf16(body: Uint8Array, le: boolean): string {
  const parts: string[] = [];
  const chunk: number[] = [];
  for (let i = 0; i + 1 < body.length; i += 2) {
    chunk.push(le ? body[i] | (body[i + 1] << 8) : (body[i] << 8) | body[i + 1]);
    if (chunk.length === 8192) parts.push(String.fromCharCode(...chunk.splice(0)));
  }
  parts.push(String.fromCharCode(...chunk));
  return parts.join('');
}

export function decode(buf: Uint8Array): Decoded {
  const bom = bomOf(buf);
  if (!bom && isBinary(buf)) return { binary: true, meta: { ...DEFAULT_META } };
  const body = bom ? buf.subarray(bom.length) : buf;
  let encoding: Encoding = bom?.encoding ?? 'utf8';
  let raw: string;
  if (encoding === 'utf8') {
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      encoding = 'windows1252';
      raw = new TextDecoder('windows-1252').decode(body);
    }
  } else raw = decodeUtf16(body, encoding === 'utf16le');
  return { binary: false, text: normalizeEol(raw), meta: { encoding, bom: !!bom, eol: detectEol(raw) } };
}

/** WHATWG windows-1252: bytes 0x80..0x9F that don't map to the C1 control of the same value. */
const CP1252_HIGH = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

function encodeCp1252(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const hi = CP1252_HIGH.indexOf(text[i]);
    if (hi >= 0) out[i] = 0x80 + hi;
    else if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else throw new Error(`The character '${text[i]}' can't be saved in the file's encoding (windows-1252)`);
  }
  return out;
}

/** Whether `text` can be written in the encoding (windows-1252 has 256 characters only). */
export function canEncode(text: string, meta: TextMeta): boolean {
  if (meta.encoding !== 'windows1252') return true;
  try {
    encodeCp1252(text);
    return true;
  } catch {
    return false;
  }
}

/** Text ('\n' line endings) → bytes in the original encoding, BOM and line separator. */
export function encode(text: string, meta: TextMeta): Uint8Array {
  const raw = meta.eol === '\n' ? text : text.replace(/\n/g, meta.eol);
  let body: Uint8Array;
  if (meta.encoding === 'utf8') body = new TextEncoder().encode(raw);
  else if (meta.encoding === 'windows1252') body = encodeCp1252(raw);
  else {
    body = new Uint8Array(raw.length * 2);
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (meta.encoding === 'utf16le') {
        body[i * 2] = c & 0xff;
        body[i * 2 + 1] = c >> 8;
      } else {
        body[i * 2] = c >> 8;
        body[i * 2 + 1] = c & 0xff;
      }
    }
  }
  if (!meta.bom) return body;
  const prefix = meta.encoding === 'utf8' ? [0xef, 0xbb, 0xbf] : meta.encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff];
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

/**
 * IntelliJ's notice when both texts are equal after normalization but the raw contents differ
 * (DiffBundle diff.contents.have.differences.only.in.*). Undefined when the texts differ or the bytes are equal.
 */
export function onlySeparatorNotice(left: Decoded, right: Decoded, leftBytes: Uint8Array, rightBytes: Uint8Array): string | undefined {
  if (left.binary || right.binary || left.text !== right.text || bytesEqual(leftBytes, rightBytes)) return undefined;
  const eol = left.meta.eol !== right.meta.eol && left.text!.includes('\n');
  const charset = left.meta.encoding !== right.meta.encoding || left.meta.bom !== right.meta.bom;
  if (eol && charset) return 'Contents have differences only in line separators and encoding';
  if (charset) return 'Contents have differences only in encoding';
  return 'Contents have differences only in line separators';
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const LANGUAGES: Record<string, string> = {
  php: 'php', phtml: 'php', inc: 'php', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  mts: 'typescript', cts: 'typescript', json: 'json', jsonc: 'json', html: 'html', htm: 'html', vue: 'html', css: 'css', scss: 'scss', sass: 'scss',
  less: 'less', xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', yml: 'yaml', yaml: 'yaml', md: 'markdown', markdown: 'markdown', py: 'python',
  sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell', ini: 'ini', env: 'ini', conf: 'ini', properties: 'ini', toml: 'ini', twig: 'twig', go: 'go',
  java: 'java', rb: 'ruby', rs: 'rust', cs: 'csharp', c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', hbs: 'handlebars', pug: 'pug', ps1: 'powershell',
};

/** Language id understood by src/webview/shared/languages.ts ('plaintext' when unknown). */
export function languageOf(rel: string): string {
  const base = rel.split('/').pop()!.toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base.endsWith('.blade.php')) return 'html';
  if (base.startsWith('.env')) return 'ini';
  if (base === '.gitconfig' || base === '.editorconfig') return 'ini';
  const dot = base.lastIndexOf('.');
  return (dot > 0 && LANGUAGES[base.slice(dot + 1)]) || 'plaintext';
}

const IMAGES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
};

/** MIME type for raster images shown side by side instead of a text diff (SVG stays a text diff, like IntelliJ). */
export function imageMime(rel: string): string | undefined {
  const base = rel.toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? IMAGES[base.slice(dot + 1)] : undefined;
}

/** IntelliJ shows commit hashes with 8 characters. */
export function shortRev(rev: string): string {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(rev) ? rev.slice(0, 8) : rev;
}

/**
 * Revision label above one side when the caller didn't give one (ChangeDiffRequestProducer.getRevisionTitle):
 * a short hash, "Current version" for the working tree, "Base version" / "Your version" for a missing side.
 */
export function defaultTitle(ref: ContentRef, side: 'left' | 'right'): string {
  if ('rev' in ref) return shortRev(ref.rev);
  if ('index' in ref) return ['Staged', 'Base version', 'Yours', 'Theirs'][ref.stage ?? 0];
  if ('worktree' in ref) return 'Current version';
  if ('text' in ref) return ref.label ?? '';
  return side === 'left' ? 'Base version' : 'Your version';
}

function refPath(ref: ContentRef): string | undefined {
  return 'path' in ref ? ref.path : undefined;
}

export interface SideTitle {
  /** revision label ("a1b2c3d4", "Current version", "Staged", ...) */
  title: string;
  /** repo-relative path shown after the revision label (FilePathDiffTitleCustomizer); none for a missing side */
  path?: string;
}

/** Titles of both sides: revision label plus the path of that side (they differ for renames/moves). */
export function sideTitles(file: DiffFile): { left: SideTitle; right: SideTitle } {
  const side = (ref: ContentRef, s: 'left' | 'right', given: string | undefined, fallbackPath?: string): SideTitle => ({
    title: given ?? defaultTitle(ref, s),
    path: 'empty' in ref || 'text' in ref ? undefined : (refPath(ref) ?? fallbackPath),
  });
  return { left: side(file.left, 'left', file.leftTitle, file.oldPath ?? file.path), right: side(file.right, 'right', file.rightTitle, file.path) };
}

/** Identity of a diff request, used to reuse an already open diff tab. */
export function requestKey(files: DiffFile[]): string {
  return JSON.stringify(files.map((f) => [f.repoRoot, f.path, f.left, f.right]));
}

/** "1.2 KB" style size label for binary/image placeholders. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
