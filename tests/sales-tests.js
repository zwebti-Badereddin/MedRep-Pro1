// Local tests for distributor sales, using the rows of the sample file «تقرير مبيعات صنف Clodil»: parsing (header, total row,
// 8 or 7 columns, dates, thousands separators), name matching and remembered links, duplicates, batches, and the analysis
// against visits.
// Run: node tests/sales-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const J = x => JSON.stringify(x);
const FILE = [
  ['التاريخ', 'المنطقة', 'اسم العميل / الصيدلية', 'اسم الصنف', 'المادة الفعالة', 'الكمية', 'سعر الوحدة (د.ل)', 'الإجمالي (د.ل)'],
  ['2026-11-01', 'ابوسليم', 'صيدلية الشفاء الحديثة', 'Clodil', 'Clopidogrel 75mg', '50', '28.50', '1,425.00'],
  ['2026-11-02', 'الهضبة', 'صيدلية ابن سينا', 'Clodil', 'Clopidogrel 75mg', '35', '28.50', '997.50'],
  ['2026-11-03', 'وسط البلاد', 'صيدلية قرطبة', 'Clodil', 'Clopidogrel 75mg', '60', '28.50', '1,710.00'],
  ['2026-11-04', 'قرجي', 'صيدلية التاجوري', 'Clodil', 'Clopidogrel 75mg', '45', '28.50', '1,282.50'],
  ['2026-11-05', 'قصر بن غشير', 'صيدلية القدس', 'Clodil', 'Clopidogrel 75mg', '30', '28.50', '855.00'],
  ['2026-11-06', 'ابوسليم', 'صيدلية النور', 'Clodil', 'Clopidogrel 75mg', '55', '28.50', '1,567.50'],
  ['2026-11-07', 'الهضبة', 'صيدلية الحياة', 'Clodil', 'Clopidogrel 75mg', '40', '28.50', '1,140.00'],
  ['2026-11-07', 'وسط البلاد', 'صيدلية العافية', 'Clodil', 'Clopidogrel 75mg', '65', '28.50', '1,852.50'],
  ['2026-11-08', 'قرجي', 'صيدلية السلام', 'Clodil', 'Clopidogrel 75mg', '25', '28.50', '712.50'],
  ['2026-11-09', 'قصر بن غشير', 'صيدلية طرابلس', 'Clodil', 'Clopidogrel 75mg', '50', '28.50', '1,425.00'],
  ['', '', '', '', 'المجموع الكلي', '455', '', '12,967.50']
];
const SEED = (extra) => Object.assign({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workDays', value: '0,1,2,3,4,5,6' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }, { id: 'REP-0002', name: 'البراء', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية الشفاء', active: true }, { id: 'PH-0002', name: 'صيدلية ابن سينا', active: true },
    { id: 'PH-0003', name: 'صيدلية الزهراء', active: true }, { id: 'PH-0004', name: 'صيدلية النور', active: true }],
  Products: [{ id: 'PROD-0001', name: 'Clodil 75mg', status: 'نشط' }, { id: 'PROD-0002', name: 'Aspi', status: 'نشط' }],
  Reports: [
    { id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-11-03', status: 'معتمد', doctors: J([{ name: 'د. علي', intro: 'Clodil 75mg' }]),
      pharmacies: J([{ name: 'صيدلية ابن سينا', pharmacyId: 'PH-0002', product: 'Clodil 75mg' }, { name: 'صيدلية الزهراء', pharmacyId: 'PH-0003', product: 'Clodil 75mg' }]) },
    { id: 'R2', no: 'MR-2', repId: 'REP-0002', date: '2026-11-04', status: 'مرسل', doctors: '[]', pharmacies: J([{ name: 'صيدلية الشفاء', pharmacyId: 'PH-0001', product: 'Aspi' }]) },
    { id: 'R3', no: 'MR-3', repId: 'REP-0002', date: '2026-11-05', status: 'مسودة', doctors: '[]', pharmacies: J([{ name: 'صيدلية النور', pharmacyId: 'PH-0004' }]) }]
}, extra || {});
const setup = (extra) => { const env = makeEnv(SEED(extra)); return { env, adm: env.session('ADM-1', 'admin'), rep: env.session('REP-0001', 'rep') }; };
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the sample file: 10 rows, header and total row skipped, 455 units, 12,967.50 LYD; matching; nothing written in preview', () => {
  const { env, adm } = setup();
  const pre = env.call(adm, 'salesImport', { rows: FILE });
  assert.deepStrictEqual([pre.add, pre.dup, pre.invalid.length, pre.qty, pre.value, pre.from, pre.to], [10, 0, 0, 455, 12967.5, '2026-11-01', '2026-11-09']);
  assert.strictEqual(pre.matchedProd, 10, '«Clodil» matches «Clodil 75mg»');
  assert.strictEqual(pre.matchedPh, 2, 'ابن سينا and النور match by name');
  assert.ok(pre.unmatched.ph.some(u => u.raw === 'صيدلية الشفاء الحديثة' && u.region === 'ابوسليم'));
  assert.ok(pre.pharmacies.length === 4 && pre.products.length === 2);
  assert.strictEqual(env.rows('Sales').length, 0);
});
test('import with a name link: the link is remembered; the same rows are never added twice', () => {
  const { env, adm } = setup();
  const out = env.call(adm, 'salesImport', { rows: FILE, commit: true, map: { ph: { 'صيدلية الشفاء الحديثة': 'PH-0001' } } });
  assert.strictEqual(out.added, 10); assert.match(out.batch, /^SB-\d{8}-\d{6}$/);
  assert.strictEqual(env.rows('Sales').find(r => r.customer === 'صيدلية الشفاء الحديثة').pharmacyId, 'PH-0001');
  const again = env.call(adm, 'salesImport', { rows: FILE });
  assert.deepStrictEqual([again.add, again.dup], [0, 10]);
  const other = env.call(adm, 'salesImport', { rows: [['2026-12-01', 'ابوسليم', 'صيدلية الشفاء الحديثة', 'Clodil', '10', '28.5', '285']] });
  assert.deepStrictEqual([other.add, other.matchedPh], [1, 1], 'remembered link, 7-column row without the active ingredient');
});
test('dates and numbers in other forms; invalid rows reported with their line', () => {
  const { env, adm } = setup();
  const r = env.call(adm, 'salesImport', { rows: [['05/11/2026', 'x', 'صيدلية النور', 'Aspi', '١٢', '2', '24'], ['46332', 'x', 'صيدلية النور', 'Aspi', '3', '2', ''],
    ['غدًا', 'x', 'صيدلية النور', 'Aspi', '1', '1', '1'], ['2026-11-05', 'x', '', 'Aspi', '1', '1', '1'], ['2026-11-05', 'x', 'صيدلية النور', 'Aspi', '0', '1', '1']] });
  assert.deepStrictEqual([r.add, r.qty, r.value, r.from], [2, 15, 30, '2026-11-05']);
  assert.strictEqual(J(r.invalid.map(x => x.line)), J([3, 4, 5]));
});
test('analysis: by product with promotion, by region, the three pharmacy lists, and by rep (sent/approved visits only)', () => {
  const { env, adm } = setup();
  env.call(adm, 'salesImport', { rows: FILE, commit: true, map: { ph: { 'صيدلية الشفاء الحديثة': 'PH-0001' } } });
  const a = env.call(adm, 'salesAnalysis', { from: '2026-11-01', to: '2026-11-30' });
  assert.deepStrictEqual([a.totals.qty, a.totals.value, a.totals.rows, a.totals.unlinked], [455, 12967.5, 10, 7]);
  const clodil = a.products.find(p => p.product === 'Clodil 75mg');
  assert.deepStrictEqual([clodil.qty, clodil.value, clodil.doctorPromo, clodil.pharmacyVisits], [455, 12967.5, 1, 2]);
  assert.ok(a.products.some(p => p.product === 'Aspi' && p.qty === 0 && p.pharmacyVisits === 1), 'promoted but not sold');
  const abs = a.regions.find(g => g.region === 'ابوسليم');
  assert.deepStrictEqual([abs.qty, abs.pharmacies, abs.visitedPharmacies, abs.visits], [105, 2, 1, 1]);
  assert.strictEqual(J(a.pharmacies.both.map(x => x.name).sort()), J(['صيدلية ابن سينا', 'صيدلية الشفاء'].sort()));
  assert.strictEqual(J(a.pharmacies.visitNoBuy.map(x => x.name)), J(['صيدلية الزهراء']));
  assert.ok(a.pharmacies.buyNoVisit.some(x => x.name === 'صيدلية النور' && x.linked), 'the draft visit to النور does not count');
  assert.strictEqual(a.pharmacies.buyNoVisit.length, 8);
  const sara = a.reps.find(r => r.rep === 'سارة');
  assert.deepStrictEqual([sara.visitedPharmacies, sara.buying, sara.qty, sara.value], [2, 1, 35, 997.5]);
});
test('batches: listed and removed whole; admin only', () => {
  const { env, adm, rep } = setup();
  const out = env.call(adm, 'salesImport', { rows: FILE, commit: true });
  const b = env.call(adm, 'salesAnalysis', { from: '2026-11-01', to: '2026-11-30' }).batches;
  assert.deepStrictEqual([b.length, b[0].rows, b[0].qty, b[0].value], [1, 10, 455, 12967.5]);
  assert.strictEqual(env.call(adm, 'salesDeleteBatch', { batch: out.batch }), 10);
  assert.strictEqual(env.rows('Sales').length, 0);
  expectError(() => env.call(adm, 'salesDeleteBatch', { batch: 'x' }), /غير صالحة/);
  expectError(() => env.call(rep, 'salesAnalysis', {}), /غير مصرح/);
});
test('English report: sales units and value per product for the month', () => {
  const { env, adm } = setup();
  env.call(adm, 'salesImport', { rows: FILE, commit: true });
  const r = env.call(adm, 'reportEn', { ym: '2026-11' });
  const c = r.products.find(p => p.name === 'Clodil 75mg');
  assert.deepStrictEqual([r.hasSales, c.salesUnits, c.salesValue, r.totals.salesUnits, r.totals.salesValue], [true, 455, 12967.5, 455, 12967.5]);
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
