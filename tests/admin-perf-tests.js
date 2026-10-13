// Local tests for admin request speed: admin account check cached 5 min, rep names cached, both invalidated on change.
// Run: node tests/admin-perf-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }],
  Admins: [{ id: 'ADM-0001', username: 'boss', name: 'المدير', active: true }, { id: 'ADM-0002', username: 'second', name: 'نائب', active: true }],
  Reps: [{ id: 'REP-0001', name: 'مندوب أول', active: true }],
  Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-10-01', status: 'مرسل', doctors: '[{"name":"a"},{"name":"b"}]', pharmacies: '[]' }]
});
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('listReports: correct rows; the second call reads neither Admins nor Reps', () => {
  const env = makeEnv(SEED()), adm = env.session('ADM-0001', 'admin');
  const a = env.call(adm, 'listReports', {});
  assert.deepStrictEqual([a.length, a[0].repName, a[0].visits], [1, 'مندوب أول', 2]);
  env.resetReads(); env.call(adm, 'listReports', {});
  assert.deepStrictEqual([env.reads.Admins || 0, env.reads.Reps || 0], [0, 0]);
});
test('a disabled administrator is refused at his very next request (cache dropped on disable)', () => {
  const env = makeEnv(SEED()), adm = env.session('ADM-0002', 'admin');
  env.call(adm, 'listReports', {}); // account check now cached
  env.ctx.SpreadsheetApp.getUi = () => ({
    Button: { OK: 'OK', YES: 'YES' }, ButtonSet: { OK_CANCEL: 1, YES_NO: 2 },
    prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => 'second' }), alert: () => 'YES' });
  env.ctx.setAdminAccountActive();
  assert.throws(() => env.call(adm, 'listReports', {}), /تم تعطيل حساب الإدارة/);
});
test('a renamed rep shows with the new name at once (rep names cache cleared by the save)', () => {
  const env = makeEnv(SEED()), adm = env.session('ADM-0001', 'admin');
  env.call(adm, 'listReports', {});
  env.call(adm, 'repSave', { row: { id: 'REP-0001', name: 'مندوب معدّل' } });
  assert.strictEqual(env.call(adm, 'listReports', {})[0].repName, 'مندوب معدّل');
});
test('legacy administrator (no ADM- id) still works without any Admins read', () => {
  const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin');
  env.resetReads(); env.call(adm, 'listReports', {});
  assert.strictEqual(env.reads.Admins || 0, 0);
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
