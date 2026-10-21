// Local tests for the paths that would grow with the number of reports: doctor/pharmacy merge, pharmacy re-verification and
// the GPS retention job must not read the whole Reports sheet (snapshots are its bulk). Run: node tests/report-scale-tests.js
'use strict';
const assert = require('assert'), vm = require('vm');
const { makeEnv } = require('./gas-harness');

const DAY = 86400000, ago = n => new Date(Date.now() - n * DAY), iso = n => ago(n).toISOString(), ymd = n => iso(n).slice(0, 10);
const P = { lat: 32.89, lng: 13.2 };
const gps = n => ({ status: 'تم التحقق', lat: P.lat, lng: P.lng, acc: 10, ts: ago(n).getTime() });
const doc = (n, extra) => Object.assign({ name: 'أحمد سالم', doctorId: 'DOC-1', specialty: 'باطنة', gps: gps(n) }, extra);
const snap = (n, visits) => JSON.stringify({ date: ymd(n), doctors: visits, pharmacies: [] });
const rep = (id, dateAgo, updated, visits, s) => ({ id: id, no: 'MR-' + id, repId: 'REP-1', date: ymd(dateAgo), status: 'مرسل', notes: '',
  doctors: JSON.stringify(visits), pharmacies: '[]', snapshot: s === undefined ? snap(dateAgo, visits) : s, createdAt: iso(dateAgo), updatedAt: updated, reopens: 0 });
const base = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'gpsRadius', value: '150' }, { key: 'gpsRefAcc', value: '50' }],
  Reps: [{ id: 'REP-1', name: 'مندوب', active: true }]
});
const T = env => vm.runInContext('T', env.ctx);
const wideReads = env => env.reads._log.filter(x => x.sheet === 'Reports' && x.cols > 1);
const fullRowReads = env => env.reads._log.filter(x => x.sheet === 'Reports' && x.cols === T(env).Reports.length); // rows with snapshots
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('merge (rewriteNames_): only the visits column is read; snapshots are never read or changed', () => {
  const seed = base(); seed.Reports = [rep('R1', 3, iso(3), [doc(3)]), rep('R2', 2, iso(2), [doc(2, { name: 'غيره', doctorId: 'DOC-9' })])];
  const env = makeEnv(seed), s0 = env.rows('Reports').map(r => r.snapshot);
  env.resetReads();
  const n = env.ctx.rewriteNames_('Doctors', 'أحمد سالم', 'أحمد سالم', 'DOC-1', 'DOC-2');
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(wideReads(env), [], 'no multi-column read of Reports');
  const rows = env.rows('Reports');
  assert.strictEqual(JSON.parse(rows[0].doctors)[0].doctorId, 'DOC-2');
  assert.strictEqual(JSON.parse(rows[1].doctors)[0].doctorId, 'DOC-9');
  assert.deepStrictEqual(rows.map(r => r.snapshot), s0, 'snapshots untouched');
  assert.ok(env.writes.filter(w => w.sheet === 'Reports').every(w => w.col === T(env).Reports.indexOf('doctors') + 1 && w.rows === 1), 'writes only the changed visits cell');
});

test('pharmacy re-verification (reverify_): only the pharmacies column is read and rewritten', () => {
  const ph = { name: 'صيدلية النور', pharmacyId: 'PH-1', gps: gps(2) };
  const seed = base(); seed.Pharmacies = [{ id: 'PH-1', name: 'صيدلية النور', active: true }];
  seed.Reports = [Object.assign(rep('R1', 2, iso(2), []), { pharmacies: JSON.stringify([ph]), snapshot: '{"keep":1}' }), rep('R2', 1, iso(1), [doc(1)])];
  const env = makeEnv(seed);
  env.ctx.facilityGeoEntity_ = () => ({ id: 'PH-1', lat: P.lat, lng: P.lng, radius: 100 });
  env.resetReads();
  const n = env.ctx.reverify_('Pharmacies', { id: 'PH-1', name: 'صيدلية النور' });
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(wideReads(env), [], 'no multi-column read of Reports');
  const g = JSON.parse(env.rows('Reports')[0].pharmacies)[0].gps;
  assert.ok(g.recheck && g.recheck.status, 'verdict recorded');
  assert.strictEqual(env.rows('Reports')[0].snapshot, '{"keep":1}');
});

