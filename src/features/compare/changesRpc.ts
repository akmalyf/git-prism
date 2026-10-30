// Host side of every changes tree of this feature (Changes browser, compare-branches Files tab, commit changes):
// load, Show Diff, Compare with Local, Get, Show History, Jump to Source.
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { invoke } from '../../core/contracts';
import { showGitError } from '../../core/git';
import type { Repository } from '../../core/repository';
import type { FileChange } from '../../core/types';
import { invertChanges, shortRev } from './parse';
import type { ChangesSource } from './protocol';
import { diffFiles, diffNameStatus, LITERAL } from './util';

export function historyTitle(rel: string): string {
  return `History: ${rel.slice(rel.lastIndexOf('/') + 1)}`;
}

export function showHistory(repo: Repository, paths: string[], title: string): Thenable<unknown> {
  return invoke('gitPrism.log.show', { repoRoot: repo.root, paths, editorTab: true, title });
}

export async function loadChanges(repo: Repository, src: ChangesSource): Promise<FileChange[]> {
  const changes = await diffNameStatus(repo, src.from, src.to, src.paths ?? []);
  return src.swapped ? invertChanges(changes) : changes;
}

function sideLabel(rev: string | undefined): string {
  return rev ? shortRev(rev) : 'Local';
}

/** RPC handlers bound to one repository; `diffTitle` names the diff tab. */
export function changesHandlers(repo: Repository, diffTitle: (src: ChangesSource) => string | undefined = () => undefined) {
  return {
    'changes.load': (p: ChangesSource) => loadChanges(repo, p),

    'changes.diff': async (p: ChangesSource & { files: FileChange[]; index: number }) => {
      if (!p.files.length) return;
      await invoke('gitPrism.diff.show', { title: diffTitle(p), files: diffFiles(repo, p, p.files), index: p.index });
    },

    'changes.compareWithLocal': async (p: ChangesSource & { file: FileChange }) => {
      const after = p.swapped ? p.from : p.to;
      const f = p.file;
      if (!after) {
        await invoke('gitPrism.diff.show', { files: diffFiles(repo, p, [f]) });
        return;
      }
      await invoke('gitPrism.diff.show', {
        files: [{
          repoRoot: repo.root,
          path: f.path,
          kind: f.kind,
          left: f.kind === 'D' ? { empty: true } : { rev: after, path: f.path },
          right: fs.existsSync(repo.abs(f.path)) ? { worktree: true, path: f.path } : { empty: true },
          rightTitle: 'Your version',
        }],
      });
    },

    'changes.get': async (p: ChangesSource & { files: FileChange[] }) => {
      // the revision side we take content from: the branch when comparing with the working tree, else the "after" side
      const side: 'left' | 'right' = p.to ? 'right' : p.swapped ? 'right' : 'left';
      const rev = p.to ? (p.swapped ? p.from : p.to) : p.from;
      const checkout: string[] = [];
      const remove: string[] = [];
      for (const f of p.files) {
        if (side === 'left') {
          if (f.kind === 'A') remove.push(f.path);
          else checkout.push(f.oldPath ?? f.path);
          if (f.kind === 'R' && !p.to) remove.push(f.path);
        } else {
          if (f.kind === 'D') remove.push(f.path);
          else checkout.push(f.path);
          if (f.kind === 'R' && f.oldPath && !p.to) remove.push(f.oldPath);
        }
      }
      const title = p.to ? 'Get from Revision' : `Get from Branch '${rev}'`;
      const n = p.files.length;
      const pick = await vscode.window.showWarningMessage(
        title,
        { modal: true, detail: `Replace ${n === 1 ? p.files[0].path : `${n} files`} with ${n === 1 ? 'its version' : 'their versions'} from ${sideLabel(rev)}?\nLocal changes in ${n === 1 ? 'this file' : 'these files'} will be lost.` },
        'Get',
      );
      if (pick !== 'Get') return false;
      try {
        // like IntelliJ's copyChangesFromBranch: delete first (a rename's old path), then check out
        if (remove.length) await repo.exec([LITERAL, 'rm', '-f', '-q', '--ignore-unmatch', '--', ...remove]);
        for (const r of remove) if (fs.existsSync(repo.abs(r))) fs.rmSync(repo.abs(r), { force: true });
        if (checkout.length) await repo.exec([LITERAL, 'checkout', rev, '--', ...checkout]);
      } catch (e) {
        showGitError(e, 'Cannot Copy Changes');
      }
      return true;
    },

    'changes.history': (p: { path: string }) => showHistory(repo, [p.path], historyTitle(p.path)),

    'changes.jumpToSource': async (p: { files: FileChange[] }) => {
      let opened = 0;
      for (const f of p.files) {
        const abs = repo.abs(f.path);
        if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
        await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: p.files.length === 1, preserveFocus: false });
        opened++;
      }
      if (!opened) vscode.window.showInformationMessage('The file doesn\'t exist in the working tree.');
    },
  };
}
