// MedRep Pro release: one command, fixed order, refuses to continue on any failed check.
//   node tools/release.js                 checks only (dry run): target project, clean git, all tests, files clasp would push
//   node tools/release.js --deploy        checks, then clasp push, new version, update the EXISTING deployment, verify the page
//   node tools/release.js --rollback N    point the existing deployment back to version N (nothing is pushed)
//   node tools/release.js --check-version N   read-only: compare the files stored in version N with the local files
// See RELEASE.md.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), { execSync, spawnSync } = require('child_process');
const root = path.join(__dirname, '..'), cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'release.config.json'), 'utf8'));
const args = process.argv.slice(2), deploy = args.includes('--deploy'), rbAt = args.indexOf('--rollback');
const sh = cmd => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
// clasp is a .cmd shim on Windows and needs a shell; node is run directly (its path may contain spaces, e.g. C:\Program Files).
const run = (cmd, a) => { const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'clasp' }); return r.status === 0; };
const q = v => (process.platform === 'win32' ? '"' + v + '"' : v); // spawn with shell on Windows needs quotes
const stop = msg => { console.log('\n✖ ' + msg + '\nNothing was published.'); process.exit(1); };
const step = msg => console.log('\n▶ ' + msg);
const win = process.platform === 'win32';
// Like run(), but also returns what the command printed (clasp exits 0 even when it decides not to push).
const runOut = (cmd, a, cwd) => { const r = spawnSync(cmd, a, { cwd: cwd || root, encoding: 'utf8', shell: win && cmd === 'clasp' }); const text = (r.stdout || '') + (r.stderr || ''); process.stdout.write(text); return { ok: r.status === 0, text: text }; };

// The files Apps Script stores in a version, compared with the local files clasp pushes (top-level .js/.html/.json,
// as .claspignore keeps tests/, tools/ and *.md out). Text is compared without CR and trailing blanks; JSON by value,
// because the online editor may reorder the manifest keys.
function versionMismatches_(version) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'medrep-v' + version + '-'));
  try {
    fs.writeFileSync(path.join(tmp, '.clasp.json'), JSON.stringify({ scriptId: cfg.scriptId, rootDir: '', scriptExtensions: clasp.scriptExtensions || ['.js', '.gs'],
      htmlExtensions: clasp.htmlExtensions || ['.html'], jsonExtensions: clasp.jsonExtensions || ['.json'] }));
    const pulled = runOut('clasp', ['pull', '--versionNumber', String(version)], tmp);
    if (!pulled.ok) return ['clasp pull of version ' + version + ' failed'];
    const list = dir => fs.readdirSync(dir).filter(f => /\.(js|html|json)$/.test(f) && f[0] !== '.' && fs.statSync(path.join(dir, f)).isFile()).sort();
    const norm = (f, s) => { if (/\.json$/.test(f)) { const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => (o[k] = sortKeys(v[k]), o), {}) : v; try { return JSON.stringify(sortKeys(JSON.parse(s))); } catch (e) {} } return s.replace(/\r\n/g, '\n').replace(/\s+$/, ''); };
    const local = list(root), remote = list(tmp), bad = [];
    local.filter(f => remote.indexOf(f) < 0).forEach(f => bad.push(f + ': missing in version ' + version));
    remote.filter(f => local.indexOf(f) < 0).forEach(f => bad.push(f + ': in version ' + version + ' but not local'));
    local.filter(f => remote.indexOf(f) >= 0).forEach(f => { if (norm(f, fs.readFileSync(path.join(root, f), 'utf8')) !== norm(f, fs.readFileSync(path.join(tmp, f), 'utf8'))) bad.push(f + ': content differs'); });
    if (!bad.length) console.log('  all ' + local.length + ' files in version ' + version + ' match the local files');
    return bad;
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
}

// 1. Target: .clasp.json must point to the production project recorded in release.config.json.
step('Target project');
const clasp = JSON.parse(fs.readFileSync(path.join(root, '.clasp.json'), 'utf8'));
if (clasp.scriptId !== cfg.scriptId) stop('.clasp.json points to ' + clasp.scriptId + ' but the production project is ' + cfg.scriptId + '.');
console.log('  scriptId ' + cfg.scriptId + '\n  deployment ' + cfg.deploymentId);

if (rbAt >= 0) { // ---- rollback: no push, just move the deployment to an older version
  const v = Number(args[rbAt + 1]);
  if (!Number.isInteger(v) || v < 1) stop('Give the version number to roll back to, e.g. --rollback 4 (list them with: clasp list-versions).');
  step('Rolling the deployment back to version ' + v);
  if (!run('clasp', ['update-deployment', cfg.deploymentId, '-V', String(v), '-d', q('rollback to v' + v)])) stop('clasp update-deployment failed.');
  console.log('\n✔ The web app now serves version ' + v + '. Data is unchanged.');
  process.exit(0);
}
const cvAt = args.indexOf('--check-version');
if (cvAt >= 0) { // ---- read-only: does version N contain exactly the local files?
  const v = Number(args[cvAt + 1]);
  if (!Number.isInteger(v) || v < 1) stop('Give the version number to check, e.g. --check-version 46.');
  step('Comparing version ' + v + ' with the local files');
  const bad = versionMismatches_(v);
  if (bad.length) { console.log('\n✖ Version ' + v + ' differs from the local files:\n  ' + bad.join('\n  ')); process.exit(1); }
  console.log('\n✔ Version ' + v + ' matches the local files.'); process.exit(0);
}

