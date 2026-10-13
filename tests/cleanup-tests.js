// Local tests for the test-data cleanup (read-only preview + approved execution). Run: node tests/cleanup-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const dwp = (id, doctorId, facilityId) => ({ id, doctorId, doctorName: doctorId, workplace: facilityId, active: true, reviewed: 'true', facilityId, linkState: 'معتمد' });
const SEED = () => ({
  Settings: [{ key: 'companyName', value: 'شركة حقيقية' }],
  KPI: [{ key: 'visits', name: 'الزيارات', target: 100, weight: 30, active: true }],
  Holidays: [{ id: 'HOL-1', date: '2026-12-24', name: 'عيد الاستقلال' }],
  Audit: [{ ts: '2026-10-01', userId: 'ADM-1', role: 'admin', action: 'x', ref: '', details: '' }],
  Doctors: [{ id: 'DOC-0001', name: 'د. أحمد سالم', active: true }, { id: 'DOC-0002', name: 'د. محمد علي', active: true }, { id: 'DOC-0003', name: 'د. خالد', active: true }],
  DoctorWorkplaces: [dwp('DWP-00001', 'DOC-0001', 'FAC-0001'), dwp('DWP-00002', 'DOC-0002', 'FAC-0002'), dwp('DWP-00003', 'DOC-0003', 'FAC-0002'), dwp('DWP-00004', 'DOC-0003', 'FAC-0003')],
  Facilities: [{ id: 'FAC-0001', name: 'عيادة النور', status: 'نشط' }, { id: 'FAC-0002', name: 'مصحة الشفاء', status: 'نشط' }, { id: 'FAC-0003', name: 'منشأة تجربة', status: 'نشط' }],
  FacilityLocations: [{ id: 'LOC-1', facilityId: 'FAC-0001', active: true }, { id: 'LOC-2', facilityId: 'FAC-0002', active: true }, { id: 'LOC-3', facilityId: 'FAC-0003', active: true }],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية الشفاء', active: true }, { id: 'PH-0002', name: 'صيدلية حقيقية', active: true }],
  Products: [{ id: 'PROD-0001', name: 'CardioPlus' }, { id: 'PROD-0002', name: 'GastroCare' }, { id: 'PROD-0003', name: 'NeuroVit' }, { id: 'PROD-0004', name: 'RealMed' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب تجربة', active: true }, { id: 'REP-0002', name: 'مندوب', active: true }],
  Reports: [{ id: 'R1', no: 'MR-2026-10-00001', repId: 'REP-0001', date: '2026-10-10', status: 'مرسل' }, { id: 'R2', no: 'MR-2026-10-00002', repId: 'REP-0002', date: '2026-10-11', status: 'مسودة' }],
  Monthly: [{ id: 'M1', ym: '2026-09', repId: 'REP-0001' }],
  Leaves: [{ id: 'LV-1', repId: 'REP-0002', from: '2026-10-05', to: '2026-10-06' }]
});
const setup = (seed, extra) => {
  const env = makeEnv(seed || SEED()), backups = [];
  env.props.set('REPORT_SEQ', '12');
  if (extra) env.props.set('TEST_CLEANUP_EXTRA', JSON.stringify(extra));
  const folder = { getName: () => 'MedRep Backups', getFiles: () => ({ hasNext: () => false }) };
  env.ctx.DriveApp = { getFoldersByName: () => ({ hasNext: () => true, next: () => folder }), createFolder: () => folder,
    getFileById: () => ({ makeCopy: (name) => { backups.push(name); } }) };
  return { env, backups };
};
const ids = (env, n) => env.rows(n).map(r => r.id);
const plain = x => JSON.parse(JSON.stringify(x));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('preview is read-only and lists the plan with an approval code', () => {
  const { env } = setup(), before = env.snapshot();
  const out = env.ctx.previewTestDataCleanup();
  assert.strictEqual(env.snapshot(), before);
  assert.strictEqual(env.props.get('REPORT_SEQ'), '12');
  assert.ok(out.readOnly && out.ready && /^CLEAN-[0-9A-F]{10}$/.test(out.approvalCode));
  assert.deepStrictEqual(plain(out.counts), { Reports: 2, Monthly: 1, Leaves: 1, FacilityLocations: 1, DoctorWorkplaces: 2, Facilities: 1, Doctors: 2, Pharmacies: 1, Products: 3 });
  assert.ok(out.resetReportSeq);
  assert.ok(out.next.includes(out.approvalCode));
});
test('cascade: a facility shared with a real doctor is kept; a facility only the demo doctor used is removed with its location history', () => {
  const p = setup().env.ctx.previewTestDataCleanup().rows;
  assert.deepStrictEqual(p.Facilities.map(x => x.id), ['FAC-0001']);
  assert.deepStrictEqual(p.FacilityLocations.map(x => x.id), ['LOC-1']);
  assert.deepStrictEqual(p.DoctorWorkplaces.map(x => x.id).sort(), ['DWP-00001', 'DWP-00002']);
  assert.ok(!p.Doctors.some(x => x.id === 'DOC-0003') && !p.Pharmacies.some(x => x.id === 'PH-0002') && !p.Products.some(x => x.name === 'RealMed'));
});
test('TEST_CLEANUP_EXTRA: a test link of a real doctor removes that link and the facility it alone used; keep.Facilities protects one', () => {
  const p = setup(null, { DoctorWorkplaces: ['DWP-00004'], Reps: ['REP-0001'], Doctors: ['DOC-9999'] }).env.ctx.previewTestDataCleanup();
  assert.ok(p.rows.DoctorWorkplaces.some(x => x.id === 'DWP-00004') && p.rows.Facilities.some(x => x.id === 'FAC-0003') && p.rows.FacilityLocations.some(x => x.id === 'LOC-3'));
  assert.ok(!p.rows.Doctors.some(x => x.id === 'DOC-0003'));
  assert.deepStrictEqual(p.rows.Reps.map(x => x.id), ['REP-0001']);
  assert.ok(p.warnings.some(w => w.type === 'extraIdNotFound' && w.id === 'DOC-9999'));
  const k = setup(null, { DoctorWorkplaces: ['DWP-00004'], keep: { Facilities: ['FAC-0003', 'FAC-0001'] } }).env.ctx.previewTestDataCleanup();
  assert.ok(!(k.rows.Facilities || []).some(x => x.id === 'FAC-0003' || x.id === 'FAC-0001'));
});
test('blocker: removing a facility a kept doctor is still linked to stops the plan', () => {
  const { env } = setup(null, { Facilities: ['FAC-0002'] }), p = env.ctx.previewTestDataCleanup();
  assert.ok(!p.ready && p.blockers.some(b => b.type === 'facilityStillLinked' && b.workplaceId === 'DWP-00003'));
  env.props.set('TEST_CLEANUP_APPROVED', p.approvalCode); const before = env.snapshot();
  assert.throws(() => env.ctx.cleanupTestData(), /الموانع/);
  assert.strictEqual(env.snapshot(), before);
});
test('execution refuses without approval and with a stale code, changing nothing', () => {
  const { env, backups } = setup(), before = env.snapshot();
  assert.throws(() => env.ctx.cleanupTestData(), /TEST_CLEANUP_APPROVED/);
  const code = env.ctx.previewTestDataCleanup().approvalCode;
  env.sheets.Reports.appendRow(['R3']); // a new report after the preview changes the plan
  env.props.set('TEST_CLEANUP_APPROVED', code);
  assert.throws(() => env.ctx.cleanupTestData(), /تغيّرت منذ المعاينة/);
  env.sheets.Reports._data.pop();
  assert.strictEqual(env.snapshot(), before);
  assert.strictEqual(backups.length, 0);
});
test('approved execution: backup first, deletes exactly the plan, resets REPORT_SEQ, leaves everything else, audits once', () => {
  const { env, backups } = setup(null, { DoctorWorkplaces: ['DWP-00004'] });
  env.props.set('TEST_CLEANUP_APPROVED', env.ctx.previewTestDataCleanup().approvalCode);
  const out = env.ctx.cleanupTestData();
  assert.strictEqual(backups.length, 1);
  assert.deepStrictEqual(ids(env, 'Reports').concat(ids(env, 'Monthly'), ids(env, 'Leaves')), []);
  assert.deepStrictEqual(ids(env, 'Doctors'), ['DOC-0003']);
  assert.deepStrictEqual(ids(env, 'DoctorWorkplaces'), ['DWP-00003']);
  assert.deepStrictEqual(ids(env, 'Facilities'), ['FAC-0002']);
  assert.deepStrictEqual(ids(env, 'FacilityLocations'), ['LOC-2']);
  assert.deepStrictEqual(ids(env, 'Pharmacies'), ['PH-0002']);
  assert.deepStrictEqual(ids(env, 'Products'), ['PROD-0004']);
  assert.deepStrictEqual(ids(env, 'Reps'), ['REP-0001', 'REP-0002']);
  assert.strictEqual(env.rows('Settings').length, 1); assert.strictEqual(env.rows('KPI').length, 1); assert.strictEqual(env.rows('Holidays').length, 1);
  assert.deepStrictEqual(env.rows('Audit').map(a => a.action), ['x', 'backup', 'cleanup_test_data']);
  assert.strictEqual(env.props.get('REPORT_SEQ'), '0');
  assert.ok(!env.props.has('TEST_CLEANUP_APPROVED'));
  assert.ok(out.after.empty);
  T_headers(env);
});
function T_headers(env) { const T = env.ctx.T || require('vm').runInContext('T', env.ctx); Object.keys(T).forEach(n => assert.deepStrictEqual(env.sheets[n]._data[0], T[n], n)); }
test('a second run finds nothing and refuses', () => {
  const { env } = setup();
  env.props.set('TEST_CLEANUP_APPROVED', env.ctx.previewTestDataCleanup().approvalCode); env.ctx.cleanupTestData();
  const p = env.ctx.previewTestDataCleanup();
  assert.ok(p.empty && p.approvalCode === '');
  assert.throws(() => env.ctx.cleanupTestData(), /لا توجد بيانات تجربة/);
});
test('demo names match despite spacing, a joined "د." prefix, hamza and invisible marks; a missing demo name is reported', () => {
  const s = SEED();
  s.Doctors = [{ id: 'DOC-0001', name: ' د.احمد  سالم ' }, { id: 'DOC-0002', name: '‏د. محمد علي' }, { id: 'DOC-0003', name: 'د. خالد' }];
  s.Pharmacies = [{ id: 'PH-0002', name: 'صيدلية حقيقية' }];
  const p = setup(s).env.ctx.previewTestDataCleanup();
  assert.deepStrictEqual(p.rows.Doctors.map(x => x.id), ['DOC-0001', 'DOC-0002']);
  assert.ok(!p.rows.Pharmacies && p.warnings.some(w => w.type === 'demoNotFound' && w.name === 'صيدلية الشفاء'));
  assert.ok(!p.warnings.some(w => w.type === 'demoNotFound' && w.sheet === 'Doctors'));
});
test('warning when no product would be left', () => {
  const s = SEED(); s.Products = s.Products.slice(0, 3);
  assert.ok(setup(s).env.ctx.previewTestDataCleanup().warnings.some(w => w.type === 'noProductLeft'));
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
