// "Push Commits to <repo>" dialog (IntelliJ VcsPushDialog): left tree "<branch> → <remote> : <target>" per repository
// with the outgoing commits (remote and target editable, "New" badge), right the changed files of the selected commits
// (double-click → diff) and the commit details; bottom Push tags (All / Current Branch), Run Git hooks, [Push ▾] [Cancel].
import { init, rpc } from '../shared/rpc';
import {
  buildPathTree,
  checkbox,
  comboBox,
  confirmDialog,
  dialogLayout,
  emptyState,
  formatPrettyDateTime,
  formGrid,
  formRow,
  gitStatusClass,
  h,
  icon,
  openModal,
  pathTreeToNodes,
  setFormatLocale,
  setTooltip,
  shortHash,
  showDropdownMenu,
  Splitter,
  textField,
  Tree,
  type TreeNode,
} from '../shared/ui';
import { isProtected } from '../../features/sync/pushLogic';
import type { PushChange, PushCommit, PushInit, PushRepo, PushRequest, PushTargetInfo } from '../../features/sync/protocol';
import { dialogPage, RefField } from '../merge-dialog/common';

const data = init<PushInit>();
if (data.locale) setFormatLocale(data.locale);
const repos: PushRepo[] = data.repos;
const many = repos.length > 1;
const force = data.forceDefault;

const CSS = `
.ps-body { display: flex; flex-direction: column; height: 460px; padding: 0 !important; }
.ps-split { flex: 1 1 auto; min-height: 0; }
.ps-left, .ps-right { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.ps-left .jb-tree, .ps-right .jb-tree { flex: 1 1 auto; min-height: 0; }
.ps-right-split { flex: 1 1 auto; min-height: 0; }
.ps-details { overflow: auto; padding: 8px 12px; user-select: text; -webkit-user-select: text; }
.ps-details pre { margin: 0 0 8px; font-family: var(--jb-mono); font-size: var(--jb-mono-size); white-space: pre-wrap; word-break: break-word; }
.ps-details .ps-meta { color: var(--jb-fg-muted); line-height: 1.6; }
.ps-target { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.ps-link { color: var(--jb-link); cursor: pointer; border-radius: 3px; padding: 0 2px; }
.ps-link:hover { text-decoration: underline; }
.ps-arrow { color: var(--jb-fg-muted); }
.ps-new { font-size: 10px; line-height: 14px; padding: 0 5px; border-radius: 7px; background: var(--jb-ref-local); color: var(--jb-editor-bg); font-weight: 600; }
.ps-problem { color: var(--jb-fg-muted); }
.ps-repo-check { margin: 0 4px 0 0; }
.ps-editor { position: fixed; z-index: 950; }
.ps-editor .jb-input { height: 22px; }
.ps-footer-left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ps-footer-left .jb-combo { height: 24px; }
.ps-split-btn { display: inline-flex; }
.ps-split-btn > .jb-btn:first-child { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.ps-split-btn > .ps-arrow-btn { border-top-left-radius: 0; border-bottom-left-radius: 0; padding: 0 6px; min-width: 0;
  border-left: 1px solid color-mix(in srgb, var(--jb-accent-fg) 35%, transparent); }
`;
const page = dialogPage(940);
const st = document.createElement('style');
st.textContent = CSS;
document.head.appendChild(st);

// ---------- left: repositories and commits ----------

const repoId = (r: PushRepo) => `repo:${r.root}`;
const commitId = (r: PushRepo, c: PushCommit) => `c:${r.root}:${c.hash}`;

interface NodeData {
  repo: PushRepo;
  commit?: PushCommit;
}

const commitTree = new Tree<NodeData>(null, {
  multiSelect: true,
  defaultExpandDepth: 1,
  ariaLabel: 'Commits to push',
  emptyText: 'No commits',
  renderLabel: (el, n) => renderNode(el, n),
});

function repoNode(r: PushRepo): TreeNode<NodeData> {
  const tip = (c: PushCommit) => `${shortHash(c.hash)}  ${formatPrettyDateTime(c.date)}  by ${c.author}\n\n${c.subject}`;
  return {
    id: repoId(r),
    label: r.name,
    icon: many ? 'repo' : undefined,
    expanded: true,
    data: { repo: r },
    children: r.problem ? undefined : r.commits.map((c) => ({ id: commitId(r, c), label: c.subject, icon: 'git-commit', tooltip: tip(c), muted: c.parents.length > 1, data: { repo: r, commit: c } })),
  };
}

