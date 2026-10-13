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
    fn(app3, 'normSamples'), fn(app3, 'mergeSamples'), fn(app3, 'sampleText'), fn(app3, 'render'),
    fn(app2, 'longDate'), fn(app2, 'visitChips'), fn(app2, 'visitCard')].join('\n');
  const c = vm.createContext({}); vm.runInContext(src + '\n;this.api={normSamples,mergeSamples,sampleText,render,longDate,visitChips,visitCard}', c);
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
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
