// Local tests for facility model V2 (migration + runtime). Run: node tests/facility-v2-tests.js
'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const { makeEnv } = require('./gas-harness');

const NOW = new Date().toISOString();
const A = { lat: 32.8900, lng: 13.2000 }, N1 = { lat: 32.8000, lng: 13.1000 }, N2 = { lat: 32.7000, lng: 13.0000 }, P = { lat: 32.6000, lng: 12.9000 };
const near = (p, m) => ({ lat: p.lat + m / 111320, lng: p.lng });
const gps = p => ({ lat: p.lat, lng: p.lng, acc: 10, ts: Date.now() });
const plain = x => JSON.parse(JSON.stringify(x));
const fac = (id, name, p, approved, extra) => Object.assign({ id, name, type: 'منشأة طبية', status: 'نشط', legacyEntity: 'DOCTOR_FACILITY', legacyId: id,
  lat: p ? p.lat : '', lng: p ? p.lng : '', radius: 150, geoState: p ? (approved ? 'مؤكد' : 'مراجعة مطلوبة') : '', geoSource: p ? (approved ? 'ADMIN_MAP' : 'REP_PROPOSAL') : '',
  geoBy: approved ? 'ADM-0001' : '', geoAt: approved ? NOW : '', geoVersion: p ? 1 : '' }, extra);
const link = (id, doctorId, facilityId, state, active) => ({ id, doctorId, doctorName: doctorId, workplace: '', active: active === false ? false : true, facilityId, linkState: state || 'معتمد' });
const V2SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'gpsRadius', value: '150' }, { key: 'gpsRefAcc', value: '50' }, { key: 'workplacePolicy', value: 'soft' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب', active: true }],
  Doctors: [{ id: 'DOC-0001', name: 'أحمد سالم', specialty: 'باطنة', active: true }, { id: 'DOC-0002', name: 'محمد علي', specialty: 'قلب', active: true },
    { id: 'DOC-0003', name: 'سالم خالد', specialty: 'أطفال', active: true }],
  Facilities: [fac('FAC-A', 'مصحة الشفاء', A, true), fac('FAC-N1', 'عيادة النور', N1, true), fac('FAC-N2', 'عيادة النور', N2, true), fac('FAC-P', 'مستشفى مقترح', P, false),
    { id: 'FAC-PH-PH-0001', name: 'صيدلية الشفاء', status: 'نشط', legacyEntity: 'Pharmacies', legacyId: 'PH-0001' }],
  DoctorWorkplaces: [link('DWP-00001', 'DOC-0001', 'FAC-A'), link('DWP-00002', 'DOC-0002', 'FAC-A'), link('DWP-00003', 'DOC-0002', 'FAC-N1'), link('DWP-00004', 'DOC-0003', 'FAC-N2')],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية الشفاء', active: true }],
  Products: [{ id: 'PROD-0001', name: 'CardioPlus', status: 'نشط' }]
});
const visit = o => Object.assign({ specialty: 'باطنة', intro: 'CardioPlus', time: 'صباحًا', sector: 'خاص' }, o);
const rep = env => env.session('REP-0001', 'rep'), adm = env => env.session('ADMIN', 'admin');
const docs = env => JSON.parse(env.rows('Reports')[0].doctors);
const links = (env, doctorId, facilityId) => env.rows('DoctorWorkplaces').filter(w => (!doctorId || w.doctorId === doctorId) && (!facilityId || w.facilityId === facilityId));
const setPolicy = (env, v) => { env.sheets.Settings._data.forEach(r => { if (r[0] === 'workplacePolicy') r[1] = v; }); env.clearCache(); };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };

/* ---------- migration ---------- */
const LOC = (id, f, p, extra) => Object.assign({ id, facilityId: f, lat: p.lat, lng: p.lng, radius: 150, source: 'ADMIN_MAP', state: 'مؤكد', approvedBy: 'ADM-0002', approvedAt: NOW, version: 1, active: true }, extra);
const LEGACY = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب', active: true }],
  Doctors: [{ id: 'DOC-0001', name: 'أحمد سالم', active: true }, { id: 'DOC-0002', name: 'محمد علي', active: true },
    { id: 'DOC-0003', name: 'سالم خالد', active: true }, { id: 'DOC-0004', name: 'قديم', workplace: 'مستوصف قديم', active: true }],
  DoctorWorkplaces: [{ id: 'DWP-00001', doctorId: 'DOC-0001', workplace: 'مصحة الشفاء', active: true }, { id: 'DWP-00002', doctorId: 'DOC-0002', workplace: 'مصحة الشفاء', active: true },
    { id: 'DWP-00003', doctorId: 'DOC-0002', workplace: 'عيادة النور', active: true }, { id: 'DWP-00004', doctorId: 'DOC-0003', workplace: 'عيادة النور', active: true }],
  Facilities: [{ id: 'FAC-SH-A', name: 'مصحة الشفاء', status: 'نشط', legacyEntity: 'SHARED_DOCTOR_FACILITY', legacyId: 'FAC-SH-A' },
    { id: 'FAC-SH-N1', name: 'عيادة النور', status: 'نشط', legacyEntity: 'SHARED_DOCTOR_FACILITY', legacyId: 'FAC-SH-N1' },
    { id: 'FAC-SH-N2', name: 'عيادة النور', status: 'نشط', legacyEntity: 'SHARED_DOCTOR_FACILITY', legacyId: 'FAC-SH-N2' },
    { id: 'FAC-DW-DWP-00002', name: 'مصحة الشفاء', status: 'نشط', legacyEntity: 'DoctorWorkplaces', legacyId: 'DWP-00002' }],
  FacilityLocations: [LOC('LOC-A', 'FAC-SH-A', A), LOC('LOC-N1', 'FAC-SH-N1', N1), LOC('LOC-N2', 'FAC-SH-N2', N2)],
  DoctorPlaces: [{ id: 'DP-1', doctorId: 'DOC-0001', facilityId: 'FAC-SH-A', active: true, legacyWorkplaceId: 'DWP-00001' },
    { id: 'DP-2', doctorId: 'DOC-0002', facilityId: 'FAC-SH-A', active: true, legacyWorkplaceId: 'DWP-00002' },
    { id: 'DP-3', doctorId: 'DOC-0002', facilityId: 'FAC-SH-N1', active: true, legacyWorkplaceId: 'DWP-00003' },
    { id: 'DP-4', doctorId: 'DOC-0003', facilityId: 'FAC-SH-N2', active: true, legacyWorkplaceId: 'DWP-00004' }],
  Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: '2026-01-05', status: 'معتمد',
    doctors: JSON.stringify([{ name: 'أحمد سالم', doctorId: 'DOC-0001', workplaceId: 'DWP-00001', place: 'مصحة الشفاء' }]), pharmacies: '[]', snapshot: '{"frozen":true}' }]
});
test('guard: before the migration the app refuses to work with a clear message instead of writing misaligned rows', () => {
  const env = makeEnv(LEGACY(), { legacyFacilitySchema: true });
  expectError(() => env.call(rep(env), 'bootstrap', {}), /migrateFacilityModelV2/);
  expectError(() => env.call(rep(env), 'saveReport', { date: env.today, doctors: [] }), /migrateFacilityModelV2/);
});
test('migration: appends columns, links every workplace to its facility, copies approved coordinates, touches no report', () => {
  const env = makeEnv(LEGACY(), { legacyFacilitySchema: true });
  const before = { reports: JSON.stringify(env.sheets.Reports._data), places: JSON.stringify(env.sheets.DoctorPlaces._data), locs: JSON.stringify(env.sheets.FacilityLocations._data) };
  const out = env.ctx.migrateFacilityModelV2();
  const T = vm.runInContext('T', env.ctx);
  assert.deepStrictEqual(env.sheets.Facilities._data[0], T.Facilities); assert.deepStrictEqual(env.sheets.DoctorWorkplaces._data[0], T.DoctorWorkplaces);
  const f = id => env.rows('DoctorWorkplaces').find(w => w.id === id).facilityId;
  assert.deepStrictEqual([f('DWP-00001'), f('DWP-00002'), f('DWP-00003'), f('DWP-00004')], ['FAC-SH-A', 'FAC-SH-A', 'FAC-SH-N1', 'FAC-SH-N2']);
  const a = env.rows('Facilities').find(x => x.id === 'FAC-SH-A');
  assert.deepStrictEqual([a.lat, a.lng, a.geoState, a.geoSource, a.geoBy], [A.lat, A.lng, 'مؤكد', 'ADMIN_MAP', 'ADM-0002']);
  assert.strictEqual(out.seededWorkplaces, 1); // DOC-0004 had only the legacy text workplace
  const seeded = env.rows('DoctorWorkplaces').find(w => w.doctorId === 'DOC-0004');
  assert.ok(seeded && env.rows('Facilities').some(x => x.id === seeded.facilityId && x.name === 'مستوصف قديم'));
  assert.strictEqual(env.rows('Facilities').find(x => x.id === 'FAC-DW-DWP-00002').status, 'معطل'); // left-over copy hidden
  assert.strictEqual(JSON.stringify(env.sheets.Reports._data), before.reports);
  assert.strictEqual(JSON.stringify(env.sheets.DoctorPlaces._data), before.places);
  assert.strictEqual(JSON.stringify(env.sheets.FacilityLocations._data), before.locs);
  assert.strictEqual(env.rows('Settings').find(r => r.key === 'workplacePolicy').value, 'soft');
  assert.strictEqual(out.after.ready, true); assert.strictEqual(out.after.counts.workplacesAlreadyMigrated, out.after.counts.workplaces);
});
test('migration: a rerun changes nothing (only its audit line), and the migrated data works end-to-end', () => {
  const env = makeEnv(LEGACY(), { legacyFacilitySchema: true });
  env.ctx.migrateFacilityModelV2();
  const noAudit = () => JSON.stringify(Object.keys(env.sheets).filter(n => n !== 'Audit').sort().map(n => [n, env.sheets[n]._data]));
  const snap = noAudit(), out = env.ctx.migrateFacilityModelV2();
  assert.strictEqual(noAudit(), snap);
  assert.deepStrictEqual([out.facilitiesCreated, out.workplacesLinked, out.facilityLocationsCopied, out.columnsAdded], [0, 0, 0, 0]);
  env.call(rep(env), 'saveReport', { date: env.today, doctors: [visit({ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: 'FAC-SH-A', place: 'مصحة الشفاء', gps: gps(A) })] });
  const d = JSON.parse(env.rows('Reports').find(r => r.id !== 'R1').doctors)[0];
  assert.deepStrictEqual([d.workplaceId, d.gps.status, !!d.linkPending], ['DWP-00001', 'تم التحقق', false]);
});
test('migration: blockers (duplicate IDs) stop it before ANY write', () => {
  const s = LEGACY(); s.DoctorWorkplaces.push({ id: 'DWP-00002', doctorId: 'DOC-0003', workplace: 'نسخة', active: true });
  const env = makeEnv(s, { legacyFacilitySchema: true }), snap = env.snapshot();
  expectError(() => env.ctx.migrateFacilityModelV2(), /توقف الترحيل دون أي كتابة/);
  assert.strictEqual(env.snapshot(), snap);
});

