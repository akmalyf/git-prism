// Reference labels of a commit row as IntelliJ paints them (pure): a local branch and the remote branch it
// tracks become one "origin & main" label, tags may be shown as icons only (Tag Names off), Compact References
// View keeps the first label's text and shows the others as icons.
import type { RefKind, RefLabel } from '../../features/log/protocol';

export interface LabelPart {
  /** text shown; '' = icon only */
  text: string;
  /** one icon per grouped ref, in display order */
  kinds: RefKind[];
  current: boolean;
  favorite: boolean;
  /** the grouped refs (for tooltips / actions) */
  refs: RefLabel[];
}

export interface LabelOptions {
  showTagNames: boolean;
  compact: boolean;
}

export function groupLabels(refs: readonly RefLabel[], o: LabelOptions): LabelPart[] {
  const used = new Set<RefLabel>();
  const out: LabelPart[] = [];
  const byName = new Map(refs.map((r) => [r.name, r]));
  for (const r of refs) {
    if (used.has(r)) continue;
    used.add(r);
    if (r.kind === 'local' && r.upstream) {
      const remote = byName.get(r.upstream);
      if (remote && remote.kind === 'remote' && !used.has(remote)) {
        used.add(remote);
        const remoteName = remote.remote ?? r.upstream.slice(0, r.upstream.indexOf('/'));
        const branchPart = r.upstream.slice(remoteName.length + 1);
        const text = branchPart === r.name ? `${remoteName} & ${r.name}` : `${r.upstream} & ${r.name}`;
        out.push({ text, kinds: ['remote', 'local'], current: !!r.current, favorite: !!(r.favorite || remote.favorite), refs: [r, remote] });
        continue;
      }
    }
    out.push({ text: r.kind === 'tag' && !o.showTagNames ? '' : r.name, kinds: [r.kind], current: !!r.current, favorite: !!r.favorite, refs: [r] });
  }
  if (o.compact && out.length > 1) {
    return out.map((p, i) => (i === 0 ? p : { ...p, text: '' }));
  }
  return out;
}

/** Tooltip text listing every reference of a row. */
export function labelsTooltip(refs: readonly RefLabel[]): string {
  return refs.map((r) => (r.kind === 'tag' ? `Tag: ${r.name}` : r.kind === 'HEAD' ? 'HEAD' : r.name + (r.current ? ' (current)' : ''))).join('\n');
}
