// Local tests: competitor notes, pharmacy stock / expiry and order lines — cleaning on save, the admin competitor summary,
// pharmacy alerts, export columns, the English report and the Telegram line.
// Run: node tests/market-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const J = x => JSON.stringify(x);
const month = n => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const SEED = (extra) => Object.assign({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'gpsRadius', value: '150' }, { key: 'gpsRefAcc', value: '50' }, { key: 'workplacePolicy', value: 'soft' }, { key: 'workDays', value: '0,1,2,3,4,5,6' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }, { id: 'REP-0002', name: 'البراء', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Facilities: [{ id: 'FAC-PH-PH-0001', name: 'صيدلية الشفاء', status: 'نشط', legacyEntity: 'Pharmacies', legacyId: 'PH-0001' }],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية الشفاء', active: true }],
  Products: [{ id: 'PROD-0001', name: 'Clodil', status: 'نشط' }, { id: 'PROD-0002', name: 'Aspi', status: 'نشط' }]
}, extra || {});
const setup = (extra) => { const env = makeEnv(SEED(extra)); return { env, rep: env.session('REP-0001', 'rep'), adm: env.session('ADM-1', 'admin') }; };
const today = new Date().toISOString().slice(0, 10);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('saving cleans the new fields: competitor notes (max 5, known types), stock (states, qty, YYYY-MM), order lines (qty ≥ 1)', () => {
  const { env, rep } = setup();
  env.call(rep, 'saveReport', { date: env.today, pharmacies: [{ name: 'صيدلية الشفاء', pharmacyId: 'PH-0001', product: 'Clodil', time: 'صباحًا',
    comp: [{ p: '  Plavix  ', t: 'price', n: 'أرخص بـ 3 دينار' }, { p: 'X', t: 'price' }, { p: 'Zyllt', t: 'hack' }],
    stock: [{ product: 'Clodil', st: 'out' }, { product: 'Aspi', st: 'low', qty: '5', exp: '2027-01' }, { product: 'Aspi', st: 'weird', exp: '2027-13' }, { product: '—', st: 'ok' }],
    orderItems: [{ product: 'Clodil', qty: '20' }, { product: 'Aspi', qty: 0 }, { product: '', qty: 3 }] }],
    doctors: [] });
  const v = JSON.parse(env.rows('Reports')[0].pharmacies)[0];
  assert.strictEqual(J(v.comp), J([{ p: 'Plavix', t: 'price', n: 'أرخص بـ 3 دينار' }, { p: 'Zyllt', t: 'other' }]));
  assert.strictEqual(J(v.stock), J([{ product: 'Clodil', st: 'out' }, { product: 'Aspi', st: 'low', qty: 5, exp: '2027-01' }, { product: 'Aspi', st: 'ok' }]));
  assert.strictEqual(J(v.orderItems), J([{ product: 'Clodil', qty: 20 }]));
});
test('stock and order lines are kept on pharmacy visits only', () => {
  const { env } = setup(), o = {};
  env.ctx.cleanVisitExtras_(o, { stock: [{ product: 'Clodil', st: 'out' }], orderItems: [{ product: 'Clodil', qty: 2 }], comp: [{ p: 'Plavix', t: 'promo' }] }, 'doctor');
  assert.strictEqual(J(o), J({ comp: [{ p: 'Plavix', t: 'promo' }] }));
});
const reports = () => [
  { id: 'R1', no: 'MR-1', repId: 'REP-0001', date: today, status: 'مرسل', doctors: J([{ name: 'د. علي', comp: [{ p: 'Plavix', t: 'price', n: 'أرخص' }] }]),
    pharmacies: J([{ name: 'صيدلية الشفاء', pharmacyId: 'PH-0001', product: 'Clodil', loc: 'ابوسليم', comp: [{ p: 'plavix', t: 'promo' }],
      stock: [{ product: 'Clodil', st: 'out' }, { product: 'Aspi', st: 'ok', exp: month(1) }], orderItems: [{ product: 'Clodil', qty: 20 }, { product: 'Aspi', qty: 5 }] }]) },
  { id: 'R2', no: 'MR-2', repId: 'REP-0002', date: today, status: 'مسودة', doctors: J([{ name: 'د. منى', comp: [{ p: 'Plavix', t: 'objection' }] }]), pharmacies: '[]' }];
test('competitor summary: sent and approved reports only; names grouped ignoring case; by type; details with rep and place', () => {
  const { env, adm } = setup({ Reports: reports() });
  const r = env.call(adm, 'compSummary', { from: today, to: today });
  assert.strictEqual(r.total, 2, 'the draft does not count');
  assert.strictEqual(J([r.products[0].product, r.products[0].count, r.products[0].types]), J(['Plavix', 2, { 'سعر أقل': 1, 'عرض أو بونص': 1 }]));
  assert.ok(r.items.some(c => c.rep === 'سارة' && c.kind === 'طبيب' && c.where === 'د. علي' && c.note === 'أرخص'));
});
test('pharmacy alerts: out of stock and expiry within 90 days, latest observation wins; the Telegram summary has the line', () => {
  const later = { id: 'R3', no: 'MR-3', repId: 'REP-0001', date: today, status: 'معتمد', doctors: '[]',
    pharmacies: J([{ name: 'صيدلية الشفاء', pharmacyId: 'PH-0001', stock: [{ product: 'Aspi', st: 'ok', exp: month(12) }] }]) };
  const { env, adm } = setup({ Reports: reports() });
  let a = env.call(adm, 'pharmAlerts', { from: today, to: today }).alerts;
  assert.strictEqual(J(a.map(x => [x.product, x.reasons[0]])), J([['Clodil', 'نفد'], ['Aspi', a[1].reasons[0]]]));
  assert.match(a[1].reasons[0], /صلاحية خلال \d+ يومًا/);
  const e2 = setup({ Reports: reports().concat([later]) });
  a = e2.env.call(e2.adm, 'pharmAlerts', { from: today, to: today }).alerts;
  assert.strictEqual(J(a.map(x => x.product)), J(['Clodil']), 'a newer visit with a far expiry clears the Aspi alert');
  assert.match(env.ctx.tgSummaryText_(today), /تنبيهات صيدليات \(نفاد أو صلاحية قريبة\): 2/);
});
test('export: competitor, stock and order-line columns', () => {
  const { env, adm } = setup({ Reports: reports() });
  const out = env.call(adm, 'exportVisits', { from: today, to: today }), h = out.rows[0], col = n => h.indexOf(n);
  const ph = out.rows.find(r => r[col('نوع الزيارة')] === 'صيدلية');
  assert.strictEqual(ph[col('أصناف الطلبية')], 'Clodil ×20 · Aspi ×5');
  assert.match(ph[col('مخزون الصيدلية')], /^Clodil: نفد · Aspi: متوفر صلاحية /);
  assert.strictEqual(ph[col('المنافسون')], 'plavix (عرض أو بونص)');
});
test('English report: ordered units per product and a competitor section', () => {
  const { env, adm } = setup({ Reports: reports() });
  const r = env.call(adm, 'reportEn', { ym: today.slice(0, 7) });
  assert.strictEqual(J(r.products.map(p => [p.name, p.orderedUnits])), J([['Clodil', 20], ['Aspi', 5]]));
  assert.strictEqual(r.totals.orderedUnits, 25);
  assert.strictEqual(J(r.competitors), J([{ product: 'Plavix', mentions: 2, types: 'lower price 1, promotion / bonus 1' }]));
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