/* ---------- runtime: save / submit ---------- */
test('linked doctor: visit by facilityId -> his link row, facility name, verified GPS, no pending flag', () => {
  const env = makeEnv(V2SEED());
  env.call(rep(env), 'saveReport', { date: env.today, doctors: [visit({ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: 'FAC-A', place: 'x', gps: gps(A) })] });
  const d = docs(env)[0];
  assert.deepStrictEqual([d.facilityId, d.workplaceId, d.place, d.gps.status, !!d.linkPending], ['FAC-A', 'DWP-00001', 'مصحة الشفاء', 'تم التحقق', false]);
});
test('soft policy: first visit of a doctor at a facility saves, creates ONE pending link, and still verifies GPS', () => {
  const env = makeEnv(V2SEED()), r = rep(env);
  const v = () => visit({ name: 'سالم خالد', doctorId: 'DOC-0003', facilityId: 'FAC-A', place: 'مصحة الشفاء', gps: gps(A) });
  env.call(r, 'saveReport', { date: env.today, doctors: [v(), v()] });
  const l = links(env, 'DOC-0003', 'FAC-A');
  assert.strictEqual(l.length, 1); assert.strictEqual(l[0].linkState, 'بانتظار');
  const [a, b] = docs(env);
  assert.deepStrictEqual([a.workplaceId, b.workplaceId, a.linkPending, a.gps.status], [l[0].id, l[0].id, true, 'تم التحقق']);
  env.call(r, 'saveReport', { date: env.today, doctors: docs(env) });
  assert.strictEqual(links(env, 'DOC-0003', 'FAC-A').length, 1);
  assert.strictEqual(env.rows('Audit').filter(x => x.action === 'propose_doctor_link').length, 1);
});
test('strict policy: unlinked visit refused; link request is pending; after admin approval the visit saves', () => {
  const env = makeEnv(V2SEED()); setPolicy(env, 'strict'); const r = rep(env); // setPolicy clears the cache (sessions included)
  const body = { date: env.today, doctors: [visit({ name: 'سالم خالد', doctorId: 'DOC-0003', facilityId: 'FAC-A', place: 'مصحة الشفاء' })] };
  expectError(() => env.call(r, 'saveReport', body), /غير مرتبط بهذه المنشأة/);
  const req = env.call(r, 'requestDoctorLink', { doctorId: 'DOC-0003', facilityId: 'FAC-A' });
  assert.strictEqual(req.linkState, 'بانتظار');
  expectError(() => env.call(r, 'saveReport', body), /غير مرتبط بهذه المنشأة/);
  env.call(adm(env), 'linkAct', { id: req.id, op: 'approve' });
  env.call(r, 'saveReport', body);
  assert.strictEqual(docs(env)[0].workplaceId, req.id);
});
test('legacy visit pointing at a colleague\'s workplace row resolves to THAT facility (and asks to link this doctor)', () => {
  const env = makeEnv(V2SEED());
  env.call(rep(env), 'saveReport', { date: env.today, doctors: [visit({ name: 'أحمد سالم', doctorId: 'DOC-0001', workplaceId: 'DWP-00003', place: 'عيادة النور', gps: gps(N1) })] });
  const d = docs(env)[0], l = links(env, 'DOC-0001', 'FAC-N1');
  assert.deepStrictEqual([d.facilityId, d.gps.status, d.linkPending, l.length, l[0].linkState], ['FAC-N1', 'تم التحقق', true, 1, 'بانتظار']);
});
test('invalid or disabled facility is refused; a merged facility resolves to the surviving one', () => {
  const s = V2SEED(); s.Facilities.push(fac('FAC-OFF', 'منشأة معطلة', A, true, { status: 'معطل' }), fac('FAC-OLD', 'مصحة الشفاء القديمة', null, false, { status: 'معطل', mergedInto: 'FAC-A' }));
  const env = makeEnv(s), r = rep(env), one = id => ({ date: env.today, doctors: [visit({ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: id, place: '' })] });
  expectError(() => env.call(r, 'saveReport', one('FAC-NOPE')), /مكان المنشأة غير صالح/);
  expectError(() => env.call(r, 'saveReport', one('FAC-OFF')), /المنشأة معطّلة/);
  env.call(r, 'saveReport', one('FAC-OLD'));
  assert.deepStrictEqual([docs(env)[0].facilityId, docs(env)[0].workplaceId], ['FAC-A', 'DWP-00001']);
});
test('homonym facilities stay separate: the verdict uses the chosen facility only', () => {
  const env = makeEnv(V2SEED());
  env.call(rep(env), 'saveReport', { date: env.today, doctors: [
    visit({ name: 'سالم خالد', doctorId: 'DOC-0003', facilityId: 'FAC-N2', place: 'عيادة النور', gps: gps(N2) }),
    visit({ name: 'سالم خالد', doctorId: 'DOC-0003', facilityId: 'FAC-N2', place: 'عيادة النور', gps: gps(N1) })] });
  assert.deepStrictEqual(docs(env).map(d => d.gps.status), ['تم التحقق', 'خارج النطاق']);
});

