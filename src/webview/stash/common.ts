// Shared bits of the stash / shelf / unstash webviews: page CSS and the IntelliJ-style file nodes (grouped by
// directory, compacted folders, status colors) of a stash, a shelf or a dialog's changes tree.
import type { ChangeKind } from '../../core/types';
import { buildPathTree, gitStatusClass, gitStatusLabel, pathTreeToNodes, type TreeNode } from '../shared/ui';

const CSS = `
html, body, #app { height: 100%; margin: 0; overflow: hidden; }
.sv-app { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.sv-toolbar { flex: 0 0 auto; padding: 2px 4px; border-bottom: 1px solid var(--jb-border); }
.sv-tree { flex: 1 1 auto; min-height: 0; position: relative; }
.sv-tree > * { height: 100%; }
.sv-error { color: var(--jb-error); padding: 4px 8px; white-space: pre-wrap; }
.sv-hidden { display: none !important; }
.sv-dialog-body { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; box-sizing: border-box; }
.sv-dialog-tree { flex: 1 1 auto; min-height: 140px; border: 1px solid var(--jb-border); border-radius: var(--jb-radius-sm); position: relative; overflow: hidden; }
.sv-dialog-tree > * { height: 100%; }
.sv-dialog-count { color: var(--jb-fg-muted); font-size: 12px; }
.sv-message { width: 100%; box-sizing: border-box; min-height: 90px; resize: vertical; font-family: var(--jb-mono); font-size: var(--jb-mono-size); line-height: 1.45; padding: 6px 8px; }
.sv-row { display: flex; align-items: center; gap: 6px; }
.sv-row > .jb-input { flex: 1 1 auto; min-width: 0; }
.sv-label { color: var(--jb-fg); min-width: 110px; }
.sv-value { color: var(--jb-fg); user-select: text; -webkit-user-select: text; }
.sv-list-wrap { display: flex; gap: 8px; flex: 1 1 auto; min-height: 160px; }
.sv-list { flex: 1 1 auto; min-width: 0; border: 1px solid var(--jb-border); border-radius: var(--jb-radius-sm); position: relative; overflow: hidden; }
.sv-list > * { height: 100%; }
.sv-side-buttons { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
.sv-side-buttons .jb-btn { min-width: 76px; }
.sv-options { display: flex; flex-direction: column; gap: 6px; }
.sv-hint { color: var(--jb-fg-muted); font-size: 12px; }
.sv-field-error { color: var(--jb-error); font-size: 12px; min-height: 0; }
`;

let injected = false;
export function injectCss(extra = ''): void {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS + extra;
  document.head.appendChild(s);
}

export interface FileLike {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
}

/** File nodes of one change list, grouped by directory like IntelliJ's changes browsers. */
export function fileNodes<T extends FileLike, D>(
  files: readonly T[],
  opts: { idPrefix: string; groupByDirectory?: boolean; data(f: T): D; extra?(f: T): Partial<TreeNode<D>> },
): TreeNode<D>[] {
  const tree = buildPathTree(files, { path: (f) => f.path, groupByDirectory: opts.groupByDirectory ?? true, compact: true, idPrefix: opts.idPrefix });
  return pathTreeToNodes<T, D>(tree, {
    file: (n) => ({
      className: gitStatusClass(n.item.kind),
      tooltip: `${n.item.oldPath ? `${n.item.oldPath} → ` : ''}${n.path} (${gitStatusLabel(n.item.kind)})`,
      data: opts.data(n.item),
      ...opts.extra?.(n.item),
    }),
  });
}

/** Files under a node (the node itself when it is a file), in display order. */
export function filesUnder<D>(node: TreeNode<D>, isFile: (d: D | undefined) => boolean): TreeNode<D>[] {
  if (isFile(node.data)) return [node];
  return (node.children ?? []).flatMap((c) => filesUnder(c, isFile));
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
