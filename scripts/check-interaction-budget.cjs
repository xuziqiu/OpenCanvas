const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
const canvasSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Canvas.tsx'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
const componentSource = ['Desktop.tsx', 'CardBodyEditor.tsx', 'CardSidePanel.tsx', 'NoteEditor.tsx']
  .map((name) => fs.readFileSync(path.join(__dirname, '..', 'src', 'components', name), 'utf8'))
  .concat(canvasSource)
  .join('\n');
const productIconSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'icons', 'ProductIcons.tsx'), 'utf8');
const electronSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const selectors = [
  '.layers-search button',
  '.layer-row button',
  '.sidebar-search-clear',
  '.tabs-heading button',
  '.canvas-toolbar button',
  '.zoom-controls button',
  '.card-selection-toolbar button',
  '.card-side-panel-header button',
  '.file-row-action',
  '.app-notification > button',
  '.desktop-zoom-controls button',
  '.editor-bubble-menu button',
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declarations(selector) {
  const matches = [...css.matchAll(new RegExp(`${escapeRegex(selector)}\\s*\\{([^}]+)\\}`, 'g'))];
  if (!matches.length) throw new Error(`Missing interaction selector ${selector}`);
  return matches.map((match) => match[1]).join(';');
}

function pixels(block, property) {
  const match = block.match(new RegExp(`(?:min-)?${property}:\\s*(\\d+(?:\\.\\d+)?)px`));
  return match ? Number(match[1]) : 0;
}

function lastNumber(block, property) {
  const matches = [...block.matchAll(new RegExp(`${property}:\\s*(-?\\d+(?:\\.\\d+)?)`, 'g'))];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

const failures = [];
for (const fragment of [
  "Inter-Regular-CKDp9E3C.woff2",
  "Inter-SemiBold-Ctx7G98q.woff2",
  "Inter-Bold-CuhepTt8.woff2",
  'font-family: Inter, "PingFang SC", "Microsoft YaHei UI"',
  'text-rendering: auto;',
]) {
  if (!css.includes(fragment)) failures.push(`missing bundled typography invariant: ${fragment}`);
}
if (!/\.structured-card-editor\.compact \.tiptap,\s*\.card-markdown-preview\s*\{[^}]*font-size:\s*14px;[^}]*line-height:\s*20px;/.test(css)) {
  failures.push('canvas preview and editor must share the same 14px/20px typography');
}
for (const selector of selectors) {
  const block = declarations(selector);
  const width = pixels(block, 'width');
  const height = pixels(block, 'height');
  if (width < 24 || height < 24) failures.push(`${selector}: ${width || '?'} x ${height || '?'} px`);
}
if (/<button\b[^>]*className=\{?`?[^>]*resize-handle/s.test(componentSource)) {
  failures.push('transparent pointer-only resize handles must not enter the keyboard tab order as buttons');
}
if (!/className="editor-bubble-menu" role="toolbar" aria-label="选中文字格式"/.test(componentSource)
  || !/className="editor-block-menu" role="menu" aria-label="转换为"/.test(componentSource)
  || /editor-format-bar/.test(componentSource)) {
  failures.push('editor formatting must use a named selection toolbar with a contextual block-type menu');
}
if (!/className="editor-command-menu[^\"]*" role="listbox"/.test(componentSource) || !/role="option" aria-selected=/.test(componentSource)) {
  failures.push('editor command suggestions must expose listbox selection semantics');
}
if (!/cardEditing\s*\?\s*<CardBodyEditor[\s\S]*?\/>\s*:\s*<CardMarkdownPreview/.test(componentSource)) {
  failures.push('canvas cards must reserve the full rich-text editor for editing while keeping the lightweight parity preview for readonly cards');
}
for (const fragment of [
  '.structured-card-editor.compact .tiptap,',
  '.card-markdown-preview {',
  '.card-markdown-preview { white-space: normal; }',
  '.card-markdown-preview :is(p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th) { white-space: break-spaces; }',
  '.structured-card-editor.compact .tiptap h1,',
  '.card-markdown-preview h1,',
]) {
  if (!css.includes(fragment)) failures.push(`missing preview/editor typography parity rule: ${fragment}`);
}
if (!/:is\(\.structured-card-editor\.compact \.tiptap, \.structured-card-editor\.document \.tiptap, \.card-markdown-preview, \.markdown-preview\) h1 \{ margin: 1\.35em 0 \.65em; \}/.test(css)
  || !/:is\(\.structured-card-editor\.compact \.tiptap, \.structured-card-editor\.document \.tiptap, \.card-markdown-preview, \.markdown-preview\) h3 \{ margin: 1\.15em 0 \.56em; \}/.test(css)) {
  failures.push('editor and readonly Markdown headings must share a deliberate section rhythm');
}
for (const fragment of [
  '.canvas-node:not(.selected) .resize-handle-n { top: calc(-10px * var(--canvas-inverse-zoom, 1)); }',
  '.canvas-node:not(.selected) .resize-handle-e { right: 0; }',
  '.canvas-node:not(.selected) .resize-handle-s { bottom: 0; }',
  '.canvas-node:not(.selected) .resize-handle-w { left: 0; }',
  '.canvas-node.node-locked .resize-handle { pointer-events: none; }',
]) {
  if (!css.includes(fragment)) failures.push(`missing safe resize-zone invariant: ${fragment}`);
}
const toolbarZ = lastNumber(declarations('.card-selection-toolbar'), 'z-index');
const resizeHandleZ = lastNumber(declarations('.resize-handle'), 'z-index');
if (toolbarZ === null || resizeHandleZ === null || toolbarZ <= resizeHandleZ) {
  failures.push(`card toolbar must remain above resize hit zones at low zoom (${toolbarZ ?? '?'} <= ${resizeHandleZ ?? '?'})`);
}
const sidePanelOpenRules = [...css.matchAll(/\.app-shell\.side-panel-open\s*\{([^}]+)\}/g)];
const finalSidePanelGrid = sidePanelOpenRules.at(-1)?.[1] ?? '';
if (!finalSidePanelGrid || /card-side-panel-width/.test(finalSidePanelGrid)) {
  failures.push('the fixed right side panel must not reserve a third grid column and reflow the canvas');
}
if (!/\.note-page\s*\{[^}]*left:\s*var\(--sidebar-width/.test(css)) {
  failures.push('the full-page card must follow the resizable left sidebar boundary');
}
if (!/\.workspace-panel-resizer-left\s*\{[^}]*z-index:\s*210[^}]*left:\s*var\(--sidebar-width/.test(css)) {
  failures.push('the left sidebar splitter must remain above the full-page card and sidebar surfaces');
}
if (!/\.app-shell\.is-resizing-left-panel \.workspace-panel-resizer-left::before,[\s\S]{0,180}\.app-shell\.is-resizing-right-panel \.workspace-panel-resizer-right::before\s*\{[^}]*width:\s*3px;[^}]*opacity:\s*1/.test(css)) {
  failures.push('active panel resizing must keep a clearly visible accent guide');
}
if (!/sidePanelOpen\s*&&\s*!focusedCardId\s*&&\s*<div className="workspace-panel-resizer workspace-panel-resizer-right"/.test(appSource)) {
  failures.push('the hidden right side panel splitter must not intercept the full-page editor');
}
if (/workspace-status/.test(componentSource) || /\.workspace-status\s*\{/.test(css)) {
  failures.push('the decorative top-left workspace status dot must not be rendered');
}
if (!/settings\.windowTheme === 'light' \? 'light' : 'dark'/.test(electronSource)
  || !/settings\.windowTheme !== theme/.test(electronSource)
  || !/backgroundColor: colors\.backgroundColor/.test(electronSource)
  || !/symbolColor: colors\.symbolColor/.test(electronSource)) {
  failures.push('the native window frame must start with and persist the selected light/dark theme');
}
if (packageJson.scripts?.dev !== 'concurrently -k "npm:dev:web" "npm:dev:electron"'
  || packageJson.scripts?.['setup:electron'] !== 'node scripts/ensure-electron.cjs'
  || packageJson.scripts?.['dev:electron'] !== 'npm run setup:electron && node scripts/dev-electron.cjs') {
  failures.push('the Windows development launcher must prepare the versioned Electron runtime and use npm-resolved commands');
}
if (!/\.file-tree-row\.file-tree-virtual-row\s*\{[^}]*position:\s*absolute/.test(css)) {
  failures.push('virtual file rows must stay absolutely positioned or their 31px transform will double the visible spacing');
}
if (!/\.desktop-board-node\.selected\s*\{[^}]*box-shadow:\s*var\(--oc-shadow-card-selected\)/.test(css)
  || !/\.desktop-board-node\.selected:active\s*\{[^}]*box-shadow:\s*var\(--oc-shadow-card-moving\)/.test(css)) {
  failures.push('desktop whiteboards must use the same restrained selected and moving shadows as canvas objects');
}
if (!/\.canvas-node\.node-board,\s*\.desktop-board-node\s*\{[^}]*border-color:\s*var\(--oc-board-border\)[^}]*box-shadow:\s*0 1px 3px/.test(css)) {
  failures.push('desktop and nested whiteboards must share one outer-surface style rule');
}
if (/className="card-side-panel-document"[^>]*key=/.test(componentSource) || /\.card-side-panel-document\s*\{[^}]*animation\s*:/.test(css)) {
  failures.push('side-panel card switches must reuse a stable, non-flashing document surface');
}
if (!/className="card-side-panel-document"[\s\S]{0,180}role="region"[\s\S]{0,180}tabIndex=\{-1\}/.test(componentSource)) {
  failures.push('side-panel linked-card navigation needs a non-editing focus destination');
}
if (!/returnFocusRef\.current\?\.isConnected/.test(componentSource) || !/\.board-path-title-field, \.layers-toggle/.test(componentSource)) {
  failures.push('closing the side panel must restore focus even when its current card is not mounted on the active board');
}
if (!/export default memo\(CardBodyEditor/.test(componentSource) || !/getCards=\{readWorkspaceCards\}/.test(componentSource)) {
  failures.push('unchanged canvas rich-text surfaces must not rerender on another card keystroke');
}
if (/canvasPlacementKeyboardAction/.test(canvasSource) || /<article[\s\S]{0,240}tabIndex=/.test(canvasSource)) {
  failures.push('canvas placements must not become keyboard selection targets or introduce a second focus outline');
}
if (!/section-title-chip section-title-chip-editing/.test(canvasSource)
  || !/\.node-frame \.section-title-editor\s*\{[^}]*field-sizing:\s*content/.test(css)) {
  failures.push('section renaming must reuse the title chip geometry instead of swapping to a fixed-width editor');
}
if (!/transform:\s*node\.isFrame \? undefined/.test(canvasSource)
  || !/\.node-frame::before\s*\{[^}]*z-index:\s*var\(--node-resting-z/.test(css)
  || !/\.node-frame \.floating-text-preview\s*\{[^}]*z-index:\s*7[0-9]/.test(css)
  || !/\.canvas-node\.node-frame[\s\S]{0,220}z-index:\s*auto/.test(css)) {
  failures.push('Section body and title must use separate root stacking levels so cards stay clickable while the title stays reachable');
}
if (!/PlacementColorRow colors=\{SECTION_CONTEXT_COLORS\}/.test(canvasSource) || !/colors === SECTION_CONTEXT_COLORS \? '区块颜色'/.test(canvasSource)) {
  failures.push('the Section object menu must expose the persisted Section color palette');
}
const connectorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'canvas', 'ConnectorLayer.tsx'), 'utf8');
if (!/className="edge-control-hit"/.test(connectorSource) || !/kind === 'insertion' \? 10 : 12/.test(connectorSource)) {
  failures.push('connector control handles must keep invisible 20-24 CSS-pixel pointer targets at every zoom');
}
if (!/className="edge-hitbox"[\s\S]{0,240}role="button"[\s\S]{0,120}tabIndex=\{0\}/.test(connectorSource) || !/shouldOpenConnectorMenu/.test(connectorSource)) {
  failures.push('detailed connectors must expose keyboard focus and standard menu activation gestures');
}
const asyncButtonSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AsyncActionButton.tsx'), 'utf8');
if (!/runExclusiveAsyncAction/.test(asyncButtonSource) || !/aria-busy=\{busy\}/.test(asyncButtonSource) || !/disabled=\{disabled \|\| Boolean\(pendingAction\)\}/.test(asyncButtonSource)) {
  failures.push('high-cost asynchronous buttons must expose progress and prevent re-entry');
}
if (!['WhiteboardIcon', 'CardIcon', 'CardPlusIcon', 'ConnectorIcon', 'DesktopIcon', 'SectionIcon', 'FilesIcon'].every((name) => productIconSource.includes(`export const ${name}`))) {
  failures.push('core workspace objects must use the dedicated product icon family');
}
if (!/:where\(svg\.oc-icon, svg\.lucide\)\s*\{[^}]*stroke-width:\s*1\.75/.test(css)
  || !/\.global-nav button\.active \.nav-object-icon\s*\{[^}]*var\(--oc-accent\)/.test(css)) {
  failures.push('product and action icons must share one optical weight and navigation state language');
}
if (!/\.multi-selection-bounds\s*\{[^}]*border-radius:\s*var\(--oc-node-radius\)[^}]*calc\(1px \* var\(--canvas-inverse-zoom, 1\)\)[^}]*color-mix\(in srgb, var\(--oc-accent\) 58%, transparent\)/.test(css)
  || !/\.canvas-node\s*\{[^}]*border-radius:\s*var\(--oc-node-radius\)/.test(css)) {
  failures.push('multi-selection bounds must reuse the card radius and remain visually quieter than object selection');
}
if (!/\.shared-board-preview\s*\{[^}]*background:\s*var\(--oc-board-surface\)/.test(css)
  || /data-theme='dark'\] \.shared-board-preview\s*\{[^}]*background:/.test(css)) {
  failures.push('nested and desktop whiteboards must keep their dedicated surface in every theme and state');
}
const modalFocusSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'modalFocus.ts'), 'utf8');
if (/!document\.activeElement\.closest\('\[aria-modal="true"\]'\)/.test(modalFocusSource) || !/topmost\.contains\(opener\)/.test(modalFocusSource)) {
  failures.push('nested dialogs must restore focus one modal level at a time');
}

if (failures.length) {
  process.stderr.write(`Interaction target budget failed:\n${failures.map((item) => `- ${item}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`Interaction target budget passed for ${selectors.length} frequent compact controls.\n`);
