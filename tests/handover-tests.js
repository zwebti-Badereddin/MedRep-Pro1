// Local tests for the handover features: visit export, setup checklist, support contact, bulk import. Run: node tests/handover-tests.js
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { makeEnv } = require('./gas-harness');

const NOW = new Date().toISOString(), A = { lat: 32.89, lng: 13.2 };
const docs = [{ name: 'د. أحمد', specialty: 'باطنة', place: 'مصحة الشفاء', sector: 'خاص', time: 'صباحًا', intro: 'Cardio', remind: '—',
  samples: [{ product: 'Neuro', qty: 2 }, { product: 'Neuro', qty: 1 }, { product: 'Gastro', qty: 1 }], gps: { status: 'تم التحقق', dist: 42.6 } },
  { name: 'د. سالم', specialty: 'قلب', place: 'عيادة', s1: 'Old', gps: { status: 'غير متاح' } }];
const phs = [{ name: 'صيدلية "النور"', loc: 'شارع 1', near: 'مصحة', time: 'مساءً', product: 'Cardio', act: 'عرض', order: '=2 علب' }];
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'companyName', value: 'فارما كير للدعاية الطبية' }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Reps: [{ id: 'REP-0001', name: 'مندوب أول', active: true }, { id: 'REP-0002', name: 'مندوب ثانٍ', active: true }],
  KPI: [{ key: 'visits', name: 'الزيارات', target: 100, weight: 30, active: true }],
  Doctors: [{ id: 'DOC-0007', name: 'د. أحمد سالم', active: true }],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية الشفاء', active: true }],
  Facilities: [{ id: 'FAC-A', name: 'مصحة الشفاء', status: 'نشط', lat: A.lat, lng: A.lng, geoState: 'مؤكد', geoSource: 'ADMIN_MAP', geoBy: 'ADM-1', geoAt: NOW },
    { id: 'FAC-B', name: 'عيادة', status: 'نشط' }, { id: 'FAC-PH', name: 'قديم', status: 'نشط', legacyEntity: 'Pharmacies' }],
  Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-10-05', status: 'معتمد', notes: 'يوم جيد', doctors: JSON.stringify(docs), pharmacies: JSON.stringify(phs) },
    { id: 'R2', no: 'MR-2', repId: 'REP-0002', date: '2026-09-01', status: 'مرسل', doctors: '[]', pharmacies: JSON.stringify(phs) }]
});
const setup = seed => { const env = makeEnv(seed || SEED()); return { env, adm: env.session('ADM-1', 'admin'), rep: env.session('REP-0001', 'rep') }; };
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- export ---------- */
test('export: one row per visit with rep name, merged samples, legacy samples, GPS verdict and distance; notes once per report', () => {
  const { env, adm } = setup(), out = env.call(adm, 'exportVisits', { from: '2026-10-01', to: '2026-10-31' });
  assert.deepStrictEqual([out.visits, out.reports], [3, 1]);
  const [h, d1, d2, p1] = out.rows, col = n => h.indexOf(n);
  assert.strictEqual(h.length, 20);
  assert.deepStrictEqual([d1[col('المندوب')], d1[col('نوع الزيارة')], d1[col('العينات المجانية')], d1[col('التحقق من الموقع')], d1[col('المسافة (م)')], d1[col('ملاحظة اليوم')]],
    ['مندوب أول', 'طبيب', 'Neuro ×3 · Gastro', 'تم التحقق', 43, 'يوم جيد']);
  assert.strictEqual(d1[col('المنتج المذكَّر به')], '');
  assert.deepStrictEqual([d2[col('العينات المجانية')], d2[col('المسافة (م)')], d2[col('ملاحظة اليوم')]], ['Old', '', '']);
  assert.deepStrictEqual([p1[col('نوع الزيارة')], p1[col('مكان العمل / العنوان')], p1[col('أقرب منشأة')], p1[col('الطلبية')]], ['صيدلية', 'شارع 1', 'مصحة', '=2 علب']);
  assert.ok(env.rows('Audit').some(a => a.action === 'export_visits'));
});
test('export: filters by rep and status; refuses a missing, reversed or longer-than-a-year period; admin only', () => {
  const { env, adm, rep } = setup();
  assert.strictEqual(env.call(adm, 'exportVisits', { from: '2026-01-01', to: '2026-12-31', repId: 'REP-0002' }).visits, 1);
  assert.strictEqual(env.call(adm, 'exportVisits', { from: '2026-01-01', to: '2026-12-31', status: 'معتمد' }).reports, 1);
  expectError(() => env.call(adm, 'exportVisits', { from: '', to: '2026-12-31' }), /فترة صحيحة/);
  expectError(() => env.call(adm, 'exportVisits', { from: '2026-12-31', to: '2026-01-01' }), /فترة صحيحة/);
  expectError(() => env.call(adm, 'exportVisits', { from: '2025-01-01', to: '2026-12-31' }), /سنة واحدة/);
  expectError(() => env.call(rep, 'exportVisits', { from: '2026-01-01', to: '2026-12-31' }), /غير مصرح/);
});
test('export still works after the license has ended', () => {
  const { env, adm } = setup(); env.props.set('LICENSE_UNTIL', '2020-01-01');
  assert.strictEqual(env.call(adm, 'exportVisits', { from: '2026-10-01', to: '2026-10-31' }).visits, 3);
});

