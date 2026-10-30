// Shared by the diff and merge webviews: theme detection and the CSS that maps ide-diff's variables to the
// VS Code theme (ide-diff keeps its JetBrains diff/syntax colors; chrome and editors follow VS Code).

export type Theme = 'dark' | 'light';

export const theme = (): Theme => (/\bvscode-(light|high-contrast-light)\b/.test(document.body.className) ? 'light' : 'dark');

/** Calls `cb` whenever VS Code switches between a light and a dark theme. */
export function onThemeChange(cb: (t: Theme) => void): void {
  let last = theme();
  new MutationObserver(() => {
    const t = theme();
    if (t !== last) cb((last = t));
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

export function injectCss(css: string): void {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

export const BASE_CSS = `
:root {
  --jb-border: var(--vscode-editorGroup-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
  --jb-added: var(--vscode-gitDecoration-addedResourceForeground, #73c991);
  --jb-modified: var(--vscode-gitDecoration-modifiedResourceForeground, #6c9ef8);
  --jb-deleted: var(--vscode-gitDecoration-deletedResourceForeground, #8c8c8c);
  --jb-untracked: var(--vscode-gitDecoration-untrackedResourceForeground, #d2a668);
  --jb-conflict: var(--vscode-gitDecoration-conflictingResourceForeground, #e4676b);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; padding: 0; overflow: hidden; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); -webkit-font-smoothing: antialiased;
  color: var(--vscode-foreground); background: var(--vscode-editor-background); }
#app { height: 100%; display: flex; flex-direction: column; min-height: 0; }
body .idd-theme-dark, body .idd-theme-light {
  --idd-font-family: var(--vscode-editor-font-family);
  --idd-font-size: var(--vscode-editor-font-size);
  --idd-line-height: calc(var(--vscode-editor-font-size) * 1.6);
  --idd-ui-font-family: var(--vscode-font-family);
  --idd-ui-font-size: var(--vscode-font-size, 13px);
  --idd-editor-bg: var(--vscode-editor-background);
  --idd-editor-fg: var(--vscode-editor-foreground);
  --idd-gutter-bg: var(--vscode-editorGutter-background, var(--vscode-editor-background));
  --idd-divider-bg: var(--vscode-editorGutter-background, var(--vscode-editor-background));
  --idd-caret: var(--vscode-editorCursor-foreground);
  --idd-caret-row-bg: var(--vscode-editor-lineHighlightBackground, transparent);
  --idd-selection-bg: var(--vscode-editor-selectionBackground);
  --idd-line-number: var(--vscode-editorLineNumber-foreground);
  --idd-line-number-caret-row: var(--vscode-editorLineNumber-activeForeground);
  --idd-whitespace: var(--vscode-editorWhitespace-foreground);
  --idd-search-result-bg: var(--vscode-editor-findMatchHighlightBackground);
  --idd-matched-brace-bg: var(--vscode-editorBracketMatch-background);
  --idd-panel-bg: var(--vscode-editor-background);
  --idd-toolbar-bg: var(--vscode-editor-background);
  --idd-window-bg: var(--vscode-editorWidget-background);
  --idd-border: var(--jb-border);
  --idd-fg: var(--vscode-foreground);
  --idd-title-fg: var(--vscode-foreground);
  --idd-fg-muted: var(--vscode-descriptionForeground);
  --idd-fg-disabled: var(--vscode-disabledForeground);
  --idd-button-hover-bg: var(--vscode-toolbar-hoverBackground);
  --idd-button-pressed-bg: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground));
  --idd-popup-bg: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  --idd-popup-border: var(--vscode-menu-border, var(--vscode-widget-border, var(--jb-border)));
  --idd-list-selection-bg: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
  --idd-list-hover-bg: var(--vscode-list-hoverBackground);
  --idd-focus: var(--vscode-focusBorder);
  --idd-accent: var(--vscode-focusBorder);
  --idd-link: var(--vscode-textLink-foreground);
  --idd-tooltip-bg: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
  --idd-tooltip-fg: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  --idd-scrollbar-thumb: var(--vscode-scrollbarSlider-background);
  --idd-scrollbar-thumb-hover: var(--vscode-scrollbarSlider-hoverBackground);
}
.jb-btn { height: 28px; padding: 0 14px; border-radius: 6px; font: inherit; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--vscode-button-border, var(--jb-border)); background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
.jb-btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)); }
.jb-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.jb-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.jb-btn:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
.jb-btn:disabled { opacity: .5; cursor: default; }
`;
