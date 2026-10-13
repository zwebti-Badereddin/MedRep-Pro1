// Local tests for the read-only facility model V2 preview. Run: node tests/facility-v2-preview-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const NOW = '2026-10-13T10:00:00.000Z', A = { lat: 32.8900, lng: 13.2000 };
const near = (p, m) => ({ lat: p.lat + m / 111320, lng: p.lng }); // m metres north
const loc = (id, fac, p, extra) => Object.assign({ id, facilityId: fac, lat: p.lat, lng: p.lng, radius: 150, source: 'ADMIN_MAP', state: 'مؤكد', approvedBy: 'ADM-0002', approvedAt: NOW, version: 1, active: true }, extra);
const fac = (id, name, extra) => Object.assign({ id, name, status: 'نشط', legacyEntity: 'SHARED_DOCTOR_FACILITY', legacyId: id }, extra);
const dwp = (id, doctorId, workplace, extra) => Object.assign({ id, doctorId, doctorName: doctorId, workplace, active: true, reviewed: 'true' }, extra);
const rel = (id, doctorId, facilityId, wid, active) => ({ id, doctorId, facilityId, active: active === false ? false : true, legacyWorkplaceId: wid });
const SEED = () => ({
  Doctors: [{ id: 'DOC-0001', name: 'أحمد', active: true }, { id: 'DOC-0002', name: 'محمد', active: true }, { id: 'DOC-0003', name: 'سالم', active: true }],
  DoctorWorkplaces: [dwp('DWP-00001', 'DOC-0001', 'مصحة الشفاء'), dwp('DWP-00002', 'DOC-0002', 'مصحة الشفاء'),
    dwp('DWP-00003', 'DOC-0002', 'عيادة النور'), dwp('DWP-00004', 'DOC-0003', 'عيادة النور')],
  Facilities: [fac('FAC-SH-A', 'مصحة الشفاء'), fac('FAC-SH-N1', 'عيادة النور'), fac('FAC-SH-N2', 'عيادة النور')],
  FacilityLocations: [loc('LOC-A-V1', 'FAC-SH-A', near(A, 300), { active: false }), loc('LOC-A-V2', 'FAC-SH-A', A, { version: 2 }),
    loc('LOC-N1', 'FAC-SH-N1', { lat: 32.80, lng: 13.10 }), loc('LOC-N2', 'FAC-SH-N2', { lat: 32.70, lng: 13.00 })],
  DoctorPlaces: [rel('DP-1', 'DOC-0001', 'FAC-SH-A', 'DWP-00001'), rel('DP-2', 'DOC-0002', 'FAC-SH-A', 'DWP-00002'),
    rel('DP-3', 'DOC-0002', 'FAC-SH-N1', 'DWP-00003'), rel('DP-4', 'DOC-0003', 'FAC-SH-N2', 'DWP-00004')]
});
const plan = seed => { const env = makeEnv(seed, { legacyFacilitySchema: true }); return { env, p: env.ctx.previewFacilityModelV2_(NOW) }; };
const wp = (p, id) => p.workplaces.find(x => x.workplaceId === id);
const fa = (p, id) => p.facilities.find(x => x.id === id);
const plain = x => JSON.parse(JSON.stringify(x));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('read-only: the owner preview changes no cell in any sheet', () => {
  const s = SEED(); s.Reports = [{ id: 'R1', doctors: JSON.stringify([{ name: 'أحمد', doctorId: 'DOC-0001', workplaceId: 'DWP-00001' }]), snapshot: '{"x":1}' }];
  const env = makeEnv(s, { legacyFacilitySchema: true }), before = JSON.stringify(Object.keys(env.sheets).map(n => [n, env.sheets[n]._data]));
  const out = env.ctx.previewFacilityModelV2();
  assert.strictEqual(out.readOnly, true);
  assert.strictEqual(JSON.stringify(Object.keys(env.sheets).map(n => [n, env.sheets[n]._data])), before);
});
test('shared facility: two doctors map to ONE facility with the latest active approved location', () => {
  const { p } = plan(SEED());
  assert.strictEqual(wp(p, 'DWP-00001').facilityId, 'FAC-SH-A');
  assert.strictEqual(wp(p, 'DWP-00002').facilityId, 'FAC-SH-A');
  const f = fa(p, 'FAC-SH-A');
  assert.strictEqual(f.doctors, 2); assert.strictEqual(f.approved, true); assert.strictEqual(f.geo.geoVersion, 2);
  assert.strictEqual(f.geo.lat, A.lat); assert.strictEqual(f.geo.from, 'FacilityLocations');
  assert.strictEqual(p.counts.facilitiesToCreate, 0); assert.strictEqual(p.ready, true);
});
test('homonyms: same-name facilities stay separate and are only REPORTED as possible duplicates', () => {
  const { p } = plan(SEED());
  assert.strictEqual(wp(p, 'DWP-00003').facilityId, 'FAC-SH-N1');
  assert.strictEqual(wp(p, 'DWP-00004').facilityId, 'FAC-SH-N2');
  const d = p.duplicates.find(x => [x.a, x.b].sort().join() === 'FAC-SH-N1,FAC-SH-N2');
  assert.ok(d && d.sameName === true && d.distance > 100);
});
test('near facilities (< 100 m) with different names are reported as possible duplicates', () => {
  const s = SEED();
  s.Facilities.push(fac('FAC-SH-X', 'مستشفى الشفاء الخاص'));
  s.FacilityLocations.push(loc('LOC-X', 'FAC-SH-X', near(A, 50)));
  s.DoctorWorkplaces.push(dwp('DWP-00005', 'DOC-0003', 'مستشفى الشفاء الخاص'));
  s.DoctorPlaces.push(rel('DP-5', 'DOC-0003', 'FAC-SH-X', 'DWP-00005'));
  const { p } = plan(s), d = p.duplicates.find(x => [x.a, x.b].sort().join() === 'FAC-SH-A,FAC-SH-X');
  assert.ok(d && d.sameName === false && d.distance < 100 && d.distance > 40);
});
test('workplace without any facility: a facility is planned, approved legacy coordinates are preserved, IDs never collide', () => {
  const s = SEED();
  s.DoctorWorkplaces.push(dwp('DWP-00009', 'DOC-0001', 'عيادة قديمة', { lat: 32.5, lng: 13.5, refBy: 'ADMIN_MAP', refState: 'مؤكد', reviewed: 'true' }));
  s.Facilities.push(fac('FAC-V2-DWP-00009', 'سجل يحمل المعرّف نفسه مسبقًا', { legacyEntity: 'Pharmacies', legacyId: 'PH-1' }));
  const { p } = plan(s), w = wp(p, 'DWP-00009'), f = fa(p, w.facilityId);
  assert.strictEqual(w.how, 'create'); assert.strictEqual(w.facilityId, 'FAC-V2-DWP-00009-2');
  assert.strictEqual(f.isNew, true); assert.strictEqual(f.approved, true); assert.strictEqual(f.geo.geoBy, 'MIGRATION_V2'); assert.strictEqual(f.geo.lat, 32.5);
});
test('inactive relation: falls back to the per-workplace legacy facility exactly like facilityForLegacy_ does today', () => {
  const s = SEED();
  s.DoctorPlaces[0].active = false;
  s.Facilities.push(fac('FAC-DW-DWP-00001', 'مصحة الشفاء', { legacyEntity: 'DoctorWorkplaces', legacyId: 'DWP-00001' }));
  const { env, p } = plan(s);
  assert.strictEqual(wp(p, 'DWP-00001').how, 'legacyFacility');
  assert.strictEqual(wp(p, 'DWP-00001').facilityId, env.ctx.facilityForLegacy_('DoctorWorkplaces', 'DWP-00001').id);
});
test('blockers and warnings: duplicate IDs stop the migration; orphan rows are reported', () => {
  const s = SEED();
  s.DoctorWorkplaces.push(dwp('DWP-00002', 'DOC-0003', 'نسخة مكررة'));
  s.DoctorWorkplaces.push(dwp('DWP-00010', 'DOC-9999', 'طبيب محذوف'));
  const { p } = plan(s);
  assert.strictEqual(p.ready, false);
  assert.deepStrictEqual(plain(p.blockers.find(b => b.type === 'duplicateIds')), { type: 'duplicateIds', sheet: 'DoctorWorkplaces', ids: ['DWP-00002'] });
  assert.ok(p.warnings.some(w => w.type === 'orphanWorkplace' && w.workplaceId === 'DWP-00010'));
});
test('visit coverage: own, colleague (legacy C1), missing, name-only and malformed reports are counted; Reports untouched', () => {
  const s = SEED();
  s.Reports = [
    { id: 'R1', doctors: JSON.stringify([{ doctorId: 'DOC-0001', workplaceId: 'DWP-00001' }, { doctorId: 'DOC-0001', workplaceId: 'DWP-00002' },
      { doctorId: 'DOC-0001', workplaceId: 'DWP-77777' }, { doctorId: 'DOC-0001', place: 'مصحة الشفاء' }, { doctorId: 'DOC-0001' }]) },
    { id: 'R2', doctors: 'not json' }];
  const { p } = plan(s);
  assert.deepStrictEqual(plain(p.visits), { total: 5, viaOwnWorkplace: 1, viaColleagueWorkplace: 1, missingWorkplace: 1, nameOnly: 1, noPlace: 1, malformedReports: 1 });
});
test('seed doctors: a doctor with only the legacy text workplace is listed for a planned row', () => {
  const s = SEED(); s.Doctors.push({ id: 'DOC-0004', name: 'قديم', workplace: 'مستوصف', active: true });
  const { p } = plan(s);
  assert.deepStrictEqual(plain(p.seedDoctors), [{ doctorId: 'DOC-0004', workplace: 'مستوصف' }]);
});
test('schema: lists columns to append; an existing facilityId is authoritative; one pointing nowhere blocks', () => {
  const { p } = plan(SEED());
  assert.deepStrictEqual(plain(p.schema.DoctorWorkplaces.columnsToAppend), ['facilityId', 'linkState', 'linkedBy', 'linkedAt']);
  assert.strictEqual(p.schema.Facilities.columnsToAppend.length, 9);
  const env = makeEnv(SEED(), { legacyFacilitySchema: true }), data = env.sheets.DoctorWorkplaces._data;
  data[0].push('facilityId'); data[1].push('FAC-SH-A'); data[2].push('FAC-SH-N1'); // DWP-00002 moved to N1 (e.g. by a facility merge)
  const q = env.ctx.previewFacilityModelV2_(NOW);
  assert.strictEqual(wp(q, 'DWP-00002').facilityId, 'FAC-SH-N1'); assert.strictEqual(wp(q, 'DWP-00002').how, 'existing');
  assert.strictEqual(q.counts.workplacesAlreadyMigrated, 2); assert.strictEqual(q.ready, true);
  data[2][data[0].length - 1] = 'FAC-GONE';
  const r = env.ctx.previewFacilityModelV2_(NOW);
  assert.ok(r.blockers.some(b => b.type === 'facilityIdMissing' && b.workplaceId === 'DWP-00002')); assert.strictEqual(r.ready, false);
});
test('schema: unknown extra columns after the expected ones block the migration', () => {
  const env = makeEnv(SEED(), { legacyFacilitySchema: true }); env.sheets.Facilities._data[0].push('somethingElse');
  const q = env.ctx.previewFacilityModelV2_(NOW);
  assert.ok(q.blockers.some(b => b.type === 'unexpectedExtraColumns' && b.sheet === 'Facilities'));
});
test('unreferenced facilities (left-over per-doctor copies, ADMIN_FACILITY rows) are reported, pharmacies excluded', () => {
  const s = SEED();
  s.Facilities.push(fac('FAC-DW-DWP-00002', 'مصحة الشفاء', { legacyEntity: 'DoctorWorkplaces', legacyId: 'DWP-00002' }));
  s.Facilities.push(fac('FAC-ADM-1', 'مستورد', { legacyEntity: 'ADMIN_FACILITY' }));
  s.Facilities.push(fac('FAC-PH-PH-0001', 'صيدلية', { legacyEntity: 'Pharmacies', legacyId: 'PH-0001' }));
  const { p } = plan(s);
  assert.deepStrictEqual(p.unreferenced.map(f => f.id).sort(), ['FAC-ADM-1', 'FAC-DW-DWP-00002']);
  assert.ok(p.warnings.some(w => w.type === 'adminFacilityRows' && w.count === 1));
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + e.message); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