/* ---------- setup checklist ---------- */
test('setup checklist: demo company, no e-mail, no products, default KPI, reps, a facility without location -> incomplete with details', () => {
  const { env, adm } = setup(), st = JSON.parse(JSON.stringify(env.call(adm, 'setupStatus'))), it = k => st.items.find(i => i.key === k);
  assert.strictEqual(st.complete, false);
  assert.deepStrictEqual(st.items.map(i => [i.key, i.done]), [['company', false], ['email', false], ['products', false], ['kpi', false], ['reps', true], ['facilities', false]]);
  assert.strictEqual(it('facilities').detail, '1 منشأة بلا موقع معتمد');
  assert.deepStrictEqual(st.items.map(i => i.go), ['co', 'co', 'prod', 'kpi', 'Reps', 'Facilities']);
});
test('setup checklist: complete once everything is set (stopped products and disabled facilities do not count)', () => {
  const s = SEED();
  s.Settings = [{ key: 'companyName', value: 'شركة النخبة' }, { key: 'reportEmail', value: 'm@x.ly' }];
  s.Products = [{ id: 'PROD-0001', name: 'Med', status: 'نشط' }];
  s.KPI = [{ key: 'visits', target: 220 }];
  s.Facilities[1].status = 'معطل';
  assert.strictEqual(setup(s).env.call(setup(s).adm, 'setupStatus').complete, true);
  s.Products[0].status = 'متوقف';
  const st = setup(s); assert.strictEqual(st.env.call(st.adm, 'setupStatus').complete, false);
});

/* ---------- support contact ---------- */
test('support contact: from SUPPORT_CONTACT in the boot of reps and admins; empty when not set', () => {
  const a = setup(); assert.strictEqual(a.env.call(a.rep, 'bootstrap').support, '');
  const b = setup(); b.env.props.set('SUPPORT_CONTACT', 'الدعم الفني: 0912345678');
  assert.strictEqual(b.env.call(b.adm, 'bootstrap').support, 'الدعم الفني: 0912345678');
  assert.strictEqual(b.env.call(b.rep, 'bootstrap').support, 'الدعم الفني: 0912345678');
});

