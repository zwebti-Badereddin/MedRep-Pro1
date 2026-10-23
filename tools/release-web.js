// Builds the installed web app (PWA) and publishes it to Netlify, then checks the LIVE site byte for byte.
//   node tools/release-web.js --config web/config.json --site <netlify site id> [--expect-api <Apps Script /exec URL>] [--dry]
//   --dry: build and check only, nothing is published.
// Called by tools/release.js after the Apps Script release succeeded (so the page never talks to a server that lacks doPost);
// also usable on its own, e.g. for the staging site.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..'), args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
const NETLIFY_CLI = 'netlify-cli@27.14.2'; // pinned: an unpinned npx download broke once mid-install
const stop = m => { console.log('\n✖ ' + m); process.exit(1); };
const cfgPath = opt('--config') || stop('--config is required'), site = opt('--site'), dry = args.includes('--dry');
const cfg = JSON.parse(fs.readFileSync(path.join(root, cfgPath), 'utf8'));
// The production page must talk to the production server: a staging URL in the production config would send every rep to test data.
const expect = opt('--expect-api');
if (expect && cfg.api !== expect) stop(cfgPath + ' points to ' + cfg.api + '\nbut the server being released is ' + expect + '. Nothing was published.');
if (!dry && !/^[0-9a-f-]{36}$/.test(site)) stop('--site must be the Netlify site id (a UUID).');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'medrep-web-'));
process.on('exit', () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch (e) {} });
{
  console.log('▶ Building the web app from ' + cfgPath);
  const b = spawnSync(process.execPath, [path.join(__dirname, 'build-web.js'), '--config', cfgPath, '--out', out], { cwd: root, stdio: 'inherit' });
  if (b.status !== 0) stop('The web build failed. Nothing was published.');
  const version = fs.readFileSync(path.join(out, 'version.txt'), 'utf8').trim(), page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  if (dry) { console.log('✔ Web build OK (version ' + version + '); nothing published (dry run).'); process.exit(0); }

  console.log('▶ Publishing to Netlify (site ' + site + ')');
  const r = spawnSync('npx', ['--yes', NETLIFY_CLI, 'deploy', '--dir', out, '--site', site, '--prod', '--no-build', '--message', JSON.stringify('MedRep ' + version)],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  const text = (r.stdout || '') + (r.stderr || '');
  const url = (text.match(/Production URL:\s*<?(https:\/\/[^\s>]+)/) || [])[1];
  if (r.status !== 0 || !/Deploy is live/.test(text) || !url) { console.log(text.slice(-1500)); stop('Netlify deploy failed (is the CLI logged in? npx ' + NETLIFY_CLI + ' login).'); }
  console.log('  live at ' + url);

  console.log('▶ Checking the live site');
  const base = url.replace(/\/?$/, '/');
  (async () => {
    let last = '';
    for (let i = 0; i < 6; i++) { // the CDN can take a few seconds to serve the new files everywhere
      try {
        const v = (await (await fetch(base + 'version.txt', { cache: 'no-store' })).text()).trim();
        const live = await (await fetch(base, { cache: 'no-store' })).text();
        // Netlify (free plan) inserts one HTML comment after <meta charset>; anything else is a real change.
        const stripped = live.replace(/\n<!-- This site is hosted on Netlify[^]*?-->/, '');
        if (v !== version) last = 'live version ' + v + ' != built ' + version;
        else if (/\/\.netlify\/scripts\//.test(live)) last = 'Netlify injected a script (badge or toolbar): switch it off in the site settings';
        else if (stripped !== page) last = 'the live page differs from the build';
        else { console.log('✔ Web app ' + version + ' is live and identical to the build.'); process.exit(0); }
      } catch (e) { last = e.message; }
      await new Promise(res => setTimeout(res, 5000));
    }
    stop('Live check failed: ' + last);
  })();
}
