// After `vite build` (emptyOutDir wipes dist/), restore the Claude dashboard
// extras and repoint the embedded original dashboard at the freshly hashed
// React bundle. Usage: node scripts/postbuild-extra.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const assets = path.join(dist, 'assets');
const canonical = path.join(root, 'scripts', 'claude-dashboard');

const js = fs.readdirSync(assets).find(f => /^index-.*\.js$/.test(f));
const css = fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f));
if (!js || !css) throw new Error('postbuild-extra: React bundle not found in dist/assets');

// 1. Restore the custom Claude dashboard shell (index.html / app.js / favicon).
for (const f of ['index.html', 'app.js', 'favicon.svg', 'claude-theme.css']) {
  const from = path.join(canonical, f);
  if (!fs.existsSync(from)) throw new Error(`postbuild-extra: missing canonical ${from}`);
  fs.copyFileSync(from, path.join(dist, f));
}

// 2. Re-patch ONLY the visible brand strings in the freshly built bundle.
//    Technical keys, routes, i18n messages and options stay untouched.
const bundlePath = path.join(assets, js);
let bundle = fs.readFileSync(bundlePath, 'utf8');
bundle = bundle.replaceAll('children:`FreeLLMAPI`', 'children:`Claude`');
// Updates-dialog subtitle (three literals on one minified line).
bundle = bundle.replaceAll('`FreeLLMAPI v${', '`Claude v${')
  .replaceAll('`FreeLLMAPI ${', '`Claude ${')
  .replaceAll(':`FreeLLMAPI`', ':`Claude`');
fs.writeFileSync(bundlePath, bundle);

// 3. The inline theme bootstrap must stay byte-identical (pinned CSP hash).
const shell = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const boot = shell.match(/<script>([\s\S]*?)<\/script>/);
if (!boot) throw new Error('postbuild-extra: inline bootstrap not found in index.html');

// 4. Regenerate the embedded original-dashboard page with the new asset hash.
const reactHtml = `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <script>${boot[1]}</script>
    <title>Claude Code · Dashboard</title>
    <script src="/dash-boot.js"></script>
    <script type="module" crossorigin src="/assets/${js}?v=claude1"></script>
    <link rel="stylesheet" crossorigin href="/assets/${css}?v=claude1">
    <link rel="stylesheet" href="/claude-theme.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
fs.writeFileSync(path.join(dist, 'react.html'), reactHtml);

const bootJs = `// Route + dark theme for the embedded original dashboard (CSP-safe external file).
try {
  localStorage.setItem('theme', 'dark');
  history.replaceState(null, '', '/models/chat');
} catch (e) { /* non-fatal */ }
`;
fs.writeFileSync(path.join(dist, 'dash-boot.js'), bootJs);

console.log(`postbuild-extra: shell restored; react.html + dash-boot.js written (bundle ${js}, brand patched)`);
