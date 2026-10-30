# JetBrains Git Tools

PhpStorm / IntelliJ (2026.2, New UI "Islands") Git tooling for VS Code: the Commit tool window, the Git tool window
with Log and Console, Compare with Branch/Revision, Show History, Annotate, the Branches popup, Push / Pull / Merge /
Rebase dialogs, Interactive Rebase, the conflict resolver, Stash and Shelf. Labels, menu order and behavior follow
PhpStorm's own resources (GitBundle, VcsBundle, VcsLogBundle, DvcsBundle, DiffBundle).

The extension talks to the `git` CLI directly (no dependency on the built-in `vscode.git` API) and works with
multiple repositories in one workspace, empty repositories, detached HEAD and in-progress merge/rebase/cherry-pick.
Every git command it runs is logged in the **Console** tab of the Git tool window.

## Features

### Commit tool window (activity bar, "Commit")
- **Changes** / **Unversioned Files** tree with checkboxes per file, directory and changelist; group by Directory,
  Module and Repository; optional Ignored Files node.
- Toolbar: Refresh, Rollback, Update Project, Shelve, Stash, View Options, Select Opened File, Expand All, Collapse All.
- Changelists: New, Edit, Delete, Set Active, Move to Another Changelist; partial (per-line) include of changes.
- **Staging Area** mode (`jbGit.commit.useStagingArea`): Staged / Unstaged, Stage / Unstage, Show Staged Version,
  Compare with Staged Version, Compare HEAD, Staged and Local Versions.
- Commit message editor with **Amend**, **Commit Message History**, **Commit** and **Commit and Push…**, Commit
  Options (author, sign-off, GPG signing, …).
- Double-click shows diff or source; diff preview; Rollback…, Add, Add to .gitignore, Commit File….

### Git tool window (panel, "Git: Log | Console")
- Branches tree (HEAD, Local, Remote › origin, Tags) with search, favorites, grouping by `/` prefix and a vertical
  toolbar (New Branch, Update, Delete, Compare, Fetch, Favorite, …).
- Commit table: Author, graph + subject with right-aligned reference labels, Date; my commits bold, merge commits grey,
  `author*` when author ≠ committer, HEAD drawn as a ring. Virtualized and paged for big repositories.
- Filter bar: Text or hash (regex, match case), Branch, User, Date, Paths; IntelliSort / topological / date sorting,
  First Parent, Long Edges.
- Changed files tree of the selected commit (compacted folders, counts) and commit details (message, hash, author,
  date, containing branches); optional diff preview.
- Commit context menu: Copy Revision Number, Create Patch…, Cherry-Pick, Checkout Revision, Show Repository at
  Revision, Compare with Local, Reset Current Branch to Here…, Revert Commit, Undo Commit…, Edit Commit Message…,
  Fixup…, Squash Into…, Squash Commits…, Drop Commits, Interactively Rebase from Here…, Push All up to Here…,
  New Branch…, New Tag…, Go To Hash/Branch/Tag.
- File context menu: Show Diff, Compare with Local, Show File at Revision, Annotate, Show History, Drop / Extract
  Selected Changes.
- **Console** tab listing every git command and its output.

### Compare & History
- Compare with Branch or Tag…, Compare with Revision…, Compare with Latest Repository Version, Show Diff (vs HEAD).
- Show History (file / folder) and Show History for Selection…, Show Current Revision, Show Repository at Revision.

### Annotate
- Annotate with Git Blame gutter: Revision / Date / Author / Commit Subject columns, name styles, color by order or
  author, ignore whitespaces, detect movements, commit timestamp.
- Annotated line actions: Show Diff, Show Affected Files, Show in Git Log, Copy Revision Number, Annotate Revision,
  Annotate Previous Revision.
- Gutter change markers: Next / Previous Change, Rollback Lines, Show Diff for Lines, Copy Original Lines.

### Diff & merge
- Side-by-side / unified diff viewer for commits, changes, stashes and shelves.
- Three-way merge tool with Accept Yours / Accept Theirs / Merge; **Resolve Conflicts…** dialog; Merge/Rebase
  operation widget with Continue / Skip / Abort.

### Branches
- Branches popup: Recent, Local, Remote, Tags with search; per branch Checkout, New Branch from…, Checkout and
  Rebase onto…, Compare with Current, Show Diff with Working Tree, Rebase / Merge into Current, Pull into using
  Rebase / Merge, Push…, Update, Rename…, Delete.
- New Tag…, Delete Tag…, Checkout Tag or Revision…, Clean Up Branches…, Find Merged Branches…, Manage Remotes…,
  Worktrees…, Clone…, Create Git Repository…, Unshallow repository, VCS Operations Popup….
- Status bar branch widget.

### Sync
- Push dialog (Force Push, push tags, protected branches), Pull…, Fetch, Update Project… (merge / rebase, stash /
  shelve local changes), Merge…, Rebase…, Reset HEAD… (soft / mixed / hard / keep).

### Stash, Shelf & patches
- Stash Changes…, Stash Silently, Unstash Changes… (Apply / Pop / Drop / Clear, unstash as new branch).
- Shelf: Shelve Changes…, Shelve Silently, Save To Shelf, Unshelve…, Unshelve Silently, Import Patches…, show
  applied shelves. Shelves are stored as patches in `<git common dir>/jb-shelf/`.
- Create Patch…, Copy as Patch to Clipboard, Apply Patch…, Apply Patch from Clipboard….

## Commands

All commands are in the **Git** category of the Command Palette. Main entry points:

