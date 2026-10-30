// "Rebase" dialog (IntelliJ GitRebaseDialog): [Git Root] git rebase [--onto <new base>] <upstream> [<branch>],
// Modify options: Select another branch to rebase, --onto, --rebase-merges, --keep-empty, --root, --interactive,
// --update-refs, --autosquash / --no-autosquash.
import { init, rpc } from '../shared/rpc';
import { dialogLayout, h } from '../shared/ui';
import { REBASE_FLAGS, REBASE_OPTIONS, rebaseOptionEnabled, type RebaseOption } from '../../features/sync/options';
import type { RebaseRequest, RefDialogInit, RepoData } from '../../features/sync/protocol';
import { cmdLabel, dialogPage, hasRef, OptionsBar, RefField, rootCombo } from '../merge-dialog/common';

const data = init<RefDialogInit>();
let repo: RepoData = data.data;
const validHashes = new Map<string, boolean>();

const upstream = new RefField({ items: repo.refs, value: data.ref ?? '', placeholder: 'branch or hash', onChange: () => validate() });
const onto = new RefField({ items: repo.refs, placeholder: 'new base (branch or hash)', onChange: () => validate() });
const branch = new RefField({ items: repo.refs.filter((r) => r.kind === 'local'), placeholder: 'source branch', onChange: () => validate() });
const ontoLabel = cmdLabel('--onto', true);

const options = new OptionsBar<RebaseOption>({
  defs: REBASE_OPTIONS,
  selected: [],
  title: 'Add Rebase Options',
  enabled: (o, sel) => rebaseOptionEnabled(o, sel),
  chips: REBASE_FLAGS,
  onChange: (sel) => {
    if (sel.includes('onto') !== ontoShown) {
      // IntelliJ moves the value between the fields when --onto is toggled
      if (sel.includes('onto')) {
        onto.setValue(upstream.value);
        upstream.setValue('');
      } else {
        upstream.setValue(onto.value);
        onto.setValue('');
      }
    }
    layout();
    validate();
  },
});

let ontoShown = false;
const row = h('div.sd-cmd-row');
const row2 = h('div.sd-cmd-row.sd-row2');
const root = rootCombo(data.repos, repo.root, async (r) => setRepo(await rpc.call<RepoData>('repoData', r)));

/** IntelliJ layout: with --onto (or a Git Root combo) the upstream / source branch fields move to a second row. */
function layout(): void {
  ontoShown = options.has('onto');
  const showBranch = options.has('switch-branch');
  const top: HTMLElement[] = [];
  const bottom: HTMLElement[] = [];
  if (root) top.push(root.element);
  top.push(cmdLabel('git rebase'));
  for (const f of [onto, upstream, branch]) f.element.classList.remove('sd-last', 'sd-first', 'sd-mid');
  if (ontoShown) {
    top.push(ontoLabel, onto.element);
    onto.element.classList.add('sd-last');
    bottom.push(upstream.element);
    upstream.element.classList.add('sd-first', 'sd-last');
    if (showBranch) {
      bottom.push(branch.element);
      branch.element.classList.add('sd-first', 'sd-last');
    }
  } else {
    top.push(upstream.element);
    upstream.element.classList.add('sd-last');
    if (showBranch && !root) {
      upstream.element.classList.remove('sd-last');
      top.push(branch.element);
      branch.element.classList.add('sd-last');
    } else if (showBranch) {
      bottom.push(branch.element);
      branch.element.classList.add('sd-first', 'sd-last');
    }
  }
  row.replaceChildren(...top);
  row2.replaceChildren(...bottom);
  row2.style.display = bottom.length ? '' : 'none';
  upstream.setPlaceholder(ontoShown ? 'old base (branch or hash)' : 'branch or hash');
  upstream.setDisabled(options.has('root'));
}

const body = h('div', null, h('div.sd-head', null, options.link), row, row2, options.chips);
layout();

const dlg = dialogLayout(dialogPage(620), {
  title: data.title,
  body,
  buttons: [
    { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
    { id: 'ok', label: 'Rebase', primary: true, run: () => submit() },
  ],
});

/** A ref name, or a hash/expression the host confirmed. */
function known(v: string): boolean | undefined {
  if (hasRef(repo.refs, v)) return true;
  if (validHashes.has(v)) return validHashes.get(v);
  void rpc.call<boolean>('validate', { root: repo.root, rev: v }).then((ok) => {
    validHashes.set(v, ok);
    validate();
  });
  return undefined;
}

function error(): { text: string; field?: RefField } | undefined {
  if (options.has('onto')) {
    if (!onto.value && !options.has('root')) return { text: 'Select a new base', field: onto };
    if (onto.value && known(onto.value) === false) return { text: 'There is no such branch or tag', field: onto };
  }
  if (!options.has('root')) {
    if (!upstream.value) return { text: options.has('onto') ? 'Select an upstream' : 'Select a new base', field: upstream };
    if (known(upstream.value) === false) return { text: 'There is no such branch or tag', field: upstream };
  }
  if (options.has('switch-branch')) {
    if (!branch.value) return { text: 'Select a branch to switch to', field: branch };
    if (!repo.refs.some((r) => r.kind === 'local' && r.name === branch.value)) return { text: `Branch '${branch.value}' does not exist`, field: branch };
  }
  return undefined;
}

let touched = !!data.ref;
for (const f of [upstream, onto, branch]) f.input.addEventListener('input', () => (touched = true));

function validate(): boolean {
  const e = error();
  const pending = [upstream, onto].some((f) => f.value && !hasRef(repo.refs, f.value) && !validHashes.has(f.value) && f.element.isConnected && !f.input.disabled);
  dlg.setEnabled('ok', !e && !pending);
  dlg.setError(touched ? e?.text : undefined);
  for (const f of [upstream, onto, branch]) f.setInvalid(touched && e?.field === f);
  return !e && !pending;
}

async function submit(): Promise<void> {
  touched = true;
  if (!validate()) return;
  const req: RebaseRequest = {
    root: repo.root,
    upstream: options.has('root') ? undefined : upstream.value,
    onto: options.has('onto') ? onto.value || undefined : undefined,
    branch: options.has('switch-branch') ? branch.value : undefined,
    options: options.value,
  };
  await rpc.call('ok', req);
}

function setRepo(d: RepoData): void {
  repo = d;
  upstream.setItems(repo.refs);
  onto.setItems(repo.refs);
  branch.setItems(repo.refs.filter((x) => x.kind === 'local'));
  validHashes.clear();
  validate();
}

rpc.on<string>('refresh', async (r) => {
  if (r === repo.root) setRepo(await rpc.call<RepoData>('repoData', r));
});

validate();
upstream.focus();
