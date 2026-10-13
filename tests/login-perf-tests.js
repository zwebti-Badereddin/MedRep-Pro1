// Local tests for login speed: sheet reads per login, long-lived lookups cache and its invalidation. Run: node tests/login-perf-tests.js
'use strict';
const assert = require('assert'), vm = require('vm');
const { makeEnv } = require('./gas-harness');
const plain = x => JSON.parse(JSON.stringify(x));

const NOW = new Date().toISOString();
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workplacePolicy', value: 'soft' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب', active: true }],
  Doctors: [{ id: 'DOC-0001', name: 'أحمد سالم', specialty: 'باطنة', active: true }],
  Facilities: [{ id: 'FAC-A', name: 'مصحة الشفاء', status: 'نشط', lat: 32.9, lng: 13.2, geoState: 'مؤكد', geoSource: 'ADMIN_MAP', geoBy: 'ADM-1', geoAt: NOW, geoVersion: 1 }],
  DoctorWorkplaces: [{ id: 'DWP-00001', doctorId: 'DOC-0001', facilityId: 'FAC-A', active: true, linkState: 'معتمد' }],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية', active: true }],
  Products: [{ id: 'PROD-0001', name: 'CardioPlus', status: 'نشط' }],
  Reports: [{ id: 'R0', no: 'MR-0', repId: 'REP-0001', date: '2026-01-01', status: 'معتمد', doctors: '[]', pharmacies: '[]' }]
});
const setup = () => {
  const env = makeEnv(SEED()), T = vm.runInContext('T', env.ctx);
  env.sheets.Reps._data[1][T.Reps.indexOf('codeHash')] = env.ctx.hash_('12345');
  const login = () => { const r = env.ctx.api(null, 'login', { code: '12345' }); if (!r.ok) throw new Error(r.error); return r.data; };
  return { env, login };
};
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('first (cold) login: Reports index read ONCE for today + yesterday, Doctors read once', () => {
  const { env, login } = setup();
  env.resetReads(); const d = login();
  assert.strictEqual(d.user.id, 'REP-0001');
  assert.strictEqual(env.reads.Reports, 3);   // one reportsLight_ = 3 narrow range reads (was 6: today + yesterday)
  assert.strictEqual(env.reads.Doctors, 1);   // lookups + specialty list share one read
});
test('second login: lookups and settings come from cache, no master sheet is read', () => {
  const { env, login } = setup();
  login(); env.resetReads(); const d = login();
  assert.deepStrictEqual(['Doctors', 'Facilities', 'DoctorWorkplaces', 'Pharmacies', 'Products', 'Settings'].map(n => env.reads[n] || 0), [0, 0, 0, 0, 0, 0]);
  assert.strictEqual(d.boot.doctors[0].workplaces[0].id, 'FAC-A');
});
test('lookups and settings are cached for 6 hours (the CacheService maximum)', () => {
  const { env, login } = setup();
  login();
  assert.deepStrictEqual([env.ttl.lk2, env.ttl.st], [21600, 21600]);
});
test('an in-app change is visible at the next login despite the 6 h cache', () => {
  const { env, login } = setup();
  login();
  env.call(env.session('ADMIN', 'admin'), 'save', { entity: 'Products', row: { name: 'NeuroVit' } });
  assert.ok(login().boot.products.some(p => p.name === 'NeuroVit'));
});
test('a manual sheet edit shows after refreshAppCache (menu item)', () => {
  const { env, login } = setup(), T = vm.runInContext('T', env.ctx);
  login();
  env.sheets.Products._data.push(T.Products.map(c => ({ id: 'PROD-0009', name: 'Manual', status: 'نشط' })[c] || ''));
  assert.ok(!login().boot.products.some(p => p.name === 'Manual')); // still cached
  env.ctx.refreshAppCache();
  assert.ok(login().boot.products.some(p => p.name === 'Manual'));
});
test('the shared Reports index never leaks out of login: a save right after sees fresh rows', () => {
  const { env, login } = setup(), tok = login().token;
  const r = env.ctx.api(tok, 'saveReport', { date: env.today, doctors: [{ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: 'FAC-A', specialty: 'باطنة' }] });
  assert.ok(r.ok, r.error);
  const mine = env.ctx.api(tok, 'myReport', {});
  assert.strictEqual(mine.data.id, r.data.id);
  const again = login(); // a new login sees the report created after the previous one
  assert.strictEqual(again.report.id, r.data.id);
});

