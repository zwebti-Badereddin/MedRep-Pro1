// Apps Script strips JS comments when it serves the page and can mistake a "//" inside a string (e.g. "https://...") for a
// comment, cutting the line and breaking the whole file (seen on App2: "string literal contains an unescaped line break").
// Rule: client code must never contain "//" or "/*" inside a string or template literal; write URLs as "https:\/\/...".
// Run: node tests/client-strings-tests.js
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
function slashesInStrings(src) {
  const hits = [], lines = src.replace(/\r/g, '').split('\n');
  let q = null, block = false;
  lines.forEach((line, n) => {
    for (let i = 0; i < line.length; i++) {
      const c = line[i], d = line[i + 1];
      if (block) { if (c === '*' && d === '/') { block = false; i++; } continue; }
      if (q) {
        if (c === '\\') { i++; continue; }
        if (c === '/' && (d === '/' || d === '*')) hits.push((n + 1) + ': ' + line.slice(Math.max(0, i - 40), i + 30));
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '/' && d === '*') { block = true; i++; continue; }
      if (c === '/' && d === '/') break; // a real comment: the rest of the line is ignored
    }
    if (q === '"' || q === "'") q = null; // a quote string never spans lines
  });
  return hits;
}
let fail = 0;
['App1.html', 'App2.html', 'App3.html', 'App4.html'].forEach(f => {
  const hits = slashesInStrings(fs.readFileSync(path.join(root, f), 'utf8'));
  if (hits.length) { fail++; console.log('FAIL  ' + f + ': "//" inside a string\n      ' + hits.join('\n      ')); }
  else console.log('PASS  ' + f + ': no "//" inside strings');
});
console.log('\n' + (4 - fail) + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