function renderNode(el: HTMLElement, n: TreeNode<NodeData>): void {
  const d = n.data!;
  if (d.commit) {
    el.textContent = d.commit.subject;
    return;
  }
  const r = d.repo;
  const stop = (e: Event) => e.stopPropagation();
  const parts: (Node | string)[] = [];
  if (many) {
    const cb = h('input.jb-check.ps-repo-check', { type: 'checkbox', tabIndex: -1, checked: r.selected, disabled: !!r.problem, onMouseDown: stop, onClick: (e: MouseEvent) => {
      e.stopPropagation();
      r.selected = (e.target as HTMLInputElement).checked;
      validate();
    } });
    parts.push(cb, h('span.jb-bold', null, r.name), ': ');
  }
  if (r.problem) {
    parts.push(h('span.ps-problem', null, r.problem === 'Cannot push' ? 'Cannot push: detached HEAD' : r.problem));
    el.replaceChildren(...parts);
    return;
  }
  parts.push(h('span', null, r.branch ?? 'HEAD'), h('span.ps-arrow', null, ' → '));
  if (!r.remotes.length) {
    parts.push(link('Define remote', () => defineRemote(r)));
  } else {
    const remoteEl = link(r.remote ?? '', (el2) => pickRemote(r, el2));
    const targetEl = link(r.target || 'Enter target branch', (el2) => editTarget(r, el2));
    parts.push(remoteEl, h('span.ps-arrow', null, ' : '), targetEl);
    if (r.isNew) parts.push(' ', h('span.ps-new', { title: r.setUpstream ? 'New & Upstream' : 'New' }, 'New'));
  }
  el.replaceChildren(h('span.ps-target', null, ...parts));
}

function link(text: string, run: (el: HTMLElement) => void): HTMLElement {
  const el = h('span.ps-link', {
    attrs: { role: 'button' },
    onMouseDown: (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    },
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      run(e.currentTarget as HTMLElement);
    },
    onDblClick: (e: MouseEvent) => e.stopPropagation(),
  }, text);
  return el;
}

function renderTree(): void {
  commitTree.setRoots(repos.map(repoNode));
  validate();
}

const retargetSeq = new Map<string, number>();

async function retarget(r: PushRepo): Promise<void> {
  const my = (retargetSeq.get(r.root) ?? 0) + 1;
  retargetSeq.set(r.root, my);
  if (!r.remote || !r.target) {
    r.commits = [];
    r.isNew = false;
    renderTree();
    return;
  }
  let info: PushTargetInfo;
  try {
    info = await rpc.call<PushTargetInfo>('target', { root: r.root, remote: r.remote, target: r.target });
  } catch (e) {
    dlg.setError(e instanceof Error ? e.message : String(e));
    return;
  }
  if (retargetSeq.get(r.root) !== my) return;
  r.isNew = info.isNew;
  r.commits = info.commits;
  r.remoteBranches = info.remoteBranches;
  renderTree();
  updateChanges();
}

function pickRemote(r: PushRepo, anchor: HTMLElement): void {
  showDropdownMenu([
    ...r.remotes.map((name) => ({ label: name, checked: name === r.remote, radio: true, run: () => {
      if (name === r.remote) return;
      r.remote = name;
      void retarget(r);
    } })),
    '-',
    { label: 'Define remote', run: () => defineRemote(r) },
  ], anchor);
}

function editTarget(r: PushRepo, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const field = new RefField({ items: r.remoteBranches.map((name) => ({ name, kind: 'remote' as const })), value: r.target ?? '', placeholder: 'branch' });
  field.element.classList.add('sd-first', 'sd-last');
  const box = h('div.ps-editor', { style: { left: `${rect.left - 4}px`, top: `${rect.top - 3}px`, width: `${Math.max(220, rect.width + 60)}px` } }, field.element);
  document.body.appendChild(box);
  let closed = false;
  const finish = (apply: boolean) => {
    if (closed) return;
    closed = true;
    field.close();
    box.remove();
    commitTree.focus();
    const v = field.value;
    if (apply && v !== (r.target ?? '')) {
      r.target = v;
      void retarget(r);
    }
  };
  field.input.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  field.input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== field.input && !document.querySelector('.sd-complete:hover')) finish(true);
  }, 150));
  field.focus();
}