/* ---------- runtime: review ---------- */
test('review: same verdict as at save; pending links listed; approval requires and then approves them; snapshot frozen', () => {
  const env = makeEnv(V2SEED()), a = adm(env);
  env.call(rep(env), 'submitReport', { date: env.today, doctors: [visit({ name: 'سالم خالد', doctorId: 'DOC-0003', facilityId: 'FAC-A', place: 'مصحة الشفاء', gps: gps(A) })] });
  const r0 = env.rows('Reports')[0];
  const sum = env.call(a, 'gpsReviewSummary', { id: r0.id });
  assert.deepStrictEqual([sum.visits[0].status, sum.pendingLinks.length], ['تم التحقق', 1]);
  expectError(() => env.call(a, 'reviewReport', { id: r0.id, approve: true }), /ارتباطات أطباء بمنشآت بانتظار الاعتماد/);
  env.call(a, 'reviewReport', { id: r0.id, approve: true, approveLinks: true });
  const r1 = env.rows('Reports')[0];
  assert.strictEqual(r1.status, 'معتمد');
  assert.strictEqual(links(env, 'DOC-0003', 'FAC-A')[0].linkState, 'معتمد');
  assert.ok(!JSON.parse(r1.doctors)[0].linkPending);
  assert.strictEqual(r1.snapshot, r0.snapshot);
});
test('gpsReference (admin map): by facilityId, and through a merged facility', () => {
  const s = V2SEED(); s.Facilities.push(fac('FAC-OLD', 'قديمة', null, false, { status: 'معطل', mergedInto: 'FAC-A' }));
  const env = makeEnv(s), a = adm(env);
  assert.strictEqual(env.call(a, 'gpsReference', { kind: 'doctor', facilityId: 'FAC-A', doctorId: 'DOC-0001' }).id, 'FAC-A');
  assert.strictEqual(env.call(a, 'gpsReference', { kind: 'doctor', facilityId: 'FAC-OLD', doctorId: 'DOC-0001' }).id, 'FAC-A');
  assert.strictEqual(env.call(a, 'gpsReference', { kind: 'doctor', facilityId: 'FAC-P', doctorId: 'DOC-0001' }), null); // not approved
});

