// Commit area of the Commit tool window: "Amend" + "last commit ▾", Commit Message History, the commit message
// editor (monospace, spell check, 72 column margin, Cmd/Ctrl+Enter), Commit / Commit and Push… and the Commit Options
// popover (Author, Sign-off commit, Sign commit with GPG key, Run Git hooks).
import { button, checkbox, formatPrettyDateTime, h, iconButton, isCtrlCmd, listen, setTooltip, shortHash, showListPopup, textField, type PopupEntry } from '../shared/ui';
import { rpc } from '../shared/rpc';
import type { CommitInfo, CommitOptions } from '../../features/commit/protocol';

export interface PanelHost {
  /** repository the amend / history actions apply to */
  primaryRepo(): { root: string; empty: boolean } | undefined;
  commit(push: boolean): void;
  draftChanged(text: string): void;
  optionsChanged(o: CommitOptions): void;
}

export class CommitPanel {
  readonly element: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  private readonly amendBox: ReturnType<typeof checkbox>;
  private readonly lastCommit: HTMLButtonElement;
  private readonly commitBtn: HTMLButtonElement;
  private readonly pushBtn: HTMLButtonElement;
  private readonly gearBtn: HTMLButtonElement;
  private readonly errorEl: HTMLElement;
  private options: CommitOptions = { author: '', signOff: false, gpgSign: false, runHooks: true };
  private draftBeforeAmend = '';
  private amendSeq = 0;
  private draftTimer: number | undefined;
  private optionsEl: HTMLElement | undefined;
  private closeOptions: (() => void) | undefined;
  private busy = false;
  amendTarget: { repo: string; hash: string } | undefined;
  /** "Commit All" label in staging area mode */
  private commitAllLabel = false;

  constructor(private readonly host: PanelHost) {
    this.amendBox = checkbox({ label: 'Amend', onChange: (v) => void this.setAmend(v) });
    this.amendBox.element.title = 'Modify the latest commit of the current branch';
    this.lastCommit = h('button.jb-link.cv-last-commit', { type: 'button', onClick: () => void this.pickCommit() }, h('span.cv-last-commit-text', null, 'last commit'), h('span.jb-chevron'));
    const historyBtn = iconButton({ icon: 'history', tooltip: 'Commit Message History', onClick: () => void this.showHistory(historyBtn) });
    this.textarea = h('textarea.jb-textarea.jb-mono.cv-message', {
      spellcheck: true,
      placeholder: 'Commit Message',
      attrs: { 'aria-label': 'Commit Message' },
      onInput: () => this.onInput(),
      onKeydown: (e: KeyboardEvent) => this.onKey(e),
    });
    this.errorEl = h('div.cv-error.jb-hidden', { attrs: { role: 'alert' } });
    this.commitBtn = button({ label: 'Commit', primary: true, onClick: () => host.commit(false) });
    this.pushBtn = button({ label: 'Commit and Push…', onClick: () => host.commit(true) });
    setTooltip(this.commitBtn, 'Commit', { shortcut: 'CmdOrCtrl+Enter' });
    setTooltip(this.pushBtn, 'Commit and Push…', { shortcut: 'CmdOrCtrl+Alt+K' });
    this.gearBtn = iconButton({ icon: 'gear', tooltip: 'Show Commit Options', onClick: () => this.toggleOptions() });
    this.element = h('div.cv-commit',
      null,
      h('div.cv-amend-row', null, this.amendBox.element, this.lastCommit, h('span.jb-fill'), historyBtn),
      h('div.cv-message-wrap', null, this.textarea),
      this.errorEl,
      h('div.cv-buttons', null, this.commitBtn, this.pushBtn, h('span.jb-fill'), this.gearBtn),
    );
  }

  get message(): string {
    return this.textarea.value;
  }

  get amend(): boolean {
    return this.amendBox.checked;
  }

  get commitOptions(): CommitOptions {
    return this.options;
  }

  setOptions(o: CommitOptions): void {
    this.options = { ...o };
    this.gearBtn.classList.toggle('cv-gear-modified', !!o.author || o.signOff || o.gpgSign || !o.runHooks);
  }

  /** Replaces the message (draft switch, history pick, prefill from jbGit.commit.focus). */
  setMessage(text: string, focus = false): void {
    this.textarea.value = text;
    this.clearError();
    if (focus) {
      this.textarea.focus();
      this.textarea.setSelectionRange(text.length, text.length);
    }
  }

