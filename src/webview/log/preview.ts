// Diff preview of the log (IntelliJ VcsLogChangeProcessor, "Show Diff Preview" right/bottom): an embedded,
// read-only @ide-diff viewer for the file selected in the changes tree, fed by the host's fileContents RPC.
import { createDiffViewer, type DiffViewerHost } from '@ide-diff/viewer';
import { EMPTY_TREE, type FileContentsResult } from '../../features/log/protocol';
import { languageFor } from '../shared/languages';
import { rpc } from '../shared/rpc';
import { emptyState, h } from '../shared/ui';
import type { FileItem } from './changes';
import { isLightTheme } from './graphpaint';

const EXT_LANG: Record<string, string> = {
  php: 'php', phtml: 'php', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  cts: 'typescript', json: 'json', jsonc: 'json', html: 'html', htm: 'html', vue: 'html', twig: 'twig', hbs: 'handlebars', css: 'css', scss: 'scss', less: 'less',
  xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', md: 'markdown', markdown: 'markdown', py: 'python', sql: 'sql', go: 'go', java: 'java', rs: 'rust',
  c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', sh: 'shell', bash: 'shell', zsh: 'shell', ini: 'ini', properties: 'ini', env: 'ini', toml: 'ini',
  rb: 'ruby', swift: 'swift', kt: 'kotlin', kts: 'kotlin', cs: 'csharp', ps1: 'powershell', pug: 'pug',
};

export function languageIdOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  return EXT_LANG[name.slice(name.lastIndexOf('.') + 1)] ?? '';
}

const short = (h: string) => (h === EMPTY_TREE ? '' : h.slice(0, 8));

export class DiffPreview {
  readonly element: HTMLElement;
  private readonly host: HTMLElement;
  private readonly title: HTMLElement;
  private viewer: DiffViewerHost | undefined;
  private seq = 0;
  private current: FileItem | undefined;
  private active = false;

  constructor() {
    this.title = h('div.lg-preview-title');
    this.host = h('div.lg-preview-host');
    this.element = h('div.lg-preview', null, this.title, this.host);
    new MutationObserver(() => this.viewer?.setOptions({ theme: isLightTheme() ? 'light' : 'dark' })).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.empty('No file selected');
  }

  /** Visible: loads diffs; hidden: ignores selection changes (and frees the editors). */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      this.viewer?.dispose();
      this.viewer = undefined;
      this.empty('No file selected');
    } else void this.show(this.current);
  }

  private empty(text: string): void {
    this.viewer?.dispose();
    this.viewer = undefined;
    this.title.textContent = '';
    this.host.replaceChildren(emptyState(text));
  }

  async show(item: FileItem | undefined): Promise<void> {
    this.current = item;
    if (!this.active) return;
    const seq = ++this.seq;
    if (!item) return this.empty('No file selected');
    const { group, file } = item;
    let res: FileContentsResult;
    try {
      res = await rpc.call<FileContentsResult>('fileContents', { root: group.root, path: file.path, oldPath: file.oldPath, kind: file.kind, from: group.from, to: group.to });
    } catch (e) {
      if (seq === this.seq) this.empty(`Cannot load file: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (seq !== this.seq) return;
    this.title.textContent = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
    if (res.binary || res.tooLarge) {
      this.empty(res.binary ? 'Binary files differ' : 'File is too large to show the diff');
      this.title.textContent = file.path;
      return;
    }
    const originalTitle = file.kind === 'A' || group.from === EMPTY_TREE ? 'No previous revision' : short(group.from);
    const modifiedTitle = file.kind === 'D' ? 'Deleted' : short(group.to);
    const language = languageFor(languageIdOf(file.path));
    if (this.viewer) {
      this.viewer.setOptions({ original: res.original, modified: res.modified, originalTitle, modifiedTitle, language });
      return;
    }
    this.host.replaceChildren();
    this.viewer = createDiffViewer(this.host, {
      original: res.original,
      modified: res.modified,
      originalTitle,
      modifiedTitle,
      language,
      theme: isLightTheme() ? 'light' : 'dark',
      readOnly: true,
      collapseUnchanged: true,
    });
  }

  layout(): void {
    this.viewer?.layout();
  }
}
