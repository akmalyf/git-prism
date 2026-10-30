# Git Log webview protocol (bundle `log`)

Host side: `src/features/log/` (controller.ts answers every call). All payload types live in
`src/features/log/protocol.ts` (no vscode/node imports — import it from the webview:
`import type { … } from '../../features/log/protocol'`). Graph constants (`EDGE_UP`, `FLAG_TERMINAL`, …) are in
`src/features/log/graph.ts`, which is also vscode-free; import only the constants/types from it.

```ts
import { rpc, init } from '../shared/rpc';
const boot = init<LogInit>();            // mode 'log' | 'history', title, hideBranches, historyPaths, editorTab
const state = await rpc.call<LogState>('state');
const page = await rpc.call<RowsResult>('rows', { from: 0, to: 100 });
rpc.on<LogState>('state', (s) => …);
```

## Instances

| where | init.mode | init.editorTab | filters persisted |
|---|---|---|---|
| Git panel → view `gitPrism.logView` ("Log") | `log` | false | yes (workspaceState `gitPrism.log.view`) |
| `gitPrism.log.show {editorTab:true}` without paths, "Open New Git Log Editor Tab" (`openInEditorTab`) | `log` | true | no |
| `gitPrism.log.show {editorTab:true, paths}` → "History: <file>" | `history` | true | no |

History view: the host always applies `init.historyPaths` as the path filter (a single file also follows its
renames); `LogState.filters.paths` stays empty there, so the UI shows Branch/User/Date/Text filters only and hides
the branches tree (`init.hideBranches`). `options.showOnlyAffectedChanges` limits changed files to those paths.

All roots (repositories) of the workspace are shown in ONE table like IntelliJ (rows from different repositories
are merged by commit time). `LogRow.root` indexes `LogState.roots`; the "Root" column / Roots filter use it.
Every other API identifies commits by `CommitId { root: absolute repo root, hash }`.

## Data model

- `LogState.version` increments on every rebuild of the list (filter change, refresh, load more, settings that
  change git ordering). Rows from an older version are stale: re-request the visible range. Keep the selection by
  `CommitId` and map it back with the `row` index you get from `goTo({text: hash})` or by scanning fetched rows.
- `rowCount` rows exist; fetch them lazily for the visible window (`rows`), e.g. 200 at a time. Each row carries
  its commit metadata, reference labels and graph print elements.
- `hasMore`: only the first 20 000 commits per repository are loaded; call `loadMore` when the user scrolls near the
  end (adds 50 000). `goTo` loads more by itself until it finds the target.
- `linear`: a text/user/date filter is active — the graph is a plain line of matching commits.
- `filtered` + `rowCount === 0` → "No commits matching filters" with a "Reset filters" link
  (`setFilters({})`); `!filtered && rowCount === 0` → "No changes committed."; `error` → "Error loading commits".
- `loading` is true while git runs ("Loading commits…").
- Auto refresh: the host reloads when refs/HEAD change (any repository) and pushes `state`. Hidden views refresh
  when shown again. Keep selection and scroll position across versions.

## Graph rendering (`LogRow.graph: GraphRowPrint`)

IntelliJ PrintElement semantics, row height H, lane width W (IntelliJ: 24 px rows, ~14 px lanes), x(p) = W·p + W/2:

- node circle at `(x(node), H/2)`; HEAD of its repo (`row.head`) as a ring; color `palette[color % n]`.
- `edges` is a flat array of 6-tuples `[position, toPosition, type, color, flags, target]`:
  - `type 0` (UP): line `(x(position), H/2) → ((x(position)+x(toPosition))/2, 0)`
  - `type 1` (DOWN): line `(x(position), H/2) → ((x(position)+x(toPosition))/2, H)`
  - `flags & 1` arrow head at the far end of that half segment (long edges with "Long Edges" on)
  - `flags & 2` terminal: the edge is cut here — draw a short stub from the middle towards top (UP) / bottom
    (DOWN) with an arrow head; `target` is the row at the other end (click → select/scroll there; tooltip
    "Jump to <subject> by <author> on <date> at <time>")
  - `flags & 4` dotted: edge to a parent that isn't loaded / not part of the list
