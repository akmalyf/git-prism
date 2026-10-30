// "Compare HEAD, Staged and Local Versions" window of the staging area (host: src/features/commit/threeWay.ts):
// ide-diff's three-pane viewer with HEAD | Staged | Local. The staged (middle) version is editable; typing and the
// >> / << chunk arrows (take HEAD's chunk = unstage it, take Local's chunk = stage it) are written to the index.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createMergeViewer, injectStyles, type MergeViewer } from '@ide-diff/viewer';
import { languageFor } from '../shared/languages';
import { init, rpc } from '../shared/rpc';
import type { ThreeWayInit, ThreeWayPayload } from '../../features/commit/protocol';
import { BASE_CSS, el, FileNav, iconButton, injectCss, IS_MAC, key, onThemeChange, rethemeIcons, sep, theme } from '../commit-diff/chrome';

const data = init<ThreeWayInit>();
const files = data.files ?? [];
let index = data.index ?? 0;
let payload: ThreeWayPayload | undefined;
let viewer: MergeViewer | undefined;
/** staged text as last loaded or written */
let sent = '';
let writeTimer: number | undefined;
let loadSeq = 0;

injectStyles();
injectCss(
  BASE_CSS +
    `
/* a comparison, not a merge: no resolve status, balloons or "apply non-conflicting" actions */
.tw .idd-status, .tw .idd-merge-actions, .tw .idd-merge-balloon, .tw .idd-merge-done { display: none !important; }
.tw.ro .idd-gutter-op, .tw.ro .idd-merge-ops { display: none !important; }
`,
);

const app = document.getElementById('app')!;
app.className = `idd-theme-${theme()}`;
const stage = el('div');
stage.id = 'stage';
app.append(stage);

const nav = new FileNav(files, () => index, (i) => switchTo(i), stage);

function extraButtons(): HTMLElement[] {
  return [sep(), iconButton('generalEdit', `Jump to Source (${key('F4 or ⌘↓', 'F4')})`, jump, 'jumpSource'), ...nav.buttons()];
}

function updateToolbar(): void {
  nav.update();
  const jumpBtn = document.getElementById('jumpSource') as HTMLButtonElement | null;
  if (jumpBtn) jumpBtn.disabled = !payload?.canJump;
}

function addToolbarButtons(): void {
  const left = stage.querySelector('.idd-toolbar-left');
  if (!left || left.querySelector('#jumpSource')) return;
  left.append(...extraButtons());
  updateToolbar();
}

onThemeChange((t) => {
  app.className = `idd-theme-${t}`;
  rethemeIcons();
  viewer?.setOptions({ theme: t });
});

function flush(): void {
  window.clearTimeout(writeTimer);
  writeTimer = undefined;
  if (!viewer || !payload?.editable) return;
  const text = viewer.getResult();
  if (text === sent) return;
  sent = text;
  rpc.call('writeStaged', { index: payload.index, text }).catch(() => undefined);
}

function render(p: ThreeWayPayload): void {
  flush();
  viewer?.dispose();
  viewer = undefined;
  nav.hideHint();
  payload = p;
  if (p.type !== 'text') {
    const root = el('div', 'fb idd-root');
    const toolbar = el('div', 'idd-toolbar');
    const left = el('div', 'idd-toolbar-left');
    left.append(...extraButtons().slice(1));
    toolbar.append(left, el('div', 'idd-toolbar-spacer'));
    root.append(toolbar, el('div', 'fb-body', p.message ?? ''));
    stage.replaceChildren(root);
    updateToolbar();
    return;
  }
  const container = el('div', `viewer tw${p.editable ? '' : ' ro'}`);
  stage.replaceChildren(container);
  sent = p.staged;
  viewer = createMergeViewer(container, {
    left: p.head,
    base: p.staged,
    right: p.local,
    leftTitle: p.headTitle,
    baseTitle: p.stagedTitle,
    rightTitle: p.localTitle,
    language: languageFor(p.language),
    theme: theme(),
    extensions: p.editable ? [] : [EditorState.readOnly.of(true)],
  });
  viewer.onDidChange(() => {
    if (payload?.editable && writeTimer === undefined) writeTimer = window.setTimeout(flush, 400);
  });
  addToolbarButtons();
  updateToolbar();
}

async function load(i: number): Promise<void> {
  const seq = ++loadSeq;
  index = i;
  nav.update();
  try {
    const p = await rpc.call<ThreeWayPayload>('load', i);
    if (seq === loadSeq) render(p);
  } catch (e) {
    if (seq !== loadSeq) return;
    const f = files[i];
    render({
      index: i,
      key: f?.key ?? '',
      path: f?.path ?? '',
      language: 'plaintext',
      type: 'message',
      message: e instanceof Error ? e.message : String(e),
      head: '',
      staged: '',
      local: '',
      headTitle: 'HEAD',
      stagedTitle: 'Staged',
      localTitle: 'Local',
      editable: false,
      canJump: false,
    });
  }
}

function switchTo(i: number): void {
  if (i < 0 || i >= files.length) return;
  flush();
  nav.closePopup();
  void load(i);
}

/** Jump to Source: the caret line when the local (right) pane has the focus, else the top of the file. */
function jump(): void {
  if (!payload?.canJump) return;
  const editors = [...stage.querySelectorAll<HTMLElement>('.cm-editor')];
  const right = editors[editors.length - 1];
  const view = right && right.contains(document.activeElement) ? EditorView.findFromDOM(right) : null;
  const line = view ? view.state.doc.lineAt(view.state.selection.main.head).number - 1 : 0;
  flush();
  rpc.call('jump', { index: payload.index, line }).catch(() => undefined);
}

document.addEventListener(
  'keydown',
  (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const arrow = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const fileNav = arrow && e.shiftKey && !e.metaKey && (IS_MAC ? e.ctrlKey && !e.altKey : e.altKey && !e.ctrlKey);
    if (e.key !== 'F7' && e.key !== 'Shift') nav.hideHint();
    if (fileNav && files.length > 1 && !nav.popupOpen) nav.move(arrow);
    else if ((e.key === 'F4' && !e.altKey && !mod && !e.shiftKey) || (IS_MAC && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowDown')) jump();
    else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') flush();
    else if (e.key === 'F7' && !mod && !e.altKey && !nav.popupOpen && viewer) {
      if (e.shiftKey) viewer.goToPreviousChange();
      else viewer.goToNextChange();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || nav.popupOpen || document.querySelector('.idd-popup')) return;
  if (nav.hideHint()) return;
  flush();
  rpc.call('close').catch(() => undefined);
});

rpc.on<ThreeWayPayload>('reload', (p) => {
  if (p.index !== index) return;
  if (!viewer || payload?.type !== 'text' || p.type !== 'text' || p.editable !== payload.editable) return render(p);
  const pending = writeTimer !== undefined || viewer.getResult() !== sent;
  const next: Parameters<MergeViewer['setOptions']>[0] = {};
  if (p.head !== payload.head) next.left = p.head;
  if (p.local !== payload.local) next.right = p.local;
  // the index changed outside this window: show the new staged version (edits here win while they're pending)
  if (!pending && p.staged !== sent) {
    next.base = p.staged;
    next.result = p.staged;
    sent = p.staged;
  }
  if (p.headTitle !== payload.headTitle) next.leftTitle = p.headTitle;
  payload = { ...p, staged: pending ? payload.staged : p.staged };
  if (Object.keys(next).length) viewer.setOptions(next);
  updateToolbar();
});

window.addEventListener('blur', flush);
window.addEventListener('beforeunload', flush);

void load(index);
