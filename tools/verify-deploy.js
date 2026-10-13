// Fetches the PUBLISHED web app (read-only, anonymous, like a rep's browser) and checks that Apps Script served every client
// file intact: after removing comments from both sides, the served code must equal the local code. Any other difference
// (e.g. a line cut at a "//" inside a string) is reported and the exit code is 1.
// Run: node tools/verify-deploy.js            (uses webAppUrl from tools/release.config.json)
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'release.config.json'), 'utf8'));

// Removes // and /* */ comments while respecting '...', "..." and `...` strings; normalises blank lines and trailing spaces.
function stripComments(src) {
  let out = '', q = null, block = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (block) { if (c === '*' && d === '/') { block = false; i++; } else if (c === '\n') out += c; continue; }
    if (q) { out += c; if (c === '\\') { out += d || ''; i++; } else if (c === q || (c === '\n' && q !== '`')) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
    if (c === '/' && d === '*') { block = true; i++; continue; }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  }
  return out.replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, '')).filter(Boolean);
}
function userHtml(page) {
  const k = 'goog.script.init("', start = page.indexOf(k);
  if (start < 0) throw new Error('The page does not look like an Apps Script web app (goog.script.init not found).');
  let j = start + k.length, e = j;
  while (!(page[e] === '"' && page[e - 1] !== '\\')) e++;
  const lit = page.slice(j, e).replace(/\\x([0-9a-fA-F]{2})/g, (m, h) => '\\u00' + h);
  return JSON.parse(JSON.parse('"' + lit + '"')).userHtml;
}
async function main() {
  const res = await fetch(cfg.webAppUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from the web app.');
  const served = userHtml(await res.text());
  let bad = 0;
  for (const n of ['App1', 'App2', 'App3', 'App4']) {
    const local = fs.readFileSync(path.join(root, n + '.html'), 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
    const at = served.indexOf('push("' + n + '")');
    if (at < 0) { bad++; console.log('FAIL  ' + n + ': not found in the published page'); continue; }
    const blk = served.slice(served.lastIndexOf('<script', at), served.indexOf('</script>', at)).replace(/^<script[^>]*>/, '');
    const A = stripComments(local), B = stripComments(blk);
    const k = A.findIndex((l, i) => l !== B[i]);
    if (k < 0 && A.length === B.length) { console.log('PASS  ' + n + ': published code matches the local file'); continue; }
    bad++;
    console.log('FAIL  ' + n + ': published code differs from the local file (first difference, comment-free line ' + (k + 1) + ')');
    console.log('      local : ' + String(A[k]).slice(0, 160));
    console.log('      served: ' + String(B[k]).slice(0, 160));
  }
  console.log(bad ? '\nThe published page is NOT what you pushed. Roll back (see RELEASE.md) and investigate.' : '\nThe published page is intact.');
  process.exit(bad ? 1 : 0);
}
main().catch(e => { console.log('FAIL  ' + e.message); process.exit(1); });
