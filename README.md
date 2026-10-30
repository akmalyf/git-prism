# JetBrains Git Tools

The PhpStorm / IntelliJ IDEA Git log in VS Code: the **Git** panel with the branches tree, the commit graph and the
changed files of a commit, plus the IDE's Git actions in the editor context menu (compare, history, annotate,
branches, push/pull/merge/rebase, conflicts, stash, patches).

Labels, menu order, commit ordering and graph colors follow PhpStorm 2026.2 (New UI "Islands"): the commit order is
a port of IntelliJ's `VcsLogSorter` / IntelliSort, the lane colors come from its `DefaultColorGenerator`, and the
row highlights use the Islands theme values. Icons and fonts follow your VS Code theme and file icon theme.

The extension talks to the `git` CLI directly, supports several repositories in one workspace, empty repositories,
detached HEAD and in-progress merge / rebase / cherry-pick / revert. Every git command it runs is shown in the
**Console** pane at the bottom of the log.

## Git panel › Log

- **Branches** tree: HEAD, Local, Remote › `<remote>`, Tags; search, favorites, grouping by `/` prefix; single click
  filters the log by the branch, context menu with Checkout, New Branch from…, Compare with Current, Merge / Rebase,
  Push…, Rename…, Delete…
- **Commit table**: Author, graph + subject with reference labels, Date; my commits bold, merge commits grey, current
  branch highlighted, `author*` when author ≠ committer, HEAD drawn as a ring. Virtualized and paged for big
  repositories.
- **Filter bar**: Text or hash (regex, match case), Branch, User, Date, Paths; sort by commit date or IntelliSort;
  First Parent, Long Edges; Go To Hash/Branch/Tag.
- **Changes**: changed files of the selected commit(s) (compacted folders, counts, status colors) and commit details
  (message, hash, author, date, containing branches); optional diff preview on the right or at the bottom.
- **Commit context menu**: Copy Revision Number, Create Patch…, Cherry-Pick, Checkout Revision, Show Repository at
  Revision, Compare with Local, Reset Current Branch to Here…, Revert Commit, Undo Commit…, Edit Commit Message…,
  Fixup…, Squash Into…, Squash Commits…, Drop Commits, Interactively Rebase from Here…, Push All up to Here…,
  New Branch…, New Tag…
- **File context menu**: Show Diff, Compare with Local, Show File at Revision, Annotate, Show History, Drop /
  Extract Selected Changes.
- Context menus are VS Code's native menus.

## Editor context menu › Git

| Group | Actions |
|---|---|
| Commit | Add, Add to .gitignore |
| Compare | Show Diff, Compare with Revision…, Compare with Branch or Tag…, Compare with Latest Repository Version, Show History, Show History for Selection…, Annotate with Git Blame |
| Rollback | Show Current Revision, Rollback…, Resolve Conflicts… |
| Remote | Push…, Pull…, Fetch, Update Project… |
| Branch | Merge…, Rebase…, Reset HEAD…, Branches…, New Branch…, New Tag…, Checkout Tag or Revision…, Clean Up Branches…; Continue / Skip / Abort of a running merge, rebase, cherry-pick or revert |
| Stash | Stash Changes…, Unstash Changes…, Create Patch…, Apply Patch… |
| Repository | Manage Remotes…, Worktrees…, Clone…, Create Git Repository…, Unshallow repository |

## Diff, merge and conflicts

- Side-by-side / unified diff viewer with previous / next file navigation and an editable right side for working
  tree files.
- Three-way merge tool with Accept Yours / Accept Theirs / Merge; **Resolve Conflicts…** dialog listing the unmerged
  files; conflict notification with "Resolve…".
- Annotate with Git Blame gutter (revision / date / author / subject, name style, colors) and annotated line actions;
  gutter change markers with Next / Previous Change, Rollback Lines and Show Diff for Lines.

## Commands

All commands are in the **Git** category of the Command Palette. Main entry points:

