// "Manage Remotes…" (IntelliJ's Git Remotes dialog as a quick pick): list remotes, Add Remote…, edit URL,
// rename and remove; adding a remote fetches it like IntelliJ does.
import * as vscode from 'vscode';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import type { Remote } from '../../core/types';
import { confirm, inputBox, withProgress } from './common';
import { checkRemoteName } from './logic';

interface RemoteItem extends vscode.QuickPickItem {
  remote?: Remote;
  add?: boolean;
}

const BTN_EDIT: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit URL…' };
const BTN_RENAME: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('symbol-text'), tooltip: 'Rename…' };
const BTN_REMOVE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('remove'), tooltip: 'Remove' };
const BTN_ADD: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('add'), tooltip: 'Add Remote' };

export async function manageRemotes(repo: Repository): Promise<void> {
  const qp = vscode.window.createQuickPick<RemoteItem>();
  qp.title = `Git Remotes — ${repo.name}`;
  qp.placeholder = 'Select a remote to edit it';
  qp.matchOnDescription = true;
  qp.buttons = [BTN_ADD];
  let remotes: Remote[] = [];
  const load = async () => {
    qp.busy = true;
    try {
      remotes = await repo.remotes();
      qp.items = [
        ...remotes.map((r) => ({
          label: `$(cloud) ${r.name}`,
          description: r.fetchUrl,
          detail: r.pushUrl && r.pushUrl !== r.fetchUrl ? `push: ${r.pushUrl}` : undefined,
          remote: r,
          buttons: [BTN_EDIT, BTN_RENAME, BTN_REMOVE],
        })),
        { label: '$(add) Add Remote…', add: true, alwaysShow: true },
      ];
    } catch (e) {
      await showGitError(e, 'Cannot list remotes');
    } finally {
      qp.busy = false;
    }
  };
  const run = async (fn: () => Promise<unknown>) => {
    qp.hide();
    await fn();
    await manageRemotes(repo);
  };
  qp.onDidTriggerButton(() => run(() => addRemote(repo, remotes)));
  qp.onDidTriggerItemButton((e) => {
    const r = e.item.remote;
    if (!r) return;
    if (e.button === BTN_EDIT) run(() => editUrl(repo, r));
    else if (e.button === BTN_RENAME) run(() => renameRemote(repo, r, remotes));
    else if (e.button === BTN_REMOVE) run(() => removeRemote(repo, r));
  });
  qp.onDidAccept(async () => {
    const it = qp.selectedItems[0];
    if (!it) return;
    if (it.add) return run(() => addRemote(repo, remotes));
    const r = it.remote!;
    qp.hide();
    const pick = await vscode.window.showQuickPick(['Edit URL…', 'Rename…', 'Remove', 'Fetch'], { title: `Remote '${r.name}'`, placeHolder: r.fetchUrl });
    if (!pick) return manageRemotes(repo);
    if (pick === 'Edit URL…') await editUrl(repo, r);
    else if (pick === 'Rename…') await renameRemote(repo, r, remotes);
    else if (pick === 'Remove') await removeRemote(repo, r);
    else await fetchRemote(repo, r.name);
    await manageRemotes(repo);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  await load();
}

async function fetchRemote(repo: Repository, name: string): Promise<void> {
  try {
    await withProgress(`Fetching ${name}…`, () => repo.exec(['fetch', name]));
  } catch (e) {
    await showGitError(e, `Fetch failed`);
  }
}

async function askUrl(title: string, value?: string): Promise<string | undefined> {
  const res = await inputBox({
    title,
    prompt: 'URL:',
    value,
    placeholder: 'https://example.com/user/repo.git',
    validate: (v) => (!v ? 'Remote URL cannot be empty' : undefined),
  });
  return res && res !== 'back' ? res.value : undefined;
}

export async function addRemote(repo: Repository, existing?: Remote[]): Promise<void> {
  const names = (existing ?? (await repo.remotes())).map((r) => r.name);
  const name = await inputBox({
    title: 'Define Remote',
    prompt: 'Name:',
    value: names.includes('origin') ? '' : 'origin',
    validate: (v) => checkRemoteName(v, names),
  });
  if (!name || name === 'back') return;
  const url = await askUrl('Define Remote');
  if (!url) return;
  try {
    await withProgress('Adding Remote…', () => repo.exec(['remote', 'add', name.value, url]));
  } catch (e) {
    await showGitError(e, `Cannot add remote ${name.value} '${url}'`);
    return;
  }
  await fetchRemote(repo, name.value);
}

async function editUrl(repo: Repository, r: Remote): Promise<void> {
  const url = await askUrl(`Edit Remote '${r.name}'`, r.fetchUrl);
  if (!url || url === r.fetchUrl) return;
  try {
    await withProgress('Changing Remote…', () => repo.exec(['remote', 'set-url', r.name, url]));
  } catch (e) {
    await showGitError(e, `Cannot change remote ${r.name} to url '${url}'`);
  }
}

async function renameRemote(repo: Repository, r: Remote, all: Remote[]): Promise<void> {
  const names = all.map((x) => x.name);
  const res = await inputBox({ title: `Rename Remote '${r.name}'`, prompt: 'Name:', value: r.name, validate: (v) => checkRemoteName(v, names, r.name) });
  if (!res || res === 'back' || res.value === r.name) return;
  try {
    await withProgress('Changing Remote…', () => repo.exec(['remote', 'rename', r.name, res.value]));
  } catch (e) {
    await showGitError(e, `Cannot change remote ${r.name} to name '${res.value}'`);
  }
}

async function removeRemote(repo: Repository, r: Remote): Promise<void> {
  const pick = await confirm('Remove Remote', `Remove remote ${r.name}?`, 'Remove');
  if (!pick) return;
  try {
    await withProgress('Removing Remote…', () => repo.exec(['remote', 'remove', r.name]));
  } catch (e) {
    await showGitError(e, `Cannot remove remote ${r.name}`);
  }
}