async function defineRemote(r: PushRepo): Promise<void> {
  const name = textField({ value: r.remotes.includes('origin') ? '' : 'origin' });
  const url = textField({ placeholder: '' });
  name.style.width = url.style.width = '100%';
  const m = openModal({
    title: 'Define Remote',
    width: 460,
    initialFocus: r.remotes.includes('origin') ? name : url,
    body: formGrid(formRow('Name:', name), formRow('URL:', url)),
    buttons: [
      { id: 'cancel', label: 'Cancel', cancel: true },
      {
        id: 'ok',
        label: 'OK',
        primary: true,
        run: async () => {
          const n = name.value.trim();
          const u = url.value.trim();
          if (!n || !u) {
            m.layout.setError(!n ? 'Remote name is empty' : 'Remote URL is empty');
            return false;
          }
          if (r.remotes.includes(n)) {
            m.layout.setError(`Remote ${n} already exists`);
            return false;
          }
          m.layout.setBusy(true, 'Adding Remote…');
          try {
            const updated = await rpc.call<PushRepo>('defineRemote', { root: r.root, name: n, url: u });
            Object.assign(r, updated, { selected: true });
            renderTree();
          } catch (e) {
            m.layout.setBusy(false);
            m.layout.setError(`Could not add remote: ${e instanceof Error ? e.message : e}`);
            return false;
          }
        },
      },
    ],
  });
}

// ---------- right: changed files + details ----------

const changesTree = new Tree<PushChange>(null, {
  multiSelect: true,
  defaultExpandDepth: Infinity,
  ariaLabel: 'Changed files',
  emptyText: 'Select to show commit details',
});
const details = h('div.ps-details');
const rightSplit = new Splitter(null, {
  orientation: 'vertical',
  first: h('div.ps-right', null, changesTree.element),
  second: details,
  size: 150,
  fixed: 'second',
  min: 60,
  minOther: 100,
  stateKey: 'push.details',
});
rightSplit.element.classList.add('ps-right-split');

let selectedCommits: { repo: PushRepo; commits: PushCommit[] } | undefined;
let changeSeq = 0;

function currentSelection(): { repo: PushRepo; commits: PushCommit[] } | undefined {
  const sel = commitTree.getSelection();
  if (!sel.length) return undefined;
  const lead = commitTree.getLead() ?? sel[0];
  const repo = lead.data!.repo;
  const commits = new Map<string, PushCommit>();
  for (const n of sel) {
    if (n.data!.repo !== repo) continue;
    if (n.data!.commit) commits.set(n.data!.commit.hash, n.data!.commit);
    else for (const c of repo.commits) commits.set(c.hash, c);
  }
  // keep newest-first order of the repo's commit list
  return { repo, commits: repo.commits.filter((c) => commits.has(c.hash)) };
}

async function updateChanges(): Promise<void> {
  const my = ++changeSeq;
  const s = currentSelection();
  selectedCommits = s;
  if (!s || !s.commits.length) {
    changesTree.setRoots([]);
    changesTree.element.querySelector('.jb-tree-empty')?.replaceChildren(emptyState([s ? 'No differences' : 'Select to show commit details']));
    details.replaceChildren();
    return;
  }
  let files: PushChange[];
  try {
    files = await rpc.call<PushChange[]>('changes', { root: s.repo.root, commits: s.commits });
  } catch (e) {
    if (my !== changeSeq) return;
    changesTree.setRoots([]);
    details.replaceChildren(h('div.jb-error-text', null, e instanceof Error ? e.message : String(e)));
    return;
  }
  if (my !== changeSeq) return;
  const nodes = buildPathTree(files, { path: (f) => f.path, groupByDirectory: true, compact: true, idPrefix: 'f:' });
  changesTree.setRoots(pathTreeToNodes(nodes, { file: (n) => ({ className: gitStatusClass(n.item.kind), data: n.item, tooltip: n.item.oldPath ? `${n.item.oldPath} → ${n.item.path}` : n.item.path }) }) as TreeNode<PushChange>[]);
  if (s.commits.length === 1) {
    const c = s.commits[0];
    const msg = await rpc.call<string>('details', { root: s.repo.root, hash: c.hash }).catch(() => c.subject);
    if (my !== changeSeq) return;
    details.replaceChildren(
      h('pre', null, msg),
      h('div.ps-meta', null, `${shortHash(c.hash)} ${c.author} <${c.authorEmail}>, ${formatPrettyDateTime(c.date)}`),
    );
  } else {
    details.replaceChildren(h('div.ps-meta', null, `${s.commits.length} commits selected`));
  }
}

commitTree.onDidChangeSelection(() => void updateChanges());
changesTree.onDidActivate(({ node }) => {
  if (!node.data || !selectedCommits) return;
  void rpc.call('showDiff', { root: selectedCommits.repo.root, commits: selectedCommits.commits, path: node.data.path });
});

