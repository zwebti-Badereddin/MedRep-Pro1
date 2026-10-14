// Local tests for the lighter report paths: autosave by id (only the changed cells), and admin search / export / KPI reading
// only notes + visits (never the snapshots). Run: node tests/report-speed-tests.js
'use strict';
const assert = require('assert'), vm = require('vm');
const { makeEnv } = require('./gas-harness');

const NOW = new Date().toISOString(), A = { lat: 32.89, lng: 13.2 };
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workplacePolicy', value: 'soft' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب', active: true }, { id: 'REP-0002', name: 'آخر', active: true }],
  Doctors: [{ id: 'DOC-0001', name: 'أحمد سالم', specialty: 'باطنة', active: true }],
  Facilities: [{ id: 'FAC-A', name: 'مصحة الشفاء', status: 'نشط', lat: A.lat, lng: A.lng, radius: 150, geoState: 'مؤكد', geoSource: 'ADMIN_MAP', geoBy: 'ADM-1', geoAt: NOW, geoVersion: 1 }],
  DoctorWorkplaces: [{ id: 'DWP-00001', doctorId: 'DOC-0001', facilityId: 'FAC-A', active: true, linkState: 'معتمد' }],
  Reports: [{ id: 'R10', no: 'MR-10', repId: 'REP-0002', date: '2026-01-02', status: 'مرسل', doctors: '[{"name":"منى"}]', pharmacies: '[]', snapshot: '{"x":1}' },
    { id: 'XR1', no: 'MR-X', repId: 'REP-0001', date: '2026-01-03', status: 'مسودة', notes: 'قديم', doctors: '[]', pharmacies: '[]' }]
});
const visit = o => Object.assign({ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: 'FAC-A', specialty: 'باطنة', intro: 'x', time: 'صباحًا', sector: 'خاص',
  gps: { lat: A.lat, lng: A.lng, acc: 10, ts: 1 } }, o);
