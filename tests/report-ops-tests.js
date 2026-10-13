// Local tests for report operations by id: reopen, open, GPS summary, review (lookup + minimal writes). Run: node tests/report-ops-tests.js
'use strict';
const assert = require('assert'), vm = require('vm');
const { makeEnv } = require('./gas-harness');

const NOW = new Date().toISOString(), A = { lat: 32.89, lng: 13.2 };
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workplacePolicy', value: 'soft' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب', active: true }, { id: 'REP-0002', name: 'آخر', active: true }],
  Doctors: [{ id: 'DOC-0001', name: 'أحمد سالم', specialty: 'باطنة', active: true }, { id: 'DOC-0002', name: 'سالم خالد', specialty: 'قلب', active: true }],
  Facilities: [{ id: 'FAC-A', name: 'مصحة الشفاء', status: 'نشط', lat: A.lat, lng: A.lng, radius: 150, geoState: 'مؤكد', geoSource: 'ADMIN_MAP', geoBy: 'ADM-1', geoAt: NOW, geoVersion: 1 }],
  DoctorWorkplaces: [{ id: 'DWP-00001', doctorId: 'DOC-0001', facilityId: 'FAC-A', active: true, linkState: 'معتمد' }],
  // Decoy ids: "R1" must never match "R10" / "XR1" (exact, whole-cell search).
  Reports: [{ id: 'R10', no: 'MR-10', repId: 'REP-0002', date: '2026-01-02', status: 'مرسل', doctors: '[]', pharmacies: '[]' },
    { id: 'XR1', no: 'MR-X', repId: 'REP-0001', date: '2026-01-03', status: 'مرسل', doctors: '[]', pharmacies: '[]' }]
});
const visit = o => Object.assign({ specialty: 'باطنة', intro: 'x', time: 'صباحًا', sector: 'خاص', gps: { lat: A.lat, lng: A.lng, acc: 10, ts: Date.now() } }, o);
const setup = () => {
  const env = makeEnv(SEED()), T = vm.runInContext('T', env.ctx), rep = env.session('REP-0001', 'rep');
  env.call(rep, 'submitReport', { date: env.today, doctors: [visit({ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: 'FAC-A' })] });
  const row = () => env.rows('Reports').find(r => r.repId === 'REP-0001' && r.date === env.today);
  return { env, T, rep, row, col: c => T.Reports.indexOf(c) + 1 };
};
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };

test('reopen: status/reopens/snapshot1 updated; visits and snapshot cells untouched', () => {
  const { env, rep, row } = setup(), before = row();
  const out = env.call(rep, 'reopenReport', { id: before.id });
  const after = row();
  assert.deepStrictEqual([after.status, String(after.reopens), after.snapshot1], ['مسودة', '1', before.snapshot]);
  assert.deepStrictEqual([after.doctors, after.pharmacies, after.snapshot], [before.doctors, before.pharmacies, before.snapshot]);
  assert.deepStrictEqual([out.status, out.reopens], ['مسودة', 1]);
});
test('reopen: no full-sheet read, and only the changed columns are written (one row)', () => {
  const { env, rep, row, col } = setup(), id = row().id;
  env.resetReads(); env.call(rep, 'reopenReport', { id: id });
  const w = env.writes.filter(x => x.sheet === 'Reports');
  assert.ok(w.length >= 1 && w.length <= 2, 'Reports writes: ' + JSON.stringify(w));
  const cols = w.flatMap(x => Array.from({ length: x.cols }, (_, i) => x.col + i)).sort((a, b) => a - b);
  assert.deepStrictEqual(cols, [col('status'), col('snapshot1'), col('reopens')].sort((a, b) => a - b));
  assert.ok(!cols.includes(col('doctors')) && !cols.includes(col('snapshot')));
  assert.ok(env.reads.Reports <= 6, 'Reports reads: ' + env.reads.Reports); // find + row + id check + prevInfo index (3)
});
test('reopen returns the draft (rep view: no GPS verdict) and yesterday\'s info: no second round trip needed', () => {
  const { env, rep, row } = setup(), out = env.call(rep, 'reopenReport', { id: row().id });
  assert.strictEqual(out.report.status, 'مسودة');
  assert.strictEqual(out.report.doctors[0].doctorId, 'DOC-0001');
  assert.strictEqual(out.report.doctors[0].gps.status, undefined); // verdict hidden from the rep
  assert.ok(out.prev && typeof out.prev.date === 'string');
});
test('second reopen after re-submitting keeps the FIRST submitted version in snapshot1', () => {
  const { env, rep, row } = setup(), first = row().snapshot;
  env.call(rep, 'reopenReport', { id: row().id });
  env.call(rep, 'submitReport', { date: env.today, notes: 'تعديل', doctors: [visit({ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: 'FAC-A' })] });
  assert.notStrictEqual(row().snapshot, first);
  env.call(rep, 'reopenReport', { id: row().id });
  assert.deepStrictEqual([row().snapshot1, String(row().reopens)], [first, '2']);
});
test('reopen guards: another rep\'s report, a partial id, an unknown id and an approved report are refused', () => {
  const { env, rep, row } = setup();
  expectError(() => env.call(rep, 'reopenReport', { id: 'R10' }), /غير موجود/);  // belongs to REP-0002
  expectError(() => env.call(rep, 'reopenReport', { id: 'R1' }), /غير موجود/);   // must not match R10 / XR1
  expectError(() => env.call(rep, 'reopenReport', { id: 'NOPE' }), /غير موجود/);
  env.call(env.session('ADMIN', 'admin'), 'reviewReport', { id: row().id, approve: true });
  expectError(() => env.call(rep, 'reopenReport', { id: row().id }), /معتمد/);
});
test('open by id (getReport): exact match, rep sees only his own report', () => {
  const { env, rep, row } = setup(), adm = env.session('ADMIN', 'admin');
  assert.strictEqual(env.call(adm, 'getReport', { id: 'R10' }).id, 'R10');
  assert.strictEqual(env.call(rep, 'getReport', { id: row().id }).id, row().id);
  expectError(() => env.call(rep, 'getReport', { id: 'R10' }), /غير موجود/);
  expectError(() => env.call(adm, 'getReport', { id: 'R1' }), /غير موجود/);
});
test('review: approve / return write only status + note (visits cell only when links are approved)', () => {
  const { env, row, col } = setup(), adm = env.session('ADMIN', 'admin');
  assert.strictEqual(env.call(adm, 'gpsReviewSummary', { id: row().id }).visits[0].status, 'تم التحقق');
  env.resetReads(); env.call(adm, 'reviewReport', { id: row().id, approve: false, note: 'راجع الزيارة' });
  const cols = env.writes.filter(x => x.sheet === 'Reports').flatMap(x => Array.from({ length: x.cols }, (_, i) => x.col + i)).sort((a, b) => a - b);
  assert.deepStrictEqual(cols, [col('status'), col('reviewNote')].sort((a, b) => a - b));
  assert.deepStrictEqual([row().status, row().reviewNote], ['معاد للمندوب', 'راجع الزيارة']);
});
test('review with a pending doctor link writes the visits cell once and approves the link', () => {
  const env = makeEnv(SEED()), rep = env.session('REP-0001', 'rep'), adm = env.session('ADMIN', 'admin'), T = vm.runInContext('T', env.ctx);
  env.call(rep, 'submitReport', { date: env.today, doctors: [visit({ name: 'سالم خالد', doctorId: 'DOC-0002', facilityId: 'FAC-A' })] });
  const r = env.rows('Reports').find(x => x.repId === 'REP-0001' && x.date === env.today);
  env.resetReads(); env.call(adm, 'reviewReport', { id: r.id, approve: true, approveLinks: true });
  const cols = env.writes.filter(x => x.sheet === 'Reports').flatMap(x => Array.from({ length: x.cols }, (_, i) => x.col + i));
  assert.ok(cols.includes(T.Reports.indexOf('doctors') + 1) && !cols.includes(T.Reports.indexOf('snapshot') + 1));
  const after = env.rows('Reports').find(x => x.id === r.id);
  assert.ok(!JSON.parse(after.doctors)[0].linkPending && JSON.parse(after.snapshot).doctors[0].linkPending); // snapshot frozen
  assert.strictEqual(env.rows('DoctorWorkplaces').find(w => w.doctorId === 'DOC-0002').linkState, 'معتمد');
});
test('dbWriteCells_ refuses to write when the row no longer holds the expected record', () => {
  const { env, row } = setup();
  assert.throws(() => env.ctx.dbWriteCells_('Reports', 2, 'id', Object.assign({}, row(), { status: 'x' }), ['status']), /تغيّر موضع السجل/);
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