/* ---------- holidays / leaves cache ---------- */
test('second login reads neither Leaves nor Holidays (cached)', () => {
  const { env, login } = setup();
  login(); env.resetReads(); login();
  assert.deepStrictEqual([env.reads.Leaves || 0, env.reads.Holidays || 0], [0, 0]);
});
test('adding or deleting a leave / holiday through the app is visible at once', () => {
  const { env, login } = setup(), adm = env.session('ADMIN', 'admin');
  login(); // caches holidays/leaves
  env.call(adm, 'leaveSave', { row: { repId: 'REP-0001', type: 'سنوية', from: '2026-12-01', to: '2026-12-03' } });
  assert.strictEqual(env.ctx.offData_().lv['REP-0001'].length, 1);
  const hid = env.call(adm, 'holidaySave', { row: { date: '2026-12-25', name: 'عطلة' } });
  assert.strictEqual(env.ctx.offData_().hol['2026-12-25'], 'عطلة');
  env.call(adm, 'holidayDelete', { id: hid });
  assert.strictEqual(env.ctx.offData_().hol['2026-12-25'], undefined);
});

/* ---------- cache warming trigger ---------- */
const withTriggers = (env, list) => { env.ctx.ScriptApp.getProjectTriggers = () => list; };
test('warm handler refuses any caller that is not its installed trigger', () => {
  const { env } = setup();
  assert.throws(() => env.ctx.warmCachesTriggerHandler(), /مخصص للمشغّل المثبّت/);
  assert.throws(() => env.ctx.warmCachesTriggerHandler({ triggerUid: 'FAKE' }), /مخصص للمشغّل المثبّت/);
});
test('after an in-app change cleared the cache, the trigger rebuilds it so the next login is fast', () => {
  const { env, login } = setup();
  login(); env.ctx.clearCache_();
  withTriggers(env, [{ getHandlerFunction: () => 'warmCachesTriggerHandler', getUniqueId: () => 'T1' }]);
  const r = env.ctx.warmCachesTriggerHandler({ triggerUid: 'T1' });
  assert.strictEqual(r.lookupsWereCached, false);
  env.resetReads(); login();
  assert.deepStrictEqual(['Doctors', 'Facilities', 'DoctorWorkplaces', 'Products', 'Leaves'].map(n => env.reads[n] || 0), [0, 0, 0, 0, 0]);
  assert.strictEqual(env.ctx.warmCachesTriggerHandler({ triggerUid: 'T1' }).lookupsWereCached, true); // cheap when warm
});
test('installCacheWarmTrigger replaces any old trigger with one running every 10 minutes', () => {
  const { env } = setup(), made = [], deleted = [];
  const old = { getHandlerFunction: () => 'warmCachesTriggerHandler', getUniqueId: () => 'OLD' };
  env.ctx.ScriptApp.getProjectTriggers = () => [old, { getHandlerFunction: () => 'monthlyClose_', getUniqueId: () => 'M' }];
  env.ctx.ScriptApp.deleteTrigger = t => deleted.push(t.getUniqueId());
  env.ctx.ScriptApp.newTrigger = h => ({ timeBased: () => ({ everyMinutes: m => ({ create: () => { made.push([h, m]); return { getUniqueId: () => 'NEW' }; } }) }) });
  const r = env.ctx.installCacheWarmTrigger();
  assert.deepStrictEqual(plain(made), [['warmCachesTriggerHandler', 10]]);
  assert.deepStrictEqual(plain(deleted), ['OLD']);
  assert.deepStrictEqual([r.installed, r.replaced, r.triggerId], [true, 1, 'NEW']);
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