const split = new Splitter(null, {
  orientation: 'horizontal',
  first: h('div.ps-left', null, commitTree.element),
  second: rightSplit.element,
  size: 0.55,
  proportional: true,
  min: 260,
  minOther: 220,
  stateKey: 'push.split',
});
split.element.classList.add('ps-split');

// ---------- footer ----------

const tags = checkbox({ label: 'Push tags', checked: data.pushTags, onChange: () => {
  tagMode.setDisabled(!tags.checked);
  validate();
} });
const tagMode = comboBox<'all' | 'current'>({ options: [{ value: 'all', label: 'All' }, { value: 'current', label: 'Current Branch' }], value: data.tagMode, disabled: !data.pushTags });
const hooks = checkbox({ label: 'Run Git hooks', checked: data.runHooks });
setTooltip(hooks.element, "If unchecked, Git hooks will be skipped with the '--no-verify' option");

const dlg = dialogLayout(page, {
  title: data.title,
  body: split.element,
  className: 'ps-dialog',
  buttons: [
    { id: 'cancel', label: 'Cancel', cancel: true, run: () => void rpc.call('cancel') },
    { id: 'push', label: force ? 'Force Push' : 'Push', primary: true, run: () => submit(force) },
  ],
});
dlg.body.classList.add('ps-body');
dlg.footer.querySelector('.jb-dialog-left')!.prepend(h('div.ps-footer-left', null, h('span.ps-target', null, tags.element, tagMode.element), hooks.element));

// split button: [Push][▾] → Force Push / Push
const pushBtn = dlg.footer.querySelector<HTMLButtonElement>('.jb-btn-primary')!;
const arrow = h('button.jb-btn.jb-btn-primary.ps-arrow-btn', { type: 'button', attrs: { 'aria-label': 'More push actions' }, onClick: () => showDropdownMenu(pushMenu(), arrow, { align: 'end' }) }, icon('chevron-down'));
const splitBtn = h('span.ps-split-btn');
pushBtn.replaceWith(splitBtn);
splitBtn.append(pushBtn, arrow);

function prohibitedTarget(): string | undefined {
  for (const r of repos) if (r.selected && !r.problem && r.target && isProtected(r.target, data.protectedPatterns)) return r.target;
  return undefined;
}

function pushMenu() {
  const prot = prohibitedTarget();
  return force
    ? [{ label: 'Push', run: () => void submit(false) }]
    : [{ label: 'Force Push', disabled: !!prot || !canPush(), description: prot ? `Force push to ${prot} is prohibited` : undefined, run: () => void submit(true) }];
}

function active(): PushRepo[] {
  return repos.filter((r) => (many ? r.selected : true) && !r.problem);
}

function canPush(): boolean {
  const a = active();
  return a.length > 0 && a.every((r) => r.remote && r.target) && a.some((r) => r.commits.length || r.isNew || tags.checked);
}

function validate(): void {
  const a = active();
  const missing = a.find((r) => r.remote && !r.target);
  dlg.setError(missing ? `Please, specify not empty remote push path for repository ${missing.name}.` : undefined);
  const ok = canPush() && !(force && prohibitedTarget());
  dlg.setEnabled('push', ok);
  arrow.disabled = !a.length;
}

async function submit(withForce: boolean): Promise<void> {
  if (!canPush()) return;
  if (withForce) {
    const prot = prohibitedTarget();
    if (prot) {
      dlg.setError(`Force push to ${prot} is prohibited`);
      return;
    }
    const targets = active().map((r) => `${r.remote}/${r.target}`);
    const ok = await confirmDialog({
      title: 'Force Push',
      message: targets.length === 1
        ? h('span', null, "You're going to force push to ", h('b', null, targets[0]), '. It may overwrite commits at the remote. Are you sure you want to proceed?')
        : "You're going to force push. It may overwrite commits at the remote. Are you sure you want to proceed?",
      ok: 'Force Push',
      width: 460,
    });
    if (!ok) return;
  }
  const req: PushRequest = {
    repos: active().map((r) => ({ root: r.root, remote: r.remote!, target: r.target! })),
    force: withForce,
    pushTags: tags.checked,
    tagMode: tagMode.value ?? 'all',
    runHooks: hooks.checked,
  };
  dlg.setBusy(true, 'Pushing…');
  await rpc.call('push', req);
}

renderTree();
const first = repos.find((r) => !r.problem && r.commits.length);
if (first) commitTree.select([commitId(first, first.commits[0])], { reveal: true, focus: true });
else commitTree.focus();
void updateChanges();
