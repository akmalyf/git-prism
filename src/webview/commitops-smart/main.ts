// "Git Checkout Problem" dialog: the files whose local changes would be overwritten, and
// Smart Checkout (stash, checkout, unstash) / Force Checkout / Don't Checkout.
import { init, rpc } from '../shared/rpc';
import { buildPathTree, dialogLayout, ensureStyles, h, icon, pathTreeToNodes, setTooltip, Tree } from '../shared/ui';
import type { SmartChoice, SmartDialogInit } from '../../features/commitOps/protocol';

const data = init<SmartDialogInit>();
ensureStyles();

const style = document.createElement('style');
style.textContent = `
html, body, #app { height: 100%; margin: 0; }
.smart-body { display: flex; flex-direction: column; gap: 10px; height: 100%; box-sizing: border-box; }
.smart-text { display: flex; gap: 10px; line-height: 1.5; user-select: text; -webkit-user-select: text; }
.smart-text > .codicon { font-size: 28px; color: var(--jb-warning); flex: none; }
.smart-files { flex: 1 1 auto; min-height: 120px; border: 1px solid var(--jb-border); border-radius: var(--jb-radius-sm); overflow: hidden; display: flex; }
.smart-files > * { flex: 1; }
`;
document.head.appendChild(style);

const files = h('div.smart-files');
const body = h('div.smart-body', null,
  h('div.smart-text', null, icon('warning'), h('div', null, h('div', null, data.text[0]), h('div', null, data.text[1]))),
  files,
);

const choose = (c: SmartChoice) => () => void rpc.call('choose', c);
const dlg = dialogLayout(document.getElementById('app')!, {
  title: data.title,
  body,
  buttons: [
    { id: 'smart', label: data.smartLabel, primary: true, run: choose('smart') },
    { id: 'force', label: data.forceLabel, run: choose('force') },
    { id: 'dont', label: data.dontLabel, cancel: true, run: choose('dont') },
  ],
});
dlg.body.style.display = 'flex';
dlg.body.style.flexDirection = 'column';
const smartBtn = dlg.footer.querySelector<HTMLElement>('.jb-btn-primary');
if (smartBtn) setTooltip(smartBtn, data.smartTooltip);

const tree = new Tree<string>(files, { multiSelect: true, defaultExpandDepth: Infinity, emptyText: ['No files'] });
tree.setRoots(
  pathTreeToNodes(buildPathTree(data.files, { path: (f) => f, groupByDirectory: true, compact: true, idPrefix: 'f:' }), {
    file: (n) => ({ className: 'jb-git-modified', data: n.item }),
  }),
);
tree.onDidActivate(({ node }) => {
  if (node.data) void rpc.call('showDiff', { path: node.data, index: data.files.indexOf(node.data) });
});
