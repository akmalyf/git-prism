# vscode-git-tools — Rencana Clone Git Tools PhpStorm

Sumber: PhpStorm 2026.2.2 (build 262.10315.130), `plugins/vcs-git`, `lib/intellij.platform.vcs*.jar`, `lib/intellij.platform.diff*.jar`.
Data mentah: `.re/actions-labeled.tsv` (611 action/group ID + label dari `*Bundle.properties`).

## Inventaris fitur (dikelompokkan per panel)

### 1. Commit tool window (`CheckinProject`, `ChangesView.*`, `CommitView.*`)
- Tree **Changes** + **Unversioned Files**; group by Directory / Module / Repository; tampilkan Ignored Files
- Checkbox per file / per changelist (partial include); `Vcs.Diff.Include/ExcludeChangedLinesIntoCommit` (per-line staging dari diff)
- Toolbar: Refresh, Rollback, Update, Shelve, Show Diff, Expand/Collapse, Group by, View options
- Double-click: Show Diff vs Show Source; single-click diff preview
- Commit message editor + **Amend** toggle + **Commit Message History** (`Vcs.ShowMessageHistory`)
- Commit / Commit and Push…; Commit Options (author, sign-off, GPG, run checks)
- Mode alternatif: **Staging Area** (`Git.Stage.*`): Staged/Unstaged, Stage All, Stage Tracked, 3-way compare HEAD/Staged/Local
- Changelists: New, Edit, Delete, Set Active, Move to Another Changelist
- Patch: Create Patch, Copy as Patch, Apply Patch (file/clipboard)

### 2. Shelf & Stash (`ShelvedChanges.*`, `Git.Stash.*`)
- Stash: Stash Changes…, Stash Silently, Apply/Pop/Drop/Clear, Unstash As (new branch), diff preview
- Shelf: Shelve/Unshelve, Restore, Rename, Show applied (bisa dipetakan ke stash di VS Code)

### 3. Git Log (`Vcs.Log.*`, `Git.Log.*`)
- 3 kolom: **Branches tree** (Local/Remote/Tags, Recent, group by directory/repo) · **Commit graph table** · **Changed files tree + commit details**
- Filter bar: Text/hash (Regex, Match Case), Branch, User, Date, Paths
- Kolom: Author, Date (Commit vs Author timestamp), Hash, Root; ref labels (kiri/kanan, compact, tag names), long edges
- Diff preview kanan/bawah; Show Changes to Parents; Show Only Affected Changes
- Go To Hash/Branch/Tag, Go to Parent/Child
- Context menu commit: Copy Revision / Subject, Checkout Revision, Show Repository at Revision, Compare Versions, Create Patch, Cherry-Pick, Revert Commit, **Reset Current Branch to Here** (soft/mixed/hard/keep), Undo Commit, Edit Commit Message, Fixup/Squash Into, Squash Commits, Drop Commits, Interactively Rebase from Here, Push All up to Here, New Branch/Tag, Go to child/parent
- Context menu file: Show Diff, Compare with Local, Compare Before with Local, Show File at Revision, Annotate, Show History, Revert/Cherry-pick Selected Changes

### 4. Branches popup / widget (`Git.Branches`, `git.branches.*`, `main.toolbar.git.*`)
- Search, Recent, Local, Remote, Tags; per-branch: Checkout, New Branch from, Checkout and Rebase onto, Compare with Current, Show Diff with Working Tree, Rebase/Merge into Current, Pull into using Rebase/Merge, Push, Rename, Delete, Update
- Fetch, Update Project (merge/rebase), Merge/Rebase widget + Abort/Continue/Skip

### 5. Compare & History (file/folder/editor)
- **Compare with Branch or Tag…** (`Git.CompareWithBranch`)
- **Compare with Revision…** (`Compare.Selected`), Compare with Same Repository Version, Compare with Latest
- **Show History** (file/folder), Show History for Selection, History Up to Here
- **Annotate** (blame gutter) + Annotated Line Operations
- Gutter change markers: Next/Prev Change, Rollback Lines, Show Diff for Lines

### 6. Diff viewer (`intellij.platform.diff.*`)
- Side-by-side / unified, align changes, combined diff semua file, Prev/Next difference & file, search in changes
- Merge tool 3-way: **Resolve Conflicts…**, Accept Yours/Theirs, Merge (sudah ada dasarnya di `diff-editor` / `ide-diff`)

### 7. Lain-lain
- Push dialog (`Vcs.Push`, Force Push), Pull dialog, Merge dialog, Rebase dialog
- Reset HEAD…, Manage Remotes, Clone, Init, Worktrees (new/open/prune/remove), Clean Up Branches, Unshallow
- Console tab (log semua git command), notifications

## Arsitektur yang diusulkan

- **Extension host (TS)**: wrapper `git` CLI sendiri (spawn, parse porcelain v2 / `log --format` / `diff --raw -z`), bukan bergantung ke API `vscode.git` (terlalu terbatas untuk log/graph/rebase).
- **UI**: Webview (React/Preact atau vanilla + Vite) untuk Commit panel & Log panel supaya bisa 1:1 visual (graph canvas, 3 kolom, filter bar). Tree view native sebagai fallback ringan.
- **Diff**: reuse `ide-diff` (`~/Agent/diff-editor`, sudah dipakai `vscode-deployment`) sebagai custom editor diff/merge.
- **Graph**: algoritma layout lane sendiri (mirip `intellij.platform.vcs.log.graph`) dirender di `<canvas>` + virtualized rows untuk repo besar.
- **Theming**: CSS variables dari VS Code theme, layout & ikon mengikuti New UI JetBrains.

## Usulan urutan milestone

1. Scaffold extension + git CLI layer + Console log
2. **Commit panel** (changes tree, checkbox, message, amend, history, commit/commit & push, rollback)
3. **Git Log panel** (graph, filter, branches tree, detail + changed files, diff preview)
4. Compare with Branch / Revision, Show History, Annotate
5. Context-menu commit ops (reset, revert, cherry-pick, interactive rebase, squash/fixup/drop/reword)
6. Branches popup + Push/Pull/Merge/Rebase dialogs + conflict resolver
7. Stash/Shelf, patches, worktrees, staging-area mode
