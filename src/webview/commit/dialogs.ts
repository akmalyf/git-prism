// Commit view dialogs (in-page modals): Rollback Changes, New / Edit Changelist, Delete Changelist confirmation.
import { buildPathTree, checkbox, confirmDialog, formGrid, formRow, gitStatusClass, h, openModal, pathTreeToNodes, pluralize, textArea, textField, Tree, type TreeNode } from '../shared/ui';
import type { ChangelistInfo, Item, RepoInfo } from '../../features/commit/protocol';
import { renameText } from './model';

/** Rollback Changes dialog: checked files + "Delete local copies of added files". Resolves the keys to roll back. */
export async function rollbackDialog(candidates: Item[], checked: Set<string>, repos: RepoInfo[], deleteAddedDefault: boolean): Promise<{ keys: string[]; deleteAdded: boolean } | undefined> {
  const multiRepo = repos.length > 1;
  const names = new Map(repos.map((r) => [r.root, r.name]));
  const staging = candidates.some((i) => i.area === 'staged' || i.area === 'unstaged');
  const groups = [];
  if (staging) groups.push({ key: (i: Item) => (i.area === 'staged' ? '1staged' : i.area === 'unstaged' ? '2unstaged' : '0unmerged'), label: (k: string) => ({ '0unmerged': 'Unmerged', '1staged': 'Staged', '2unstaged': 'Unstaged' })[k] ?? k });
  if (multiRepo) groups.push({ key: (i: Item) => i.repo, label: (k: string) => names.get(k) ?? k });
  const nodes = pathTreeToNodes<Item, Item>(buildPathTree(candidates, { path: (i) => i.path, groups, idPrefix: 'rb:' }), {
    file: (n) => ({ className: gitStatusClass(n.item.area === 'conflict' ? 'conflict' : n.item.kind), checkable: true, checked: checked.has(n.item.key), data: n.item, description: renameText(n.item) }),
    group: (n) => ({ icon: names.has(n.key) ? 'repo' : undefined }),
  });
  const host = h('div.cv-rollback-tree.jb-island');
  const tree = new Tree<Item>(host, { checkboxes: true, multiSelect: true, defaultExpandDepth: Infinity, speedSearch: true });
  tree.setRoots(nodes as TreeNode<Item>[]);
  const hasAdded = candidates.some((i) => i.kind === 'A' || i.kind === 'C' || repos.find((r) => r.root === i.repo)?.empty);
  const del = checkbox({ label: 'Delete local copies of added files', checked: deleteAddedDefault });
  const count = h('div.cv-rollback-count.jb-muted');
  const body = h('div.cv-rollback', null, host, count, hasAdded ? del.element : null);
  let result: { keys: string[]; deleteAdded: boolean } | undefined;
  const handle = openModal({
    title: 'Rollback Changes',
    width: 560,
    body,
    initialFocus: tree.element,
    buttons: [
      { id: 'cancel', label: 'Cancel', cancel: true },
      {
        id: 'ok',
        label: 'Rollback',
        primary: true,
        run: () => {
          const keys = tree.getChecked().map((n) => n.data!.key);
          if (!keys.length) return false;
          result = { keys, deleteAdded: hasAdded && del.checked };
        },
      },
    ],
  });
  const update = () => {
    const n = tree.getChecked().length;
    count.textContent = `${pluralize(n, 'file')} selected`;
    handle.layout.setEnabled('ok', n > 0);
  };
  tree.onDidChangeChecked(update);
  update();
  requestAnimationFrame(() => tree.refresh());
  await handle.result;
  tree.dispose();
  return result;
}

export interface ChangelistEdit {
  name: string;
  comment: string;
  active: boolean;
}

/** New Changelist / Edit Changelist dialog. */
export async function changelistDialog(lists: ChangelistInfo[], edit?: ChangelistInfo): Promise<ChangelistEdit | undefined> {
  const name = textField({ value: edit?.name ?? '' });
  name.style.width = '100%';
  const comment = textArea({ value: edit?.comment ?? '', rows: 5 });
  comment.style.width = '100%';
  const active = checkbox({ label: 'Set active', checked: !!edit?.active, disabled: !!edit?.active });
  const validate = (v: string): string | undefined => {
    const n = v.trim();
    if (!n) return 'Cannot create new changelist with empty name';
    if (lists.some((l) => l.id !== edit?.id && l.name === n)) return edit ? `A changelist named '${n}' already exists` : 'A changelist with that name already exists';
    return undefined;
  };
  let result: ChangelistEdit | undefined;
  const handle = openModal({
    title: edit ? 'Edit Changelist' : 'New Changelist',
    width: 460,
    initialFocus: name,
    body: h('div.cv-changelist-form', null, formGrid(formRow('Name:', name), formRow('Comment:', comment)), active.element),
    buttons: [
      { id: 'cancel', label: 'Cancel', cancel: true },
      {
        id: 'ok',
        label: 'OK',
        primary: true,
        run: () => {
          const err = validate(name.value);
          handle.layout.setError(err);
          if (err) return false;
          result = { name: name.value.trim(), comment: comment.value, active: active.checked };
        },
      },
    ],
  });
  name.addEventListener('input', () => {
    const err = validate(name.value);
    handle.layout.setEnabled('ok', !err);
    handle.layout.setError(name.value ? err : undefined);
  });
  handle.layout.setEnabled('ok', !validate(name.value));
  await handle.result;
  return result;
}

export function confirmDeleteChangelists(lists: ChangelistInfo[]): Promise<boolean> {
  const message =
    lists.length === 1
      ? `Are you sure want to remove changelist '${lists[0].name}'?\nAll changes will be moved to the active changelist.`
      : `Are you sure want to remove ${lists.length} changelists?\nAll changes will be moved to the active changelist.`;
  return confirmDialog({ title: 'Delete Changelist', message: h('div', { style: { whiteSpace: 'pre-line' } }, message), ok: 'Delete' });
}