/* ---------- import ---------- */
test('import preview: header skipped, duplicates (existing and within the paste) and short names reported, nothing written', () => {
  const { env, adm } = setup(), before = env.snapshot();
  const r = JSON.parse(JSON.stringify(env.call(adm, 'importMaster', { entity: 'Doctors', rows: [['الاسم', 'التخصص', 'القطاع'], ['د. خالد علي', 'قلب', 'عام'], ['احمد سالم', 'باطنة', ''],
    ['', '', ''], ['خالد  علي', 'قلب', 'خاص'], ['ab'], ['منى سعيد', 'أطفال', 'مستشفى حكومي']] })));
  assert.strictEqual(env.snapshot(), before);
  assert.deepStrictEqual(r.add.map(x => [x.name, x.specialty, x.sector]), [['د. خالد علي', 'قلب', 'عام'], ['منى سعيد', 'أطفال', 'عام']]);
  assert.deepStrictEqual(r.dup.map(x => [x.line, x.existing]), [[3, 'د. أحمد سالم'], [5, 'مكرر في السطر 2']]);
  assert.deepStrictEqual(r.invalid.map(x => x.line), [6]);
});
test('import commit: ids continue after the highest, rows are reviewed, active, added by the admin; one write; audited', () => {
  const { env, adm } = setup();
  env.resetReads();
  const r = env.call(adm, 'importMaster', { entity: 'Doctors', commit: true, rows: [['خالد علي', 'قلب'], ['منى سعيد']] });
  assert.strictEqual(r.added, 2);
  const rows = env.rows('Doctors');
  assert.deepStrictEqual(rows.map(d => d.id), ['DOC-0007', 'DOC-0008', 'DOC-0009']);
  assert.deepStrictEqual([rows[1].name, rows[1].specialty, String(rows[1].active), rows[1].addedBy, String(rows[1].reviewed)], ['خالد علي', 'قلب', 'true', 'ADM-1', 'true']);
  assert.strictEqual(env.writes.filter(w => w.sheet === 'Doctors').length, 1);
  assert.ok(env.rows('Audit').some(a => a.action === 'import_doctors' && a.details === '2'));
  assert.strictEqual(env.call(adm, 'importMaster', { entity: 'Doctors', commit: true, rows: [['خالد علي']] }).added, 0); // re-run adds nothing
});
test('import pharmacies maps name, location, nearest facility; only doctors and pharmacies; admin only; 1000-row limit', () => {
  const { env, adm, rep } = setup();
  env.call(adm, 'importMaster', { entity: 'Pharmacies', commit: true, rows: [['صيدلية الأمل', 'الهاني', 'مصحة العلمين']] });
  const p = env.rows('Pharmacies')[1];
  assert.deepStrictEqual([p.id, p.name, p.location, p.nearFacility], ['PH-0002', 'صيدلية الأمل', 'الهاني', 'مصحة العلمين']);
  expectError(() => env.call(adm, 'importMaster', { entity: 'Reps', rows: [['x']] }), /غير مسموح/);
  expectError(() => env.call(rep, 'importMaster', { entity: 'Doctors', rows: [['x']] }), /غير مصرح/);
  expectError(() => env.call(adm, 'importMaster', { entity: 'Doctors', rows: Array.from({ length: 1001 }, (_, i) => ['طبيب رقم ' + i]) }), /1000/);
});

test('import facilities: type default, coordinates optional (two cells or "lat, lng"), invalid coordinates rejected, duplicates vs live facilities', () => {
  const { env, adm } = setup();
  const r = JSON.parse(JSON.stringify(env.call(adm, 'importMaster', { entity: 'Facilities', rows: [['اسم المنشأة', 'النوع'], ['مستشفى الخضراء', 'مستشفى', 'طريق المطار', '32.85', '13.21'],
    ['مصحة النور', '', '', '32.88, 13.17'], ['عيادة الأمل', 'عيادة', 'الهاني'], ['مركز بلا طول', '', '', '32.8'], ['مكان بعيد', '', '', '200', '13'], ['مصحه الشفاء']] })));
  assert.deepStrictEqual(r.add.map(x => [x.name, x.type, x.lat, x.lng]), [['مستشفى الخضراء', 'مستشفى', 32.85, 13.21], ['مصحة النور', 'منشأة طبية', 32.88, 13.17], ['عيادة الأمل', 'عيادة', '', '']]);
  assert.deepStrictEqual(r.invalid.map(x => [x.line, x.reason]), [[5, 'إحداثيات غير صحيحة'], [6, 'إحداثيات غير صحيحة']]);
  assert.deepStrictEqual(r.dup.map(x => x.existing), ['مصحة الشفاء']);
});
test('import facilities commit: new FAC ids; imported coordinates stay a proposal (not approved) and count as "needs review"', () => {
  const { env, adm } = setup();
  const r = env.call(adm, 'importMaster', { entity: 'Facilities', commit: true, rows: [['مستشفى الخضراء', 'مستشفى', 'طريق المطار', '32.85', '13.21'], ['عيادة الأمل']] });
  assert.strictEqual(r.added, 2);
  const [a, b] = env.rows('Facilities').slice(-2);
  assert.ok(/^FAC-[0-9A-F]{12}$/.test(a.id) && a.id !== b.id && a.legacyId === a.id && a.legacyEntity === 'DOCTOR_FACILITY');
  assert.deepStrictEqual([a.status, a.geoState, a.geoSource, a.geoBy, String(a.lat)], ['نشط', 'مراجعة مطلوبة', 'ADMIN_IMPORT', '', '32.85']);
  assert.deepStrictEqual([b.geoState, b.geoSource, b.lat], ['', '', '']);
  assert.ok(!env.ctx.facilityApproved_(a));
  const list = env.call(adm, 'facilitiesList', {}), imp = list.find(f => f.id === a.id);
  assert.ok(imp && !imp.approved);
  assert.strictEqual(JSON.parse(JSON.stringify(env.call(adm, 'setupStatus'))).items.find(i => i.key === 'facilities').detail, '3 منشأة بلا موقع معتمد');
});

