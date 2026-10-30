// Bundles the extension host (src/extension.ts), every webview entry (src/webview/<name>/main.ts →
// dist/media/<name>.js) and, with --test, every src/**/*.test.ts (pure modules only, no vscode) for node --test.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');
const root = path.resolve(import.meta.dirname, '..');
const r = (...p) => path.join(root, ...p);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

if (test) {
  const entries = walk(r('src')).filter((f) => f.endsWith('.test.ts'));
  fs.rmSync(r('dist-test'), { recursive: true, force: true });
  await esbuild.build({
    entryPoints: entries,
    outdir: r('dist-test'),
    outbase: r('src'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    logLevel: 'warning',
  });
  // Newer Node resolves `node --test dist-test/` as a module path: give it an index that loads every test file.
  const outs = walk(r('dist-test')).filter((f) => f.endsWith('.test.js'));
  fs.writeFileSync(r('dist-test/index.js'), outs.map((f) => `require('./${path.relative(r('dist-test'), f).split(path.sep).join('/')}');`).join('\n') + '\n');
  process.exit(0);
}

// start from a clean dist/media so bundles of removed webviews don't linger in the package
fs.rmSync(r('dist/media'), { recursive: true, force: true });
fs.mkdirSync(r('dist/media'), { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) fs.copyFileSync(r('node_modules/@vscode/codicons/dist', f), r('dist/media', f));

const webviews = fs
  .readdirSync(r('src/webview'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'shared' && fs.existsSync(r('src/webview', d.name, 'main.ts')))
  .map((d) => d.name);

const configs = [
  {
    entryPoints: [r('src/extension.ts')],
    outfile: r('dist/extension.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    minify: !watch,
    sourcemap: true,
  },
  ...webviews.map((name) => ({
    entryPoints: [r('src/webview', name, 'main.ts')],
    outfile: r('dist/media', `${name}.js`),
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    minify: !watch,
    loader: { '.css': 'text' },
    define: { __JB_BUNDLE__: JSON.stringify(name) },
  })),
];

if (watch) {
  for (const c of configs) await (await esbuild.context({ ...c, logLevel: 'info' })).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build({ ...c, logLevel: 'warning' })));
  console.log(`built extension + ${webviews.length} webview(s): ${webviews.join(', ')}`);
}
