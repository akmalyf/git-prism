// "Edit Commit Message" / "Squashed Commit Message" dialog: a label, a monospace multiline message editor, OK / Cancel.
import { init, rpc } from '../shared/rpc';
import { dialogLayout, ensureStyles, formatShortcut, h, icon, textArea } from '../shared/ui';
import type { MessageDialogInit } from '../../features/commitOps/protocol';

const data = init<MessageDialogInit>();
ensureStyles();

const style = document.createElement('style');
style.textContent = `
html, body, #app { height: 100%; margin: 0; }
.msg-body { display: flex; flex-direction: column; gap: 8px; height: 100%; box-sizing: border-box; }
.msg-label { color: var(--jb-fg); user-select: text; -webkit-user-select: text; }
.msg-warning { display: flex; gap: 6px; align-items: flex-start; padding: 6px 10px; border-radius: var(--jb-radius-sm);
  background: var(--vscode-inputValidation-warningBackground, transparent); border: 1px solid var(--vscode-inputValidation-warningBorder, var(--jb-warning)); }
.msg-warning .codicon { color: var(--jb-warning); }
.msg-editor { flex: 1 1 auto; min-height: 160px; width: 100%; box-sizing: border-box; resize: none;
  font-family: var(--jb-mono); font-size: var(--jb-mono-size); line-height: 1.45; padding: 8px 10px; }
.msg-hint { color: var(--jb-fg-muted); font-size: 12px; }
`;
document.head.appendChild(style);

const editor = textArea({ value: data.message, monospace: true, spellcheck: true, rows: 12 });
editor.classList.add('msg-editor');
const body = h('div.msg-body', null,
  h('div.msg-label', null, data.label),
  data.warning ? h('div.msg-warning', null, icon('warning'), h('span', null, data.warning)) : null,
  editor,
  h('div.msg-hint', null, `Press ${formatShortcut('CmdOrCtrl+Enter')} to apply changes`),
);

const dlg = dialogLayout(document.getElementById('app')!, {
  title: data.title,
  body,
  buttons: [
    { id: 'ok', label: data.okLabel || 'OK', primary: true, run: () => submit() },
    { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
  ],
});
dlg.body.style.display = 'flex';
dlg.body.style.flexDirection = 'column';

// IntelliJ only disables OK for a blank message
const validate = () => {
  dlg.setEnabled('ok', !!editor.value.trim());
  dlg.setError(undefined);
};
editor.addEventListener('input', validate);

async function submit(): Promise<false | void> {
  if (!editor.value.trim()) {
    validate();
    return false;
  }
  dlg.setBusy(true);
  try {
    const r = await rpc.call<{ error?: string }>('ok', editor.value);
    if (r?.error) {
      dlg.setError(r.error);
      return false;
    }
  } catch (e) {
    dlg.setError((e as Error).message);
    return false;
  } finally {
    dlg.setBusy(false);
  }
}

validate();
editor.focus();
// caret at the start, like IntelliJ's GitNewCommitMessageActionDialog
editor.setSelectionRange(0, 0);
editor.scrollTop = 0;
