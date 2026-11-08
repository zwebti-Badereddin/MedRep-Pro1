// Local tests for visit check-in / check-out: the server keeps well-formed points only, computes the duration itself, marks a phone
// clock that is off, and the export shows in / out / minutes / warnings.
// Run: node tests/visit-time-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'gpsRadius', value: '150' }, { key: 'gpsRefAcc', value: '50' }, { key: 'workplacePolicy', value: 'soft' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Facilities: [{ id: 'FAC-PH-PH-0001', name: 'صيدلية الشفاء', status: 'نشط', legacyEntity: 'Pharmacies', legacyId: 'PH-0001' }],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية الشفاء', active: true }],
  Products: [{ id: 'PROD-0001', name: 'CardioPlus', status: 'نشط' }]
});
const A = { lat: 32.89, lng: 13.2 };
const at = min => new Date(Date.UTC(2026, 0, 5, 9, 0) + min * 60000).toISOString();
const ph = o => Object.assign({ name: 'صيدلية الشفاء', pharmacyId: 'PH-0001', product: 'CardioPlus', time: 'صباحًا' }, o);
const setup = () => { const env = makeEnv(SEED()); return { env, rep: env.session('REP-0001', 'rep'), adm: env.session('ADM-1', 'admin') }; };
const stored = env => JSON.parse(env.rows('Reports')[0].pharmacies);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('check-in / check-out are kept and the duration is computed on the server (the phone\'s value is ignored)', () => {
  const { env, rep } = setup();
  env.call(rep, 'saveReport', { date: env.today, clk: Date.now(), pharmacies: [ph({ ci: Object.assign({ t: at(0), acc: 12 }, A), co: { t: at(14), lat: A.lat, lng: A.lng, acc: 9 }, dur: 999 })] });
  const v = stored(env)[0];
  assert.deepStrictEqual([v.ci.t, v.co.t, v.dur, v.ci.acc, v.sk], [at(0), at(14), 14, 12, undefined]);
});
test('malformed times are dropped: missing check-out, reversed, longer than a day, bad coordinates removed from the point', () => {
  const { env, rep } = setup();
  env.call(rep, 'saveReport', { date: env.today, pharmacies: [
    ph({ ci: { t: at(0) } }), ph({ ci: { t: at(10) }, co: { t: at(5) } }), ph({ ci: { t: at(0) }, co: { t: at(60 * 25) } }),
    ph({ ci: { t: 'not a date' }, co: { t: at(5) } }), ph({ ci: { t: at(0), lat: 999, lng: 13 }, co: { t: at(3) } })] });
  const s = stored(env);
  assert.deepStrictEqual(s.slice(0, 4).map(v => [v.ci, v.co, v.dur]), [[undefined, undefined, undefined], [undefined, undefined, undefined], [undefined, undefined, undefined], [undefined, undefined, undefined]]);
  assert.deepStrictEqual([s[4].dur, s[4].ci.lat], [3, undefined]);
});
test('a phone clock 10 minutes off is marked on new visits and the mark stays on later saves', () => {
  const { env, rep } = setup();
  const v = ph({ ci: { t: at(0) }, co: { t: at(20) } });
  env.call(rep, 'saveReport', { date: env.today, clk: Date.now() - 10 * 60000, pharmacies: [v] });
  assert.strictEqual(stored(env)[0].sk, 10);
  env.call(rep, 'saveReport', { date: env.today, clk: Date.now(), pharmacies: [v] });
  assert.strictEqual(stored(env)[0].sk, 10, 'kept');
  env.call(rep, 'saveReport', { date: env.today, clk: Date.now() - 60000, pharmacies: [v, ph({ ci: { t: at(30) }, co: { t: at(40) } })] });
  assert.strictEqual(stored(env)[1].sk, undefined, 'one minute off is not marked');
});
test('warnings: short, long, far check-out, clock, overlap', () => {
  const { env } = setup(), f = env.ctx.vtFlags_;
  const a = { ci: Object.assign({ t: at(0), acc: 10 }, A), co: { t: at(1), lat: A.lat + 0.01, lng: A.lng, acc: 10 }, dur: 1, sk: -7 };
  const b = { ci: { t: at(0) }, co: { t: at(130) }, dur: 130 };
  assert.deepStrictEqual(Array.from(f(a, [a])), ['زيارة قصيرة جدًا', 'الخروج بعيد عن الدخول (1112 م)', 'ساعة الهاتف غير دقيقة (7 د)']);
  assert.deepStrictEqual(Array.from(f(b, [a, b])), ['مدة طويلة غير معتادة']);
  const c = { ci: { t: at(10) }, co: { t: at(30) }, dur: 20 }, d = { ci: { t: at(20) }, co: { t: at(40) }, dur: 20 };
  assert.deepStrictEqual(Array.from(f(d, [c, d])), ['متداخلة مع زيارة أخرى']);
  assert.deepStrictEqual(Array.from(f({ name: 'old' }, [])), []);
});
test('export: in, out, minutes and warnings per visit (times in the company time zone)', () => {
  const { env, rep, adm } = setup();
  env.call(rep, 'saveReport', { date: env.today, pharmacies: [ph({ ci: { t: at(0) }, co: { t: at(1) } }), ph({ name: 'صيدلية الشفاء' })] });
  const out = env.call(adm, 'exportVisits', { from: env.today, to: env.today }), h = out.rows[0], col = n => h.indexOf(n);
  const r1 = out.rows[1], r2 = out.rows[2];
  assert.deepStrictEqual([r1[col('الدخول')], r1[col('الخروج')], r1[col('مدة الزيارة (دقيقة)')], r1[col('تنبيهات الوقت')]], ['09:00', '09:01', 1, 'زيارة قصيرة جدًا']);
  assert.deepStrictEqual([r2[col('الدخول')], r2[col('مدة الزيارة (دقيقة)')]], ['', '']);
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
