// Merge window webview ("Merge Revisions for <file>"): ide-diff 3-way merge viewer with IntelliJ's bottom buttons
// Accept Left / Accept Right / Apply / Cancel. The host writes the result, stages it and closes the tab.
import { createMergeViewer } from '@ide-diff/viewer';
import { languageFor } from '../shared/languages';
import { init, rpc } from '../shared/rpc';
import type { MergeInit } from '../../features/diff/protocol';
import { BASE_CSS, injectCss, onThemeChange, theme } from '../diff/theme';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const data = init<MergeInit>();

injectCss(
  BASE_CSS +
    `
.merge-host { flex: 1; min-height: 0; }
.bottom { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--jb-border); }
.jb-apply-link { color: var(--vscode-textLink-foreground); text-decoration: none; }
.jb-apply-link:hover { text-decoration: underline; }
.bottom .spacer { flex: 1; }
`,
);

const app = document.getElementById('app')!;
app.className = `idd-theme-${theme()}`;
const host = document.createElement('div');
host.className = 'merge-host';
const bottom = document.createElement('div');
bottom.className = 'bottom';
app.append(host, bottom);

const button = (text: string, primary = false): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = primary ? 'jb-btn primary' : 'jb-btn';
  b.textContent = text;
  return b;
};
const acceptLeft = button('Accept Left');
const acceptRight = button('Accept Right');
const spacer = document.createElement('span');
spacer.className = 'spacer';
const apply = button('Apply', true);
apply.title = `Apply (${IS_MAC ? '⌘⏎' : 'Ctrl+Enter'})`;
const cancel = button('Cancel');
bottom.append(acceptLeft, acceptRight, spacer, apply, cancel);

// the toolbar shows IntelliJ's status ("1 change, 2 conflicts" / "All conflicts resolved") itself
const viewer = createMergeViewer(host, {
  left: data.left,
  base: data.base,
  right: data.right,
  leftTitle: data.leftTitle,
  baseTitle: 'Result',
  rightTitle: data.rightTitle,
  language: languageFor(data.language),
  theme: theme(),
});
const initial = viewer.getResult();
const changed = (): boolean => viewer.getResult() !== initial;
onThemeChange((t) => {
  app.className = `idd-theme-${t}`;
  viewer.setOptions({ theme: t });
});

// "All changes have been processed" balloon: IntelliJ adds an "Apply Changes" link that finishes the merge
const balloon = host.querySelector<HTMLElement>('.idd-merge-balloon');
if (balloon) {
  new MutationObserver(() => {
    if (!balloon.classList.contains('idd-visible') || balloon.querySelector('.jb-apply-link')) return;
    const link = document.createElement('a');
    link.className = 'jb-apply-link';
    link.href = '#';
    link.textContent = 'Apply Changes';
    link.addEventListener('mousedown', (e) => e.preventDefault());
    link.addEventListener('click', (e) => {
      e.preventDefault();
      void doApply();
    });
    const close = balloon.querySelector('.idd-merge-balloon-close');
    if (close) close.before(link);
    else balloon.append(link);
  }).observe(balloon, { attributes: true, attributeFilter: ['class'], childList: true });
}

let busy = false;
async function run(fn: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true;
  for (const b of [acceptLeft, acceptRight, apply, cancel]) b.disabled = true;
  try {
    await fn();
  } catch {
    /* the host reports errors */
  } finally {
    busy = false;
    for (const b of [acceptLeft, acceptRight, apply, cancel]) b.disabled = false;
  }
}

const doApply = (): Promise<void> => run(() => rpc.call('apply', { text: viewer.getResult(), status: viewer.getStatus() }));
const doCancel = (): Promise<void> => run(() => rpc.call('cancel', changed()));
acceptLeft.addEventListener('click', () => void run(() => rpc.call('accept', { side: 'left', changed: changed() })));
acceptRight.addEventListener('click', () => void run(() => rpc.call('accept', { side: 'right', changed: changed() })));
apply.addEventListener('click', () => void doApply());
cancel.addEventListener('click', () => void doCancel());

document.addEventListener('keydown', (e) => {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    void doApply();
  } else if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.idd-popup')) {
    e.preventDefault();
    void doCancel();
  }
});
