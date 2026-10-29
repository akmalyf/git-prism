# Architecture & rules (read fully before writing code)

VS Code extension that recreates PhpStorm 2026.2's Git tooling 1:1 (New UI "Islands" look). Feature inventory: `PLAN.md`.

## Reference material (use it for exact behavior & strings)
- `.re/actions-labeled.tsv` — every PhpStorm VCS/Git action: module, kind, id, label, implementing class.
- `.re/extract/**/messages/*.properties` — PhpStorm's own UI strings (GitBundle, VcsBundle, VcsLogBundle, DvcsBundle,
  DiffBundle, ModalCommitBundle, ActionsBundle). **Grep these for dialog titles, button labels, checkbox texts, messages,
  notifications** so the UI reads exactly like PhpStorm (strip `&`/`_` mnemonics, `…` = `…`).
- `.re/extract/**/*.xml` — action/group registrations (which actions appear in which popup/toolbar, in what order).
- The IntelliJ source is open (github.com/JetBrains/intellij-community, `plugins/git4idea`, `platform/vcs-log`,
  `platform/vcs-impl`) — you may WebFetch raw files there to check exact behavior/ordering.

## Layout
```
src/extension.ts              activates every feature (fixed list, don't edit)
src/contributes.base.json     view containers: activitybar "jbGitCommit" (Commit), panel "jbGitPanel" (Git)
src/core/                     SHARED, owned by the lead — read-only for feature agents
  git.ts         git(cwd,args,opts) / gitRaw / GitError / showGitError — ALL git calls go through here
  repository.ts  Repository (status, refs, log, show, changes, commitChanges, remotes, stashes, operationState,
                 exec() = mutating command + change event) and RepositoryManager (discover, pick, forUri, events)
  parse.ts       pure parsers (porcelain v2 status, name-status, log, refs) + LOG_FORMAT/REF_FORMAT
  types.ts       shared data shapes (also importable from webviews)
  contracts.ts   cross-feature command ids + arg types: invoke(id,args) / implement(id,handler)
  webview.ts     webviewHtml(webview, extUri, bundle, init), webviewOptions(), RpcBridge (call/emit)
  console.ts     "Git Console" output channel (every git command is logged automatically)
  context.ts     FeatureContext { extension, repos }
src/features/<name>/          one folder per feature, owned by exactly one agent
  index.ts         export function activate(ctx: FeatureContext)
  contributes.json fragment merged into package.json by `npm run contributes` (commands, menus, views,
                   keybindings, configuration.properties). Never edit package.json directly.
  *.ts             anything else the feature needs; pure logic in separate files with *.test.ts next to it
src/webview/shared/           webview UI kit (owned by the ui-kit agent): rpc.ts, languages.ts, base.css, ui/*
src/webview/<bundle>/main.ts  one webview bundle → dist/media/<bundle>.js (auto-discovered by scripts/build.mjs)
                              a feature may own several bundles; name them <feature> or <feature>-<thing>
```

## Ownership (hard rule)
Only create/edit files inside the folders you own. Need something from core or another feature? Use the contract
commands in `src/core/contracts.ts`. If the contract truly lacks something, register an additional command id in your
own feature with prefix `jbGit.<yourFeature>.` and mention it in your final report — don't edit contracts.ts.
No new npm dependencies (everything needed is installed: @ide-diff/viewer + @ide-diff/core, CodeMirror 6 + languages,
@vscode/codicons). Node built-ins are fine on the extension side.

| feature folder | webview bundles | owns contract commands |
|---|---|---|
| diff | diff, merge | jbGit.diff.show, jbGit.conflicts.mergeFile |
| conflicts | conflicts | jbGit.conflicts.resolve |
| commit | commit | jbGit.commit.focus |
| log | log | jbGit.log.show |
| commitOps | rebase (interactive rebase dialog), commitops-* dialogs | jbGit.commit.* except focus |
| compare | changes, history-selection, compare-* | jbGit.changes.show, jbGit.compare.*, jbGit.repoAtRevision |
| annotate | (none, editor decorations) | — |
| branches | branches-* dialogs if needed | jbGit.branches.show, jbGit.branch.*, jbGit.tag.new |
| sync | push, pull, merge-dialog, rebase-dialog, reset | jbGit.push/pull/fetch/merge/rebase/updateProject/resetHead |
| stash | stash, unstash | jbGit.stash.* |
| ui-kit (src/webview/shared) | — | — |

## Conventions
- TypeScript strict, ES2022. Extension host: `module Node16`. Webviews: DOM, no framework — vanilla TS + the shared UI kit.
- Match this repo's style: 2-space indent, single quotes, semicolons, short top-of-file comment explaining the file,
  sparse comments elsewhere.
- Command ids `jbGit.*`, category `"Git"`, titles = PhpStorm labels. Context keys `jbGit.*`. Settings `jbGit.<feature>.*`.
- Repo-relative paths always use forward slashes. Use `repo.abs()`/`repo.rel()`.
- Mutating git commands: `repo.exec([...])` (fires refresh). Read-only: `repo.run([...], { quiet: true })` when polled.
- Errors: catch and `showGitError(e, 'Push failed')`. Long operations: `vscode.window.withProgress`.
- Never leave a git operation half-done silently: on conflicts, notify with "Resolve Conflicts…" → `invoke('jbGit.conflicts.resolve', …)`.
- Webviews: `webviewHtml(webview, ctx.extension.extensionUri, '<bundle>', init)`, `webviewOptions(...)`,
  `new RpcBridge(webview, handlers)`. In the page: `import { rpc, init, viewState } from '../shared/rpc'`.
  Refresh: listen to `ctx.repos.onDidChangeRepository` on the host and `bridge.emit('refresh')`.
- Theming: only VS Code CSS variables (`--vscode-*`) + the UI kit's tokens; must look right in dark AND light themes.
  JetBrains look: compact 22–24px rows, 13px UI font (`--vscode-font-family`), codicons for icons, subtle
  selection (`--vscode-list-activeSelectionBackground` / inactive variant), no heavy borders, rounded 4–6px
  "islands" panels. ide-diff takes `theme: document.body.classList.contains('vscode-light') ? 'light' : 'dark'`.
- Keyboard: every list/tree/table must be keyboard navigable (arrows, Home/End, PageUp/Down, Enter, Space for
  checkboxes, Shift/Cmd multi-select, context menu via Shift+F10 / ContextMenu key).
- Big repos: virtualize lists over ~500 rows; page `git log` (e.g. 1000 commits per chunk); never block the UI.

## Checking your work
- `npx tsc --noEmit 2>&1 | grep 'src/features/<yours>'` and `npx tsc --noEmit -p src/webview 2>&1 | grep 'src/webview/<yours>'`
  (other agents work in parallel — ignore their errors, fix all of yours).
- `node scripts/build.mjs` bundles everything; `node scripts/build.mjs --test && node --test dist-test/` runs pure unit tests.
- A scratch repo for manual git experiments: create one under `/private/tmp/claude-501/jbgit-scratch-<feature>` — never
  run mutating git commands in this project's own repo.
