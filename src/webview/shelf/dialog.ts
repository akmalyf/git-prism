// Dialogs of the shelf bundle around a checkable changes tree: Shelve Changes (message, keep changes), Unshelve
// Changes (Remove successfully applied files from the shelf), Create Patch (To file / To clipboard, Reverse patch)
// and Apply Patch (Patch file name, Git Root, per-file status).
import type { ApplyPatchResult, CreatePatchResult, DialogChange, ShelfDialogInit, ShelveResult, UnshelveResult } from '../../features/stash/protocol';
import { rpc } from '../shared/rpc';
import { button, checkbox, comboBox, dialogLayout, h, pluralize, setFormatLocale, textArea, textField, Tree, type TreeNode } from '../shared/ui';
import { errorText, fileNodes, injectCss } from '../stash/common';

type Node = TreeNode<DialogChange>;

export function startShelfDialog(init: ShelfDialogInit): void {
  injectCss();
  setFormatLocale(init.locale);
  let changes = init.changes;
  const treeEl = h('div.sv-dialog-tree');
  const count = h('div.sv-dialog-count');
  const tree = new Tree<DialogChange>(treeEl, { multiSelect: true, checkboxes: true, defaultExpandDepth: Infinity, ariaLabel: 'Changes', emptyText: 'No changes' });
  const key = (c: DialogChange) => `${c.repoRoot}\0${c.path}`;

  const roots = (): Node[] => {
    const repos = [...new Set(changes.map((c) => c.repoRoot))];
    const build = (list: DialogChange[], prefix: string) =>
      fileNodes<DialogChange, DialogChange>(list, {
        idPrefix: prefix,
        data: (c) => c,
        extra: (c) => ({ checkable: true, checked: c.checked, trailing: c.status }),
      });
    if (repos.length <= 1) return build(changes, 'f:');
    return repos.map((r) => ({
      id: `repo:${r}`,
      label: r.split(/[\\/]/).pop() ?? r,
      icon: 'repo',
      tooltip: r,
      expanded: true,
      children: build(changes.filter((c) => c.repoRoot === r), `f:${r}:`),
    }));
  };
  const checked = (): DialogChange[] => {
    const set = new Set(tree.getChecked().map((n) => n.data).filter((d): d is DialogChange => !!d).map(key));
    return changes.filter((c) => set.has(key(c)));
  };
  const updateCount = () => {
    const n = checked().length;
    count.textContent = `${pluralize(n, 'file')} selected of ${changes.length}`;
    dlg?.setEnabled('ok', n > 0 && extraValid());
  };
  let extraValid = () => true;
  tree.onDidChangeChecked(() => updateCount());

  const body = h('div.sv-dialog-body');
  let ok: () => unknown = () => undefined;
  let okLabel = 'OK';

  switch (init.mode) {
    case 'shelve': {
      okLabel = init.okLabel;
      const msg = textArea({ value: init.message, monospace: true, spellcheck: true, rows: 4, placeholder: 'Shelved changes name' });
      msg.classList.add('sv-message');
      const keep = checkbox({ label: 'Keep changes in the working tree', checked: init.keep, title: 'Copy the selected changes to the shelf without removing them from the working tree (Save To Shelf)' });
      body.append(treeEl, count, h('label.sv-label', null, 'Comment:'), msg, keep.element);
      ok = () => {
        const r: ShelveResult = { message: msg.value, keep: keep.checked, files: checked().map((c) => ({ repoRoot: c.repoRoot, path: c.path })) };
        return rpc.call('ok', r);
      };
      queueMicrotask(() => msg.focus());
      break;
    }
    case 'unshelve': {
      okLabel = 'Unshelve Changes';
      const remove = checkbox({ label: 'Remove successfully applied files from the shelf', checked: init.removeApplied });
      body.append(h('div.sv-row', null, h('span.sv-label', null, 'Shelved changelist:'), h('span.sv-value', null, init.name)), treeEl, count, remove.element);
      ok = () => {
        const r: UnshelveResult = { paths: checked().map((c) => c.path), removeApplied: remove.checked };
        return rpc.call('ok', r);
      };
      break;
    }
    case 'createPatch': {
      okLabel = 'Create Patch';
      const file = textField({ value: init.file, onInput: () => updateCount() });
      const browse = button({ label: 'Browse…', onClick: async () => {
        const f = await rpc.call<string | undefined>('browse', { file: file.value });
        if (f) {
          file.value = f;
          updateCount();
        }
      } });
      const clip = checkbox({
        label: 'To clipboard',
        checked: init.clipboard,
        onChange: (v) => {
          file.disabled = v;
          browse.disabled = v;
          updateCount();
        },
      });
      file.disabled = browse.disabled = init.clipboard;
      const reverse = checkbox({ label: 'Reverse patch' });
      extraValid = () => clip.checked || !!file.value.trim();
      body.append(treeEl, count, h('div.sv-row', null, h('label.sv-label', null, 'To file:'), file, browse), h('div.sv-options', null, clip.element, reverse.element));
      ok = () => {
        const r: CreatePatchResult = { files: checked().map((c) => ({ repoRoot: c.repoRoot, path: c.path })), file: file.value.trim(), clipboard: clip.checked, reverse: reverse.checked };
        return rpc.call('ok', r);
      };
      break;
    }
    case 'applyPatch': {
      okLabel = 'Apply Patch';
      let repoRoot = init.repoRoot;
      const file = textField({ value: init.file || '(clipboard)' });
      file.readOnly = true;
      const browse = button({ label: 'Browse…', onClick: async () => {
        try {
          const r = await rpc.call<{ file: string; changes: DialogChange[] } | undefined>('browse');
          if (!r) return;
          file.value = r.file;
          setChanges(r.changes);
          dlg.setError(undefined);
        } catch (e) {
          dlg.setError(errorText(e));
        }
      } });
      body.append(h('div.sv-row', null, h('label.sv-label', null, 'Patch file name:'), file, browse));
      if (init.repos.length > 1) {
        const combo = comboBox({
          options: init.repos.map((r) => ({ value: r.root, label: r.name, icon: 'repo', description: r.root })),
          value: repoRoot,
          onChange: async (v) => {
            repoRoot = v;
            try {
              const r = await rpc.call<{ changes: DialogChange[] } | undefined>('setRepo', { repoRoot: v });
              if (r) setChanges(r.changes);
              dlg.setError(undefined);
            } catch (e) {
              dlg.setError(errorText(e));
            }
          },
        });
        body.append(h('div.sv-row', null, h('label.sv-label', null, 'Git Root:'), combo.element));
      }
      body.append(treeEl, count);
      ok = () => {
        const r: ApplyPatchResult = { repoRoot, file: file.value, paths: checked().map((c) => c.path) };
        return rpc.call('ok', r);
      };
      break;
    }
  }

  function setChanges(c: DialogChange[]): void {
    changes = c;
    tree.setRoots(roots(), { resetChecks: true });
    updateCount();
  }

  const dlg = dialogLayout(document.getElementById('app')!, {
    title: init.title,
    body,
    buttons: [
      {
        id: 'ok',
        label: okLabel,
        primary: true,
        run: async () => {
          dlg.setBusy(true);
          try {
            await ok();
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
  dlg.body.style.display = 'flex';
  dlg.body.style.flexDirection = 'column';
  dlg.body.style.minHeight = '0';
  setChanges(changes);
}
