// Local tests for the rep screens (approved design): sample quantities, visit cards, dates, printed report, server cleaning.
// Run: node tests/rep-ui-tests.js
'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const { makeEnv } = require('./gas-harness');

const root = path.join(__dirname, '..'), read = f => fs.readFileSync(path.join(root, f), 'utf8');
const app1 = read('App1.html'), app2 = read('App2.html'), app3 = read('App3.html'), app4 = read('App4.html');
const fn = (src, name) => { const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\r?\\n\\}')); assert.ok(m, 'function ' + name); return m[0]; };
const line = (src, start) => { const l = src.split('\n').find(x => x.trim().startsWith(start)); assert.ok(l, start); return l.trim().replace(/;\s*$/, '') + ';'; };
const escLine = app1.split('\n').find(l => l.includes(',esc=t=>'));
const client = (() => {
  const src = ['const ' + escLine.slice(escLine.indexOf('esc=t=>')).replace(/;\s*$/, '') + ';', line(app1, 'const DAYS='), line(app1, 'const MN='),
    line(app4, 'const svgI='), app4.match(/const IC=\{[\s\S]*?\r?\n\};/)[0],
    fn(app3, 'normSamples'), fn(app3, 'mergeSamples'), fn(app3, 'sampleText'), fn(app3, 'render'), fn(app3, 'vtHM'), fn(app3, 'vtFlagsC'), fn(app3, 'vtCell'), line(app3, 'const COMP_T='), line(app3, 'const STK_T='), line(app3, 'const tName='), fn(app3, 'compTextC'), fn(app3, 'stockTextC'), fn(app3, 'orderTextC'), line(app3, 'const FB_T='), fn(app3, 'fbTextC'),
    fn(app2, 'longDate'), fn(app2, 'visitChips'), fn(app2, 'visitCard')].join('\n');
  const c = vm.createContext({}); vm.runInContext(src + '\n;this.api={normSamples,mergeSamples,sampleText,render,longDate,visitChips,visitCard,vtFlagsC,compTextC,stockTextC,orderTextC}', c);
  return c.api;
})();
const plain = x => JSON.parse(JSON.stringify(x));
const tests = [];
const test = (name, f) => tests.push({ name, fn: f });

test('samples: legacy s1/s2 become one each; new rows keep their quantity, clamped to 1–99; "—" ignored', () => {
  assert.deepStrictEqual(plain(client.normSamples({ s1: 'NeuroVit', s2: '—' })), [{ product: 'NeuroVit', qty: 1 }]);
  assert.deepStrictEqual(plain(client.normSamples({ samples: [{ product: 'A', qty: 0 }, { product: 'B', qty: 150 }, { product: '—', qty: 3 }] })),
    [{ product: 'A', qty: 1 }, { product: 'B', qty: 99 }]);
  assert.deepStrictEqual(plain(client.normSamples({})), []);
});
test('samples: the same product twice is merged and summed (max 99)', () => {
  assert.deepStrictEqual(plain(client.mergeSamples([{ product: 'A', qty: 2 }, { product: 'B', qty: 1 }, { product: 'A', qty: 3 }, { product: 'C', qty: 98 }, { product: 'C', qty: 5 }])),
    [{ product: 'A', qty: 5 }, { product: 'B', qty: 1 }, { product: 'C', qty: 99 }]);
});
test('sampleText: "NeuroVit ×2 · GastroCare"; a legacy visit with the same sample twice reads ×2', () => {
  assert.strictEqual(client.sampleText({ samples: [{ product: 'NeuroVit', qty: 2 }, { product: 'GastroCare', qty: 1 }] }), 'NeuroVit ×2 · GastroCare');
  assert.strictEqual(client.sampleText({ s1: 'X', s2: 'X' }), 'X ×2');
  assert.strictEqual(client.sampleText({}), '');
});
test('header date: "الثلاثاء · 13 أكتوبر 2026"', () => {
  assert.strictEqual(client.longDate('2026-10-13'), 'الثلاثاء · 13 أكتوبر 2026');
});
test('doctor card: name, specialty · facility, chips (intro, reminder, samples, location), menu button; escaped', () => {
  const v = { name: 'د. أحمد <b>سالم</b>', specialty: 'باطنة', place: 'مصحة الشفاء', time: 'صباحًا', intro: 'CardioPlus', remind: 'GastroCare',
    samples: [{ product: 'NeuroVit', qty: 2 }], gps: { lat: 32.9, lng: 13.2 } };
  const h = client.visitCard('d', v, 0, false);
  ['01', 'باطنة · مصحة الشفاء', 'صباحًا', 'تعريف: CardioPlus', 'تذكير: GastroCare', 'عينات: NeuroVit ×2', 'الموقع مسجّل', 'data-more="d0"'].forEach(t => assert.ok(h.includes(t), 'missing ' + t));
  assert.ok(!h.includes('<b>سالم</b>') && h.includes('&lt;b&gt;سالم'));
  assert.ok(!/undefined|NaN/.test(h));
});
test('cards: no location -> "بدون موقع"; a locked (sent) report has no menu button; pharmacy chips', () => {
  const d = client.visitCard('d', { name: 'x', gps: { status: 'غير متاح' } }, 1, true);
  assert.ok(d.includes('بدون موقع') && !d.includes('data-more') && d.includes('02'));
  const p = client.visitCard('p', { name: 'صيدلية الشفاء', loc: 'بن عاشور', product: 'CardioPlus', order: 'علبتان', time: 'مساءً' }, 0, false);
  ['صيدلية الشفاء', 'بن عاشور', 'CardioPlus', 'طلبية: علبتان', 'مساءً'].forEach(t => assert.ok(p.includes(t), 'missing ' + t));
});
test('printed report shows sample quantities, and old reports (s1/s2) still print', () => {
  const base = { company: { color: '#0b6b6f', short: 'PC', name: 'Co', title: 'T' }, no: 'MR-1', rep: 'R', day: 'الثلاثاء', date: '13 / 10 / 2026', notes: '', phs: [] };
  assert.ok(client.render(Object.assign({}, base, { docs: [{ name: 'a', samples: [{ product: 'NeuroVit', qty: 2 }] }] })).includes('NeuroVit ×2'));
  assert.ok(client.render(Object.assign({}, base, { docs: [{ name: 'b', s1: 'GastroCare', s2: '—' }] })).includes('GastroCare'));
});
test('server: samples are cleaned (trim, 1–99, no empty or "—", at most 20 rows); a non-list is dropped', () => {
  const NOW = new Date().toISOString();
  const env = makeEnv({
    Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workplacePolicy', value: 'soft' }],
    Reps: [{ id: 'REP-0001', name: 'م', active: true }], Doctors: [{ id: 'DOC-0001', name: 'أحمد', specialty: 'باطنة', active: true }],
    Facilities: [{ id: 'FAC-A', name: 'مصحة', status: 'نشط', lat: 32.9, lng: 13.2, geoState: 'مؤكد', geoSource: 'ADMIN_MAP', geoBy: 'A', geoAt: NOW, geoVersion: 1 }],
    DoctorWorkplaces: [{ id: 'DWP-00001', doctorId: 'DOC-0001', facilityId: 'FAC-A', active: true, linkState: 'معتمد' }]
  }), rep = env.session('REP-0001', 'rep');
  const many = Array.from({ length: 25 }, (_, i) => ({ product: 'P' + i, qty: 1 }));
  env.call(rep, 'saveReport', { date: env.today, doctors: [
    { name: 'أحمد', doctorId: 'DOC-0001', facilityId: 'FAC-A', samples: [{ product: '  NeuroVit ', qty: 150 }, { product: '—', qty: 1 }, { product: '', qty: 2 }, { product: 'X', qty: 'abc' }] },
    { name: 'أحمد', doctorId: 'DOC-0001', facilityId: 'FAC-A', samples: many },
    { name: 'أحمد', doctorId: 'DOC-0001', facilityId: 'FAC-A', samples: 'NeuroVit' }] });
  const d = JSON.parse(env.rows('Reports')[0].doctors);
  assert.deepStrictEqual(d[0].samples, [{ product: 'NeuroVit', qty: 99 }, { product: 'X', qty: 1 }]);
  assert.strictEqual(d[1].samples.length, 20);
  assert.strictEqual(d[2].samples, undefined);
});

