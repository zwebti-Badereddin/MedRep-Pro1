// Local tests for the monthly English report: rep rows, product activity, English names with Arabic fallback, roles.
// Run: node tests/report-en-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workDays', value: '0,1,2,3,4,5,6' }, { key: 'companyName', value: 'شركة الأمل' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }, { id: 'REP-0002', name: 'البراء', active: true }, { id: 'REP-0003', name: 'متوقف', active: false }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Supervisors: [{ id: 'SUP-0001', username: 'salem', name: 'المشرف', active: true }],
  Doctors: [{ id: 'DOC-1', name: 'د. علي', active: true }, { id: 'DOC-2', name: 'د. منى', active: true }],
  Products: [{ id: 'PROD-0001', name: 'منتج أ', status: 'نشط' }, { id: 'PROD-0002', name: 'منتج ب', status: 'نشط' }, { id: 'PROD-0003', name: 'منتج ج', status: 'نشط' }],
  KPI: [{ key: 'visits', name: 'الزيارات', target: 10, weight: 10, active: true }],
  Reports: [
    { id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-01-05', status: 'معتمد', submittedAt: '2026-01-05T15:00:00Z', pharmacies: JSON.stringify([{ name: 'ص', product: 'منتج ب', order: '10 علب' }, { name: 'ص2', product: 'منتج ب' }]),
      doctors: JSON.stringify([{ name: 'د. علي', doctorId: 'DOC-1', intro: 'منتج أ', remind: 'منتج ب', samples: [{ product: 'منتج أ', qty: 3 }] }, { name: 'د. علي', doctorId: 'DOC-1', intro: 'منتج أ' }]) },
    { id: 'R2', no: 'MR-2', repId: 'REP-0001', date: '2026-01-06', status: 'مرسل', submittedAt: '2026-01-06T15:00:00Z', pharmacies: '[]',
      doctors: JSON.stringify([{ name: 'د منى', intro: 'منتج قديم', s1: 'منتج أ' }]) },
    { id: 'R3', no: 'MR-3', repId: 'REP-0002', date: '2026-01-06', status: 'مسودة', pharmacies: '[]', doctors: JSON.stringify([{ name: 'د. علي', doctorId: 'DOC-1', intro: 'منتج ج' }]) },
    { id: 'R4', no: 'MR-4', repId: 'REP-0002', date: '2026-02-01', status: 'معتمد', pharmacies: '[]', doctors: JSON.stringify([{ name: 'د. علي', doctorId: 'DOC-1', intro: 'منتج ج' }]) }]
});
const setup = () => { const env = makeEnv(SEED()); return { env, adm: env.session('ADM-1', 'admin'), sup: env.session('SUP-0001', 'supervisor'), rep: env.session('REP-0001', 'rep') }; };
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('rep rows: sent/approved visits of the month only, unique doctors as a count, active reps only', () => {
  const { env, adm } = setup();
  const r = env.call(adm, 'reportEn', { ym: '2026-01' });
  assert.strictEqual(r.company, 'شركة الأمل');
  assert.deepStrictEqual(r.reps.map(x => x.name), ['سارة', 'البراء']);
  const sara = r.reps[0], baraa = r.reps[1];
  assert.deepStrictEqual([sara.doctorVisits, sara.pharmacyVisits, sara.uniqueDoctors], [3, 2, 2]);
  assert.deepStrictEqual([baraa.doctorVisits, baraa.pharmacyVisits], [0, 0], 'a draft and next month\'s report do not count');
  assert.deepStrictEqual([r.totals.doctorVisits, r.totals.pharmacyVisits, r.totals.reps], [3, 2, 2]);
  assert.ok(!JSON.stringify(r).includes('د. علي'), 'no doctor names in the report');
});
test('product activity: detailing, reminders, samples (s1/s2 too), pharmacy visits and orders; unknown names kept; zeros listed', () => {
  const { env, adm } = setup();
  const p = {}; env.call(adm, 'reportEn', { ym: '2026-01' }).products.forEach(x => { p[x.name] = [x.detailing, x.reminders, x.samples, x.pharmacyVisits, x.orders]; });
  assert.deepStrictEqual(p['منتج أ'], [2, 0, 4, 0, 0]);
  assert.deepStrictEqual(p['منتج ب'], [0, 1, 0, 2, 1]);
  assert.deepStrictEqual(p['منتج ج'], [0, 0, 0, 0, 0]);
  assert.deepStrictEqual(p['منتج قديم'], [1, 0, 0, 0, 0]);
});
test('English names are saved once and used; a missing one falls back to Arabic; unknown ids are dropped', () => {
  const { env, adm } = setup();
  const r = env.call(adm, 'reportEn', { ym: '2026-01', names: { companyNameEn: '  Al Amal   Pharma ', reps: { 'REP-0001': 'Sara', 'REP-9': 'Ghost' }, products: { 'PROD-0001': 'Product A' } } });
  assert.strictEqual(r.company, 'Al Amal Pharma');
  assert.deepStrictEqual(r.reps.map(x => x.name), ['Sara', 'البراء']);
  assert.ok(r.products.some(x => x.name === 'Product A') && r.products.some(x => x.name === 'منتج ب'));
  const setup2 = env.call(adm, 'reportEnSetup', {});
  assert.strictEqual(setup2.companyNameEn, 'Al Amal Pharma');
  assert.strictEqual(setup2.reps.find(x => x.id === 'REP-0001').en, 'Sara');
  assert.ok(!env.rows('Settings').find(x => x.key === 'repsEn').value.includes('Ghost'));
});
test('month checks and roles: no future month; admin only', () => {
  const { env, adm, sup, rep } = setup();
  expectError(() => env.call(adm, 'reportEn', { ym: '2999-01' }), /لم يبدأ بعد/);
  expectError(() => env.call(sup, 'reportEn', { ym: '2026-01' }), /غير مصرح/);
  expectError(() => env.call(rep, 'reportEnSetup', {}), /غير مصرح/);
});
test('plan coverage column: null without a list, % with an approved list', () => {
  const { env, adm } = setup();
  assert.strictEqual(env.call(adm, 'reportEn', { ym: '2026-01' }).reps[0].coverage, null);
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-1', cls: 'A' });
  assert.strictEqual(env.call(adm, 'reportEn', { ym: '2026-01' }).reps[0].coverage, 50); // 2 visits of 4
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