| Command | Id |
|---|---|
| Commit… | `jbGit.commit.focus` |
| Commit and Push… | `jbGit.commit.commitAndPush` |
| Show VCS Log | `jbGit.log.show` |
| Show Git Console | `jbGit.console.show` |
| Branches… | `jbGit.branches.show` |
| New Branch… / New Tag… | `jbGit.branch.new` / `jbGit.tag.new` |
| Push… / Pull… / Fetch | `jbGit.push` / `jbGit.pull` / `jbGit.fetch` |
| Update Project… | `jbGit.updateProject` |
| Merge… / Rebase… / Reset HEAD… | `jbGit.merge` / `jbGit.rebase` / `jbGit.resetHead` |
| Resolve Conflicts… | `jbGit.conflicts.resolve` |
| Compare with Branch or Tag… | `jbGit.compareWithBranch` |
| Compare with Revision… | `jbGit.compareWithRevision` |
| Show History / Show History for Selection… | `jbGit.showHistory` / `jbGit.showHistoryForSelection` |
| Annotate with Git Blame | `jbGit.annotate.toggle` |
| Stash Changes… / Unstash Changes… | `jbGit.stash.create` / `jbGit.stash.unstash` |
| Shelve Changes… / Unshelve… | `jbGit.shelf.shelve` / `jbGit.shelf.unshelve` |
| Create Patch… / Apply Patch… | `jbGit.patch.create` / `jbGit.patch.apply` |
| Clean Up Branches… / Manage Remotes… / Worktrees… | `jbGit.cleanupBranches` / `jbGit.remotes.manage` / `jbGit.worktrees` |
| VCS Operations Popup… | `jbGit.vcsOperations` |

File-level actions are also available from the explorer and editor context menus under **Git**.

## Keybindings

PhpStorm (macOS / Windows-Linux) defaults:

| Action | macOS | Windows / Linux |
|---|---|---|
| Commit… | `Cmd+K` | `Ctrl+K` |
| Commit and Push… | `Cmd+Alt+K` | `Ctrl+Alt+K` |
| Push… | `Cmd+Shift+K` | `Ctrl+Shift+K` |
| Update Project… | `Cmd+T` | `Ctrl+T` |
| VCS Operations Popup… | `Ctrl+V` | ``Alt+` `` |
| Rollback Lines | `Cmd+Alt+Z` | `Ctrl+Alt+Z` |
| Next / Previous Change | `Ctrl+Alt+Shift+Down/Up` | `Ctrl+Alt+Shift+Down/Up` |

The commit/push/update shortcuts are only active outside the text editor and terminal, so they do not shadow VS
Code's own `Cmd+K` chords while typing.

## Settings

| Setting | Default | Description |
|---|---|---|
| `jbGit.gitPath` | `""` | Path to the git executable (empty = `git` from PATH). |
| `jbGit.commit.useStagingArea` | `false` | Staging Area instead of changelists in the Commit tool window. |
| `jbGit.log.*` | | Sort type, First Parent, Long Edges, columns, date format, pretty dates, highlights (my / merge commits, current branch), tag names, compact references, references on the left, details, diff preview and its location, branches tree. |
| `jbGit.annotate.*` | | Visible columns, name style, colors, ignore whitespaces, detect movements, commit timestamp. |
| `jbGit.branches.*` | | Tags, Recent, group by directory / repository, only favorites. |
| `jbGit.push.protectedBranches` | `"master, main"` | Protected branches (force push prohibited). |
| `jbGit.fetch.prune` | `true` | Fetch with `--prune`. |
| `jbGit.update.showDialog` | `true` | Show the Update Project dialog. |
| `jbGit.update.method` | `"merge"` | Merge or rebase for Update Project. |
| `jbGit.update.saveChangesPolicy` | `"stash"` | Stash or shelve local changes before updating. |
| `jbGit.cherryPick.addSuffix` | `false` | Add "cherry picked from" suffix. |
| `jbGit.commitOps.showDropCommitDialog` | `true` | Confirm Drop Commits. |
| `jbGit.conflicts.showNotification` | `true` | Notify about merge conflicts. |
| `jbGit.diff.gutterMarkers` | `true` | Changed-line markers in the gutter and overview ruler. |

## Requirements

- VS Code 1.140 or newer.
- Git 2.30 or newer on PATH (or `jbGit.gitPath`).

## Development

```sh
npm install
npm run contributes      # merge src/**/contributes.json into package.json
npm run typecheck        # extension host + webviews
npm run build            # dist/extension.js + dist/media/*.js
npm test                 # pure unit tests (node:test)
npm run package          # .vsix
```

See `ARCHITECTURE.md` for the layout and rules.

## Known gaps

- Not a pixel-identical copy: view headers, tool window tabs and the activity bar are drawn by VS Code, so their
  chrome follows VS Code rather than the Islands theme.
- No AI commit message generation and no pre-commit inspections (code analysis, reformat, optimize imports, TODO
  check) from Commit Options.
- "Group by Module" uses the top-level folder, since VS Code has no module concept.
- Shelves are stored as patches under the git directory (not in `.idea/shelf`) and are not shared with PhpStorm.
- Reverting merge commits from the log is disabled (as `git revert -m` needs a parent choice).
- Splitting commits (Extract Selected Changes) does not support changes inside git submodule entries.
- Only the `git` CLI is supported; no GitHub/GitLab integrations (pull requests, review, sharing).
- `package.json` has no `repository` field yet (`vsce` warns; `npm run package` passes `--allow-missing-repository`).
