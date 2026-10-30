// "Merge into <branch>" dialog (IntelliJ GitMergeDialog): [Git Root] git merge [branch ▾], Modify options
// (--no-ff, --ff-only, --squash, -m, --no-commit, --no-verify, --allow-unrelated-histories), commit message for -m.
import { init, rpc } from '../shared/rpc';
import { dialogLayout, h, textArea } from '../shared/ui';
import { MERGE_OPTIONS, mergeOptionEnabled, type MergeOption } from '../../features/sync/options';
import type { MergeRequest, RefDialogInit, RepoData, RefItem } from '../../features/sync/protocol';
import { cmdLabel, dialogPage, hasRef, OptionsBar, RefField, rootCombo } from './common';

const data = init<RefDialogInit>();
let repo: RepoData = data.data;

const candidates = (d: RepoData): RefItem[] => d.refs.filter((r) => r.name !== d.branch);

const field = new RefField({ items: candidates(repo), value: data.ref ?? '', placeholder: 'Specify branch', onChange: () => validate() });
field.element.classList.add('sd-last');
const message = textArea({ rows: 4, monospace: true, spellcheck: true, placeholder: '' });
message.style.width = '100%';
message.addEventListener('input', () => validate());
const messageBox = h('div', { style: { display: 'none' } }, h('label.sd-label', null, 'Commit message:'), message);

const options = new OptionsBar<MergeOption>({
  defs: MERGE_OPTIONS,
  selected: [],
  title: 'Add Merge Options',
  enabled: mergeOptionEnabled,
  chips: MERGE_OPTIONS.map((o) => o.id).filter((id) => id !== 'm'),
  onChange: (sel) => {
    const show = sel.includes('m');
    messageBox.style.display = show ? '' : 'none';
    if (show && !message.value) message.value = `Merge branch '${field.value}'${repo.branch ? ` into ${repo.branch}` : ''}`;
    if (show) message.focus();
    validate();
  },
});

const root = rootCombo(data.repos, repo.root, async (r) => {
  repo = await rpc.call<RepoData>('repoData', r);
  field.setItems(candidates(repo));
  dlg.element.querySelector('.jb-dialog-title')!.textContent = repo.branch ? `Merge into ${repo.branch}` : 'Merge Changes';
  validate();
});

const body = h('div', null,
  h('div.sd-head', null, options.link),
  h('div.sd-cmd-row', null, root?.element, cmdLabel('git merge'), field.element),
  options.chips,
  messageBox,
);

const dlg = dialogLayout(dialogPage(560), {
  title: data.title,
  body,
  buttons: [
    { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
    { id: 'ok', label: 'Merge', primary: true, run: () => submit() },
  ],
});

function error(): string | undefined {
  const b = field.value;
  if (!b) return 'The merge branch should be selected.';
  if (!hasRef(repo.refs, b) && !/^[0-9a-f]{7,64}$/i.test(b)) return 'There is no matching branch.';
  if (repo.merged?.includes(b)) return `Branch '${b}' is already merged`;
  if (options.has('m') && !message.value.trim()) return 'Specify a message for the merge commit';
  return undefined;
}

let touched = !!data.ref;
function validate(): boolean {
  const e = error();
  dlg.setEnabled('ok', !e);
  dlg.setError(touched ? e : undefined);
  field.setInvalid(touched && !!e && e !== 'Specify a message for the merge commit');
  return !e;
}
field.input.addEventListener('input', () => (touched = true));

async function submit(): Promise<void> {
  touched = true;
  if (!validate()) return;
  const req: MergeRequest = { root: repo.root, ref: field.value, options: options.value, message: options.has('m') ? message.value : undefined };
  await rpc.call('ok', req);
}

rpc.on<string>('refresh', async (r) => {
  if (r !== repo.root) return;
  repo = await rpc.call<RepoData>('repoData', r);
  field.setItems(candidates(repo));
  validate();
});

validate();
field.focus();
