// Runs every local check: syntax of each server .js file and of the client scripts (as the browser receives them), then every
// test file twice: server files loaded in name order and in reverse order (Apps Script's load order must not matter).
// Run: node tests/run-all.js   (exit code 0 only when everything passes)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
let failed = 0;
const syntax = (label, src) => {
  try { new vm.Script(src, { filename: label }); console.log('PASS  syntax ' + label); }
  catch (e) { failed++; console.log('FAIL  syntax ' + label + ': ' + e.message); }
};
const serverFiles = fs.readdirSync(root).filter(f => /\.js$/.test(f)).sort();
if (!serverFiles.length) { failed++; console.log('FAIL  no server .js files found'); }
serverFiles.forEach(f => syntax(f, fs.readFileSync(path.join(root, f), 'utf8')));
// The four client files are separate <script> blocks of one page; each must parse alone, and together (shared globals).
const client = ['App1', 'App2', 'App3', 'App4'].map(n => {
  const html = fs.readFileSync(path.join(root, n + '.html'), 'utf8'), m = html.match(/<script>([\s\S]*)<\/script>\s*$/);
  if (!m) { failed++; console.log('FAIL  ' + n + '.html: expected one <script>…</script> block ending the file'); return ''; }
  syntax(n + '.html', m[1]); return m[1];
});
syntax('App1-4 combined', client.join('\n;\n'));
['', 'reverse'].forEach(order => fs.readdirSync(__dirname).filter(f => /-tests?\.js$/.test(f)).sort().forEach(f => {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', env: Object.assign({}, process.env, { LOAD_ORDER: order }) });
  const last = (r.stdout || '').trim().split('\n').pop(), tag = order ? '  [reverse load order]' : '';
  if (r.status === 0) console.log('PASS  ' + f + tag + '  (' + last + ')');
  else { failed++; console.log('FAIL  ' + f + tag + '\n' + (r.stdout || '') + (r.stderr || '')); }
}));
console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nAll checks passed');
process.exit(failed ? 1 : 0);
