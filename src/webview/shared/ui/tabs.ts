// Tool-window style tabs ("Git: Log | Console | +"): text tabs with underline, optional icons, close buttons,
// "+" button, keyboard navigation; tabs with `content` are shown/hidden automatically in `panels`.
import { h, DisposableStore, Emitter } from './dom';
import { icon } from './icons';
import { setTooltip } from './tooltip';
import { ensureStyles } from './styles';

export interface TabItem {
  id: string;
  label: string;
  icon?: string;
  closable?: boolean;
  tooltip?: string;
  content?: HTMLElement;
}

export interface TabsOptions {
  tabs: TabItem[];
  active?: string;
  /** text before the tabs, e.g. "Git:" */
  prefix?: string;
  add?: { tooltip: string; run(): void };
  /** extra elements on the right side of the tab strip */
  trailing?: HTMLElement;
}

export class Tabs {
  readonly element: HTMLElement;
  readonly strip: HTMLElement;
  readonly panels: HTMLElement;
  private tabs: TabItem[] = [];
  private activeId: string | undefined;
  private readonly store = new DisposableStore();
  private tabStore = new DisposableStore();
  private readonly changed = new Emitter<string>();
  private readonly closed = new Emitter<string>();
  readonly onDidChange = this.changed.event;
  readonly onDidClose = this.closed.event;

  constructor(parent: HTMLElement | null, private readonly o: TabsOptions) {
    ensureStyles();
    this.strip = h('div.jb-tabs-strip', { attrs: { role: 'tablist' }, onKeydown: (e: KeyboardEvent) => this.onKey(e) });
    this.panels = h('div.jb-tab-panels');
    this.element = h('div.jb-tabs', null, h('div.jb-tabs-bar', null, o.prefix ? h('span.jb-tabs-prefix', null, o.prefix) : null, this.strip, h('div.jb-fill'), o.trailing ?? null), this.panels);
    this.activeId = o.active ?? o.tabs[0]?.id;
    this.setTabs(o.tabs);
    parent?.appendChild(this.element);
  }

  get active(): string | undefined {
    return this.activeId;
  }

  setTabs(tabs: TabItem[]): void {
    this.tabs = tabs;
    if (!tabs.some((t) => t.id === this.activeId)) this.activeId = tabs[0]?.id;
    for (const t of tabs) if (t.content && t.content.parentElement !== this.panels) this.panels.append(t.content);
    this.render();
  }

  setActive(id: string, fire = false): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    const changed = id !== this.activeId;
    this.activeId = id;
    this.render();
    if (changed && fire) this.changed.fire(id);
  }

  updateTab(id: string, patch: Partial<TabItem>): void {
    this.tabs = this.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.render();
  }

  private render(): void {
    this.tabStore.dispose();
    this.tabStore = new DisposableStore();
    this.strip.replaceChildren();
    for (const t of this.tabs) {
      const on = t.id === this.activeId;
      const tab = h('div.jb-tab', {
        class: { 'jb-active': on },
        tabIndex: on ? 0 : -1,
        dataset: { tabId: t.id },
        attrs: { role: 'tab', 'aria-selected': String(on) },
        onMousedown: (e: MouseEvent) => {
          if (e.button === 1 && t.closable) {
            e.preventDefault();
            this.closed.fire(t.id);
          }
        },
        onClick: () => this.select(t.id),
      },
        t.icon ? icon(t.icon) : null,
        h('span.jb-tab-label', null, t.label),
        t.closable
          ? h('button.jb-tab-close', { type: 'button', tabIndex: -1, onClick: (e: MouseEvent) => {
              e.stopPropagation();
              this.closed.fire(t.id);
            } }, icon('close'))
          : null,
      );
      if (t.tooltip) this.tabStore.add(setTooltip(tab, t.tooltip));
      this.strip.append(tab);
    }
    if (this.o.add) {
      const add = this.o.add;
      const b = h('button.jb-icon-btn.jb-tab-add', { type: 'button', tabIndex: -1, onClick: () => add.run() }, icon('add'));
      this.tabStore.add(setTooltip(b, add.tooltip));
      this.strip.append(b);
    }
    for (const t of this.tabs) t.content?.classList.toggle('jb-hidden', t.id !== this.activeId);
  }

  private select(id: string): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.render();
    this.changed.fire(id);
    (this.strip.querySelector(`.jb-tab.jb-active`) as HTMLElement | null)?.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowRight') j = (i + 1) % this.tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + this.tabs.length) % this.tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = this.tabs.length - 1;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.tabs[i].closable) {
      this.closed.fire(this.tabs[i].id);
      return;
    } else return;
    e.preventDefault();
    this.select(this.tabs[j].id);
  }

  dispose(): void {
    this.tabStore.dispose();
    this.store.dispose();
    this.changed.dispose();
    this.closed.dispose();
    this.element.remove();
  }
}
