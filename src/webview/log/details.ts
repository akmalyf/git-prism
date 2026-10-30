// Commit details below the changed files (IntelliJ CommitDetailsListPanel): full message in the editor font with
// clickable hashes and URLs, reference labels, "<hash> <author> <email> on <date> at <time>", committer when it
// differs, "In N branches: …" loaded lazily; several selected commits are stacked (at most 50).
import type { CommitDetails, ContainingBranches, LogRow } from '../../features/log/protocol';
import { rpc } from '../shared/rpc';
import { emptyState, h, pluralize } from '../shared/ui';
import { renderLabel } from './committable';
import { dateAndTime } from './dates';
import { groupLabels } from './labels';
import { linkify } from './linkify';

const MAX = 50;
const BRANCHES_SHOWN = 6;

export interface DetailsHost {
  /** navigate to a hash / ref mentioned in a message */
  goTo(text: string): void;
}

export class DetailsPane {
  readonly element: HTMLElement;
  private seq = 0;

  constructor(private readonly host: DetailsHost) {
    this.element = h('div.lg-details', { tabIndex: -1, attrs: { 'aria-label': 'Commit details' } });
    this.showEmpty();
  }

  private showEmpty(text = 'No commits selected'): void {
    this.element.replaceChildren(emptyState(text));
  }

  async show(rows: LogRow[], rootOf: (r: LogRow) => string): Promise<void> {
    const seq = ++this.seq;
    if (!rows.length) return this.showEmpty();
    const shown = rows.slice(0, MAX);
    let details: CommitDetails[];
    try {
      details = await rpc.call<CommitDetails[]>('details', { commits: shown.map((r) => ({ root: rootOf(r), hash: r.hash })) });
    } catch {
      if (seq === this.seq) this.showEmpty('Error loading commit details');
      return;
    }
    if (seq !== this.seq) return;
    const blocks: HTMLElement[] = [];
    if (rows.length > 1) {
      blocks.push(h('div.lg-details-summary', null, `${pluralize(rows.length, 'commit')} selected`, rows.length > MAX ? h('span.jb-muted', null, ` (showing ${MAX} of ${rows.length} selected commits)`) : null));
    }
    details.forEach((d, i) => {
      if (i > 0) blocks.push(h('div.lg-details-sep'));
      blocks.push(this.block(d, details.length === 1, seq));
    });
    this.element.replaceChildren(...blocks);
    this.element.scrollTop = 0;
  }

  private block(d: CommitDetails, single: boolean, seq: number): HTMLElement {
    const msg = h('div.lg-details-message');
    for (const s of linkify(d.message)) {
      if (s.kind === 'text') msg.append(s.text);
      else if (s.kind === 'url') msg.append(h('a.jb-link', { href: s.text, title: s.text }, s.text));
      else msg.append(h('a.jb-link', { href: '#', title: `Go to ${s.text}`, onClick: (e: MouseEvent) => {
        e.preventDefault();
        this.host.goTo(s.text);
      } }, s.text));
    }
    const { date, time } = dateAndTime(d.authorDate);
    const hash = h('a.jb-link.jb-mono', { href: '#', title: 'Go to commit', onClick: (e: MouseEvent) => {
      e.preventDefault();
      this.host.goTo(d.hash);
    } }, d.hash.slice(0, 8));
    const info = h('div.lg-details-info', null, hash, ' ', h('span.lg-details-author', null, d.author), ' ', h('a.jb-link', { href: `mailto:${d.authorEmail}` }, `<${d.authorEmail}>`), ` on ${date} at ${time}`);
    const lines: HTMLElement[] = [msg];
    if (d.refs.length) {
      lines.push(h('div.lg-details-refs', null, groupLabels(d.refs, { showTagNames: true, compact: false }).map(renderLabel)));
    }
    lines.push(info);
    if (d.committer && (d.committer !== d.author || d.committerEmail !== d.authorEmail || d.commitDate !== d.authorDate)) {
      const c = dateAndTime(d.commitDate);
      const by = d.committer !== d.author || d.committerEmail !== d.authorEmail;
      lines.push(h('div.lg-details-info.jb-muted', null, by ? `committed by ${d.committer} on ${c.date} at ${c.time}` : `committed on ${c.date} at ${c.time}`));
    }
    if (single) {
      const branches = h('div.lg-details-branches.jb-muted', null, 'In branches: loading…');
      lines.push(branches);
      void rpc
        .call<ContainingBranches>('containingBranches', { root: d.root, hash: d.hash })
        .then((b) => {
          if (seq === this.seq) this.renderBranches(branches, b.branches);
        })
        .catch(() => {
          if (seq === this.seq) branches.textContent = '';
        });
    }
    return h('div.lg-details-block', null, lines);
  }

  private renderBranches(el: HTMLElement, list: string[], all = false): void {
    if (!list.length) {
      el.textContent = 'Not in any branch';
      return;
    }
    const head = `In ${list.length === 1 ? '1 branch' : `${list.length} branches`}: `;
    const shown = all ? list : list.slice(0, BRANCHES_SHOWN);
    el.replaceChildren(head, shown.join(', '));
    if (list.length > BRANCHES_SHOWN) {
      el.append(
        all ? ' ' : ', … ',
        h('a.jb-link', { href: '#', onClick: (e: MouseEvent) => {
          e.preventDefault();
          this.renderBranches(el, list, !all);
        } }, all ? 'Hide' : 'Show all'),
      );
    }
  }
}
