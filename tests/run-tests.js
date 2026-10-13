// Local tests for: generic save route (and a pharmacy regression). Run: node tests/run-tests.js
'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const { makeEnv } = require('./gas-harness');
const ROOT = process.env.APP_ROOT || require('path').join(__dirname, '..');

const NOW = new Date().toISOString(), A = { lat: 32.8900, lng: 13.2000 }, N1 = { lat: 32.8000, lng: 13.1000 }, N2 = { lat: 32.7000, lng: 13.0000 };
const loc = (id, fac, p) => ({ id, facilityId: fac, lat: p.lat, lng: p.lng, radius: 150, source: 'ADMIN_MAP', state: 'مؤكد', proposedBy: 'ADM-0001', proposedAt: NOW, approvedBy: 'ADM-0002', approvedAt: NOW, version: 1, active: true, note: '' });
const fac = (id, name) => ({ id, name, type: 'منشأة طبية', status: 'نشط', legacyEntity: 'SHARED_DOCTOR_FACILITY', legacyId: id });
const dwp = (id, doctorId, doctorName, workplace, active) => ({ id, doctorId, doctorName, workplace, sector: 'خاص', active: active === false ? false : true, refState: 'مؤكد', refBy: 'ADMIN_MAP', reviewed: 'true' });
const rel = (id, doctorId, facilityId, wid) => ({ id, doctorId, facilityId, active: true, legacyWorkplaceId: wid });
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'gpsRadius', value: '150' }, { key: 'gpsRefAcc', value: '50' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب', active: true }, { id: 'REP-0003', name: 'مندوب ثالث', active: true }],
  Doctors: [{ id: 'DOC-0001', name: 'أحمد سالم', specialty: 'باطنة', active: true }, { id: 'DOC-0002', name: 'محمد علي', specialty: 'قلب', active: true },
    { id: 'DOC-0003', name: 'سالم خالد', specialty: 'أطفال', active: true }],
  DoctorWorkplaces: [dwp('DWP-00001', 'DOC-0001', 'أحمد سالم', 'مصحة الشفاء'), dwp('DWP-00002', 'DOC-0002', 'محمد علي', 'مصحة الشفاء'),
    dwp('DWP-00003', 'DOC-0002', 'محمد علي', 'عيادة النور'), dwp('DWP-00004', 'DOC-0003', 'سالم خالد', 'عيادة النور'),
    dwp('DWP-00005', 'DOC-0003', 'سالم خالد', 'مركز معطل', false)],
  // Two different physical facilities share the name «عيادة النور» (N1 for DOC-0002, N2 for DOC-0003).
  Facilities: [fac('FAC-SH-A', 'مصحة الشفاء'), fac('FAC-SH-N1', 'عيادة النور'), fac('FAC-SH-N2', 'عيادة النور')],
  FacilityLocations: [loc('LOC-A', 'FAC-SH-A', A), loc('LOC-N1', 'FAC-SH-N1', N1), loc('LOC-N2', 'FAC-SH-N2', N2)],
  DoctorPlaces: [rel('DP-1', 'DOC-0001', 'FAC-SH-A', 'DWP-00001'), rel('DP-2', 'DOC-0002', 'FAC-SH-A', 'DWP-00002'),
    rel('DP-3', 'DOC-0002', 'FAC-SH-N1', 'DWP-00003'), rel('DP-4', 'DOC-0003', 'FAC-SH-N2', 'DWP-00004')],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية الشفاء', active: true }],
  Products: [{ id: 'PROD-0001', name: 'CardioPlus', category: 'عام', status: 'نشط' }, { id: 'PROD-0003', name: 'NeuroVit', category: 'عام', status: 'نشط' }]
});
const gps = p => ({ lat: p.lat, lng: p.lng, acc: 10, ts: Date.now() });
const visit = (o) => Object.assign({ specialty: 'باطنة', intro: 'CardioPlus', time: 'صباحًا', sector: 'خاص' }, o);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const savedDocs = env => JSON.parse(env.rows('Reports')[0].doctors);

