// Local tests for doctor work schedules: several facilities on one day, edits keep history, «غير متواجد اليوم», the warning
// in daily plans, merge, and validation.
// Run: node tests/schedule-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const J = x => JSON.stringify(x);
const today = new Date().toISOString().slice(0, 10), wd = new Date(Date.parse(today + 'T12:00:00Z')).getUTCDay(), other = (wd + 1) % 7;
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Supervisors: [{ id: 'SUP-0001', username: 'salem', name: 'سالم', active: true }],
  Doctors: [{ id: 'DOC-1', name: 'د. علي', specialty: 'باطنة', active: true }, { id: 'DOC-2', name: 'د. منى', specialty: 'أطفال', active: true }],
  Facilities: [{ id: 'FAC-1', name: 'مستشفى الخضراء', status: 'نشط' }, { id: 'FAC-2', name: 'عيادة النور', status: 'نشط' },
    { id: 'FAC-3', name: 'قديمة', status: 'نشط', mergedInto: 'FAC-2' }, { id: 'FAC-4', name: 'مغلقة', status: 'معطل' }]
});
const setup = () => { const env = makeEnv(SEED()); return { env, adm: env.session('ADM-1', 'admin'), sup: env.session('SUP-0001', 'supervisor'), rep: env.session('REP-0001', 'rep') }; };
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('two facilities on the same day (morning / evening); a merged facility resolves to the kept one; duplicates collapse', () => {
  const { env, rep } = setup();
  const r = env.call(rep, 'docScheduleSave', { doctorId: 'DOC-1', slots: [
    { facilityId: 'FAC-1', day: wd, period: 'am' }, { facilityId: 'FAC-3', day: wd, period: 'pm' }, { facilityId: 'FAC-2', day: wd, period: 'pm' }, { facilityId: 'FAC-1', day: other, period: 'all' }] });
  const s = r.sched['DOC-1'];
  assert.strictEqual(J(s.slots.map(x => [x.d, x.f, x.p])), J([[wd, 'FAC-1', 'am'], [wd, 'FAC-2', 'pm'], [other, 'FAC-1', 'all']].sort((a, b) => a[0] - b[0] || (a[2] > b[2] ? 1 : -1))));
  assert.ok(s.at && s.by !== undefined);
  assert.strictEqual(J(env.ctx.schOnDate_(r, 'DOC-1', today)), J({ off: false, absent: false, where: 'مستشفى الخضراء صباحًا · عيادة النور مساءً' }));
  assert.strictEqual(env.ctx.schOnDate_(r, 'DOC-2', today), null, 'no schedule = no opinion');
});
test('editing keeps unchanged slots and ends removed ones (history kept, not deleted)', () => {
  const { env, rep, sup } = setup();
  env.call(rep, 'docScheduleSave', { doctorId: 'DOC-1', slots: [{ facilityId: 'FAC-1', day: wd, period: 'am' }, { facilityId: 'FAC-2', day: wd, period: 'pm' }] });
  const before = env.rows('DocSchedule').map(r => r.id);
  const r = env.call(sup, 'docScheduleSave', { doctorId: 'DOC-1', slots: [{ facilityId: 'FAC-1', day: wd, period: 'am' }, { facilityId: 'FAC-1', day: other, period: 'pm' }] });
  const rows = env.rows('DocSchedule');
  assert.strictEqual(rows.length, 3, 'one ended row kept + one new');
  const ended = rows.find(x => String(x.active) === 'false');
  assert.strictEqual(J([ended.facilityId, ended.endedBy]), J(['FAC-2', 'SUP-0001']));
  assert.ok(before.indexOf(rows.find(x => x.facilityId === 'FAC-1' && +x.day === wd).id) >= 0, 'unchanged slot keeps its row');
  assert.strictEqual(r.sched['DOC-1'].slots.length, 2);
  const cleared = env.call(rep, 'docScheduleSave', { doctorId: 'DOC-1', slots: [] });
  assert.ok(!cleared.sched['DOC-1'], 'an empty schedule = back to no schedule');
});
test('«غير متواجد اليوم»: today only for a rep, undo; validation errors', () => {
  const { env, rep } = setup();
  env.call(rep, 'docScheduleSave', { doctorId: 'DOC-1', slots: [{ facilityId: 'FAC-1', day: wd, period: 'am' }] });
  let r = env.call(rep, 'docAbsent', { doctorId: 'DOC-1', date: '2099-01-01' });
  assert.strictEqual(J(r.absent['DOC-1']), J([today]));
  assert.strictEqual(J(env.ctx.schOnDate_(r, 'DOC-1', today)), J({ off: true, absent: true, where: 'مستشفى الخضراء صباحًا' }));
  r = env.call(rep, 'docAbsent', { doctorId: 'DOC-1', undo: true });
  assert.ok(!r.absent['DOC-1']);
  expectError(() => env.call(rep, 'docScheduleSave', { doctorId: 'DOC-1', slots: [{ facilityId: 'FAC-4', day: 1, period: 'am' }] }), /المنشأة غير موجودة/);
  expectError(() => env.call(rep, 'docScheduleSave', { doctorId: 'DOC-1', slots: [{ facilityId: 'FAC-1', day: 7, period: 'am' }] }), /يوم غير صحيح/);
  expectError(() => env.call(rep, 'docScheduleSave', { doctorId: 'DOC-1', slots: [{ facilityId: 'FAC-1', day: 1, period: 'night' }] }), /الفترة/);
  expectError(() => env.call(rep, 'docScheduleSave', { doctorId: 'DOC-9', slots: [] }), /الطبيب غير موجود/);
});
test('daily plans show where the doctor works that day, or warn that he does not', () => {
  const { env, sup } = setup();
  env.call(sup, 'docScheduleSave', { doctorId: 'DOC-1', slots: [{ facilityId: 'FAC-2', day: other, period: 'pm' }] });
  const a = env.call(sup, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-1', purpose: 'intro' });
  assert.strictEqual(J([a.schedOff, a.schedWhere]), J([true, '']));
  const b = env.call(sup, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-2', purpose: 'intro' });
  assert.strictEqual(J([b.schedOff, b.schedWhere]), J([false, '']), 'no schedule: no warning');
});
test('merging doctors moves the schedule when the kept doctor has none', () => {
  const { env, adm } = setup();
  env.call(adm, 'docScheduleSave', { doctorId: 'DOC-2', slots: [{ facilityId: 'FAC-1', day: wd, period: 'all' }] });
  env.call(adm, 'masterAct', { entity: 'Doctors', id: 'DOC-2', op: 'merge', into: 'DOC-1' });
  assert.strictEqual(J(env.call(adm, 'docSchedules', {}).sched['DOC-1'].slots.map(x => x.f)), J(['FAC-1']));
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
