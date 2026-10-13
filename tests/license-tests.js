// Local tests for the license period (warning, grace, then no new reports; reading stays). Run: node tests/license-tests.js
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { makeEnv } = require('./gas-harness');

const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workplacePolicy', value: 'soft' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية', active: true }],
  Products: [{ id: 'PROD-0001', name: 'Med' }],
  Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-01-02', status: 'مرسل', doctors: '[]', pharmacies: '[]' }]
});
const shift = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const setup = (until, extra) => {
  const env = makeEnv(SEED());
  if (until !== undefined) env.props.set('LICENSE_UNTIL', until);
  Object.keys(extra || {}).forEach(k => env.props.set(k, extra[k]));
  return { env, rep: env.session('REP-0001', 'rep'), adm: env.session('ADM-1', 'admin') };
};
const phVisit = { name: 'صيدلية', pharmacyId: 'PH-0001', time: 'صباحًا', product: 'Med' };
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('state: none / ok / warn (14 days) / grace (3 days) / expired; invalid date; custom warn and grace', () => {
  const st = makeEnv(SEED()).ctx.licenseState_, d = '2027-01-31';
  assert.strictEqual(st('', d).state, 'none');
  assert.strictEqual(st('31/01/2027', d).state, 'invalid');
  assert.strictEqual(st(d, shift(d, -15)).state, 'ok');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(st(d, shift(d, -14)))), { state: 'warn', until: d, days: 14, graceEnd: '2027-02-03' });
  assert.strictEqual(st(d, d).state, 'warn');
  assert.strictEqual(st(d, shift(d, 3)).state, 'grace');
  assert.strictEqual(st(d, shift(d, 4)).state, 'expired');
  assert.strictEqual(st(d, shift(d, -20), '30', '0').state, 'warn');
  assert.strictEqual(st(d, shift(d, 1), '', '0').state, 'expired');
});
test('no LICENSE_UNTIL: the app behaves as before and the boot carries no license', () => {
  const { env, rep, adm } = setup();
  env.call(rep, 'saveReport', { date: env.today, pharmacies: [phVisit] });
  assert.strictEqual(env.call(rep, 'bootstrap').license, null);
  assert.strictEqual(env.call(adm, 'bootstrap').license, null);
});
test('expired: every rep write is refused with the renewal message; nothing is written', () => {
  const { env, rep } = setup(shift(makeEnv(SEED()).today, -10)), before = env.snapshot();
  ['saveReport', 'submitReport', 'reopenReport', 'proposeFacility', 'requestDoctorLink', 'addDoctor', 'addPharmacy', 'addSpecialty'].forEach(a =>
    expectError(() => env.call(rep, a, { date: env.today, id: 'R1', name: 'اسم جديد', pharmacies: [phVisit] }), /انتهى ترخيص النظام/));
  assert.strictEqual(env.snapshot(), before);
});
test('expired: login data, own reports, admin lists, review and dashboard still work', () => {
  const { env, rep, adm } = setup(shift(makeEnv(SEED()).today, -10));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(env.call(rep, 'bootstrap').license)), { state: 'expired' });
  const a = env.call(adm, 'bootstrap').license; assert.strictEqual(a.state, 'expired'); assert.ok(a.until && a.graceEnd);
  env.call(rep, 'myReport', {}); env.call(rep, 'myReports', {});
  assert.strictEqual(env.call(adm, 'listReports', { from: '2026-01-01', to: '2026-01-31' }).length, 1);
  env.call(adm, 'getReport', { id: 'R1' });
  env.call(adm, 'reviewReport', { id: 'R1', approve: true, note: 'سبب الاعتماد الاستثنائي' });
  assert.strictEqual(env.rows('Reports')[0].status, 'معتمد');
});
test('grace period: work continues; the rep is not told, the admin is', () => {
  const { env, rep, adm } = setup(shift(makeEnv(SEED()).today, -2));
  env.call(rep, 'saveReport', { date: env.today, pharmacies: [phVisit] });
  assert.strictEqual(env.call(rep, 'bootstrap').license, null);
  assert.strictEqual(env.call(adm, 'bootstrap').license.state, 'grace');
});
test('renewal: a new LICENSE_UNTIL applies after refreshAppCache (cache cleared)', () => {
  const { env, rep } = setup(shift(makeEnv(SEED()).today, -10));
  expectError(() => env.call(rep, 'saveReport', { date: env.today, pharmacies: [phVisit] }), /انتهى ترخيص/);
  env.props.set('LICENSE_UNTIL', shift(env.today, 365));
  expectError(() => env.call(rep, 'saveReport', { date: env.today, pharmacies: [phVisit] }), /انتهى ترخيص/); // still cached
  env.ctx.clearCache_();
  env.call(rep, 'saveReport', { date: env.today, pharmacies: [phVisit] });
});

// Client: the notice text per state, and the rep screen is read-only when expired.
const app1 = fs.readFileSync(path.join(__dirname, '..', 'App1.html'), 'utf8');
const client = (() => {
  const escLine = app1.split('\n').find(l => l.includes(',esc=t=>'));
  const m = app1.match(/const licOff=[\s\S]*?\r?\n\}/); assert.ok(m, 'licOff..licNotice block');
  const c = vm.createContext({ CFG: {}, S: null });
  vm.runInContext('const ' + escLine.slice(escLine.indexOf('esc=t=>')).replace(/;\s*$/, '') + ';\n' + m[0] + '\n;this.api={licOff,locked,licNotice}', c);
  return { api: c.api, set: (lic, s) => { c.CFG.lic = lic; vm.runInContext('S=' + JSON.stringify(s), c); } };
})();
test('client notice: warn (amber, days), grace (red, end of grace), expired admin vs rep, none', () => {
  const { api, set } = client;
  set({ state: 'warn', until: '2027-01-31', days: 10, graceEnd: '2027-02-03' }, null);
  let h = api.licNotice(); assert.ok(h.includes('31/01/2027') && h.includes('بعد 10 يوم') && !h.includes(' stop'));
  set({ state: 'grace', until: '2027-01-31', days: -1, graceEnd: '2027-02-03' }, null);
  h = api.licNotice(); assert.ok(h.includes('03/02/2027') && h.includes('notice stop'));
  set({ state: 'expired', until: '2027-01-31' }, null); assert.ok(api.licNotice().includes('عرض التقارير السابقة وتصديرها'));
  set({ state: 'expired' }, null); assert.ok(api.licNotice().includes('راجع الإدارة'));
  set(null, null); assert.strictEqual(api.licNotice(), '');
});
test('client lock: a draft is editable normally and read-only once the license expired', () => {
  const { api, set } = client;
  set(null, { status: 'مسودة' }); assert.strictEqual(api.locked(), false);
  set({ state: 'grace' }, { status: 'مسودة' }); assert.strictEqual(api.locked(), false);
  set({ state: 'expired' }, { status: 'مسودة' }); assert.strictEqual(api.locked(), true);
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