test('GPS retention: first run (no mark) reads every report and reduces exactly as before, then sets the mark', () => {
  const seed = base();
  seed.Reports = [
    rep('OLD', 200, iso(200), [doc(200)]),                 // expired, in visits and snapshot
    rep('NEW', 5, iso(5), [doc(5)]),                       // recent: kept
    rep('MIX', 150, iso(1), [doc(150), doc(1)]),          // old report reopened yesterday: one expired, one fresh
    rep('NOUPD', 120, '', [doc(120)])                      // no updatedAt
  ];
  const env = makeEnv(seed);
  const out = env.ctx.reduceExpiredGpsData_(), byId = id => env.rows('Reports').find(r => r.id === id);
  assert.strictEqual(out.reportsRead, 4);
  const reduced = v => !!v.gps.rawLocationReducedAt && v.gps.lat === undefined;
  assert.ok(reduced(JSON.parse(byId('OLD').doctors)[0]) && reduced(JSON.parse(byId('OLD').snapshot).doctors[0]));
  assert.ok(!reduced(JSON.parse(byId('NEW').doctors)[0]));
  assert.deepStrictEqual(JSON.parse(byId('MIX').doctors).map(reduced), [true, false]);
  assert.ok(reduced(JSON.parse(byId('NOUPD').doctors)[0]));
  const mark = Date.parse(env.props.get('GPS_RETENTION_SCAN_FROM'));
  assert.ok(Math.abs(mark - (Date.now() - 97 * DAY)) < 60000, 'mark = cutoff - 7 days');
});

test('GPS retention: later runs read only reports written since the mark (plus rows without updatedAt)', () => {
  const seed = base();
  seed.Reports = [rep('A', 300, iso(300), [doc(300)]), rep('B', 250, iso(250), [doc(250)]), rep('C', 150, iso(1), [doc(150)]),
    rep('D', 120, '', [doc(120)]), rep('E', 3, iso(3), [doc(3)])];
  const env = makeEnv(seed);
  env.ctx.reduceExpiredGpsData_();
  // Plant an unreduced old location in A without touching updatedAt: a skipped row must stay exactly as it is.
  const aRow = env.rows('Reports').findIndex(r => r.id === 'A') + 2, dc = T(env).Reports.indexOf('doctors') + 1;
  env.sheets.Reports.getRange(aRow, dc).setValue(JSON.stringify([doc(300)]));
  env.resetReads();
  const out = env.ctx.reduceExpiredGpsData_();
  assert.strictEqual(out.reportsRead, 3, 'C (recent write), D (no updatedAt), E (recent)');
  const readRows = new Set(fullRowReads(env).flatMap(x => Array.from({ length: x.rows }, (_, i) => x.row + i)));
  assert.ok(!readRows.has(aRow) && !readRows.has(aRow + 1), 'A and B (written before the mark) are not read');
  assert.ok(JSON.parse(env.rows('Reports').find(r => r.id === 'A').doctors)[0].gps.lat !== undefined, 'A not touched');
  assert.strictEqual(out.visitsReduced, 0, 'nothing left to reduce');
});

test('GPS retention: distant selected rows are read separately, not as one block spanning the sheet', () => {
  const seed = base(); seed.Reports = [rep('OLD1', 400, iso(1), [doc(400)])];
  for (let i = 0; i < 60; i++) seed.Reports.push(rep('F' + i, 300, iso(300), [doc(300)]));
  seed.Reports.push(rep('LAST', 2, iso(2), [doc(2)]));
  const env = makeEnv(seed);
  env.props.set('GPS_RETENTION_SCAN_FROM', iso(97));
  env.resetReads();
  const out = env.ctx.reduceExpiredGpsData_();
  assert.strictEqual(out.reportsRead, 2);
  assert.strictEqual(fullRowReads(env).reduce((a, x) => a + x.rows, 0), 2, 'two single-row reads, not 62 rows');
});

test('report index timing is reported in [MedRepPerf] phases', () => {
  const seed = base(); seed.Reports = [rep('R1', 1, iso(1), [doc(1)])];
  const env = makeEnv(seed), logs = [];
  env.ctx.console.log = m => logs.push(String(m));
  env.call(env.session('REP-1', 'rep'), 'myReports', {});
  const perf = logs.map(l => l.match(/^\[MedRepPerf\] (.*)$/)).filter(Boolean).map(m => JSON.parse(m[1])).pop();
  assert.ok(perf && perf.phases && typeof perf.phases.reportIndex === 'number' && perf.phases.reportRows === 1, JSON.stringify(perf));
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
