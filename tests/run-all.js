// Runs every local check: syntax of Code.js and of the client scripts (as the browser receives them), then every test file.
// Run: node tests/run-all.js   (exit code 0 only when everything passes)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
let failed = 0;
const syntax = (label, src) => {
  try { new vm.Script(src, { filename: label }); console.log('PASS  syntax ' + label); }
  catch (e) { failed++; console.log('FAIL  syntax ' + label + ': ' + e.message); }
};
syntax('Code.js', fs.readFileSync(path.join(root, 'Code.js'), 'utf8'));
// The four client files are separate <script> blocks of one page; each must parse alone, and together (shared globals).
const client = ['App1', 'App2', 'App3', 'App4'].map(n => {
  const html = fs.readFileSync(path.join(root, n + '.html'), 'utf8'), m = html.match(/<script>([\s\S]*)<\/script>\s*$/);
  if (!m) { failed++; console.log('FAIL  ' + n + '.html: expected one <script>…</script> block ending the file'); return ''; }
  syntax(n + '.html', m[1]); return m[1];
});
syntax('App1-4 combined', client.join('\n;\n'));
fs.readdirSync(__dirname).filter(f => /-tests?\.js$/.test(f)).sort().forEach(f => {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').pop();
  if (r.status === 0) console.log('PASS  ' + f + '  (' + last + ')');
  else { failed++; console.log('FAIL  ' + f + '\n' + (r.stdout || '') + (r.stderr || '')); }
});
console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nAll checks passed');
process.exit(failed ? 1 : 0);
