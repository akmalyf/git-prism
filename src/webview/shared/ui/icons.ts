// Codicon helpers: icon elements, file-type icons by extension, folder icons, git status classes/labels. File and
// folder icons come from the user's VS Code file icon theme when one is active (see src/core/iconTheme.ts), else
// from codicons.
import type { ChangeKind } from '../../../core/types';

export interface IconOptions {
  color?: string;
  className?: string;
  title?: string;
  spin?: boolean;
}

/** <span class="codicon codicon-NAME">; `name` without the codicon- prefix. */
export function icon(name: string, opts: IconOptions = {}): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `codicon codicon-${name} jb-icon${opts.spin ? ' codicon-modifier-spin' : ''}${opts.className ? ' ' + opts.className : ''}`;
  if (opts.color) el.style.color = opts.color;
  if (opts.title) el.title = opts.title;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export interface FileIconSpec {
  name: string;
  /** CSS color (a kit token) or undefined for the default foreground */
  color?: string;
}

const C = {
  php: 'var(--jb-icon-purple)',
  js: 'var(--jb-icon-yellow)',
  ts: 'var(--jb-icon-blue)',
  web: 'var(--jb-icon-orange)',
  style: 'var(--jb-icon-blue)',
  data: 'var(--jb-icon-green)',
  doc: 'var(--jb-icon-grey)',
  conf: 'var(--jb-icon-grey)',
  media: 'var(--jb-icon-green)',
  py: 'var(--jb-icon-blue)',
  rb: 'var(--jb-icon-red)',
  java: 'var(--jb-icon-orange)',
  go: 'var(--jb-icon-blue)',
  rs: 'var(--jb-icon-orange)',
  sh: 'var(--jb-icon-green)',
  db: 'var(--jb-icon-yellow)',
};

const BY_EXT: Record<string, FileIconSpec> = {
  php: { name: 'symbol-class', color: C.php },
  phtml: { name: 'code', color: C.php },
  js: { name: 'symbol-method', color: C.js },
  mjs: { name: 'symbol-method', color: C.js },
  cjs: { name: 'symbol-method', color: C.js },
  jsx: { name: 'symbol-method', color: C.js },
  ts: { name: 'symbol-namespace', color: C.ts },
  tsx: { name: 'symbol-namespace', color: C.ts },
  mts: { name: 'symbol-namespace', color: C.ts },
  cts: { name: 'symbol-namespace', color: C.ts },
  vue: { name: 'code', color: C.data },
  svelte: { name: 'code', color: C.web },
  html: { name: 'code', color: C.web },
  htm: { name: 'code', color: C.web },
  twig: { name: 'code', color: C.data },
  blade: { name: 'code', color: C.web },
  xml: { name: 'code', color: C.web },
  css: { name: 'symbol-color', color: C.style },
  scss: { name: 'symbol-color', color: C.php },
  sass: { name: 'symbol-color', color: C.php },
  less: { name: 'symbol-color', color: C.style },
  json: { name: 'json', color: C.js },
  jsonc: { name: 'json', color: C.js },
  yml: { name: 'settings', color: C.conf },
  yaml: { name: 'settings', color: C.conf },
  toml: { name: 'settings', color: C.conf },
  ini: { name: 'settings', color: C.conf },
  env: { name: 'settings', color: C.conf },
  properties: { name: 'settings', color: C.conf },
  neon: { name: 'settings', color: C.conf },
  lock: { name: 'lock', color: C.conf },
  md: { name: 'markdown', color: C.ts },
  markdown: { name: 'markdown', color: C.ts },
  txt: { name: 'file-text' },
  log: { name: 'output', color: C.doc },
  csv: { name: 'table', color: C.data },
  sql: { name: 'database', color: C.db },
  py: { name: 'symbol-namespace', color: C.py },
  rb: { name: 'ruby', color: C.rb },
  java: { name: 'symbol-class', color: C.java },
  kt: { name: 'symbol-class', color: C.php },
  kts: { name: 'symbol-class', color: C.php },
  go: { name: 'symbol-namespace', color: C.go },
  rs: { name: 'symbol-namespace', color: C.rs },
  c: { name: 'symbol-namespace', color: C.ts },
  h: { name: 'symbol-namespace', color: C.php },
  cpp: { name: 'symbol-namespace', color: C.ts },
  hpp: { name: 'symbol-namespace', color: C.php },
  cs: { name: 'symbol-class', color: C.data },
  swift: { name: 'symbol-class', color: C.java },
  sh: { name: 'terminal', color: C.sh },
  bash: { name: 'terminal', color: C.sh },
  zsh: { name: 'terminal', color: C.sh },
  ps1: { name: 'terminal', color: C.ts },
  bat: { name: 'terminal', color: C.sh },
  png: { name: 'file-media', color: C.media },
  jpg: { name: 'file-media', color: C.media },
  jpeg: { name: 'file-media', color: C.media },
  gif: { name: 'file-media', color: C.media },
  webp: { name: 'file-media', color: C.media },
  svg: { name: 'file-media', color: C.web },
  ico: { name: 'file-media', color: C.media },
  bmp: { name: 'file-media', color: C.media },
  mp4: { name: 'device-camera-video', color: C.media },
  mp3: { name: 'unmute', color: C.media },
  pdf: { name: 'file-pdf', color: C.rb },
  zip: { name: 'file-zip', color: C.doc },
  gz: { name: 'file-zip', color: C.doc },
  tgz: { name: 'file-zip', color: C.doc },
  jar: { name: 'file-zip', color: C.doc },
  phar: { name: 'file-zip', color: C.php },
  woff: { name: 'text-size', color: C.doc },
  woff2: { name: 'text-size', color: C.doc },
  ttf: { name: 'text-size', color: C.doc },
  exe: { name: 'file-binary', color: C.doc },
  dll: { name: 'file-binary', color: C.doc },
  so: { name: 'file-binary', color: C.doc },
  patch: { name: 'diff', color: C.doc },
  diff: { name: 'diff', color: C.doc },
};

