// MedRep Pro release: one command, fixed order, refuses to continue on any failed check.
//   node tools/release.js                 checks only (dry run): target project, clean git, all tests, files clasp would push
//   node tools/release.js --deploy        checks, then clasp push, new version, update the EXISTING deployment, verify the page
//   node tools/release.js --rollback N    point the existing deployment back to version N (nothing is pushed)
// See RELEASE.md.
'use strict';
const fs = require('fs'), path = require('path'), { execSync, spawnSync } = require('child_process');
const root = path.join(__dirname, '..'), cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'release.config.json'), 'utf8'));
const args = process.argv.slice(2), deploy = args.includes('--deploy'), rbAt = args.indexOf('--rollback');
const sh = cmd => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
const run = (cmd, a) => { const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }); return r.status === 0; };
const q = v => (process.platform === 'win32' ? '"' + v + '"' : v); // spawn with shell on Windows needs quotes
const stop = msg => { console.log('\n✖ ' + msg + '\nNothing was published.'); process.exit(1); };
const step = msg => console.log('\n▶ ' + msg);

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

if (!deploy) { console.log('\n✔ Dry run passed. To publish: node tools/release.js --deploy'); process.exit(0); }

// 5. Push, version, update the existing deployment (same URL for the reps), tag, verify.
const label = 'MedRep ' + new Date().toISOString().slice(0, 10) + ' ' + commit;
step('clasp push');
if (!run('clasp', ['push'])) stop('clasp push failed.');
step('New version "' + label + '"');
let out;
try { out = sh('clasp create-version "' + label + '"'); console.log('  ' + out); } catch (e) { stop('clasp create-version failed: ' + e.message); }
const m = out.match(/(\d+)/); if (!m) stop('Could not read the new version number from: ' + out);
const version = m[1];
step('Updating deployment to version ' + version);
if (!run('clasp', ['update-deployment', cfg.deploymentId, '-V', version, '-d', q(label)])) stop('clasp update-deployment failed. The code is pushed but NOT published; the reps still use the previous version.');
try { sh('git tag -a release-v' + version + ' -m "' + label + '"'); console.log('  git tag release-v' + version); } catch (e) { console.log('  (git tag skipped: ' + e.message.split('\n')[0] + ')'); }
step('Verifying the published page');
if (!run(process.execPath, [path.join(__dirname, 'verify-deploy.js')])) {
  console.log('\n✖ The published page differs from the pushed code. Roll back now: node tools/release.js --rollback <previous version>');
  process.exit(1);
}
console.log('\n✔ Published version ' + version + ' (' + label + ').');
