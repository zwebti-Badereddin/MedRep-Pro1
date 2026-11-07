// Local tests for supervisor accounts: created by an admin, sign in on the admin screen, review reports only.
// Run: node tests/supervisor-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workplacePolicy', value: 'soft' },
    { key: 'mapKey', value: 'SECRET_MAP_KEY_1234567890' }, { key: 'reportEmail', value: 'boss@example.com' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب أول', active: true }, { id: 'REP-0002', name: 'مندوب ثانٍ', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية', active: true }],
  Products: [{ id: 'PROD-0001', name: 'Med' }],
  Reports: [
    { id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-01-02', status: 'مرسل', doctors: '[]', pharmacies: '[{"name":"صيدلية","pharmacyId":"PH-0001"}]' },
    { id: 'R2', no: 'MR-2', repId: 'REP-0002', date: '2026-01-02', status: 'مرسل', doctors: '[]', pharmacies: '[{"name":"صيدلية","pharmacyId":"PH-0001"}]' },
    { id: 'R3', no: 'MR-3', repId: 'REP-0002', date: '2026-01-03', status: 'مرسل', pharmacies: '[]',
      doctors: '[{"name":"د. سالم","doctorId":"DOC-1","workplaceId":"DWP-1","linkPending":true}]' }]
});
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const setup = () => {
  const env = makeEnv(SEED()), adm = env.session('ADM-1', 'admin');
  const sv = env.call(adm, 'supervisorSave', { name: 'المشرف سالم', username: 'Salem.S', password: 'super-secret-1' });
  return { env, adm, sv, sup: env.session(sv.id, 'supervisor') };
};
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('admin creates a supervisor: id SUP-0001, username lower-cased, password stored only as a hash', () => {
  const { env, sv } = setup();
  assert.deepStrictEqual([sv.id, sv.username, sv.active], ['SUP-0001', 'salem.s', true]);
  const row = env.rows('Supervisors')[0];
  assert.ok(row.passwordHash && row.passwordHash !== 'super-secret-1');
  assert.ok(!('passwordHash' in sv));
  assert.ok(env.rows('Audit').some(a => a.action === 'create_supervisor' && a.ref === 'SUP-0001'));
});
test('creation is validated: name, username format, username taken by an admin or a supervisor, password of 10+', () => {
  const { env, adm } = setup();
  expectError(() => env.call(adm, 'supervisorSave', { name: 'س', username: 'okname', password: 'x'.repeat(10) }), /اسم المشرف/);
  expectError(() => env.call(adm, 'supervisorSave', { name: 'سالم', username: 'a b', password: 'x'.repeat(10) }), /اسم المستخدم/);
  expectError(() => env.call(adm, 'supervisorSave', { name: 'سالم', username: 'boss', password: 'x'.repeat(10) }), /مستخدم لحساب آخر/);
  expectError(() => env.call(adm, 'supervisorSave', { name: 'سالم', username: 'salem.s', password: 'x'.repeat(10) }), /مستخدم لحساب آخر/);
  expectError(() => env.call(adm, 'supervisorSave', { name: 'سالم', username: 'other', password: 'short' }), /10 أحرف/);
});
test('a supervisor signs in on the admin screen with username + password; a wrong password is refused', () => {
  const { env } = setup();
  env.ctx.bootstrap_ = () => ({}); // the boot itself is covered elsewhere
  const r = env.ctx.login_({ role: 'admin', username: 'SALEM.S', password: 'super-secret-1' });
  assert.deepStrictEqual([r.user.id, r.user.role], ['SUP-0001', 'supervisor']);
  expectError(() => env.ctx.login_({ role: 'admin', username: 'salem.s', password: 'wrong-password' }), /بيانات الدخول غير صحيحة/);
});
test('supervisor sees every rep\'s reports and can open them and their location check', () => {
  const { env, sup } = setup();
  assert.strictEqual(JSON.stringify(env.call(sup, 'listReports', {}).map(r => r.id).sort()), '["R1","R2","R3"]');
  assert.strictEqual(env.call(sup, 'getReport', { id: 'R2' }).repId, 'REP-0002');
  assert.strictEqual(env.call(sup, 'gpsReviewSummary', { id: 'R1' }).reportId, 'R1');
});
test('supervisor approves (with the exception reason) and returns reports; the audit names the supervisor', () => {
  const { env, sup } = setup();
  expectError(() => env.call(sup, 'reviewReport', { id: 'R1', approve: true }), /سبب الاعتماد الاستثنائي/);
  assert.strictEqual(env.call(sup, 'reviewReport', { id: 'R1', approve: true, note: 'زيارة مؤكدة هاتفيًا' }).status, 'معتمد');
  assert.strictEqual(env.call(sup, 'reviewReport', { id: 'R2', approve: false, note: 'أكمل البيانات' }).status, 'معاد للمندوب');
  assert.ok(env.rows('Audit').some(a => a.action === 'approve_report' && a.userId === 'SUP-0001' && a.role === 'supervisor'));
});
test('a report with a pending doctor ↔ facility link is left to the admin (the supervisor may still return it)', () => {
  const { env, sup } = setup();
  expectError(() => env.call(sup, 'reviewReport', { id: 'R3', approve: true, note: 'سبب كافٍ للاعتماد', approveLinks: true }), /يعتمده المدير/);
  assert.strictEqual(env.rows('Reports').find(r => r.id === 'R3').status, 'مرسل');
  assert.strictEqual(env.call(sup, 'reviewReport', { id: 'R3', approve: false, note: 'راجع المنشأة' }).status, 'معاد للمندوب');
});
test('everything outside review is refused for a supervisor', () => {
  const { env, sup } = setup();
  ['repsList', 'repSave', 'saveSettings', 'exportVisits', 'performance', 'dashboard', 'supervisorsList', 'supervisorSave',
    'masterList', 'facilityAct', 'linkAct', 'list', 'save', 'audit', 'closeMonth', 'saveReport', 'submitReport', 'myReport']
    .forEach(a => expectError(() => env.call(sup, a, {}), /غير مصرح/));
});
test('supervisor boot: rep names for the filters, never the map key or the report e-mail', () => {
  const { env, sup } = setup();
  const b = env.ctx.bootstrap_(Object.assign({ token: sup }, JSON.parse(env.ctx.CacheService.getScriptCache().get('s_' + sup))));
  assert.deepStrictEqual(b.reps.map(r => r.id), ['REP-0001', 'REP-0002']);
  assert.ok(!('mapKey' in b.settings) && !('reportEmail' in b.settings));
});
test('admin disables a supervisor: the open session is refused at the next request; re-enabled with a new password', () => {
  const { env, adm, sup } = setup();
  env.call(sup, 'listReports', {}); // session checked and marked
  env.call(adm, 'supervisorSave', { id: 'SUP-0001', name: 'المشرف سالم', username: 'salem.s', active: false });
  expectError(() => env.call(sup, 'listReports', {}), /تم تعطيل حساب المشرف/);
  env.call(adm, 'supervisorSave', { id: 'SUP-0001', name: 'المشرف سالم', username: 'salem.s', active: true, password: 'new-password-22' });
  env.ctx.bootstrap_ = () => ({});
  assert.strictEqual(env.ctx.login_({ role: 'admin', username: 'salem.s', password: 'new-password-22' }).user.role, 'supervisor');
  assert.deepStrictEqual(env.call(adm, 'supervisorsList', {}).map(x => [x.id, x.active, 'passwordHash' in x]), [['SUP-0001', true, false]]);
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
