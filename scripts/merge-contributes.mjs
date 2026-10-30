// Merges src/contributes.base.json and every src/features/*/contributes.json into package.json "contributes".
// Arrays are concatenated (commands, menus.<id>, keybindings, views.<id>, ...); objects are merged deeply;
// configuration.properties from all fragments end up in one "JetBrains Git Tools" configuration section.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const featuresDir = path.join(root, 'src/features');
const fragments = [path.join(root, 'src/contributes.base.json')];
for (const d of fs.readdirSync(featuresDir).sort()) {
  const f = path.join(featuresDir, d, 'contributes.json');
  if (fs.existsSync(f)) fragments.push(f);
}

function merge(a, b, where) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v, `${where}.${k}`) : v;
    return out;
  }
  if (a !== undefined && a !== b) throw new Error(`conflicting scalar at ${where}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return b;
}

let contributes = {};
for (const f of fragments) {
  let frag = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (frag.configuration && !Array.isArray(frag.configuration)) frag = { ...frag, configuration: { properties: frag.configuration.properties ?? {} } };
  contributes = merge(contributes, frag, path.relative(root, f));
}
if (contributes.configuration) contributes.configuration = { title: 'Git Prism', ...contributes.configuration };

// Native webview context menus: src/webview/<bundle>/menus.json is { "<section>": [item | "-", ...] } where
// item = { "id", "title", "toggle"? } or a submenu { "id", "title", "items": [...] }. Each item becomes a hidden
// command gitPrism.m.<bundle>.<section>.<key> shown in "webview/context" when the webview published jbm_<key>
// (see src/webview/shared/ui/menu.ts); "-" starts a new group. Submenu item keys are "<submenu>_<id>".
const webviewDir = path.join(root, 'src/webview');
for (const bundle of fs.readdirSync(webviewDir).sort()) {
  const f = path.join(webviewDir, bundle, 'menus.json');
  if (!fs.existsSync(f)) continue;
  const sections = JSON.parse(fs.readFileSync(f, 'utf8'));
  const commands = (contributes.commands ??= []);
  const menus = (contributes.menus ??= {});
  const palette = (menus.commandPalette ??= []);
  const submenus = (contributes.submenus ??= []);
  for (const [section, items] of Object.entries(sections)) {
    const scope = `jbmMenu == '${bundle}.${section}'`;
    const emit = (list, menuId, prefix) => {
      let group = 0;
      let order = 0;
      const target = (menus[menuId] ??= []);
      for (const it of list) {
        if (it === '-') {
          group++;
          order = 0;
          continue;
        }
        const key = prefix + it.id;
        const when = `${scope} && jbm_${key}`;
        const g = `${String(group).padStart(2, '0')}_${bundle}@${order++}`;
        if (it.items) {
          const sub = `gitPrism.m.${bundle}.${section}.${key}.menu`;
          submenus.push({ id: sub, label: it.title });
          target.push({ submenu: sub, group: g, when });
          emit(it.items, sub, `${key}_`);
          continue;
        }
        const command = `gitPrism.m.${bundle}.${section}.${key}`;
        const c = { command, title: it.title };
        if (it.toggle) c.toggled = `jbmc_${key}`;
        commands.push(c);
        palette.push({ command, when: 'false' });
        target.push({ command, group: g, when });
      }
    };
    emit(items, 'webview/context', '');
  }
}

const ids = new Map();
for (const c of contributes.commands ?? []) {
  if (ids.has(c.command)) throw new Error(`duplicate command id ${c.command}`);
  ids.set(c.command, c);
}

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.contributes = contributes;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`merged ${fragments.length} fragment(s), ${ids.size} command(s)`);
