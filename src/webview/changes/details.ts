// Commit details block (full message in monospace, hash, author, date, containing branches) shared by the
// compare-branches and history-selection webviews.
import type { Commit } from '../../core/types';
import { formatDateTime, h, link } from '../shared/ui';

export interface DetailsActions {
  copyHash?(hash: string): void;
  showInLog?(hash: string): void;
}

export function commitDetails(c: Commit | { hash: string; subject: string; body?: string; author: string; authorEmail: string; authorDate?: number; date?: number; committer?: string; commitDate?: number }, branches: string[] | undefined, actions: DetailsActions = {}): HTMLElement {
  const date = 'authorDate' in c && c.authorDate !== undefined ? c.authorDate : (c as { date?: number }).date ?? 0;
  const hashEl = actions.showInLog ? link(c.hash.slice(0, 8), () => actions.showInLog!(c.hash), 'Show in Git Log') : h('span', null, c.hash.slice(0, 8));
  const copy = actions.copyHash ? link('Copy', () => actions.copyHash!(c.hash), 'Copy Revision Number') : undefined;
  const committer = 'committer' in c && c.committer && c.committer !== c.author ? h('div', null, `committed by ${c.committer}${c.commitDate ? ` on ${formatDateTime(c.commitDate)}` : ''}`) : undefined;
  return h(
    'div',
    null,
    h('div.msg', null, h('span.subject', null, c.subject), c.body ? `\n\n${c.body}` : ''),
    h(
      'div.meta',
      null,
      h('div', null, hashEl, ' ', copy ?? '', ' ', `${c.author}${c.authorEmail ? ` <${c.authorEmail}>` : ''} on ${formatDateTime(date)}`),
      committer ?? '',
    ),
    branches === undefined ? '' : h('div.branches', null, branches.length ? `In ${branches.length} ${branches.length === 1 ? 'branch' : 'branches'}: ${branches.join(', ')}` : 'Not in any branch'),
  );
}