const BY_NAME: Record<string, FileIconSpec> = {
  '.gitignore': { name: 'circle-slash', color: C.conf },
  '.gitattributes': { name: 'settings', color: C.conf },
  '.gitmodules': { name: 'settings', color: C.conf },
  '.editorconfig': { name: 'settings', color: C.conf },
  '.env': { name: 'settings', color: C.conf },
  dockerfile: { name: 'package', color: C.ts },
  makefile: { name: 'tools', color: C.conf },
  license: { name: 'law', color: C.doc },
  'composer.json': { name: 'package', color: C.php },
  'package.json': { name: 'package', color: C.data },
  artisan: { name: 'terminal', color: C.rb },
};

/** Codicon name + color for a file path (by file name, then extension). */
export function fileIconName(path: string): FileIconSpec {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const lower = base.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  if (lower.startsWith('.env')) return BY_NAME['.env'];
  if (lower.endsWith('.blade.php')) return BY_EXT.blade;
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const spec = BY_EXT[lower.slice(dot + 1)];
    if (spec) return spec;
  }
  return { name: 'file' };
}

// ------------------------------------------------------------------ VS Code file icon theme

interface IconThemeData {
  css?: string;
  assoc: {
    file?: number;
    folder?: number;
    folderExpanded?: number;
    fileExtensions: Record<string, number>;
    fileNames: Record<string, number>;
    folderNames: Record<string, number>;
    folderNamesExpanded: Record<string, number>;
    languageIds: Record<string, number>;
  };
  extToLang: Record<string, string>;
  nameToLang: Record<string, string>;
}

