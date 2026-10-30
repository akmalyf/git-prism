# Architecture

VS Code extension with a desktop-IDE-style Git log and Git actions. The commit ordering and graph coloring are
ports of Apache-2.0 code from github.com/JetBrains/intellij-community (`platform/vcs-log`); that code base is the
reference for their exact behavior.

## Layout

```
src/extension.ts              activates every feature
src/contributes.base.json     panel container "gitPrismPanel" (Git), the editor "Git" submenu
src/core/                     shared infrastructure
  git.ts         git(cwd, args, opts) / gitRaw / GitError / showGitError — every git call goes through here
  repository.ts  Repository (status, refs, log, show, changes, remotes, stashes, operationState, exec() =
                 mutating command + change event) and RepositoryManager (discover, pick, forUri, events)
  parse.ts       pure parsers (porcelain v2 status, name-status, log, refs) + LOG_FORMAT / REF_FORMAT
  types.ts       shared data shapes (also imported by webviews)
  contracts.ts   cross-feature command ids + argument types: invoke(id, args) / implement(id, handler)
  webview.ts     webviewHtml(), webviewOptions(), RpcBridge (call / emit), native context menu routing
  iconTheme.ts   the user's file icon theme as CSS + association tables for the webviews
  console.ts     "Git Console" output channel (every git command is logged)
src/features/<name>/          one folder per feature
  index.ts         export function activate(ctx: FeatureContext)
  contributes.json fragment merged into package.json by `npm run contributes` (commands, menus, views,
                   keybindings, configuration.properties) — never edit package.json's "contributes" by hand
  *.ts             pure logic in separate modules with *.test.ts next to it (node:test)
src/webview/shared/           webview UI kit: rpc.ts, languages.ts, base.css, ui/* (see ui/README.md)
src/webview/<bundle>/main.ts  one webview bundle → dist/media/<bundle>.js (auto-discovered by scripts/build.mjs)
src/webview/<bundle>/menus.json
                              native VS Code context menus of that webview (generated into package.json)
```

Features: `log` (Git panel, commit list, graph engine, commit sorting, console), `commitOps` (log context menu
operations, interactive rebase), `compare` (compare / history / repository at revision), `annotate` (blame, gutter
markers), `branches` (branches popup, branch / tag / remote / worktree management), `sync` (push / pull / fetch /
update / merge / rebase / reset dialogs), `conflicts` (conflicts dialog, continue / abort / skip), `diff` (diff and
merge viewers on @ide-diff/viewer), `stash` (stash dialogs, patches), `commit` (Add, Add to .gitignore, Rollback).

## Conventions

- TypeScript strict, ES2022. Extension host: `module Node16`. Webviews: DOM, vanilla TS + the shared UI kit.
- 2-space indent, single quotes, semicolons, a short header comment per file.
- Command ids `gitPrism.*`, category "Git". Context keys `gitPrism.*`. Settings `gitPrism.<feature>.*`.
- Repo-relative paths use forward slashes (`repo.abs()` / `repo.rel()`).
- Mutating git commands go through `repo.exec([...])` (fires a refresh); read-only ones through `repo.run([...], { quiet: true })` when polled.
- Errors: `showGitError(e, 'Push failed')`; long operations: `vscode.window.withProgress`.
- Features never import each other; they call the contract commands in `src/core/contracts.ts`.
- Webviews: `webviewHtml(webview, extUri, '<bundle>', init)`, `new RpcBridge(webview, handlers)`; in the page
  `import { rpc, init, viewState } from '../shared/rpc'`. Right-click menus call `showContextMenu()` synchronously
  from the `contextmenu` event and list every item in `menus.json`; VS Code then shows its native menu.
- Theming: VS Code CSS variables only; must work in dark and light themes. File icons come from the user's icon theme.

## Checking

```sh
npm run contributes && npm run typecheck && npm run build && npm test && npm run package
```
