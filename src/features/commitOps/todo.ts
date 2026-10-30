// Pure logic for history rewriting: rebase plans (one entry per commit, oldest first), validation, the
// generated `git rebase -i` todo (messages applied by `exec git commit --amend` lines) and plan builders
// for Edit Commit Message / Squash Commits / Drop Commits. No vscode/node imports (unit-tested).

export type RebaseAction = 'pick' | 'edit' | 'reword' | 'squash' | 'fixup' | 'drop';

export interface RebaseEntry {
  /** full commit hash */
  hash: string;
  action: RebaseAction;
  /** original full commit message (subject + body) */
  message: string;
  /**
   * new message: for 'reword' the reworded message; on the first commit of a squash group the edited
   * combined message (otherwise the combined message is derived from the group)
   */
  newMessage?: string;
}

export interface PlannedMessage {
  /** index into the message files the caller writes (msg-<n>.txt) */
  id: number;
  text: string;
}

export interface Todo {
  /** todo file contents for GIT_SEQUENCE_EDITOR */
  text: string;
  messages: PlannedMessage[];
}

const ACTIONS: RebaseAction[] = ['pick', 'edit', 'reword', 'squash', 'fixup', 'drop'];

export function isRebaseAction(a: string): a is RebaseAction {
  return (ACTIONS as string[]).includes(a);
}

