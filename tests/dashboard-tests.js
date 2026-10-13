// Local tests for the admin dashboard (server aggregation + client rendering). Run: node tests/dashboard-tests.js
'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const { makeEnv } = require('./gas-harness');

const plain = x => JSON.parse(JSON.stringify(x));
const g = st => ({ lat: 32.9, lng: 13.2, acc: 10, ts: 1, status: st });
const rpt = (id, repId, date, status, docs, phs, submittedAt) => ({ id, no: 'MR-' + id, repId, date, status,
  doctors: JSON.stringify(docs || []), pharmacies: JSON.stringify(phs || []), submittedAt: submittedAt || '', updatedAt: submittedAt || date + 'T20:00:00Z', createdAt: date + 'T08:00:00Z' });
// Period under test: 2026-09-01 .. 2026-09-10 (10 days); previous period: 2026-08-22 .. 2026-08-31.
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workDays', value: '0,1,2,3,4,5,6' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب أول', active: true }, { id: 'REP-0002', name: 'مندوب ثانٍ', active: true }, { id: 'REP-0003', name: 'معطّل', active: false }],
  Doctors: [{ id: 'DOC-0001', name: 'أحمد', active: true }, { id: 'DOC-0002', name: 'محمد', active: true }],
  Facilities: [{ id: 'FAC-A', name: 'مصحة الشفاء', status: 'نشط' }, { id: 'FAC-B', name: 'مستشفى النور', status: 'نشط' },
    { id: 'FAC-OLD', name: 'النور القديم', status: 'معطل', mergedInto: 'FAC-B' }],
  DoctorWorkplaces: [{ id: 'DWP-00001', doctorId: 'DOC-0001', facilityId: 'FAC-A', active: true, linkState: 'معتمد' }],
  Reports: [
    rpt('R1', 'REP-0001', '2026-09-01', 'مرسل', [{ doctorId: 'DOC-0001', facilityId: 'FAC-A', gps: g('تم التحقق') }, { doctorId: 'DOC-0002', facilityId: 'FAC-A', gps: g('خارج النطاق') }],
      [{ name: 'صيدلية', gps: { status: 'غير متاح' } }], '2026-09-01T15:00:00Z'),
    rpt('R2', 'REP-0001', '2026-09-02', 'معتمد', [{ doctorId: 'DOC-0001', workplaceId: 'DWP-00001', gps: g('غير حاسم') }], [], '2026-09-02T12:00:00Z'),
    rpt('R3', 'REP-0002', '2026-09-05', 'مرسل', [{ doctorId: 'DOC-0002', facilityId: 'FAC-OLD' }, { name: 'طبيب قديم', place: 'عيادة قديمة' }], [], '2026-09-07T09:00:00Z'),
    rpt('R4', 'REP-0002', '2026-09-06', 'مسودة', [{ doctorId: 'DOC-0001', facilityId: 'FAC-B' }], []),
    rpt('R0', 'REP-0001', '2026-08-25', 'مرسل', [{ doctorId: 'DOC-0001', facilityId: 'FAC-A' }, { doctorId: 'DOC-0002', facilityId: 'FAC-A' }], [], '2026-08-25T18:00:00Z')
  ]
});
const run = () => { const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin'); return { env, adm, d: env.call(adm, 'dashboard', { from: '2026-09-01', to: '2026-09-10' }) }; };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };

test('cards: doctor / pharmacy visits of sent+approved reports only, compared with the previous period of equal length', () => {
  const { d } = run();
  assert.deepStrictEqual([d.prevFrom, d.prevTo], ['2026-08-22', '2026-08-31']);
  assert.deepStrictEqual(plain(d.cards.doctorVisits), { value: 5, change: 150 }); // 5 now (draft R4 excluded) vs 2 before
  assert.deepStrictEqual(plain(d.cards.pharmacyVisits), { value: 1, change: null }); // nothing to compare with
  assert.strictEqual(d.reports, 3);
});
test('cards: compliance = on-time reports / expected working days of ACTIVE reps; change in points', () => {
  const { d } = run();
  assert.deepStrictEqual(plain(d.cards.compliance), { value: 10, change: 5 }); // 2 on time of 20 expected; before 1 of 20
  assert.deepStrictEqual(plain(d.compliance.map(r => [r.repId, r.pct, r.onTime, r.late, r.expected])),
    [['REP-0001', 20, 2, 0, 10], ['REP-0002', 0, 0, 1, 10]]); // inactive REP-0003 not listed
});
test('most visited facilities: by facility ID, older visits via their workplace row, merges followed, free text kept apart', () => {
  const { d } = run();
  assert.deepStrictEqual(plain(d.facilities), [
    { id: 'FAC-A', name: 'مصحة الشفاء', visits: 3, doctors: 2 },
    { id: '', name: 'عيادة قديمة', visits: 1, doctors: 1 },        // ties are ordered alphabetically
    { id: 'FAC-B', name: 'مستشفى النور', visits: 1, doctors: 1 }]);
  assert.deepStrictEqual(plain(d.cards.topFacility), { name: 'مصحة الشفاء', value: 3 });
});
test('daily series covers every day of the period; GPS verdicts are counted (missing verdict = unavailable)', () => {
  const { d } = run();
  assert.strictEqual(d.daily.length, 10);
  assert.deepStrictEqual(plain(d.daily[0]), { date: '2026-09-01', doctors: 2, pharmacies: 1 });
  assert.deepStrictEqual(plain(d.daily.find(x => x.date === '2026-09-06')), { date: '2026-09-06', doctors: 0, pharmacies: 0 }); // draft
  assert.deepStrictEqual(plain(d.gps.map(x => [x.status, x.count])),
    [['تم التحقق', 1], ['خارج النطاق', 1], ['غير حاسم', 1], ['مرجع غير مؤكد', 0], ['غير متاح', 3]]);
});
test('latest reports: drafts excluded, newest submission first, visit counts filled', () => {
  const { d } = run();
  assert.deepStrictEqual(plain(d.latest.map(r => [r.id, r.visits, r.repName])),
    [['R3', 2, 'مندوب ثانٍ'], ['R2', 1, 'مندوب أول'], ['R1', 3, 'مندوب أول'], ['R0', 2, 'مندوب أول']]);
});
test('performance: the second call within 5 minutes is served from cache (no Reports read); snapshots never read', () => {
  const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin');
  env.resetReads(); env.call(adm, 'dashboard', { from: '2026-09-01', to: '2026-09-10' });
  assert.ok(env.reads.Reports > 0);
  env.resetReads(); env.call(adm, 'dashboard', { from: '2026-09-01', to: '2026-09-10' });
  assert.strictEqual(env.reads.Reports || 0, 0);
});
test('guards: admin only; invalid or too long periods refused; nothing is written', () => {
  const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin'), snap = env.snapshot();
  expectError(() => env.call(env.session('REP-0001', 'rep'), 'dashboard', {}), /غير مصرح/);
  expectError(() => env.call(adm, 'dashboard', { from: '2026-09-10', to: '2026-09-01' }), /تاريخ البداية/);
  expectError(() => env.call(adm, 'dashboard', { from: '2024-01-01', to: '2026-09-01' }), /سنة/);
  env.call(adm, 'dashboard', { from: '2026-09-01', to: '2026-09-10' });
  assert.strictEqual(env.snapshot(), snap);
});
test('empty period: zeros, no crash', () => {
  const env = makeEnv(SEED()), d = env.call(env.session('ADMIN', 'admin'), 'dashboard', { from: '2025-01-01', to: '2025-01-01' });
  assert.deepStrictEqual([d.cards.doctorVisits.value, d.cards.pharmacyVisits.value, d.cards.topFacility, d.facilities.length], [0, 0, null, 0]);
});

/* ---------- client rendering (App4) ---------- */
const client = () => {
  const root = path.join(__dirname, '..'), app1 = fs.readFileSync(path.join(root, 'App1.html'), 'utf8'), app4 = fs.readFileSync(path.join(root, 'App4.html'), 'utf8');
  const fn = name => { const m = app4.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\r?\\n\\}')); assert.ok(m, name); return m[0]; };
  const escLine = app1.split('\n').find(l => l.includes(',esc=t=>'));
  const src = ['const ' + escLine.slice(escLine.indexOf('esc=t=>')).replace(/;\s*$/, ''), app4.match(/const DASH_CSS=[\s\S]*?';\r?\n/)[0],
    app4.match(/const DASH_GPS_COLORS=[^\n]*/)[0], fn('dashChange'), fn('dashLine'), fn('dashDonut'), fn('dashCompliance'), fn('dashHtml')].join('\n');
  const c = vm.createContext({}); vm.runInContext(src + '\n;this.dashHtml=dashHtml', c); return c.dashHtml;
};
test('client: renders the four cards, two lines, the donut and both tables without NaN/undefined', () => {
  const { d } = run(), html = client()(d);
  ['زيارات الأطباء', 'زيارات الصيدليات', 'درجة التزام المندوبين', 'أكثر المنشآت زيارة', 'مصحة الشفاء', '▲ +150%', '▲ +5 نقطة', 'لا توجد بيانات سابقة للمقارنة']
    .forEach(t => assert.ok(html.includes(t), 'missing: ' + t));
  assert.strictEqual((html.match(/<polyline /g) || []).length, 2);
  assert.ok(/class="dt">6</.test(html)); // donut centre = all visits of the period
  assert.strictEqual((html.match(/class="dr"/g) || []).length, 4);
  assert.ok(!/NaN|undefined/.test(html));
  assert.strictEqual((html.match(/class="dk /g) || []).length, 4);
  assert.ok(html.includes('🩺') && !html.includes('👨'));
  const same = client()(Object.assign({}, d, { cards: Object.assign({}, d.cards, { compliance: { value: 0, change: 0 } }) }));
  assert.ok(same.includes('بدون تغيير عن الفترة السابقة') && !same.includes('0 نقطة'));
});
test('client: an empty period and a single-day period render cleanly', () => {
  const env = makeEnv(SEED()), d = env.call(env.session('ADMIN', 'admin'), 'dashboard', { from: '2025-01-01', to: '2025-01-01' }), html = client()(d);
  assert.ok(!/NaN|undefined/.test(html));
  assert.ok(html.includes('لا توجد زيارات أطباء في الفترة') && html.includes('—'));
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