/* ---------- 1. generic save route ---------- */
test('save: Doctors / Pharmacies / Reps are refused through the generic route', () => {
  const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin');
  expectError(() => env.call(adm, 'save', { entity: 'Doctors', row: { name: 'طبيب دون تحقق', active: true } }), /كيان غير مسموح/);
  expectError(() => env.call(adm, 'save', { entity: 'Pharmacies', row: { id: 'PH-0001', refBy: 'ADMIN_MAP', refState: 'مؤكد', lat: 1, lng: 1 } }), /كيان غير مسموح/);
  expectError(() => env.call(adm, 'save', { entity: 'Reps', row: { id: 'REP-0001', codeHash: 'x' } }), /كيان غير مسموح/);
  assert.strictEqual(env.rows('Doctors').length, 3);
  assert.strictEqual(env.rows('Pharmacies')[0].refBy, '');
  assert.strictEqual(env.rows('Reps')[0].codeHash, '');
});
test('save: new product with an ID gap gets max+1 and never overwrites an existing record', () => {
  const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin');
  const id = env.call(adm, 'save', { entity: 'Products', row: { name: 'GastroCare', category: 'عام' } });
  assert.strictEqual(id, 'PROD-0004'); // old rule (row count + 1) would have produced PROD-0003 and overwritten NeuroVit
  const p = env.rows('Products');
  assert.strictEqual(p.length, 3);
  assert.strictEqual(p.find(x => x.id === 'PROD-0003').name, 'NeuroVit');
  assert.strictEqual(p.find(x => x.id === 'PROD-0004').status, 'نشط');
});
test('save: an unknown ID is refused instead of being created with a client-chosen ID', () => {
  const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin');
  expectError(() => env.call(adm, 'save', { entity: 'Products', row: { id: 'PROD-0099', name: 'Ghost' } }), /السجل غير موجود/);
  assert.strictEqual(env.rows('Products').length, 2);
});
test('save: editing an existing product still works and keeps unchanged fields', () => {
  const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin');
  env.call(adm, 'save', { entity: 'Products', row: { id: 'PROD-0003', status: 'متوقف' } });
  const p = env.rows('Products').find(x => x.id === 'PROD-0003');
  assert.deepStrictEqual([p.name, p.category, p.status], ['NeuroVit', 'عام', 'متوقف']);
  assert.strictEqual(env.rows('Products').length, 2);
});
test('save: duplicate product name is still refused (existing validation preserved)', () => {
  const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin');
  expectError(() => env.call(adm, 'save', { entity: 'Products', row: { name: 'cardioplus' } }), /المنتج موجود مسبقًا/);
});
test('repSave (internal saveEntity_ user): new rep gets max+1, existing reps untouched; unknown rep ID refused', () => {
  const env = makeEnv(SEED()), adm = env.session('ADMIN', 'admin');
  const id = env.call(adm, 'repSave', { row: { name: 'مندوب جديد', code: '12345' } });
  assert.strictEqual(id, 'REP-0004');
  assert.strictEqual(env.rows('Reps').find(r => r.id === 'REP-0003').name, 'مندوب ثالث');
  expectError(() => env.call(adm, 'repSave', { row: { id: 'REP-0077', name: 'غير موجود' } }), /السجل غير موجود/);
});

/* Doctor-visit / facility tests live in facility-v2-tests.js (facility model V2). */

/* ---------- regression ---------- */
test('regression: pharmacy visit still saves and validates its ID', () => {
  const env = makeEnv(SEED()), rep = env.session('REP-0001', 'rep');
  env.call(rep, 'saveReport', { date: env.today, pharmacies: [{ name: 'صيدلية الشفاء', pharmacyId: 'PH-0001', loc: '' }] });
  assert.strictEqual(JSON.parse(env.rows('Reports')[0].pharmacies)[0].pharmacyId, 'PH-0001');
  expectError(() => env.call(rep, 'saveReport', { date: env.today, pharmacies: [{ name: 'صيدلية الشفاء', pharmacyId: 'PH-0999' }] }), /الصيدلية/);
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + e.message); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
