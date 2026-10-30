// The user's VS Code file icon theme (workbench.iconTheme) for webviews: loads the theme JSON from the extension that
// contributes it and turns it into CSS (icon definitions as classes, fonts as @font-face) plus association tables the
// webview resolves file/folder names with (src/webview/shared/ui/icons.ts). Webviews get it through webviewHtml()
// and the '__iconTheme' event when the icon theme or the color theme kind changes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Association tables; values are icon definition indexes (CSS class `jbti-<index>`). */
export interface IconAssociations {
  file?: number;
  folder?: number;
  folderExpanded?: number;
  fileExtensions: Record<string, number>;
  fileNames: Record<string, number>;
  folderNames: Record<string, number>;
  folderNamesExpanded: Record<string, number>;
  languageIds: Record<string, number>;
}

export interface IconThemePayload {
  css: string;
  assoc: IconAssociations;
  /** lower-case extension (no dot) / file name → language id, for languageIds associations */
  extToLang: Record<string, string>;
  nameToLang: Record<string, string>;
}

interface RawAssoc {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}

interface RawTheme extends RawAssoc {
  iconDefinitions?: Record<string, { iconPath?: string; fontCharacter?: string; fontColor?: string; fontSize?: string; fontId?: string }>;
  fonts?: { id: string; src: { path: string; format: string }[]; weight?: string; style?: string; size?: string }[];
  light?: RawAssoc;
  highContrast?: RawAssoc;
}

interface Loaded {
  dir: string;
  theme: RawTheme;
}

let cache: { key: string; loaded: Loaded | undefined } | undefined;

/** Roots webviews must be allowed to load icon images/fonts from. */
export function iconThemeRoots(): vscode.Uri[] {
  return vscode.extensions.all.filter((e) => e.packageJSON?.contributes?.iconThemes?.length).map((e) => e.extensionUri);
}

function stripJsonComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function load(): Loaded | undefined {
  const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');
  const key = String(id);
  if (cache?.key === key) return cache.loaded;
  let loaded: Loaded | undefined;
  if (id) {
    for (const ext of vscode.extensions.all) {
      const entry = (ext.packageJSON?.contributes?.iconThemes as { id: string; path: string }[] | undefined)?.find((t) => t.id === id);
      if (!entry) continue;
      try {
        const file = path.join(ext.extensionPath, entry.path);
        loaded = { dir: path.dirname(file), theme: JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8'))) };
      } catch {
        loaded = undefined;
      }
      break;
    }
  }
  cache = { key, loaded };
  return loaded;
}

function languageTables(): { extToLang: Record<string, string>; nameToLang: Record<string, string> } {
  const extToLang: Record<string, string> = {};
  const nameToLang: Record<string, string> = {};
  for (const ext of vscode.extensions.all) {
    for (const l of (ext.packageJSON?.contributes?.languages ?? []) as { id: string; extensions?: string[]; filenames?: string[] }[]) {
      for (const e of l.extensions ?? []) {
        const k = e.replace(/^\./, '').toLowerCase();
        if (k && !(k in extToLang)) extToLang[k] = l.id;
      }
      for (const n of l.filenames ?? []) if (!(n.toLowerCase() in nameToLang)) nameToLang[n.toLowerCase()] = l.id;
    }
  }
  return { extToLang, nameToLang };
}

const cssString = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The icon theme as CSS + tables for one webview, or undefined when no (file) icon theme is active. */
export function iconThemePayload(webview: vscode.Webview): IconThemePayload | undefined {
  const l = load();
  const defs = l?.theme.iconDefinitions;
  if (!l || !defs) return undefined;
  const { theme, dir } = l;
  const uri = (p: string) => webview.asWebviewUri(vscode.Uri.file(path.resolve(dir, p))).toString();
  const index = new Map<string, number>();
  const css: string[] = [];
  const fonts = new Map<string, { size?: string }>();
  for (const f of theme.fonts ?? []) {
    fonts.set(f.id, { size: f.size });
    const src = f.src.map((s) => `url('${uri(s.path)}') format('${s.format}')`).join(', ');
    css.push(`@font-face{font-family:${cssString(`jbti-${f.id}`)};src:${src};font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'};font-display:block}`);
  }
  const defaultFont = theme.fonts?.[0]?.id;
  for (const [id, d] of Object.entries(defs)) {
    const i = index.size;
    index.set(id, i);
    const sel = `.jbti-${i}::before`;
    if (d.iconPath) css.push(`${sel}{content:'';background-image:url('${uri(d.iconPath)}')}`);
    else if (d.fontCharacter) {
      const font = d.fontId ?? defaultFont;
      const size = d.fontSize ?? (font ? fonts.get(font)?.size : undefined);
      css.push(
        `${sel}{content:${cssString(d.fontCharacter.replace(/^\\/, '\\'))};${font ? `font-family:${cssString(`jbti-${font}`)};` : ''}${d.fontColor ? `color:${d.fontColor};` : ''}${size ? `font-size:${size};` : ''}}`,
      );
    }
  }
  const kind = vscode.window.activeColorTheme.kind;
  const variant = kind === vscode.ColorThemeKind.Light ? theme.light : kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight ? theme.highContrast : undefined;
  const one = (k: 'file' | 'folder' | 'folderExpanded') => {
    const id = variant?.[k] ?? theme[k];
    return id !== undefined ? index.get(id) : undefined;
  };
  const table = (k: 'fileExtensions' | 'fileNames' | 'folderNames' | 'folderNamesExpanded' | 'languageIds') => {
    const out: Record<string, number> = {};
    for (const src of [theme[k], variant?.[k]]) {
      for (const [name, id] of Object.entries(src ?? {})) {
        const i = index.get(id);
        if (i !== undefined) out[k === 'languageIds' ? name : name.toLowerCase()] = i;
      }
    }
    return out;
  };
  return {
    css: css.join('\n'),
    assoc: {
      file: one('file'),
      folder: one('folder'),
      folderExpanded: one('folderExpanded'),
      fileExtensions: table('fileExtensions'),
      fileNames: table('fileNames'),
      folderNames: table('folderNames'),
      folderNamesExpanded: table('folderNamesExpanded'),
      languageIds: table('languageIds'),
    },
    ...languageTables(),
  };
}

/** Fires when webviews should reload the icon theme (icon theme setting or color theme kind changed). */
export function onDidChangeIconTheme(listener: () => void): vscode.Disposable {
  let kind = vscode.window.activeColorTheme.kind;
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('workbench.iconTheme')) listener();
    }),
    vscode.window.onDidChangeActiveColorTheme((t) => {
      if (t.kind !== kind) {
        kind = t.kind;
        listener();
      }
    }),
    vscode.extensions.onDidChange(() => {
      cache = undefined;
      listener();
    }),
  );
}
