// Two small dialogs of the sync feature:
// - "Pull to <branch>" (IntelliJ GitPullDialog): [Git Root] git pull [remote ▾] [branch(es)], Modify options,
//   Cmd/Ctrl+F5 fetches the remote to update the branch list.
// - "Update Project": Update Type (merge / rebase), Clean working tree before update (stash / shelve),
//   "Don't show this dialog again".
import { init, rpc } from '../shared/rpc';
import { checkbox, comboBox, dialogLayout, formatShortcut, formSection, h, radioGroup } from '../shared/ui';
import { PULL_OPTIONS, pullOptionEnabled, type PullOption } from '../../features/sync/options';
import type { PullInit, PullRequest, RepoData, SavePolicy, UpdateInit, UpdateMethod, UpdateRequest } from '../../features/sync/protocol';
import { cmdLabel, dialogPage, OptionsBar, RefField, rootCombo } from '../merge-dialog/common';

const data = init<(PullInit & { kind: 'pull' }) | UpdateInit>();
if (data.kind === 'update') updateDialog(data);
else pullDialog(data);

function updateDialog(d: UpdateInit): void {
  const method = radioGroup<UpdateMethod>({
    options: [
      { value: 'merge', label: 'Merge incoming changes into the current branch' },
      { value: 'rebase', label: 'Rebase the current branch on top of incoming changes' },
    ],
    value: d.method,
  });
  const policy = radioGroup<SavePolicy>({
    options: [
      { value: 'stash', label: 'Using Stash' },
      { value: 'shelve', label: 'Using Shelve' },
    ],
    value: d.policy,
  });
  const dontShow = checkbox({ label: "Don't show this dialog again" });
  const body = h('div', null,
    formSection('Update Type', method.element),
    formSection('Clean working tree before update', policy.element),
    h('div', { style: { marginTop: '12px' } }, dontShow.element),
  );
  dialogLayout(dialogPage(440), {
    title: d.title,
    body,
    buttons: [
      { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
      {
        id: 'ok',
        label: 'OK',
        primary: true,
        run: async () => {
          const req: UpdateRequest = { method: method.value ?? 'merge', policy: policy.value ?? 'stash', dontShowAgain: dontShow.checked };
          await rpc.call('ok', req);
        },
      },
    ],
  });
  (document.querySelector('.jb-radio') as HTMLInputElement | null)?.focus();
}

function pullDialog(d: PullInit): void {
  let repo: RepoData = d.data;
  let branches = d.branches;
  const toItems = (bs: string[]) => bs.map((name) => ({ name, kind: 'remote' as const }));

  const remote = comboBox<string>({ options: repo.remotes.map((r) => ({ value: r, label: r })), value: d.remote, placeholder: 'No remotes', onChange: (r) => loadBranches(r) });
  remote.element.classList.add('sd-attached');
  remote.element.style.flex = '0 0 130px';
  const field = new RefField({ items: toItems(branches), value: d.ref ?? '', placeholder: 'Specify branch', multi: true, onChange: () => validate() });
  field.element.classList.add('sd-last');

  const options = new OptionsBar<PullOption>({ defs: PULL_OPTIONS, selected: [], title: 'Add Pull Options', enabled: pullOptionEnabled, onChange: () => validate() });

  const root = rootCombo(d.repos, repo.root, async (r) => {
    const res = await rpc.call<{ data: RepoData; remote?: string; branch?: string; branches: string[] }>('repoData', r);
    repo = res.data;
    branches = res.branches;
    remote.setOptions(repo.remotes.map((x) => ({ value: x, label: x })));
    if (res.remote) remote.set(res.remote);
    field.setItems(toItems(branches));
    field.setValue(res.branch ?? '');
    title.textContent = repo.branch ? `Pull to ${repo.branch}` : 'Pull';
    validate();
  });

  async function loadBranches(r: string): Promise<void> {
    branches = await rpc.call<string[]>('branches', { root: repo.root, remote: r });
    field.setItems(toItems(branches));
    if (field.value && !field.values.every((b) => branches.includes(b))) field.setValue('');
    validate();
  }

  const hint = h('div.sd-hint', null, `Press ${formatShortcut('CmdOrCtrl+F5')} to update branches`);
  const body = h('div', null,
    h('div.sd-head', null, options.link),
    h('div.sd-cmd-row', null, root?.element, cmdLabel('git pull'), remote.element, field.element),
    options.chips,
    hint,
  );
  const dlg = dialogLayout(dialogPage(600), {
    title: d.title,
    body,
    buttons: [
      { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
      { id: 'ok', label: 'Pull', primary: true, run: () => submit() },
    ],
  });
  const title = dlg.element.querySelector('.jb-dialog-title') as HTMLElement;

  let touched = !!d.ref;
  field.input.addEventListener('input', () => (touched = true));
  function error(): string | undefined {
    if (!repo.remotes.length) return 'No remotes';
    if (!remote.value) return 'Select the remote to pull from';
    if (!field.values.length) return 'The branch to pull from should be selected.';
    const bad = field.values.find((b) => !branches.includes(b));
    if (bad) return `There is no branch '${bad}' on ${remote.value}`;
    return undefined;
  }
  function validate(): boolean {
    const e = error();
    dlg.setEnabled('ok', !e);
    dlg.setError(touched || !repo.remotes.length ? e : undefined);
    field.setInvalid(touched && !!e);
    return !e;
  }

  async function submit(): Promise<void> {
    touched = true;
    if (!validate()) return;
    const req: PullRequest = { root: repo.root, remote: remote.value!, branches: field.values, options: options.value };
    await rpc.call('ok', req);
  }

  document.addEventListener('keydown', async (e) => {
    if (e.key === 'F5' && (e.metaKey || e.ctrlKey) && remote.value) {
      e.preventDefault();
      dlg.setBusy(true, 'Fetching…');
      try {
        branches = await rpc.call<string[]>('fetch', { root: repo.root, remote: remote.value });
        field.setItems(toItems(branches));
        dlg.setError(undefined);
      } catch (err) {
        dlg.setError(`Cannot load remote branches: ${err instanceof Error ? err.message : err}`);
      } finally {
        dlg.setBusy(false);
        validate();
      }
    }
  });

  rpc.on<string>('refresh', async (r) => {
    if (r !== repo.root) return;
    const res = await rpc.call<{ data: RepoData; remote?: string; branches: string[] }>('repoData', r);
    repo = res.data;
    remote.setOptions(repo.remotes.map((x) => ({ value: x, label: x })));
    if (!remote.value || !repo.remotes.includes(remote.value)) {
      if (res.remote) remote.set(res.remote);
      branches = res.branches;
    } else {
      branches = await rpc.call<string[]>('branches', { root: r, remote: remote.value });
    }
    field.setItems(toItems(branches));
    validate();
  });

  validate();
  field.focus();
}
