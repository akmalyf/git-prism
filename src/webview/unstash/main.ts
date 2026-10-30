// Stash dialogs: "Stash" (Git Root, Current branch, Message, Keep index, Include untracked files → Create Stash),
// "Unstash Changes" (Git Root, Current branch, Stashes list with View / Drop / Clear, Pop stash, Reinstate index,
// As new branch → Apply Stash / Pop Stash / Branch) and "Unstash Changes in <root>" (GitUnstashAsDialog).
import type { RepoChoice, StashItem, StashRequest, UnstashInit, UnstashRequest } from '../../features/stash/protocol';
import { init, rpc } from '../shared/rpc';
import {
  button,
  checkbox,
  comboBox,
  dialogLayout,
  ensureStyles,
  formatDateTime,
  formatPrettyDateTime,
  h,
  setFormatLocale,
  setTooltip,
  textField,
  Tree,
  type DialogLayout,
  type TreeNode,
} from '../shared/ui';
import { errorText, injectCss } from '../stash/common';

ensureStyles();
injectCss();
const data = init<UnstashInit>();
setFormatLocale(data.locale);
const app = document.getElementById('app')!;

const row = (label: string, ...control: (Node | string)[]) => h('div.sv-row', null, h('label.sv-label', null, label), ...control);

function repoCombo(repos: RepoChoice[], value: string, onChange: (root: string) => void) {
  return comboBox({ options: repos.map((r) => ({ value: r.root, label: r.name, icon: 'repo', description: r.root })), value, onChange });
}

/** "As new branch" + Pop stash + Reinstate index, the OK label following IntelliJ's updateOkButtonText(). */
function unstashOptions(getDlg: () => DialogLayout) {
  const branchErr = h('div.sv-field-error');
  const branch = textField({ placeholder: '', onInput: () => update() });
  setTooltip(branch, 'If non-empty name is entered, the stash is checked out as a new branch');
  const pop = checkbox({ label: 'Pop stash', title: 'If selected the stash is dropped after it is applied', onChange: () => update() });
  const index = checkbox({ label: 'Reinstate index', title: 'Attempt to reinstate index as well as working tree changes' });
  let valid = true;
  const update = async () => {
    const b = branch.value.trim();
    pop.setDisabled(!!b);
    index.setDisabled(!!b);
    getDlg().setLabel('ok', b ? 'Branch' : pop.checked ? 'Pop Stash' : 'Apply Stash');
    const err = b ? await rpc.call<string | undefined>('validateBranch', b) : undefined;
    valid = !err;
    branchErr.textContent = err ?? '';
    onValidity?.();
  };
  let onValidity: (() => void) | undefined;
  return {
    branch,
    pop,
    index,
    branchErr,
    update,
    get valid() {
      return valid;
    },
    onValidity(cb: () => void) {
      onValidity = cb;
    },
    request(repoRoot: string, hash: string): UnstashRequest {
      const b = branch.value.trim();
      return { repoRoot, hash, pop: !b && pop.checked, index: !b && index.checked, branch: b || undefined };
    },
  };
}

function stashLabel(s: StashItem): string {
  return `${s.ref}: ${s.branch ? `On ${s.branch}: ` : ''}${s.message}`;
}