// 2. Git: what is published must be an exact commit.
step('Git state');
const dirty = sh('git status --porcelain');
if (dirty) stop('Uncommitted changes:\n' + dirty + '\nCommit them first, so the published code is an exact commit.');
const branch = sh('git rev-parse --abbrev-ref HEAD'), commit = sh('git rev-parse --short HEAD');
if (cfg.releaseBranch && branch !== cfg.releaseBranch) stop('Releases are made from "' + cfg.releaseBranch + '" but you are on "' + branch + '".');
console.log('  branch ' + branch + ', commit ' + commit);

// 3. Every local check.
step('Tests and syntax');
if (!run(process.execPath, [path.join(root, 'tests', 'run-all.js')])) stop('A check failed.');

// 4. What would be pushed.
step('Files clasp will push');
if (!run('clasp', ['show-file-status'])) stop('clasp show-file-status failed (is clasp logged in?).');

// 4b. The installed web app (Netlify) builds from these same files; its config must point to THIS server.
const web = cfg.web && cfg.web.config ? cfg.web : null;
const webArgs = web ? [path.join(__dirname, 'release-web.js'), '--config', web.config, '--expect-api', cfg.webAppUrl] : [];
if (web) { step('Installed web app (build check)'); if (!run(process.execPath, webArgs.concat('--dry'))) stop('The installed web app does not build for this server.'); }

if (!deploy) { console.log('\n✔ Dry run passed. To publish: node tools/release.js --deploy'); process.exit(0); }

// 5. Push, version, update the existing deployment (same URL for the reps), tag, verify.
const label = 'MedRep ' + new Date().toISOString().slice(0, 10) + ' ' + commit;
step('clasp push');
const pushed = runOut('clasp', ['push']);
if (!pushed.ok) stop('clasp push failed.');
// clasp asks before overwriting a manifest that differs from the project's and, with no one to answer, skips the push
// while still exiting 0. This silently published old code in versions 42-45.
if (/Skipping push/i.test(pushed.text)) stop('clasp skipped the push: it wanted to overwrite appsscript.json and got no answer. The manifest was most ' +
  'likely reordered by opening the project in the online editor. Check that nothing was edited online (clone the project into an empty folder ' +
  'and compare), then run "clasp push --force" and release again.');
step('New version "' + label + '"');
let out;
try { out = sh('clasp create-version "' + label + '"'); console.log('  ' + out); } catch (e) { stop('clasp create-version failed: ' + e.message); }
const m = out.match(/(\d+)/); if (!m) stop('Could not read the new version number from: ' + out);
const version = m[1];
// The page check below only sees the four client files; this compares every file (server code included) BEFORE the reps get it.
step('Checking the content of version ' + version);
const badFiles = versionMismatches_(version);
if (badFiles.length) stop('Version ' + version + ' does not contain the committed code:\n  ' + badFiles.join('\n  ') + '\nThe deployment was NOT updated; the reps still use the previous version.');
step('Updating deployment to version ' + version);
if (!run('clasp', ['update-deployment', cfg.deploymentId, '-V', version, '-d', q(label)])) stop('clasp update-deployment failed. The code is pushed but NOT published; the reps still use the previous version.');
try { sh('git tag -a release-v' + version + ' -m "' + label + '"'); console.log('  git tag release-v' + version); } catch (e) { console.log('  (git tag skipped: ' + e.message.split('\n')[0] + ')'); }
step('Verifying the published page');
if (!run(process.execPath, [path.join(__dirname, 'verify-deploy.js')])) {
  console.log('\n✖ The published page differs from the pushed code. Roll back now: node tools/release.js --rollback <previous version>');
  process.exit(1);
}
// 6. Only now the installed web app: it calls doPost, which this Apps Script version has. If it fails, Apps Script stays
// published and the phones keep the previous web app, which still works against it.
if (web && web.netlifySiteId) {
  step('Publishing the installed web app');
  if (!run(process.execPath, webArgs.concat('--site', web.netlifySiteId))) {
    console.log('\n✖ Apps Script version ' + version + ' is live, but the installed web app was NOT updated (phones keep the previous one, which still works).' +
      '\n  Fix the cause, then publish it alone: node tools/release-web.js --config ' + web.config + ' --site ' + web.netlifySiteId + ' --expect-api ' + cfg.webAppUrl);
    process.exit(1);
  }
} else console.log('\n  (installed web app: not set up yet, skipped; set web.netlifySiteId in tools/release.config.json)');
console.log('\n✔ Published version ' + version + ' (' + label + ').');
