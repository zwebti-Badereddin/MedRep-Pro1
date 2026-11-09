// Local tests for the simpler location review: the facility is the reference; within its range (150 m by default, or its own)
// = matched with the distance; farther = doubtful (the supervisor decides); a weak reading is only judged when clear.
// The rep sees the distance only when a visit is far; «اعتماد كل التقارير المطابقة» approves the fully matched reports.
// Run: node tests/gps-review-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const J = x => JSON.stringify(x);
const NOW = new Date().toISOString(), A = { lat: 32.8900, lng: 13.2000 };
const north = m => ({ lat: A.lat + m / 111320, lng: A.lng, acc: 15, ts: Date.now() });
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'gpsRadius', value: '150' }, { key: 'gpsRefAcc', value: '50' }, { key: 'workplacePolicy', value: 'soft' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }, { id: 'REP-0002', name: 'البراء', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Doctors: [{ id: 'DOC-1', name: 'د. علي', specialty: 'باطنة', active: true }],
  Facilities: [{ id: 'FAC-A', name: 'مصحة المسرة', type: 'مصحة', status: 'نشط', legacyEntity: 'DOCTOR_FACILITY', legacyId: 'FAC-A', lat: A.lat, lng: A.lng, radius: '',
    geoState: 'مؤكد', geoSource: 'ADMIN_MAP', geoBy: 'ADM-1', geoAt: NOW, geoVersion: 1 }],
  DoctorWorkplaces: [{ id: 'DWP-00001', doctorId: 'DOC-1', doctorName: 'د. علي', workplace: '', active: true, facilityId: 'FAC-A', linkState: 'معتمد' }],
  Products: [{ id: 'PROD-0001', name: 'Clodil', status: 'نشط' }]
});
const visit = gps => ({ name: 'د. علي', doctorId: 'DOC-1', facilityId: 'FAC-A', specialty: 'باطنة', intro: 'Clodil', time: 'صباحًا', sector: 'خاص', gps: gps });
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('verdict: within the range = matched (whatever small accuracy), beyond = doubtful; a weak reading is judged only when clear', () => {
  const env = makeEnv(SEED()), v = env.ctx.geoVerdict_;
  assert.strictEqual(J([v(140, 30, 150, 50), v(160, 10, 150, 50), v(149, 50, 150, 50)]), J(['تم التحقق', 'خارج النطاق', 'تم التحقق']));
  assert.strictEqual(J([v(20, 120, 150, 50), v(900, 300, 150, 50), v(100, 300, 150, 50), v(100, 0, 150, 50)]), J(['تم التحقق', 'خارج النطاق', 'غير حاسم', 'غير حاسم']));
});
test('the rep gets the distance only for a far visit; the supervisor sees the verdict and the distance', () => {
  const env = makeEnv(SEED()), rep = env.session('REP-0001', 'rep'), adm = env.session('ADM-1', 'admin');
  const r = env.call(rep, 'saveReport', { date: env.today, doctors: [visit(north(60)), visit(north(420))] });
  assert.strictEqual(J(r.docs.map(d => [d.gps.warn, d.gps.status, d.gps.dist])), J([[undefined, undefined, undefined], [420, undefined, undefined]]));
  const id = env.rows('Reports')[0].id; env.sheets.Reports._data[1][4] = 'مرسل';
  const sum = env.call(adm, 'gpsReviewSummary', { id: id });
  assert.strictEqual(J(sum.visits.map(x => [x.status, x.distance])), J([['تم التحقق', 60], ['خارج النطاق', 420]]));
});
test('«اعتماد كل التقارير المطابقة»: the fully matched report is approved, the one with a doubtful visit stays for review', () => {
  const env = makeEnv(SEED()), adm = env.session('ADM-1', 'admin');
  env.call(env.session('REP-0001', 'rep'), 'submitReport', { date: env.today, doctors: [visit(north(40))] });
  env.call(env.session('REP-0002', 'rep'), 'submitReport', { date: env.today, doctors: [Object.assign(visit(north(700)), {})] });
  const ids = env.rows('Reports').map(r => r.id);
  const x = env.call(adm, 'approveMatched', { ids: ids });
  assert.strictEqual(J([x.approved, x.review]), J([1, 1]));
  assert.strictEqual(J(env.rows('Reports').map(r => [r.repId, r.status])), J([['REP-0001', 'معتمد'], ['REP-0002', 'مرسل']]));
  assert.throws(() => env.call(env.session('REP-0001', 'rep'), 'approveMatched', { ids: ids }), /غير مصرح/);
});
test('a facility\'s own range: 300 m makes a 250 m visit match (old visits re-checked); out of 20–1000 is refused', () => {
  const env = makeEnv(SEED()), rep = env.session('REP-0001', 'rep'), adm = env.session('ADM-1', 'admin');
  env.call(rep, 'saveReport', { date: env.today, doctors: [visit(north(250))] });
  assert.strictEqual(JSON.parse(env.rows('Reports')[0].doctors)[0].gps.status, 'خارج النطاق');
  env.call(adm, 'facilityAct', { id: 'FAC-A', op: 'edit', row: { name: 'مصحة المسرة', radius: '300' } });
  assert.strictEqual(String(env.rows('Facilities')[0].radius), '300');
  assert.strictEqual(JSON.parse(env.rows('Reports')[0].doctors)[0].gps.status, 'تم التحقق', 're-checked with the new range');
  assert.throws(() => env.call(adm, 'facilityAct', { id: 'FAC-A', op: 'edit', row: { name: 'مصحة المسرة', radius: '5000' } }), /بين 20 و1000/);
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
