// In-memory history editing (IntelliJ's "in-memory" reword/squash/extract changes): new commit objects are written
// with `git hash-object` and descendants are re-parented, so the working tree and index stay untouched and merge
// commits after the edited one are preserved. Trees with some paths reverted are built in a temporary index file.
// Git access goes through a small runner (unit-tested with real git).
import { headerValues, rewriteCommit, utf8ToBytes } from './objects';

export interface ObjectGit {
  /** runs git; stdin and stdout are byte-preserving latin1 strings; `env` is added to the environment */
  run(args: string[], input?: string, env?: Record<string, string>): Promise<string>;
}

/** Reads raw commit objects (latin1) with one `git cat-file --batch`. */
export async function readCommits(git: ObjectGit, hashes: string[]): Promise<Map<string, string>> {
  const res = new Map<string, string>();
  if (!hashes.length) return res;
  const out = await git.run(['cat-file', '--batch'], hashes.join('\n') + '\n');
  let pos = 0;
  for (const h of hashes) {
    const nl = out.indexOf('\n', pos);
    const header = out.slice(pos, nl).split(' ');
    if (header[1] !== 'commit') throw new Error(`${h} is not a commit`);
    const size = Number(header[2]);
    res.set(h, out.slice(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return res;
}

export async function writeCommit(git: ObjectGit, raw: string): Promise<string> {
  return (await git.run(['hash-object', '-t', 'commit', '-w', '--stdin'], raw)).trim();
}

/**
 * Re-creates every descendant of `from` up to `head` (`--ancestry-path`) with parents mapped through `replaced`
 * (old hash → new hash) and returns the new head.
 */
export async function rewriteDescendants(git: ObjectGit, from: string, head: string, replaced: Map<string, string>, committer: string): Promise<string> {
  const map = new Map(replaced);
  if (from !== head) {
    const list = (await git.run(['rev-list', '--topo-order', '--reverse', '--ancestry-path', `${from}..${head}`])).split('\n').filter(Boolean);
    const raws = await readCommits(git, list);
    for (const h of list) {
      const raw = raws.get(h)!;
      const parents = headerValues(raw, 'parent');
      if (!parents.some((p) => map.has(p))) continue;
      map.set(h, await writeCommit(git, rewriteCommit(raw, { parents: parents.map((p) => map.get(p) ?? p), committer })));
    }
  }
  return map.get(head) ?? head;
}

export async function committerIdent(git: ObjectGit): Promise<string> {
  return (await git.run(['var', 'GIT_COMMITTER_IDENT'])).trim();
}

/** New message for `target` (an ancestor of or equal to `head`); returns the new head hash. */
export async function rewordInMemory(git: ObjectGit, target: string, head: string, message: string): Promise<string> {
  const committer = await committerIdent(git);
  const raw = (await readCommits(git, [target])).get(target)!;
  const created = await writeCommit(git, rewriteCommit(raw, { committer, message }));
  return rewriteDescendants(git, target, head, new Map([[target, created]]), committer);
}

/**
 * Squashes a consecutive chain (oldest-first, each the single parent of the next) into one commit with the tree
 * of the newest, the parents and author of the oldest and `message`; returns the new head hash.
 */
export async function squashChainInMemory(git: ObjectGit, chain: string[], head: string, message: string): Promise<string> {
  const committer = await committerIdent(git);
  const raws = await readCommits(git, [chain[0], chain[chain.length - 1]]);
  const oldest = raws.get(chain[0])!;
  const newest = raws.get(chain[chain.length - 1])!;
  const tree = headerValues(newest, 'tree')[0];
  const created = await writeCommit(git, rewriteCommit(oldest, { tree, committer, message }));
  const last = chain[chain.length - 1];
  return rewriteDescendants(git, last, head, new Map([[last, created]]), committer);
}

/** Thrown for selections that can't be split (IntelliJ: "Selected changes cannot be extracted"). */
export class SplitError extends Error {}

export interface CommitSplit {
  /** raw object of the commit */
  raw: string;
  /** tree of the commit */
  tree: string;
  /** tree of its parent (the empty tree for a root commit) */
  parentTree: string;
  /** tree of the commit with the selected paths as in the parent */
  remaining: string;
}

/**
 * Splits a non-merge commit by repo-relative `paths`: `remaining` is its tree with every selected path reverted to
 * the parent's version (removed when the parent doesn't have it). `indexFile` is a scratch index path (deleted by
 * the caller), so the repository's index is never touched.
 */
export async function splitCommit(git: ObjectGit, target: string, paths: string[], indexFile: string): Promise<CommitSplit> {
  const raw = (await readCommits(git, [target])).get(target)!;
  const parents = headerValues(raw, 'parent');
  if (parents.length > 1) throw new SplitError(`Selected commit has ${parents.length} parents`);
  const tree = headerValues(raw, 'tree')[0];
  const parentTree = parents.length ? (await git.run(['rev-parse', `${parents[0]}^{tree}`])).trim() : (await git.run(['mktree'], '')).trim();
  const wanted = new Set(paths.map(utf8ToBytes));
  const fromParent = new Map<string, string>();
  if (parents.length && paths.length) {
    const out = await git.run(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', parents[0], '--', ...paths]);
    for (const rec of out.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const p = rec.slice(tab + 1);
      if (!wanted.has(p)) continue;
      const [mode, type, oid] = rec.slice(0, tab).split(' ');
      if (type === 'commit') throw new SplitError('Splitting a tree by git submodule entry is not supported');
      fromParent.set(p, `${mode} ${oid}`);
    }
  }
  const zero = '0'.repeat(tree.length);
  const info = [...wanted].map((p) => `${fromParent.get(p) ?? `0 ${zero}`}\t${p}\0`).join('');
  const env = { GIT_INDEX_FILE: indexFile };
  let remaining: string;
  try {
    await git.run(['read-tree', tree], undefined, env);
    await git.run(['update-index', '-z', '--index-info'], info, env);
    remaining = (await git.run(['write-tree'], undefined, env)).trim();
  } catch {
    throw new SplitError('Selected changes cannot be extracted');
  }
  // a file replaced by a directory (or back) with only one side selected: the index drops the other side too
  const touched = (await git.run(['diff-tree', '-r', '--no-renames', '--name-only', '-z', tree, remaining])).split('\0').filter(Boolean);
  if (touched.some((p) => !wanted.has(p))) throw new SplitError('Selected changes cannot be extracted');
  return { raw, tree, parentTree, remaining };
}

/** The commit with the selected changes removed (same parents and author); descendants are not touched. */
export async function dropChangesCommit(git: ObjectGit, split: CommitSplit): Promise<string> {
  return writeCommit(git, rewriteCommit(split.raw, { tree: split.remaining, committer: await committerIdent(git) }));
}

/**
 * IntelliJ's in-memory "Extract Selected Changes to Separate Commit": the commit keeps its message without the
 * selected changes, a new commit with `message` (same author, the original tree) follows it, descendants up to
 * `head` are re-parented. Returns the new head and the hash of the extracted commit.
 */
export async function extractChangesInMemory(git: ObjectGit, target: string, head: string, split: CommitSplit, message: string): Promise<{ head: string; extracted: string }> {
  const committer = await committerIdent(git);
  const first = await writeCommit(git, rewriteCommit(split.raw, { tree: split.remaining, committer }));
  const extracted = await writeCommit(git, rewriteCommit(split.raw, { parents: [first], committer, message }));
  return { head: await rewriteDescendants(git, target, head, new Map([[target, extracted]]), committer), extracted };
}