  focus(): void {
    this.textarea.focus();
  }

  setAmendEnabled(enabled: boolean): void {
    this.amendBox.setDisabled(!enabled);
    this.lastCommit.disabled = !enabled;
    if (!enabled && this.amend) void this.setAmend(false, true);
  }

  setCommitAll(all: boolean): void {
    this.commitAllLabel = all;
    this.updateLabels();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.commitBtn.disabled = busy;
    this.pushBtn.disabled = busy;
  }

  showError(text: string | undefined): void {
    this.errorEl.textContent = text ?? '';
    this.errorEl.classList.toggle('jb-hidden', !text);
  }

  clearError(): void {
    this.showError(undefined);
  }

  /** After a successful commit: empty message, amend off. */
  reset(): void {
    if (this.amend) this.amendBox.set(false);
    this.amendTarget = undefined;
    this.draftBeforeAmend = '';
    this.setLastCommitLabel(undefined);
    this.updateLabels();
    this.setMessage('');
  }

  private updateLabels(): void {
    const amend = this.amend;
    this.commitBtn.textContent = amend ? 'Amend Commit' : this.commitAllLabel ? 'Commit All' : 'Commit';
    this.pushBtn.textContent = amend ? 'Amend Commit and Push…' : 'Commit and Push…';
  }

  private setLastCommitLabel(c: CommitInfo | undefined): void {
    const t = this.lastCommit.querySelector('.cv-last-commit-text')!;
    t.textContent = c ? c.subject : 'last commit';
    this.lastCommit.title = c ? `${shortHash(c.hash)} ${c.subject}` : '';
  }

  async setAmend(on: boolean, silent = false): Promise<void> {
    if (this.amendBox.checked !== on) this.amendBox.set(on);
    this.updateLabels();
    const seq = ++this.amendSeq;
    if (on) {
      this.draftBeforeAmend = this.textarea.value;
      const repo = this.amendTarget?.repo ?? this.host.primaryRepo()?.root;
      if (!repo) return;
      const msg = this.amendTarget
        ? await rpc.call<string>('commitMessage', { repo, hash: this.amendTarget.hash })
        : await rpc.call<string>('amendMessage', { repo });
      if (seq !== this.amendSeq || !this.amend) return;
      this.setMessage(msg);
    } else {
      this.amendTarget = undefined;
      this.setLastCommitLabel(undefined);
      if (!silent || this.draftBeforeAmend) this.setMessage(this.draftBeforeAmend);
      this.host.draftChanged(this.textarea.value);
    }
  }

  private async pickCommit(): Promise<void> {
    const repo = this.host.primaryRepo();
    if (!repo || repo.empty) return;
    const commits = await rpc.call<CommitInfo[]>('amendableCommits', { repo: repo.root });
    if (!commits.length) return;
    const items: PopupEntry<string>[] = commits.map((c, i) => ({
      value: c.hash,
      label: c.subject,
      description: shortHash(c.hash),
      trailing: `${c.author}, ${formatPrettyDateTime(c.date)}`,
      disabled: c.merge && i > 0,
      checked: (this.amendTarget?.hash ?? commits[0].hash) === c.hash,
    }));
    const picked = await showListPopup(this.lastCommit, { items, width: Math.min(460, window.innerWidth - 16), search: commits.length > 10, active: this.amendTarget?.hash ?? commits[0].hash });
    if (!picked?.length) return;
    const hash = picked[0];
    const c = commits.find((x) => x.hash === hash)!;
    const head = hash === commits[0].hash;
    const wasAmend = this.amend;
    this.amendTarget = head ? undefined : { repo: repo.root, hash };
    this.setLastCommitLabel(head ? undefined : c);
    if (!wasAmend) await this.setAmend(true);
    else {
      const seq = ++this.amendSeq;
      const msg = await rpc.call<string>('commitMessage', { repo: repo.root, hash });
      if (seq === this.amendSeq && this.amend) this.setMessage(msg);
    }
  }