let pass = 0, fail = 0;
test('check-in / check-out: the report shows "in ← out · minutes"; warnings only on the reviewer view', () => {
  const at = (h, m) => new Date(2026, 9, 13, h, m).toISOString();
  const base = { company: { name: 'X', color: '#000', short: 'X', title: 'T' }, no: '1', rep: 'r', day: 'd', date: 'd', notes: '', phs: [] };
  const v = { name: 'a', ci: { t: at(9, 30) }, co: { t: at(9, 31) }, dur: 1 };
  const rep = client.render(Object.assign({}, base, { docs: [v] })), adm = client.render(Object.assign({}, base, { adm: true, docs: [v] }));
  assert.ok(rep.includes('09:30 ← 09:31 · 1 دقيقة') && !rep.includes('قصيرة'));
  assert.ok(adm.includes('زيارة قصيرة جدًا'));
  const a = { ci: { t: at(10, 0) }, co: { t: at(10, 20) }, dur: 20 }, b = { ci: { t: at(10, 10) }, co: { t: at(10, 30) }, dur: 20, sk: -9 };
  assert.strictEqual(JSON.stringify(client.vtFlagsC(b, [a, b])), JSON.stringify(['ساعة الهاتف غير دقيقة (9 د)', 'متداخلة مع زيارة أخرى']));
  assert.ok(!client.render(Object.assign({}, base, { docs: [{ name: 'old' }] })).includes('الدخول والخروج'), 'older visits without times show nothing');
});
test('market information: competitor notes, pharmacy stock and order lines in the report and on the cards', () => {
  const base = { company: { name: 'X', color: '#000', short: 'X', title: 'T' }, no: '1', rep: 'r', day: 'd', date: 'd', notes: '' };
  const ph = { name: 'صيدلية', order: 'تسليم الخميس', orderItems: [{ product: 'Clodil', qty: 20 }], stock: [{ product: 'Clodil', st: 'out' }, { product: 'Aspi', st: 'low', qty: 5, exp: '2027-01' }], comp: [{ p: 'Plavix', t: 'price', n: 'أرخص' }] };
  const html = client.render(Object.assign({}, base, { docs: [{ name: 'د', comp: [{ p: 'Plavix', t: 'promo' }] }], phs: [ph] }));
  assert.ok(html.includes('Plavix (عرض أو بونص)') && html.includes('Plavix (سعر أقل): أرخص'));
  assert.ok(html.includes('Clodil ×20 · تسليم الخميس') || html.includes('Clodil ×20 — تسليم الخميس'));
  assert.ok(html.includes('Clodil: نفد · Aspi: قليل (5) صلاحية 2027-01'));
  const chips = client.visitChips(ph, 'p');
  assert.ok(chips.includes('نفد: Clodil') && chips.includes('منافس: Plavix') && chips.includes('طلبية: Clodil ×20'));
  assert.ok(!client.render(Object.assign({}, base, { docs: [{ name: 'old', order: 'x' }], phs: [] })).includes('المنافسون'));
});
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