/* ---------- runtime: administration ---------- */
test('setLoc: approves the facility, re-verifies its visits with ONE Reports read, keeps snapshots, logs history', () => {
  const env = makeEnv(V2SEED()), a = adm(env);
  env.call(rep(env), 'submitReport', { date: env.today, doctors: [visit({ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: 'FAC-P', place: 'مستشفى مقترح', gps: gps(P) }),
    visit({ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: 'FAC-A', place: 'مصحة الشفاء', gps: gps(A) })] });
  const r0 = env.rows('Reports')[0];
  assert.strictEqual(JSON.parse(r0.doctors)[0].gps.status, 'مرجع غير مؤكد');
  env.resetReads();
  env.call(a, 'facilityAct', { id: 'FAC-P', op: 'setLoc', lat: P.lat, lng: P.lng });
  assert.strictEqual(env.reads.Reports, 1);
  const r1 = env.rows('Reports')[0], g = JSON.parse(r1.doctors)[0].gps;
  assert.deepStrictEqual([g.status, g.recheck.previousStatus], ['تم التحقق', 'مرجع غير مؤكد']);
  const other = JSON.parse(r1.doctors)[1].gps; // a visit at ANOTHER facility is not touched
  assert.deepStrictEqual([other.status, other.recheck], ['تم التحقق', undefined]);
  assert.strictEqual(r1.snapshot, r0.snapshot);
  const f = env.rows('Facilities').find(x => x.id === 'FAC-P');
  assert.deepStrictEqual([f.geoState, f.geoSource, f.geoBy, f.geoVersion], ['مؤكد', 'ADMIN_MAP', 'ADMIN', 2]);
  assert.ok(env.rows('FacilityLocations').some(l => l.facilityId === 'FAC-P' && String(l.active) !== 'false' && l.state === 'مؤكد'));
});
test('rename keeps coordinates; disabling a facility leaves every doctor link untouched', () => {
  const env = makeEnv(V2SEED()), a = adm(env);
  env.call(a, 'facilityAct', { id: 'FAC-A', op: 'edit', row: { name: 'مستشفى الشفاء', type: 'مستشفى' } });
  const f = env.rows('Facilities').find(x => x.id === 'FAC-A');
  assert.deepStrictEqual([f.name, f.lat, f.geoState], ['مستشفى الشفاء', A.lat, 'مؤكد']);
  const before = JSON.stringify(links(env, null, 'FAC-A'));
  env.call(a, 'facilityAct', { id: 'FAC-A', op: 'toggle' });
  assert.strictEqual(JSON.stringify(links(env, null, 'FAC-A')), before);
  assert.ok(!env.call(rep(env), 'bootstrap', {}).facilities.some(x => x.id === 'FAC-A'));
});
test('merge facilities: links move by ID, a duplicate link is disabled, old visits follow the merge', () => {
  const s = V2SEED();
  s.Facilities.push(fac('FAC-A2', 'الشفاء (مكرر)', near(A, 30), false));
  s.DoctorWorkplaces.push(link('DWP-00005', 'DOC-0001', 'FAC-A2'), link('DWP-00006', 'DOC-0003', 'FAC-A2'));
  const env = makeEnv(s), a = adm(env);
  env.call(a, 'facilityAct', { id: 'FAC-A2', op: 'merge', into: 'FAC-A' });
  const w = id => env.rows('DoctorWorkplaces').find(x => x.id === id);
  assert.strictEqual(String(w('DWP-00005').active), 'false');           // DOC-0001 already linked to FAC-A
  assert.strictEqual(w('DWP-00006').facilityId, 'FAC-A');               // DOC-0003 moved
  const old = env.rows('Facilities').find(x => x.id === 'FAC-A2');
  assert.deepStrictEqual([old.mergedInto, old.status], ['FAC-A', 'معطل']);
  assert.strictEqual(env.call(a, 'gpsReference', { kind: 'doctor', facilityId: 'FAC-A2' }).id, 'FAC-A');
});
test('proposeFacility: similar name or < 100 m is offered first (no write); confirmNew creates a pending proposal + link', () => {
  const env = makeEnv(V2SEED()), r = rep(env), snap = env.snapshot();
  const byName = env.call(r, 'proposeFacility', { name: 'مصحه  الشفاء', lat: 33.5, lng: 14.5, doctorId: 'DOC-0003' });
  assert.deepStrictEqual(plain(byName.similar.map(x => x.id)), ['FAC-A']);
  const byDistance = env.call(r, 'proposeFacility', { name: 'مركز جديد', lat: near(N2, 40).lat, lng: N2.lng, doctorId: 'DOC-0003' });
  assert.deepStrictEqual(plain(byDistance.similar.map(x => x.id)), ['FAC-N2']);
  assert.strictEqual(env.snapshot(), snap);
  const made = env.call(r, 'proposeFacility', { name: 'مركز جديد', lat: near(N2, 40).lat, lng: N2.lng, doctorId: 'DOC-0003', confirmNew: true });
  const f = env.rows('Facilities').find(x => x.id === made.facility.id);
  assert.deepStrictEqual([f.geoSource, f.geoState, made.facility.reviewed], ['REP_PROPOSAL', 'مراجعة مطلوبة', false]);
  assert.strictEqual(links(env, 'DOC-0003', f.id)[0].linkState, 'بانتظار');
  expectError(() => env.call(r, 'proposeFacility', { name: 'إحداثيات خاطئة', lat: 95, lng: 13.2 }), /خط العرض وخط الطول/);
});
test('proposeFacility (rep): no location is accepted and labelled by reason; GPS source and accuracy are recorded, never approved', () => {
  const env = makeEnv(V2SEED()), r = rep(env), get = id => env.rows('Facilities').find(x => x.id === id);
  const noFix = get(env.call(r, 'proposeFacility', { name: 'مستوصف الإشارة الضعيفة', locSource: 'none' }).facility.id);
  const away = get(env.call(r, 'proposeFacility', { name: 'عيادة أضيفت من المكتب', locSource: 'away' }).facility.id);
  const bare = get(env.call(r, 'proposeFacility', { name: 'بلا إحداثيات' }).facility.id);
  assert.deepStrictEqual([noFix.geoSource, noFix.geoState, noFix.lat], ['REP_NO_FIX', '', '']);
  assert.deepStrictEqual([away.geoSource, bare.geoSource], ['REP_AWAY', 'REP_NO_FIX']);
  assert.strictEqual(env.rows('FacilityLocations').filter(l => [noFix.id, away.id, bare.id].includes(l.facilityId)).length, 0);
  const weak = env.call(r, 'proposeFacility', { name: 'مركز القراءة الضعيفة', lat: 31.5, lng: 11.5, acc: 320, locSource: 'gps_weak' }), fw = get(weak.facility.id);
  assert.deepStrictEqual([fw.geoSource, fw.geoState, weak.facility.reviewed], ['REP_PROPOSAL', 'مراجعة مطلوبة', false]);
  const good = get(env.call(r, 'proposeFacility', { name: 'مركز القراءة الجيدة', lat: 31.0, lng: 11.0, acc: 12, locSource: 'gps' }).facility.id);
  const note = id => env.rows('FacilityLocations').filter(l => l.facilityId === id).map(l => l.note).join('|');
  assert.ok(/ضعيفة/.test(note(fw.id)) && /320/.test(note(fw.id)), note(fw.id));
  assert.ok(/GPS هاتف المندوب/.test(note(good.id)) && /12/.test(note(good.id)), note(good.id));
  const aud = env.rows('Audit').filter(a => a.action === 'propose_facility').map(a => a.details).join('\n');
  assert.ok(/loc=تعذّر التقاط الموقع في المنشأة/.test(aud) && /loc=أضافها من خارج المنشأة/.test(aud) && /loc=GPS ضعيف \(±320 م\)/.test(aud), aud);
  const forged = get(env.call(r, 'proposeFacility', { name: 'مصدر مزيف', lat: 30.5, lng: 10.5, locSource: 'ADMIN_MAP' }).facility.id);
  assert.deepStrictEqual([forged.geoSource, forged.geoState], ['REP_PROPOSAL', 'مراجعة مطلوبة']);
});
test('lookups: facilities come from Facilities only (no pharmacies, disabled or merged); each doctor lists his links', () => {
  const s = V2SEED(); s.DoctorWorkplaces.push(link('DWP-00009', 'DOC-0003', 'FAC-A', 'بانتظار'));
  const env = makeEnv(s), b = env.call(rep(env), 'bootstrap', {});
  assert.deepStrictEqual(plain(b.facilities.map(f => f.id)), ['FAC-A', 'FAC-N1', 'FAC-N2', 'FAC-P']);
  assert.deepStrictEqual(plain(b.doctors.find(d => d.id === 'DOC-0002').workplaces.map(w => [w.id, w.linked])), [['FAC-A', true], ['FAC-N1', true]]);
  assert.deepStrictEqual(plain(b.doctors.find(d => d.id === 'DOC-0003').workplaces.map(w => [w.id, w.linked])), [['FAC-N2', true], ['FAC-A', false]]);
});
test('doctor merge moves links by facility ID; a link the target already has is disabled', () => {
  const env = makeEnv(V2SEED());
  env.call(adm(env), 'masterAct', { entity: 'Doctors', id: 'DOC-0002', op: 'merge', into: 'DOC-0001' });
  const w = id => env.rows('DoctorWorkplaces').find(x => x.id === id);
  assert.strictEqual(String(w('DWP-00002').active), 'false');
  assert.deepStrictEqual([w('DWP-00003').doctorId, w('DWP-00003').facilityId], ['DOC-0001', 'FAC-N1']);
});

