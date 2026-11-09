// A line comment in client code must never hold code. An edit once appended "// ..." in the middle of a line, so the rest of
// that line (the declaration let REAUTH=null) fell inside the comment and the session renewal broke without any visible error.
// Run: node tests/client-comments-tests.js
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const CODEY = /(let |const |var |function\s*\w*\(|=>|\$\("|\)\{|\};|\w+\([^)]*\);|[a-zA-Z_]\w*=[^=])/;
function swallowed(src) {
  const hits = [];
  src.replace(/\r/g, '').split('\n').forEach((line, n) => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i], d = line[i + 1];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '/' && d === '/') { if (CODEY.test(line.slice(i + 2))) hits.push((n + 1) + ': //' + line.slice(i + 2, i + 100)); break; }
      if (c === '/' && d !== '/' && d !== '*' && /[=(,:!&|?{};]\s*$/.test(line.slice(0, i))) { // a regex literal: skip it
        for (i++; i < line.length; i++) { if (line[i] === '\\') { i++; continue; } if (line[i] === '/') break; }
      }
    }
  });
  return hits;
}
let fail = 0;
// the checker itself finds the old bug
if (!swallowed('const A=[1]; // a comment that ate the next statement let REAUTH=null;').length) { fail++; console.log('FAIL  the checker misses a swallowed statement'); }
else console.log('PASS  the checker finds a statement swallowed by a comment');
['App1.html', 'App2.html', 'App3.html', 'App4.html'].forEach(f => {
  const hits = swallowed(fs.readFileSync(path.join(root, f), 'utf8'));
  if (hits.length) { fail++; console.log('FAIL  ' + f + ': code inside a line comment\n      ' + hits.join('\n      ')); }
  else console.log('PASS  ' + f + ': no code inside line comments');
});
console.log('\n' + (5 - fail) + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