- Draw edges first, then the node. `width` = number of lanes used in the row (subject text starts after
  `max(width)` of the visible rows, or after the row's own width like IntelliJ).
- Colors are stable per branch name (main lineage of a head) and per lineage index otherwise.
- "Long Edges" (`settings.showLongEdges`) only changes printing: re-fetch rows when it changes (`settings` event).

## Methods (`rpc.call(method, params)`)

| method | params | result | notes |
|---|---|---|---|
| `state` | — | `LogState` | waits for the first load |
| `rows` | `RowsRequest {from, to}` | `RowsResult {version, rowCount, rows: LogRow[]}` | if `version` differs from yours, discard and refetch |
| `loadMore` | — | `LogState` | |
| `refresh` | — | `LogState` | Refresh (keeps loaded range) |
| `setFilters` | `LogFilters` (replaces all) | `LogState` | persisted for the panel view |
| `setOptions` | `Partial<LogViewOptions>` | `LogState` | Show Changes to Parents, Show Only Affected Changes |
| `setSetting` | `{key: LogSettingKey, value}` | void | writes `gitPrism.log.<key>` (global); a `settings` + `state` event follows |
| `details` | `{commits: CommitId[]}` | `CommitDetails[]` | full message (`message`), committer, refs; for the details pane |
| `containingBranches` | `CommitId` | `ContainingBranches` | lazy "In N branches: …"; show "In branches: loading…" until it resolves; `[]` → "Not in any branch" |
| `changes` | `ChangesRequest {commits, showChangesToParents?}` | `ChangesResult {groups, merge, affectedOnly}` | one commit → 1 group (parent → commit); a merge → files changed vs ALL parents, or with Show Changes to Parents one group per parent titled "Changes to <hash>"; several commits of one repo → combined `oldest^..newest`; several repos → one group per repo |
| `showDiff` | `ShowDiffRequest {group, path, mode?, beside?}` | void | opens `gitPrism.diff.show` with ALL files of the group (prev/next file); mode `commit` (Show Diff), `local` (Compare with Local), `beforeLocal` (Compare Before with Local) |
| `openFileAtRevision` | `FileAtRevision {root, path, rev}` | void | Show File at Revision (use `group.to`, or `group.from` for deleted files) |
| `annotate` | `FileAtRevision` | void | Annotate (`gitPrism.annotate.revision`) |
| `showHistory` | `{root, path, revision?}` | void | Show History for the file (new History tab) |
| `historyUpTo` | `HistoryUpToRequest` | void | History Up to Here: new History tab whose branch filter is the revision |
| `historyInfo` | `CommitId` | `HistoryFileInfo` | history view: the history file in that commit (path at revision, deleted, dir) |
| `historyAction` | `HistoryActionRequest` | void | history view actions (Vcs.FileHistory.ContextMenu / Toolbar): showDiff, showDiffNewTab, compareWithLocal, openFile, annotate, get, showAllAffected, selectInLog |
| `compareWithLocalFile` | `FileAtRevision` | void | `gitPrism.compare.fileWithRevision` |
| `openFile` | `{root, path}` | void | Jump to Source (working tree file) |
| `getFromRevision` | `FilesAtRevision {root, paths, rev}` | void | "Get": asks for confirmation, restores the files' content from `rev` (files absent there are deleted) |
| `revertSelectedChanges` | `FilesAtRevision {root, paths, rev, from}` | void | reverse-applies `from..rev` for those files (merges with local changes, reports conflicts) |
| `cherryPickSelectedChanges` | `FilesAtRevision {root, paths, rev, from}` | void | applies `from..rev` for those files |
| `commitOp` | `CommitOpRequest {op, commits}` | unknown | invokes `gitPrism.commit.<op>` / `gitPrism.repoAtRevision` with `{repoRoot, hashes}` (commits newest first, single repo) |
| `refOp` | `RefOpRequest {op, root, ref?}` | unknown | branch/tag actions, see below |
| `compareVersions` | `{commits: [CommitId, CommitId]}` | void | Compare Versions → `gitPrism.changes.show` older → newer |
| `compareWithLocal` | `CommitId` | void | changes between the commit and the working tree (`gitPrism.changes.show`) |
| `refs` | — | `RefsInfo[]` | per root: current, head, detached, local/remote/tags (`RefItem`), recent (reflog), favorites — branch filter popup ("HEAD", Local, Remote, Tags, Recent, Favorites) and branches tree |
| `toggleFavorite` | `{root, name}` | void | ★ in the branches tree (defaults: main/master, origin/main/master) |
| `users` | — | `UsersResult {users, me}` | User filter popup (shortlog, most commits first); offer "me" first |
| `paths` | `{query, limit?}` | `PathSuggestion[]` | Paths filter completion (tracked files and folders); use `abs` in `LogFilters.paths` |
| `goTo` | `{text, root?}` | `GoToResult {row, hash?, root?, message?}` | Go To Hash/Branch/Tag; `message` = "Commit or reference 'x' not found" / "... doesn't match the filters" |
| `search` | `SearchRequest {text, from, backward?, regex?, matchCase?}` | `SearchResult {row}` | speed search in the table over subject/author/hash (fetches metadata as needed); -1 = none |
| `copy` | `{text}` | void | clipboard |
| `openInEditorTab` | — | void | "Open New Git Log Editor Tab" with the current filters |
| `showConsole` | — | void | Git Console |
| `rowsOf` | `{commits: CommitId[]}` | `number[]` | current rows of commits (-1 = not in the list); keeps the selection across reloads without loading more |
| `fileContents` | `FileContentsRequest {root, path, oldPath?, kind, from, to}` | `FileContentsResult {original, modified, binary?, tooLarge?}` | both sides of a file for the embedded diff preview (> 2 MB → `tooLarge`) |
| `cherryPicked` | `CherryPickedRequest {root, branch}` | `string[]` | "Not Cherry-Picked Commits": commits of `branch` already applied to HEAD (`git cherry HEAD branch`, `-` lines) |
| `selectFolders` | — | `string[]` | Paths filter "Select in Tree…" (open dialog; absolute paths, forward slashes) |
| `commitLocalChanges` | — | void | empty log link "Commit local changes" → `gitPrism.commit.focus` |

`RefOp` → contract command (`{repoRoot: root, ref}`):
`actions` → `gitPrism.branch.actions` (the Branches-popup action list for a ref), `checkout` → `gitPrism.branch.checkout`,
`newBranch` → `gitPrism.branch.new` (New Branch from 'ref'…), `newTag` → `gitPrism.tag.new`, `delete` →
`gitPrism.branch.delete`, `deleteTag` → `gitPrism.tag.delete`, `rename` → `gitPrism.branch.rename`, `merge` → `gitPrism.merge`,
`rebase` → `gitPrism.rebase`, `compareWithCurrent` → `gitPrism.compare.withCurrent`, `push` / `fetch` / `pull` /
`updateProject` → `gitPrism.push` / `gitPrism.fetch` / `gitPrism.pull` / `gitPrism.updateProject` (`{repoRoot}` only).
Implemented by the log itself (`branchops.ts`): `checkoutAndRebase` ("Checkout and Rebase onto Current",
`git rebase <current> <ref>`, a remote ref gets a local tracking branch first), `update` (current branch → Update
Project, another → `git fetch <remote> <merge>:refs/heads/<b>` fast-forward), `pullRebase` / `pullMerge` ("Pull into
Current Using Rebase/Merge" from a remote branch); `showDiffWithWorkingTree` → `gitPrism.compare.withWorkingTree`.
Failed rebases/pulls that leave an operation in progress offer "Resolve Conflicts…" / "Abort".

`CommitOp` values: `checkoutRevision`, `resetToHere`, `revert`, `cherryPick`, `undo`, `reword`, `fixup`,
`squashInto`, `squash`, `drop`, `interactiveRebase`, `pushUpTo`, `newBranch`, `newTag`, `createPatch`, `copyHash`,
`repoAtRevision` (Show Repository at Revision).

## Events (`rpc.on(event, cb)`)

| event | data | when |
|---|---|---|
| `state` | `LogState` | any load start/end, filters/options/settings change |
| `settings` | `LogSettings` | a `gitPrism.log.*` setting changed (re-render; refetch rows if `showLongEdges` changed) |
| `select` | `{row, hash, root}` | host wants a commit selected and scrolled into view (`gitPrism.log.show {revision}`, Go To command) |
| `refs` | — | after every load: re-request `refs` for the branches tree / branch filter |
| `focusTextFilter` | — | command "Focus Text Filter" |

## Filters (`LogFilters`, applied by git)

- `branches`: `'HEAD'` and/or short names (`main`, `origin/main`, `v1.0`); a repo where none exist shows nothing.
- `users`: `'me'` (each repo's user.name / user.email), a name, an email or `Name <email>`; exact match, OR-ed.
- `since` / `until`: unix seconds ("Last 24 hours" = now − 86400, "Last 7 days", Select… → dialog).
- `paths`: absolute paths (forward slashes); simplified history (`git log -- paths` semantics, parents rewritten so
  the graph stays connected). Roots without any selected path are hidden.
- `roots`: absolute repo roots to show.
- `text` + `regex` (".*") + `matchCase` ("Cc"): commit message via `--grep`; if every word looks like a hash
  (7–40 hex chars) commits whose hash starts with it are matched too.
- Text, user and date filters are structure-changing (`state.linear`).

## Settings (`LogSettings` = VS Code `gitPrism.log.*`)

`sortType` ('topological' "Topologically" / 'date' "By Commit Date"), `firstParent` ("First Parent"),
`showLongEdges` ("Long Edges"), `columns` (order + visibility of 'author' | 'subject' | 'date' | 'hash' | 'root';
default author, subject, date), `preferCommitDate` ("Commit Timestamp"), `dateFormat` ('' = locale, or pattern with
yyyy yy MM M dd d HH H mm ss), `prettyDates` (Today/Yesterday), `highlightMyCommits` (bold), `highlightMergeCommits`
(grey), `highlightCurrentBranch`, `showTagNames`, `compactReferences`, `referencesOnLeft`, `showDetails`,
`showDiffPreview`, `diffPreviewLocation` ('right' | 'bottom'), `showBranches` (branches tree visible).
Change them with `setSetting` from the View Options (eye) menu.

## Row fields worth knowing

- `refs`: sorted like IntelliJ (detached `HEAD`, local with the current branch first, remote, tags). A local branch
  with `upstream` equal to a remote label of the same row renders as "origin & main". `favorite` → ★.
- `mine` → bold author when `highlightMyCommits`; `parents.length > 1` → grey when `highlightMergeCommits`;
  `onCurrentBranch` (reachable from HEAD; computed with `git rev-list HEAD` when the list is filtered or lacks HEAD)
  for the Current Branch highlighter and the history-rewriting actions; author ≠ committer → append `*` to the author.
- `childRows` / `parentRows` → Go to Child / Parent Commit (`-1` = not loaded).
- `authorDate` vs `commitDate` per `preferCommitDate`.