if (data.mode === 'stash') {
  let repoRoot = data.repoRoot;
  const branchEl = h('span.sv-value');
  const setBranch = async () => {
    const b = await rpc.call<string | undefined>('branch', { repoRoot }).catch(() => undefined);
    branchEl.textContent = b ?? 'HEAD (detached)';
  };
  const message = textField({ placeholder: '' });
  setTooltip(message, 'Enter stash message here');
  const keep = checkbox({ label: 'Keep index', title: 'If this checkbox is selected, all changes already added to the index are left intact' });
  const untracked = checkbox({ label: 'Include untracked files', title: 'Also stash untracked files (git stash --include-untracked)' });
  const rows: Node[] = [];
  // paths belong to the repository they were chosen in: no root switching then
  if (data.repos.length > 1 && !data.paths?.length) rows.push(row('Git Root:', repoCombo(data.repos, repoRoot, (v) => ((repoRoot = v), void setBranch())).element));
  else if (data.repos.length > 1) rows.push(row('Git Root:', h('span.sv-value', null, data.repos.find((r) => r.root === repoRoot)?.name ?? repoRoot)));
  rows.push(row('Current branch:', branchEl), row('Message:', message), h('div.sv-options', null, keep.element, untracked.element));
  if (data.paths?.length) rows.push(h('div.sv-hint', null, `Only changes in: ${data.paths.join(', ')}`));
  const dlg = dialogLayout(app, {
    title: 'Stash',
    body: h('div.sv-dialog-body', null, ...rows),
    buttons: [
      {
        id: 'ok',
        label: 'Create Stash',
        primary: true,
        run: async () => {
          const req: StashRequest = { repoRoot, message: message.value, keepIndex: keep.checked, untracked: untracked.checked, paths: data.paths };
          dlg.setBusy(true, 'Stashing Changes…');
          try {
            await rpc.call('stash', req);
          } catch (e) {
            dlg.setError(errorText(e));
            return false;
          } finally {
            dlg.setBusy(false);
          }
          return undefined;
        },
      },
      { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
    ],
  });
  void setBranch();
  message.focus();
} else if (data.mode === 'unstashAs') {
  let dlg!: DialogLayout;
  const o = unstashOptions(() => dlg);
  const body = h('div.sv-dialog-body', null,
    row('Current branch:', h('span.sv-value', null, data.branch ?? 'HEAD (detached)')),
    row('Stash:', h('span.sv-value', null, stashLabel(data.stash))),
    row('As new branch:', o.branch),
    o.branchErr,
    h('div.sv-options', null, o.pop.element, o.index.element),
  );
  dlg = dialogLayout(app, {
    title: `Unstash Changes in ${data.repoName}`,
    body,
    buttons: [
      { id: 'ok', label: 'Apply Stash', primary: true, run: () => submit() },
      { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
    ],
  });
  o.onValidity(() => dlg.setEnabled('ok', o.valid));
  const submit = async () => {
    if (!o.valid) return false;
    dlg.setBusy(true, 'Unstashing…');
    try {
      await rpc.call('unstash', o.request(data.repoRoot, data.stash.hash));
    } catch (e) {
      dlg.setError(errorText(e));
    } finally {
      dlg.setBusy(false);
    }
    return false;
  };
  void o.update();
  o.branch.focus();
} else {
  let repoRoot = data.repoRoot;
  let stashes: StashItem[] = [];
  let dlg!: DialogLayout;
  const o = unstashOptions(() => dlg);
  const branchEl = h('span.sv-value');
  const listEl = h('div.sv-list');
  const tree = new Tree<StashItem>(listEl, { multiSelect: false, ariaLabel: 'Stashes', emptyText: 'No stashes', defaultExpandDepth: 0 });
  const view = button({ label: 'View', onClick: () => void act('view') });
  const drop = button({ label: 'Drop', onClick: () => void act('drop') });
  const clear = button({ label: 'Clear', onClick: () => void act('clear') });
  setTooltip(view, 'View selected stash');
  setTooltip(drop, 'Delete selected stash');
  setTooltip(clear, 'Delete all stashes in the repository');

  const selected = () => tree.getLead()?.data ?? tree.getSelection()[0]?.data;
  const updateButtons = () => {
    const s = selected();
    view.disabled = drop.disabled = !s;
    clear.disabled = !stashes.length;
    dlg?.setEnabled('ok', !!s && o.valid);
  };

  async function load(keepSelection = true): Promise<void> {
    try {
      const prev = keepSelection ? selected()?.hash : undefined;
      const r = await rpc.call<{ branch?: string; stashes: StashItem[] }>('list', { repoRoot });
      stashes = r.stashes;
      branchEl.textContent = r.branch ?? 'HEAD (detached)';
      const nodes: TreeNode<StashItem>[] = stashes.map((s) => ({
        id: s.hash,
        label: stashLabel(s),
        icon: 'git-stash',
        trailing: formatPrettyDateTime(s.date),
        tooltip: `${stashLabel(s)}\n${formatDateTime(s.date)}\n${s.hash}`,
        data: s,
      }));
      tree.setRoots(nodes);
      const sel = stashes.find((s) => s.hash === prev) ?? stashes[0];
      if (sel) tree.select([sel.hash], { reveal: true });
      dlg.setError(undefined);
    } catch (e) {
      dlg.setError(`Could not Show the List of Stashes: ${errorText(e)}`);
    }
    updateButtons();
  }

  async function act(what: 'view' | 'drop' | 'clear'): Promise<void> {
    const s = selected();
    try {
      if (what === 'view' && s) await rpc.call('view', { repoRoot, hash: s.hash });
      else if (what === 'drop' && s) {
        if (await rpc.call('drop', { repoRoot, hash: s.hash })) await load(false);
      } else if (what === 'clear') {
        if (await rpc.call('clear', { repoRoot })) await load(false);
      }
    } catch (e) {
      dlg.setError(errorText(e));
    }
  }

  const rows: Node[] = [];
  if (data.repos.length > 1) rows.push(row('Git Root:', repoCombo(data.repos, repoRoot, (v) => ((repoRoot = v), void load(false))).element));
  rows.push(
    row('Current branch:', branchEl),
    h('label.sv-label', null, 'Stashes:'),
    h('div.sv-list-wrap', null, listEl, h('div.sv-side-buttons', null, view, drop, clear)),
    h('div.sv-options', null, o.pop.element, o.index.element),
    row('As new branch:', o.branch),
    o.branchErr,
  );
  dlg = dialogLayout(app, {
    title: 'Unstash Changes',
    body: h('div.sv-dialog-body', null, ...rows),
    buttons: [
      { id: 'ok', label: 'Apply Stash', primary: true, run: () => submit() },
      { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
    ],
  });
  dlg.body.style.display = 'flex';
  dlg.body.style.flexDirection = 'column';
  dlg.body.style.minHeight = '0';
  o.onValidity(() => updateButtons());
  const submit = async () => {
    const s = selected();
    if (!s || !o.valid) return false;
    dlg.setBusy(true, 'Unstashing…');
    try {
      await rpc.call('unstash', o.request(repoRoot, s.hash));
    } catch (e) {
      dlg.setError(errorText(e));
    } finally {
      dlg.setBusy(false);
    }
    return false;
  };
  tree.onDidChangeSelection(() => updateButtons());
  tree.onDidActivate(() => void act('view'));
  listEl.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      e.preventDefault();
      void act('drop');
    }
  });
  rpc.on('refresh', () => void load());
  void o.update();
  void load().then(() => tree.focus());
}
