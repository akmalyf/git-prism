// "Reset Head" / "Git Reset" dialog: [Git Root], To Commit (validated live: "<hash> <subject> by <author>"),
// reset mode Soft / Mixed / Hard / Keep with IntelliJ's descriptions (GitBundle git.reset.mode.*), [Reset] [Cancel].
import { init, rpc } from '../shared/rpc';
import { dialogLayout, formatPrettyDateTime, formGrid, formRow, h, radioGroup, setFormatLocale, shortHash } from '../shared/ui';
import type { CommitInfo, RepoData, ResetInit, ResetMode, ResetRequest } from '../../features/sync/protocol';
import { dialogPage, RefField, rootCombo } from '../merge-dialog/common';

const data = init<ResetInit>();
if (data.locale) setFormatLocale(data.locale);
let repo: RepoData = data.data;
let info: CommitInfo | null = null;
let seq = 0;

const field = new RefField({ items: repo.refs, value: data.ref ?? 'HEAD', placeholder: 'HEAD', onChange: () => check() });
field.element.classList.add('sd-first', 'sd-last');
const commitText = h('div.sd-hint');
const branchText = h('span');

async function loadRepo(r: string): Promise<void> {
  const res = await rpc.call<{ data: RepoData; hasChanges: boolean }>('repoData', r);
  repo = res.data;
  field.setItems(repo.refs);
  renderBranch();
  void check();
}
const root = rootCombo(data.repos, repo.root, (r) => void loadRepo(r));
rpc.on<string>('refresh', (r) => {
  if (r === repo.root) void loadRepo(r);
});

const MODES: { value: ResetMode; label: string; description: string }[] = [
  { value: 'soft', label: 'Soft', description: "Files won't change, differences will be staged for commit." },
  { value: 'mixed', label: 'Mixed', description: "Files won't change, differences won't be staged." },
  { value: 'hard', label: 'Hard', description: 'Files will be reverted to the state of the selected commit.\nWarning: any local changes will be lost.' },
  { value: 'keep', label: 'Keep', description: 'Files will be reverted to the state of the selected commit,\nbut local changes will be kept intact.' },
];
const mode = radioGroup<ResetMode>({ options: MODES, value: 'mixed' });
mode.element.querySelectorAll<HTMLElement>('.jb-radio-desc').forEach((el) => (el.style.whiteSpace = 'pre-line'));

function renderBranch(): void {
  branchText.textContent = repo.branch ?? 'HEAD (detached)';
}
renderBranch();

const body = h('div', null,
  h('div.jb-dialog-message', { style: { marginBottom: '10px' } }, 'This will reset the current branch head to the selected commit,\nand update the working tree and the index according to the selected mode:'),
  formGrid(
    root ? formRow('Git Root:', root.element) : null,
    formRow('Current Branch:', branchText),
    formRow('To Commit:', h('div', null, field.element, commitText)),
  ),
  h('div', { style: { marginTop: '12px' } }, mode.element),
);

const dlg = dialogLayout(dialogPage(520), {
  title: data.title,
  body,
  buttons: [
    { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
    { id: 'ok', label: 'Reset', primary: true, run: () => submit() },
  ],
});

async function check(): Promise<void> {
  const my = ++seq;
  dlg.setEnabled('ok', false);
  const rev = field.value;
  const res = rev ? await rpc.call<CommitInfo | null>('validate', { root: repo.root, rev }) : null;
  if (my !== seq) return;
  info = res;
  field.setInvalid(!info);
  commitText.textContent = info ? `${shortHash(info.hash)} ${info.subject} by ${info.author}, ${formatPrettyDateTime(info.date)}` : '';
  dlg.setError(info ? undefined : 'The specified commit expression did not pass validation.');
  dlg.setEnabled('ok', !!info);
}

async function submit(): Promise<void> {
  if (!info) return;
  const req: ResetRequest = { root: repo.root, commit: info.hash, mode: mode.value ?? 'mixed' };
  await rpc.call('ok', req);
}

void check();
field.focus();