  private async showHistory(anchor: HTMLElement): Promise<void> {
    const repo = this.host.primaryRepo();
    const h0 = await rpc.call<{ messages: string[]; recent: string[] }>('history', { repo: repo?.root });
    const seen = new Set(h0.messages.map((m) => m.trim()));
    const recent = h0.recent.filter((m) => !seen.has(m.trim()));
    const entry = (m: string) => {
      const lines = m.split('\n');
      return { value: m, label: lines[0], description: lines.length > 1 ? '…' : undefined, tooltip: m, searchText: m };
    };
    const items: PopupEntry<string>[] = [...h0.messages.map(entry)];
    if (recent.length) items.push(...(items.length ? ['-' as const] : []), ...recent.map(entry));
    const picked = await showListPopup(anchor, { title: 'Commit Message History', items, search: true, width: Math.min(420, window.innerWidth - 16), emptyText: 'No commit messages', align: 'end' });
    if (!picked?.length) return;
    this.setMessage(picked[0], true);
    this.onInput();
  }

  private onInput(): void {
    this.clearError();
    if (this.amend) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => this.host.draftChanged(this.textarea.value), 400);
  }

  /** Saves a pending draft immediately (before switching the draft target). */
  flushDraft(): void {
    if (this.draftTimer === undefined) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    if (!this.amend) this.host.draftChanged(this.textarea.value);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && isCtrlCmd(e) && !this.busy) {
      e.preventDefault();
      this.host.commit(e.altKey);
    } else if ((e.key === 'k' || e.key === 'K' || e.code === 'KeyK') && isCtrlCmd(e) && e.altKey && !this.busy) {
      e.preventDefault();
      this.host.commit(true);
    }
  }

  // ---------------------------------------------------------------- Commit Options popover

  private toggleOptions(): void {
    if (this.optionsEl) {
      this.closeOptions?.();
      return;
    }
    const save = () => {
      this.setOptions(this.options);
      this.host.optionsChanged(this.options);
    };
    const author = textField({ value: this.options.author, placeholder: 'Name <email>', onInput: () => ((this.options.author = author.value), save()) });
    author.setAttribute('list', 'cv-authors');
    author.style.width = '100%';
    const list = h('datalist', { id: 'cv-authors' });
    void rpc.call<string[]>('authors').then((names) => list.replaceChildren(...(names ?? []).map((n) => h('option', { value: n }))));
    const signOff = checkbox({ label: 'Sign-off commit', checked: this.options.signOff, onChange: (v) => ((this.options.signOff = v), save()) });
    const signOffTip = (who: string) => (signOff.element.title = `Adds the following line at the end of the commit message:\nSigned-off by: ${who}`);
    signOffTip(this.options.author || '<author>');
    void rpc.call<string>('identity', { repo: this.host.primaryRepo()?.root }).then((who) => {
      if (who && !this.options.author) signOffTip(who);
    });
    const gpg = checkbox({ label: 'Sign commit with GPG key', checked: this.options.gpgSign, onChange: (v) => ((this.options.gpgSign = v), save()) });
    gpg.element.title = 'Sign the commit with the GPG key configured in Git (user.signingkey)';
    const hooks = checkbox({ label: 'Run Git hooks', checked: this.options.runHooks, onChange: (v) => ((this.options.runHooks = v), save()) });
    hooks.element.title = "If unchecked, Git hooks will be skipped with the '--no-verify' option for the upcoming commit";
    const el = h('div.cv-options', { attrs: { role: 'dialog', 'aria-label': 'Commit Options' }, tabIndex: -1 },
      h('div.cv-options-title', null, 'Git'),
      h('div.cv-options-row', null, h('label.cv-options-label', null, 'Author:'), author, list),
      signOff.element,
      gpg.element,
      hooks.element,
    );
    document.body.appendChild(el);
    const r = this.gearBtn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    el.style.bottom = `${Math.max(8, window.innerHeight - r.top + 4)}px`;
    this.optionsEl = el;
    this.gearBtn.classList.add('jb-on');
    const subs = [
      listen(document, 'mousedown', (e) => {
        if (!el.contains(e.target as Node) && !this.gearBtn.contains(e.target as Node)) close();
      }),
      listen(document, 'keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
          this.gearBtn.focus();
        }
      }),
    ];
    const close = () => {
      subs.forEach((s) => s.dispose());
      el.remove();
      this.optionsEl = undefined;
      this.closeOptions = undefined;
      this.gearBtn.classList.remove('jb-on');
    };
    this.closeOptions = close;
    requestAnimationFrame(() => author.focus());
  }
}
