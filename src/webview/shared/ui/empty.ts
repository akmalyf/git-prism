// Empty-state text (IntelliJ StatusText): centered grey lines, optionally with clickable links.
import { h, type Child } from './dom';
import { formatShortcut } from './format';
import { ensureStyles } from './styles';

export interface EmptyLink {
  text: string;
  run(): void;
  shortcut?: string;
}
export type EmptySegment = string | EmptyLink;
export type EmptyLine = string | EmptySegment[];

export function emptyState(lines: EmptyLine[] | string, opts: { className?: string } = {}): HTMLElement {
  ensureStyles();
  const list = typeof lines === 'string' ? [lines] : lines;
  const el = h('div.jb-empty', { class: opts.className });
  list.forEach((line, i) => {
    const segs: Child[] = (typeof line === 'string' ? [line] : line).map((s) =>
      typeof s === 'string'
        ? s
        : [
            h('button.jb-link', {
              type: 'button',
              onClick: (e: MouseEvent) => {
                e.stopPropagation();
                s.run();
              },
            }, s.text),
            s.shortcut ? h('span.jb-kbd', null, ` ${formatShortcut(s.shortcut)}`) : null,
          ],
    );
    el.append(h('div.jb-empty-line', { class: i === 0 ? 'jb-empty-main' : undefined }, segs));
  });
  return el;
}
