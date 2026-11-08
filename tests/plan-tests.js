// Local tests for the visit plan: rep proposals, admin approval, coverage (capped per doctor, leaves, drafts), import, KPI, roles.
// Run: node tests/plan-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const J = x => JSON.parse(JSON.stringify(x));
const today = new Date().toISOString().slice(0, 10);
const docVisits = (ids) => JSON.stringify(ids.map(id => (typeof id === 'string' ? { name: 'x', doctorId: id } : id)));
const SEED = (extra) => Object.assign({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workDays', value: '0,1,2,3,4,5,6' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }, { id: 'REP-0002', name: 'البراء', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Supervisors: [{ id: 'SUP-0001', username: 'salem', name: 'المشرف', active: true }],
  Doctors: [{ id: 'DOC-1', name: 'د. علي التومي', active: true }, { id: 'DOC-2', name: 'د. منى سالم', active: true }, { id: 'DOC-3', name: 'د. خالد', active: true },
    { id: 'DOC-9', name: 'د. متوقف', active: false }],
  KPI: [{ key: 'visits', name: 'الزيارات', target: 100, weight: 10, active: true }],
  Reports: []
}, extra || {});
const setup = (extra) => {
  const env = makeEnv(SEED(extra));
  return { env, rep: env.session('REP-0001', 'rep'), rep2: env.session('REP-0002', 'rep'), adm: env.session('ADM-1', 'admin'), sup: env.session('SUP-0001', 'supervisor') };
};
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const rowOf = (env, rep, doc) => env.rows('RepDoctors').find(r => r.repId === rep && r.doctorId === doc && String(r.active) !== 'false');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('rep proposes a class: the row waits for approval and counts nothing yet', () => {
  const { env, rep } = setup();
  const out = env.call(rep, 'planPropose', { doctorId: 'DOC-1', cls: 'A' });
  const d = out.coverage.doctors[0];
  assert.deepStrictEqual([d.doctorId, d.cls, d.pendingCls, d.req], ['DOC-1', '', 'A', 0]);
  assert.strictEqual(out.coverage.pct, null);
  assert.strictEqual(out.coverage.pending, 1);
  expectError(() => env.call(rep, 'planPropose', { doctorId: 'DOC-1', cls: 'D' }), /A أو B أو C/);
  expectError(() => env.call(rep, 'planPropose', { doctorId: 'DOC-9', cls: 'A' }), /غير موجود/);
});
test('admin approves; the rep sees this month\'s progress including today\'s draft', () => {
  const { env, rep, adm } = setup({ Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: today, status: 'مسودة', doctors: docVisits(['DOC-1']), pharmacies: '[]' }] });
  env.call(rep, 'planPropose', { doctorId: 'DOC-1', cls: 'A' });
  const id = rowOf(env, 'REP-0001', 'DOC-1').id;
  assert.strictEqual(env.call(adm, 'planAct', { op: 'approve', ids: [id] }), 1);
  const cov = env.call(rep, 'myPlan', {}).coverage;
  assert.deepStrictEqual([cov.doctors[0].cls, cov.doctors[0].pendingCls, cov.doctors[0].visits, cov.doctors[0].req], ['A', '', 1, 4]);
  assert.strictEqual(cov.pct, 25);
  assert.ok(env.rows('Audit').some(a => a.action === 'plan_approve'));
});
test('coverage is capped per doctor: extra visits to one doctor do not cover another; never-visited is counted', () => {
  const { env, adm } = setup({ Reports: [
    { id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-01-05', status: 'مرسل', doctors: docVisits(['DOC-1', 'DOC-1', 'DOC-1']), pharmacies: '[]' },
    { id: 'R2', no: 'MR-2', repId: 'REP-0001', date: '2026-01-06', status: 'معتمد', doctors: docVisits(['DOC-1', 'DOC-1', 'DOC-1']), pharmacies: '[]' },
    { id: 'R3', no: 'MR-3', repId: 'REP-0001', date: '2026-01-07', status: 'مسودة', doctors: docVisits(['DOC-2']), pharmacies: '[]' }] });
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-1', cls: 'A' });
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-2', cls: 'B' });
  const c = env.call(adm, 'planCoverage', { from: '2026-01-01', to: '2026-01-31' }).reps[0];
  assert.deepStrictEqual([c.req, c.done, c.pct, c.never], [6, 4, 67, 1], 'the draft visit to DOC-2 does not count for the admin');
  assert.deepStrictEqual([c.cls.A.req, c.cls.A.done, c.cls.B.req, c.cls.B.done], [4, 4, 2, 0]);
  assert.strictEqual(c.doctors[0].doctorId, 'DOC-2', 'not visited first');
});
test('leave lowers the target in proportion to available work days (rounded up)', () => {
  const { env, adm } = setup({ Leaves: [{ id: 'LV-0001', repId: 'REP-0001', from: '2026-01-01', to: '2026-01-15', type: 'سنوية' }] });
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-1', cls: 'A' });
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-3', cls: 'C' });
  const c = env.call(adm, 'planCoverage', { from: '2026-01-01', to: '2026-01-31' }).reps[0];
  assert.strictEqual(c.months, 0.52); // 16 of 31 days
  assert.deepStrictEqual([c.cls.A.req, c.cls.C.req], [3, 1]);
  const two = env.call(adm, 'planCoverage', { from: '2026-02-01', to: '2026-03-31' }).reps[0];
  assert.deepStrictEqual([two.months, two.cls.A.req], [2, 8]);
});
test('visits without a doctor id match by the doctor\'s name', () => {
  const { env, adm } = setup({ Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-01-05', status: 'مرسل', doctors: JSON.stringify([{ name: 'د علي التومي' }]), pharmacies: '[]' }] });
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-1', cls: 'C' });
  assert.strictEqual(env.call(adm, 'planCoverage', { from: '2026-01-01', to: '2026-01-31' }).reps[0].pct, 100);
});
test('a class change waits while the approved class still counts; reject keeps the old class, reject of a new doctor removes it', () => {
  const { env, rep, adm } = setup();
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-1', cls: 'A' });
  env.call(rep, 'planPropose', { doctorId: 'DOC-1', cls: 'C' });
  let r = rowOf(env, 'REP-0001', 'DOC-1');
  assert.deepStrictEqual([r.cls, r.pendingCls], ['A', 'C']);
  env.call(adm, 'planAct', { op: 'reject', ids: [r.id] });
  r = rowOf(env, 'REP-0001', 'DOC-1');
  assert.deepStrictEqual([r.cls, r.pendingCls], ['A', '']);
  env.call(rep, 'planPropose', { doctorId: 'DOC-2', cls: 'B' });
  env.call(adm, 'planAct', { op: 'reject', ids: [rowOf(env, 'REP-0001', 'DOC-2').id] });
  assert.strictEqual(rowOf(env, 'REP-0001', 'DOC-2'), undefined);
});
test('approve with another class, approve-all, set and remove', () => {
  const { env, rep, adm } = setup();
  env.call(rep, 'planPropose', { doctorId: 'DOC-1', cls: 'A' }); env.call(rep, 'planPropose', { doctorId: 'DOC-2', cls: 'A' });
  const ids = env.rows('RepDoctors').map(r => r.id);
  env.call(adm, 'planAct', { op: 'approve', ids: [ids[0]], cls: 'B' });
  assert.strictEqual(rowOf(env, 'REP-0001', 'DOC-1').cls, 'B');
  env.call(adm, 'planAct', { op: 'approve', ids: ids }); // DOC-1 has nothing pending any more: unchanged
  assert.deepStrictEqual([rowOf(env, 'REP-0001', 'DOC-1').cls, rowOf(env, 'REP-0001', 'DOC-2').cls], ['B', 'A']);
  env.call(adm, 'planAct', { op: 'set', ids: [ids[1]], cls: 'C' });
  assert.strictEqual(rowOf(env, 'REP-0001', 'DOC-2').cls, 'C');
  env.call(adm, 'planAct', { op: 'remove', ids: [ids[1]] });
  assert.strictEqual(rowOf(env, 'REP-0001', 'DOC-2'), undefined);
});
test('one doctor on two reps\' lists with different classes', () => {
  const { env, adm } = setup();
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-1', cls: 'A' });
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0002', doctorId: 'DOC-1', cls: 'C' });
  const reps = env.call(adm, 'planCoverage', { from: '2026-01-01', to: '2026-01-31' }).reps;
  assert.deepStrictEqual(J(reps.map(r => [r.repId, r.req])), [['REP-0001', 4], ['REP-0002', 1]]);
});
test('roles: the rep withdraws only own pending rows; the supervisor sees lists and coverage but cannot change them', () => {
  const { env, rep, rep2, adm, sup } = setup();
  env.call(rep, 'planPropose', { doctorId: 'DOC-1', cls: 'A' });
  const id = rowOf(env, 'REP-0001', 'DOC-1').id;
  expectError(() => env.call(rep2, 'planWithdraw', { id }), /لا يوجد طلب/);
  expectError(() => env.call(rep, 'planAct', { op: 'approve', ids: [id] }), /غير مصرح/);
  expectError(() => env.call(sup, 'planAct', { op: 'approve', ids: [id] }), /غير مصرح/);
  assert.strictEqual(env.call(sup, 'planList', {}).rows.length, 1);
  assert.ok(Array.isArray(env.call(sup, 'planCoverage', {}).reps));
  expectError(() => env.call(rep, 'planCoverage', {}), /غير مصرح/);
  env.call(rep, 'planWithdraw', { id });
  assert.strictEqual(rowOf(env, 'REP-0001', 'DOC-1'), undefined);
  assert.ok(adm);
});
test('import from Excel: preview, then add approved rows; names, ids and أ/ب/ج are accepted', () => {
  const { env, adm } = setup();
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-3', cls: 'C' });
  const rows = [['المندوب', 'الطبيب', 'الفئة'], ['سارة', 'د. علي التومي', 'أ'], ['REP-0002', 'DOC-2', 'b'], ['سارة', 'د. خالد', 'C'],
    ['مجهول', 'د. علي التومي', 'A'], ['سارة', 'د. غير موجود', 'A'], ['سارة', 'د. منى سالم', 'X'], ['سارة', 'د. علي التومي', 'B']];
  const pre = env.call(adm, 'planImport', { rows });
  assert.deepStrictEqual([pre.add.length, pre.dup.length, pre.invalid.length], [2, 2, 3]);
  assert.strictEqual(env.rows('RepDoctors').length, 1, 'preview writes nothing');
  const out = env.call(adm, 'planImport', { rows, commit: true });
  assert.strictEqual(out.added, 2);
  assert.deepStrictEqual([rowOf(env, 'REP-0001', 'DOC-1').cls, rowOf(env, 'REP-0002', 'DOC-2').cls], ['A', 'B']);
});
test('KPI: «تغطية خطة الزيارات» is added once with weight 0 and its actual is the coverage %', () => {
  const { env, adm } = setup({ Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-01-05', status: 'مرسل', doctors: docVisits(['DOC-1', 'DOC-1']), pharmacies: '[]' }] });
  env.call(adm, 'kpiList', {}); env.call(adm, 'kpiList', {});
  const k = env.rows('KPI').filter(x => x.key === 'plan_cov');
  assert.strictEqual(k.length, 1); assert.strictEqual(+k[0].weight, 0);
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-1', cls: 'A' });
  const perf = env.call(adm, 'performance', { from: '2026-01-01', to: '2026-01-31' });
  const sara = perf.find(r => r.repId === 'REP-0001'), cov = sara.kpis.find(x => x.key === 'plan_cov');
  assert.deepStrictEqual([cov.actual, cov.target, cov.achievement, cov.weighted], [50, 100, 50, 0]);
  assert.strictEqual(perf.find(r => r.repId === 'REP-0002').kpis.find(x => x.key === 'plan_cov').actual, 0);
});
test('visits per class are set in the plan settings (0–31) and change the targets', () => {
  const { env, adm } = setup();
  expectError(() => env.call(adm, 'planSaveFreq', { freq: { A: 40, B: 2, C: 1 } }), /بين 0 و31/);
  assert.strictEqual(JSON.stringify(env.call(adm, 'planSaveFreq', { freq: { A: 6, B: 3, C: 1 } })), '{"A":6,"B":3,"C":1}');
  env.call(adm, 'planAct', { op: 'add', repId: 'REP-0001', doctorId: 'DOC-1', cls: 'A' });
  assert.strictEqual(env.call(adm, 'planCoverage', { from: '2026-01-01', to: '2026-01-31' }).reps[0].req, 6);
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