const setup = () => {
  const env = makeEnv(SEED()), T = vm.runInContext('T', env.ctx), rep = env.session('REP-0001', 'rep');
  const row = () => env.rows('Reports').find(r => r.repId === 'REP-0001' && r.date === env.today);
  return { env, T, rep, row, col: c => T.Reports.indexOf(c) + 1 };
};
const span = x => Array.from({ length: x.cols }, (_, i) => x.col + i);
const writtenCols = env => env.writes.filter(x => x.sheet === 'Reports').flatMap(span).sort((a, b) => a - b);
const readCols = env => env.reads._log.filter(x => x.sheet === 'Reports' && x.rows > 1).flatMap(span); // multi-row reads only
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('autosave with the report id: only notes, visits and updatedAt are written (snapshots untouched)', () => {
  const { env, rep, row, col } = setup();
  const first = env.call(rep, 'saveReport', { date: env.today, doctors: [visit()] });
  env.resetReads();
  env.call(rep, 'saveReport', { id: first.id, date: env.today, notes: 'جديد', doctors: [visit(), visit({ intro: 'y', gps: { lat: A.lat, lng: A.lng, acc: 10, ts: 2 } })] });
  assert.deepStrictEqual(writtenCols(env), [col('notes'), col('doctors'), col('pharmacies'), col('updatedAt')]);
  const r = row();
  assert.deepStrictEqual([r.status, r.notes, JSON.parse(r.doctors).length, r.snapshot], ['مسودة', 'جديد', 2, '']);
});
test('autosave with the id reads fewer Reports ranges than without it', () => {
  const { env, rep } = setup(), first = env.call(rep, 'saveReport', { date: env.today, doctors: [visit()] });
  env.resetReads(); env.call(rep, 'saveReport', { date: env.today, notes: 'a', doctors: [visit()] }); const without = env.reads.Reports;
  env.resetReads(); env.call(rep, 'saveReport', { id: first.id, date: env.today, notes: 'b', doctors: [visit()] }); const withId = env.reads.Reports;
  assert.ok(withId < without, 'with id ' + withId + ' vs without ' + without);
});
test('a wrong id hint is ignored: another rep\'s or another day\'s report is never written', () => {
  const { env, rep, row } = setup(), before = env.rows('Reports').map(r => JSON.stringify(r));
  env.call(rep, 'saveReport', { id: 'R10', date: env.today, notes: 'n1', doctors: [visit()] });   // REP-0002's report
  env.call(rep, 'saveReport', { id: 'XR1', date: env.today, notes: 'n2', doctors: [visit()] });   // own report, other day
  const all = env.rows('Reports');
  assert.strictEqual(JSON.stringify(all.find(r => r.id === 'R10')), before[0]);
  assert.strictEqual(JSON.stringify(all.find(r => r.id === 'XR1')), before[1]);
  assert.strictEqual(all.filter(r => r.repId === 'REP-0001' && r.date === env.today).length, 1); // one report, not a duplicate
  assert.strictEqual(row().notes, 'n2');
});
test('submit with the id hint still freezes the snapshot', () => {
  const { env, rep, row } = setup(), first = env.call(rep, 'saveReport', { date: env.today, doctors: [visit()] });
  env.call(rep, 'submitReport', { id: first.id, date: env.today, notes: 'تم', doctors: [visit()] });
  const r = row();
  assert.strictEqual(r.status, 'مرسل');
  assert.strictEqual(JSON.parse(r.snapshot).notes, 'تم');
});
test('admin text search, export and KPI read only notes + visits columns (never the snapshots)', () => {
  const { env, rep, col } = setup(), adm = env.session('ADMIN', 'admin');
  env.call(rep, 'submitReport', { date: env.today, notes: 'ملاحظة', doctors: [visit()] });
  const noSnap = what => { const c = readCols(env); assert.ok(!c.includes(col('snapshot')) && !c.includes(col('snapshot1')), what + ' read a snapshot column'); };
  env.resetReads();
  const hits = env.call(adm, 'listReports', { q: 'أحمد' });
  noSnap('search');
  assert.strictEqual(JSON.stringify(hits.map(h => [h.repId, h.visits])), JSON.stringify([['REP-0001', 1]]));
  assert.strictEqual(env.call(adm, 'listReports', { q: 'منى' })[0].id, 'R10');
  env.resetReads();
  const ex = env.call(adm, 'exportVisits', { from: '2026-01-01', to: env.today });
  noSnap('export');
  assert.deepStrictEqual([ex.reports, ex.visits], [3, 2]);
  const own = ex.rows.find(r => r[0] && r[6] === 'أحمد سالم');
  assert.strictEqual(own[own.length - 1], 'ملاحظة');
  env.resetReads();
  env.call(adm, 'performance', { from: '2026-01-01', to: env.today });
  noSnap('performance');
});
test('export: a note Sheets turned into a date comes out as text, as before (not a JS date string)', () => {
  const { env, col } = setup(), adm = env.session('ADMIN', 'admin');
  env.sheets.Reports._data[2][col('notes') - 1] = vm.runInContext('new Date(Date.UTC(2026, 0, 2))', env.ctx); // XR1's note, auto-converted by Sheets
  const ex = env.call(adm, 'exportVisits', { from: '2026-01-01', to: '2026-01-05' }), r = ex.rows.find(x => x[0] === 'MR-X');
  assert.strictEqual(r, undefined); // XR1 has no visits: export rows are per visit
  env.sheets.Reports._data[2][col('doctors') - 1] = '[{"name":"منى"}]';
  const row = env.call(adm, 'exportVisits', { from: '2026-01-01', to: '2026-01-05' }).rows.find(x => x[0] === 'MR-X');
  assert.strictEqual(row[row.length - 1], '2026-01-02T00:00:00.000Z');
});
test('rep search sees only his own reports', () => {
  const { env, rep } = setup();
  env.call(rep, 'saveReport', { date: env.today, doctors: [visit()] });
  assert.strictEqual(env.call(rep, 'listReports', { q: 'منى' }).length, 0);
  assert.strictEqual(env.call(rep, 'listReports', { q: 'أحمد' }).length, 1);
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