/** Single-quotes a string for sh (used in `exec` lines and GIT_SEQUENCE_EDITOR). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Normalizes a commit message like `git commit --cleanup=whitespace` (trailing blanks, CRLF, edge blank lines). */
export function cleanMessage(msg: string): string {
  const lines = msg.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  const out: string[] = [];
  for (const l of lines) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

export function subjectOf(msg: string): string {
  return cleanMessage(msg).split('\n')[0] ?? '';
}

/** Combined message of a squash: messages joined by a blank line, duplicates removed. */
export function combineMessages(messages: string[]): string {
  const seen: string[] = [];
  for (const m of messages.map(cleanMessage)) if (m && !seen.includes(m)) seen.push(m);
  return seen.join('\n\n');
}

const AUTOSQUASH = /^(fixup|squash|amend)! (.+)/;

/**
 * IntelliJ's GitSquashedCommitsMessage.prettySquash: distinct messages joined by two blank lines; the
 * "fixup!/squash!/amend! <subject>" line is removed when the commit it refers to is part of the squash.
 */
export function prettySquash(messages: string[]): string {
  const firstLine = (m: string) => m.split('\n')[0];
  const subjects = new Set(messages.filter((m) => !AUTOSQUASH.test(firstLine(m))).map(firstLine));
  const out: string[] = [];
  for (const m of messages) {
    const target = AUTOSQUASH.exec(firstLine(m))?.[2];
    let v: string | undefined = m;
    if (target !== undefined && subjects.has(target)) {
      const i = m.indexOf('\n');
      v = i < 0 ? '' : m.slice(i + 1).trim();
      if (!v.trim()) v = undefined;
    }
    if (v !== undefined && !out.includes(v)) out.push(v);
  }
  return out.join('\n\n\n');
}

/** The rows that end up as one commit: a non-squash entry followed by its squash/fixup entries (drops excluded). */
export interface Group {
  head: number;
  members: number[];
}

export function groups(entries: RebaseEntry[]): Group[] {
  const res: Group[] = [];
  entries.forEach((e, i) => {
    if (e.action === 'drop') return;
    if ((e.action === 'squash' || e.action === 'fixup') && res.length) res[res.length - 1].members.push(i);
    else res.push({ head: i, members: [] });
  });
  return res;
}

/** The message the commit of a group gets; undefined = keep git's (the head commit's original message). */
export function groupMessage(entries: RebaseEntry[], g: Group): string | undefined {
  const head = entries[g.head];
  const squashes = g.members.filter((i) => entries[i].action === 'squash');
  if (head.newMessage !== undefined && (head.action === 'reword' || squashes.length)) return cleanMessage(head.newMessage);
  if (squashes.length) {
    const first = head.action === 'reword' && head.newMessage !== undefined ? head.newMessage : head.message;
    return cleanMessage(prettySquash([first, ...squashes.map((i) => entries[i].message)]));
  }
  if (head.action === 'reword') return cleanMessage(head.newMessage ?? head.message);
  return undefined;
}

/** Returns an error text when the plan can't be executed, else undefined. */
export function validatePlan(entries: RebaseEntry[]): string | undefined {
  if (!entries.length) return 'Nothing to rebase';
  const first = entries.find((e) => e.action !== 'drop');
  if (first && (first.action === 'squash' || first.action === 'fixup')) {
    return `There is no previous commit to ${first.action} into`;
  }
  for (const g of groups(entries)) {
    const msg = groupMessage(entries, g);
    if (msg !== undefined && !msg.trim()) return 'Commit message is empty';
  }
  return undefined;
}

/**
 * Generates the todo. Squashes become `fixup` lines followed by one `exec git commit --amend -F` with the combined
 * (or edited) message, rewords become `pick` + exec, so git never needs an interactive editor.
 * `msgPath(id)` returns the absolute path the caller writes message `id` to.
 */
export function buildTodo(entries: RebaseEntry[], msgPath: (id: number) => string): Todo {
  const err = validatePlan(entries);
  if (err) throw new Error(err);
  const lines: string[] = [];
  const messages: PlannedMessage[] = [];
  const gs = groups(entries);
  const byHead = new Map(gs.map((g) => [g.head, g]));
  let open: { group: Group; message?: string } | undefined;
  const flush = () => {
    if (open?.message !== undefined) {
      const id = messages.length;
      messages.push({ id, text: open.message + '\n' });
      lines.push(`exec git commit --amend --only --allow-empty --no-verify --cleanup=verbatim -F ${shQuote(msgPath(id))}`);
    }
    open = undefined;
  };
  entries.forEach((e, i) => {
    const line = (verb: string) => `${verb} ${e.hash} ${subjectOf(e.message)}`;
    if (e.action === 'drop') {
      lines.push(line('drop'));
      return;
    }
    const g = byHead.get(i);
    if (g) {
      flush();
      open = { group: g, message: groupMessage(entries, g) };
      lines.push(line(e.action === 'edit' ? 'edit' : 'pick'));
    } else {
      lines.push(line('fixup'));
    }
  });
  flush();
  return { text: lines.join('\n') + '\n', messages };
}

/** Rows of IntelliJ's "Git Commands" dialog (Action / Hash / Subject) for the plan. */
export function describeTodo(entries: RebaseEntry[]): { action: string; hash: string; subject: string }[] {
  return entries.map((e) => ({ action: e.action, hash: e.hash.slice(0, 8), subject: subjectOf(e.newMessage ?? e.message) }));
}

/** True when the plan doesn't change anything (all picks in the original order, no messages). */
export function isNoop(entries: RebaseEntry[], originalOrder: string[]): boolean {
  return entries.length === originalOrder.length && entries.every((e, i) => e.action === 'pick' && e.hash === originalOrder[i]);
}

export interface PlanCommit {
  hash: string;
  message: string;
}

const picks = (commits: PlanCommit[]): RebaseEntry[] => commits.map((c) => ({ hash: c.hash, message: c.message, action: 'pick' }));

/** Edit Commit Message of an older commit: `commits` = oldest-first from the commit to HEAD. */
export function planReword(commits: PlanCommit[], hash: string, newMessage: string): RebaseEntry[] {
  return picks(commits).map((e) => (e.hash === hash ? { ...e, action: 'reword', newMessage } : e));
}

/** Drop Commits: `commits` = oldest-first from the oldest selected commit to HEAD. */
export function planDrop(commits: PlanCommit[], hashes: string[]): RebaseEntry[] {
  const set = new Set(hashes);
  return picks(commits).map((e) => (set.has(e.hash) ? { ...e, action: 'drop' } : e));
}

/**
 * Squash Commits: the selected commits are moved right after the oldest selected one (keeping their order)
 * and squashed into it with `newMessage`. `commits` = oldest-first from the oldest selected commit to HEAD.
 */
export function planSquash(commits: PlanCommit[], hashes: string[], newMessage: string): RebaseEntry[] {
  const set = new Set(hashes);
  const all = picks(commits);
  const selected = all.filter((e) => set.has(e.hash));
  if (selected.length < 2) throw new Error('Select at least two commits to squash');
  const rest = all.filter((e) => !set.has(e.hash));
  const headIdx = all.indexOf(selected[0]);
  const before = rest.filter((e) => all.indexOf(e) < headIdx);
  const after = rest.filter((e) => all.indexOf(e) > headIdx);
  const group: RebaseEntry[] = selected.map((e, i) => (i === 0 ? { ...e, newMessage } : { ...e, action: 'squash' }));
  return [...before, ...group, ...after];
}

/** Moves the rows at `indices` one step up (-1) or down (+1); returns the new array and the moved indices. */
export function moveRows<T>(rows: T[], indices: number[], delta: -1 | 1): { rows: T[]; indices: number[] } {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  if (!sorted.length) return { rows, indices };
  if ((delta < 0 && sorted[0] === 0) || (delta > 0 && sorted[sorted.length - 1] === rows.length - 1)) return { rows, indices: sorted };
  const out = [...rows];
  const order = delta < 0 ? sorted : [...sorted].reverse();
  for (const i of order) [out[i], out[i + delta]] = [out[i + delta], out[i]];
  return { rows: out, indices: sorted.map((i) => i + delta) };
}

/** Moves the rows at `indices` so they are inserted before position `target` (drag & drop). */
export function moveRowsTo<T>(rows: T[], indices: number[], target: number): { rows: T[]; indices: number[] } {
  const set = new Set(indices);
  const moving = rows.filter((_, i) => set.has(i));
  const before = rows.slice(0, target).filter((_, i) => !set.has(i));
  const after = rows.slice(target).filter((_, i) => !set.has(i + target));
  return { rows: [...before, ...moving, ...after], indices: moving.map((_, i) => before.length + i) };
}

/**
 * "Unite" (IntelliJ): the selected rows are squashed into the first selected one; rows between them are moved
 * below the united group. Returns the new rows and the indices of the united group.
 */
export function uniteRows(entries: RebaseEntry[], indices: number[]): { rows: RebaseEntry[]; indices: number[] } {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  if (sorted.length < 2) return { rows: entries, indices: sorted };
  const set = new Set(sorted);
  const head = sorted[0];
  const group = sorted.map((i, k) => (k === 0 ? (entries[i].action === 'drop' ? { ...entries[i], action: 'pick' as const } : entries[i]) : { ...entries[i], action: 'squash' as const }));
  const before = entries.slice(0, head);
  const after = entries.slice(head).filter((_, k) => !set.has(k + head));
  return { rows: [...before, ...group, ...after], indices: group.map((_, k) => head + k) };
}

/** Lines of git's "would be overwritten" error listing the files (tab-indented lines after the header). */
export function parseOverwrittenFiles(stderr: string): { kind: 'local' | 'untracked'; files: string[] } | undefined {
  const m = /(untracked working tree files|local changes to the following files) would be (?:overwritten|removed) by [^:]+:\n((?:\t.*\n?)+)/.exec(stderr.replace(/\r\n/g, '\n'));
  if (!m) return undefined;
  const files = m[2].split('\n').map((l) => l.trim()).filter(Boolean);
  return { kind: m[1].startsWith('untracked') ? 'untracked' : 'local', files };
}

/** IntelliJ protected branch patterns are regexes matched against the whole branch name (without remote). */
export function isProtectedBranch(branch: string, patterns: string[]): boolean {
  for (const p of patterns) {
    try {
      if (new RegExp(`^(?:${p})$`).test(branch)) return true;
    } catch {
      // invalid patterns never match (GitSharedSettings.isMatchSafe)
    }
  }
  return false;
}

/** IntelliJ's "Cannot {op} during rebase" family. */
export function prohibitedStateMessage(state: string, op: string): string | undefined {
  switch (state) {
    case 'rebase':
    case 'am':
      return `Cannot ${op} during rebase`;
    case 'merge':
      return `Cannot ${op} during merge`;
    case 'cherry-pick':
      return `Cannot ${op} during cherry-pick`;
    case 'revert':
      return `Cannot ${op} during revert`;
    default:
      return undefined;
  }
}

/** `{n} commit|commits` */
export function commits(n: number): string {
  return `${n} ${n === 1 ? 'commit' : 'commits'}`;
}