/* ---------- client ---------- */
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app1 = read('App1.html'), app2 = read('App2.html'), app4 = read('App4.html');
const fn = (src, name) => { const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\r?\\n\\}|function ' + name + '\\([^\\n]*\\}')); assert.ok(m, 'function ' + name); return m[0]; };
const client = (() => {
  const escLine = app1.split('\n').find(l => l.includes(',esc=t=>'));
  const src = ['const ' + escLine.slice(escLine.indexOf('esc=t=>')).replace(/;\s*$/, '') + ';', fn(app1, 'csvCell'), fn(app1, 'csvText'),
    app2.match(/const parsePasted=[^\n]*/)[0], fn(app2, 'importResultHtml'), fn(app4, 'setupCardHtml')].join('\n');
  const c = vm.createContext({}); vm.runInContext(src + '\n;this.api={csvText,parsePasted,importResultHtml,setupCardHtml}', c); return c.api;
})();
test('client CSV: BOM for Excel, quoting of commas/quotes/newlines, formula-like cells neutralised', () => {
  const t = client.csvText([['أ', 'b,c'], ['قال "نعم"', 'x\ny'], ['=SUM(A1)', '-5', '@x', '+1', 42]]);
  assert.strictEqual(t, '﻿أ,"b,c"\r\n"قال ""نعم""","x\ny"\r\n\'=SUM(A1),\'-5,\'@x,\'+1,42');
});
test('client import: pasted Excel lines split by tab; result lists to add, duplicates and invalid lines (escaped)', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(client.parsePasted('أ\tب\r\nج'))), [['أ', 'ب'], ['ج']]);
  const h = client.importResultHtml({ add: [{ name: '<b>x</b>', specialty: 'قلب' }], dup: [{ line: 3, name: 'y', existing: 'Y' }], invalid: [{ line: 4, reason: 'قصير' }] }, false);
  assert.ok(h.includes('سيُضاف 1') && h.includes('موجود مسبقًا 1') && h.includes('سطر 3') && h.includes('&lt;b&gt;') && !h.includes('<b>x</b>'));
  assert.ok(client.importResultHtml({ added: 5, add: [], dup: [], invalid: [] }, true).includes('أُضيف 5'));
});
test('client setup card: progress, one button per item with its screen, hidden when complete', () => {
  const h = client.setupCardHtml({ complete: false, items: [{ key: 'company', go: 'co', label: 'اسم الشركة', done: true, detail: 'النخبة' }, { key: 'reps', go: 'Reps', label: 'المندوبون', done: false, detail: '0 مندوب نشط' }] });
  assert.ok(h.includes('1 من 2') && h.includes('data-go="Reps"') && h.includes('si ok') && h.includes('0 مندوب نشط'));
  assert.strictEqual(client.setupCardHtml({ complete: true, items: [] }), '');
});
test('login page carries the support meta tag, filled by doGet', () => {
  assert.ok(read('Index.html').includes('<meta name="medrep-support" content="<?= support ?>">'));
  assert.ok(read('Main.js').includes('page.support = supportContact_()'));
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