let iconTheme: IconThemeData | null = typeof window !== 'undefined' ? ((window as { __ICONS__?: IconThemeData | null }).__ICONS__ ?? null) : null;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data;
    if (!m || m.kind !== 'event' || m.event !== '__iconTheme') return;
    const data = m.data as IconThemeData | null;
    iconTheme = data;
    const style = document.getElementById('jb-icon-theme');
    if (style) style.textContent = data?.css ?? '';
    window.dispatchEvent(new Event('jb-icontheme'));
  });
}

/** Icon theme definition index for a file name, like VS Code: file name, extensions (longest first), language, default. */
export function themeFileIcon(path: string): number | undefined {
  const t = iconTheme?.assoc;
  if (!t || !iconTheme) return undefined;
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name in t.fileNames) return t.fileNames[name];
  for (let i = name.indexOf('.'); i >= 0; i = name.indexOf('.', i + 1)) {
    const ext = name.slice(i + 1);
    if (ext in t.fileExtensions) return t.fileExtensions[ext];
  }
  const dot = name.lastIndexOf('.');
  const lang = iconTheme.nameToLang[name] ?? (dot >= 0 ? iconTheme.extToLang[name.slice(dot + 1)] : undefined);
  if (lang && lang in t.languageIds) return t.languageIds[lang];
  return t.file;
}

export function themeFolderIcon(name: string, expanded: boolean): number | undefined {
  const t = iconTheme?.assoc;
  if (!t) return undefined;
  const n = name.toLowerCase();
  if (expanded) return t.folderNamesExpanded[n] ?? t.folderExpanded ?? t.folderNames[n] ?? t.folder;
  return t.folderNames[n] ?? t.folder;
}

function themed(index: number, opts: IconOptions): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `jb-ti jbti-${index}${opts.className ? ' ' + opts.className : ''}`;
  if (opts.title) el.title = opts.title;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/**
 * Icon for a tree node spec: "file:<path>" / "folder:<name>" use the file icon theme (codicons as fallback),
 * anything else is a codicon name.
 */
export function nodeIcon(spec: string, expanded: boolean, opts: IconOptions = {}): HTMLSpanElement {
  if (spec.startsWith('file:')) return fileIcon(spec.slice(5), opts);
  if (spec.startsWith('folder:')) return folderIcon(expanded, opts, spec.slice(7));
  return icon(spec, opts);
}

export function fileIcon(path: string, opts: IconOptions = {}): HTMLSpanElement {
  const themedIndex = themeFileIcon(path);
  if (themedIndex !== undefined) return themed(themedIndex, opts);
  const spec = fileIconName(path);
  return icon(spec.name, { color: spec.color, ...opts });
}

export function folderIcon(open = false, opts: IconOptions = {}, name = ''): HTMLSpanElement {
  const themedIndex = themeFolderIcon(name, open);
  if (themedIndex !== undefined) return themed(themedIndex, opts);
  return icon(open ? 'folder-opened' : 'folder', opts);
}

export type GitStatusKind = ChangeKind | 'conflict';

/** CSS class coloring a file label by git status (IntelliJ FileStatus colors). */
export function gitStatusClass(kind: GitStatusKind | '.' | undefined): string {
  switch (kind) {
    case 'A':
    case 'C':
      return 'jb-git-added';
    case 'M':
    case 'T':
      return 'jb-git-modified';
    case 'D':
      return 'jb-git-deleted';
    case 'R':
      return 'jb-git-renamed';
    case 'U':
    case 'conflict':
      return 'jb-git-conflict';
    case '?':
      return 'jb-git-untracked';
    case '!':
      return 'jb-git-ignored';
    default:
      return '';
  }
}

/** IntelliJ FileStatus names. */
export function gitStatusLabel(kind: GitStatusKind | '.' | undefined): string {
  switch (kind) {
    case 'A':
      return 'Added';
    case 'C':
      return 'Copied';
    case 'M':
    case 'T':
      return 'Modified';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'U':
    case 'conflict':
      return 'Merged with conflicts';
    case '?':
      return 'Unversioned';
    case '!':
      return 'Ignored';
    default:
      return 'Up to date';
  }
}