| Command | Id |
|---|---|
| Show VCS Log | `jbGit.log.show` |
| Show Git Console | `jbGit.console.show` |
| Branches… | `jbGit.branches.show` |
| New Branch… / New Tag… | `jbGit.branch.new` / `jbGit.tag.new` |
| Push… / Pull… / Fetch | `jbGit.push` / `jbGit.pull` / `jbGit.fetch` |
| Update Project… | `jbGit.updateProject` |
| Merge… / Rebase… / Reset HEAD… | `jbGit.merge` / `jbGit.rebase` / `jbGit.resetHead` |
| Resolve Conflicts… | `jbGit.conflicts.resolve` |
| Compare with Branch or Tag… / with Revision… | `jbGit.compareWithBranch` / `jbGit.compareWithRevision` |
| Show History / Show History for Selection… | `jbGit.showHistory` / `jbGit.showHistoryForSelection` |
| Annotate with Git Blame | `jbGit.annotate.toggle` |
| Stash Changes… / Unstash Changes… | `jbGit.stash.create` / `jbGit.stash.unstash` |
| Create Patch… / Apply Patch… | `jbGit.patch.create` / `jbGit.patch.apply` |
| Clean Up Branches… / Manage Remotes… / Worktrees… | `jbGit.cleanupBranches` / `jbGit.remotes.manage` / `jbGit.worktrees` |
| VCS Operations Popup… | `jbGit.vcsOperations` |

## Keybindings

| Action | macOS | Windows / Linux |
|---|---|---|
| VCS Operations Popup… | `Ctrl+V` | — |
| Rollback Lines | `Cmd+Alt+Z` | `Ctrl+Alt+Z` |
| Next / Previous Change | `Ctrl+Alt+Shift+Down/Up` | `Ctrl+Alt+Shift+Down/Up` |

## Settings

| Setting | Default | Description |
|---|---|---|
| `jbGit.gitPath` | `""` | Path to the git executable (empty = `git` from PATH). |
| `jbGit.log.sortType` | `"date"` | `date` (PhpStorm default: by commit date, children above parents) or `topological` (IntelliSort). |
| `jbGit.log.*` | | First Parent, Long Edges, columns, date format, pretty dates, highlights (my / merge commits, current branch), tag names, compact references, references on the left, details, diff preview and its location, branches tree. |
| `jbGit.annotate.*` | | Visible columns, name style, colors, ignore whitespaces, detect movements, commit timestamp. |
| `jbGit.branches.*` | | Tags, Recent, group by directory / repository, only favorites. |
| `jbGit.push.protectedBranches` | `"master, main"` | Protected branches (force push prohibited). |
| `jbGit.fetch.prune` | `true` | Fetch with `--prune`. |
| `jbGit.update.showDialog` | `true` | Show the Update Project dialog. |
| `jbGit.update.method` | `"merge"` | Merge or rebase for Update Project. |
| `jbGit.update.saveChangesPolicy` | `"stash"` | Stash local changes before updating. |
| `jbGit.cherryPick.addSuffix` | `false` | Add the "cherry picked from" suffix. |
| `jbGit.commitOps.showDropCommitDialog` | `true` | Confirm Drop Commits. |
| `jbGit.conflicts.showNotification` | `true` | Notify about merge conflicts. |
| `jbGit.diff.gutterMarkers` | `true` | Changed-line markers in the gutter and overview ruler. |

## Requirements

- VS Code 1.140 or newer.
- Git 2.30 or newer on PATH (or `jbGit.gitPath`).

## Development

```sh
npm install
npm run contributes      # merge src/**/contributes.json + src/webview/*/menus.json into package.json
npm run typecheck        # extension host + webviews
npm run build            # dist/extension.js + dist/media/*.js
npm test                 # unit tests (node:test)
npm run package          # .vsix
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the layout.

## Known gaps

- Only the `git` CLI is supported; no GitHub / GitLab integrations.
- The graph layout is computed on the loaded (filtered) commits, so with a branch filter secondary lanes may differ
  from PhpStorm, which lays out the whole repository.
- Reverting merge commits from the log is disabled (`git revert -m` needs a parent choice).
- Extract Selected Changes does not support changes inside git submodule entries.

## License

MIT. Not affiliated with JetBrains; PhpStorm and IntelliJ IDEA are trademarks of JetBrains s.r.o. The commit
ordering and graph coloring are ports of Apache-2.0 code from
[intellij-community](https://github.com/JetBrains/intellij-community).