/* ---------- fewer reads ---------- */
test('save path never reads DoctorPlaces; with a warm cache it reads none of the facility tables from the sheet', () => {
  const env = makeEnv(V2SEED()), r = rep(env);
  const body = () => ({ date: env.today, doctors: [visit({ name: 'أحمد سالم', doctorId: 'DOC-0001', facilityId: 'FAC-A', place: 'مصحة الشفاء', gps: gps(near(A, 5)) })] });
  env.resetReads(); env.call(r, 'saveReport', body());
  assert.strictEqual(env.reads.DoctorPlaces || 0, 0);
  env.resetReads(); env.call(r, 'saveReport', body());
  assert.deepStrictEqual([env.reads.DoctorPlaces || 0, env.reads.DoctorWorkplaces || 0, env.reads.Facilities || 0, env.reads.Doctors || 0], [0, 0, 0, 0]);
});

/* ---------- client ---------- */
test('client (App3): every option value is a facility ID; linked first, others grouped; selection by facilityId', () => {
  const root = path.join(__dirname, '..'), html = f => fs.readFileSync(path.join(root, f), 'utf8');
  const grab = (src, name) => { const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}')); assert.ok(m, name); return m[0]; };
  const app1 = html('App1.html'), app2 = html('App2.html'), app3 = html('App3.html'), escLine = app1.split('\n').find(l => l.includes(',esc=t=>'));
  const src = ['const ' + escLine.slice(escLine.indexOf('esc=t=>')).replace(/;\s*$/, ''), (app2.match(/const norm=[^\n]*/) || [])[0],
    grab(app3, 'workplaceChoices'), grab(app3, 'workplaceOptions'), grab(app3, 'pickWorkplace')].join('\n');
  const c = vm.createContext({}); vm.runInContext(src + '\n;this.api={workplaceChoices,workplaceOptions,pickWorkplace}', c);
  const { workplaceChoices, workplaceOptions, pickWorkplace } = c.api;
  const doctor = { workplaces: [{ id: 'FAC-A', workplace: 'مصحة الشفاء', reviewed: true, linked: true }, { id: 'FAC-P', workplace: 'مستشفى مقترح', reviewed: false, linked: false }] };
  const facilities = [{ id: 'FAC-A', workplace: 'مصحة الشفاء', active: true, reviewed: true }, { id: 'FAC-N1', workplace: 'عيادة النور', active: true, reviewed: true },
    { id: 'FAC-N2', workplace: 'عيادة النور', active: true, reviewed: true }, { id: 'FAC-P', workplace: 'مستشفى مقترح', active: true, reviewed: false }];
  const ch = workplaceChoices(doctor, facilities), html2 = workplaceOptions(ch);
  assert.deepStrictEqual([...html2.matchAll(/value="([^"]+)"/g)].map(m => m[1]), ['FAC-A', 'FAC-P', 'FAC-N1', 'FAC-N2', '__new__']);
  assert.ok(html2.includes('(الربط بانتظار الاعتماد)') && html2.indexOf('<optgroup') > html2.indexOf('FAC-P'));
  assert.strictEqual(pickWorkplace(ch, { facilityId: 'FAC-N2', place: 'عيادة النور' }).value, 'FAC-N2'); // homonym chosen by ID, not by name
  assert.strictEqual(pickWorkplace(ch, { facilityId: 'FAC-N2' }).link, true);
  assert.strictEqual(pickWorkplace(ch, { place: 'مصحة الشفاء' }).value, 'FAC-A');
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
