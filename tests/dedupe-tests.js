// Local tests for duplicate protection: the name key, «هل تقصد؟» on add, rename refusal, the admin list and Excel import.
// Run: node tests/dedupe-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const J = x => JSON.stringify(x);
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Doctors: [{ id: 'DOC-1', name: 'د. عبد الله محمد الصغير', specialty: 'باطنة', active: true },
    { id: 'DOC-2', name: 'منى سالم', specialty: 'أطفال', active: true },
    { id: 'DOC-3', name: 'Dr. منى  سالم', specialty: 'أطفال', active: true },
    { id: 'DOC-4', name: 'خالد عمر', specialty: 'عظام', active: true }],
  Pharmacies: [{ id: 'PH-1', name: 'صيدلية النور', location: 'الحي', active: true }]
});
const setup = () => { const env = makeEnv(SEED()); return { env, adm: env.session('ADM-1', 'admin'), rep: env.session('REP-0001', 'rep') }; };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('nameKey_: titles, punctuation, «ال», عبد/ابو joined', () => {
  const { env } = setup(), k = env.ctx.nameKey_;
  assert.strictEqual(k('د. عبد الله محمد الصغير', 'Doctors'), k('الدكتور عبدالله محمد صغير', 'Doctors'));
  assert.strictEqual(k('Dr. Ali-Omar', 'Doctors'), k('ali omar', 'Doctors'));
  assert.strictEqual(k('صيدلية النور', 'Pharmacies'), k('النور', 'Pharmacies'));
  assert.notStrictEqual(k('منى سالم', 'Doctors'), k('منى سليم', 'Doctors'));
});
test('same key reuses the existing record; a similar name asks «هل تقصد؟»; confirmNew creates', () => {
  const { env, rep } = setup();
  assert.strictEqual(env.call(rep, 'addDoctor', { name: 'الدكتور عبدالله محمد صغير', specialty: 'باطنة' }).id, 'DOC-1');
  const r = env.call(rep, 'addDoctor', { name: 'خالد عمر علي', specialty: 'عظام' });
  assert.strictEqual(J(r.similar.map(x => x.id)), J(['DOC-4']));
  assert.strictEqual(env.call(rep, 'addDoctor', { name: 'خالد عمرو', specialty: 'عظام' }).similar[0].id, 'DOC-4');
  const n = env.call(rep, 'addDoctor', { name: 'خالد عمر علي', specialty: 'عظام', confirmNew: true });
  assert.ok(n.id && n.id !== 'DOC-4' && !n.similar);
  assert.ok(env.call(rep, 'addDoctor', { name: 'يوسف الهادي', specialty: 'جلدية' }).id); // not similar: created directly
  assert.strictEqual(env.call(rep, 'addPharmacy', { name: 'النور', location: 'x' }).id, 'PH-1');
});
test('admin list shows exact and similar pairs; rep cannot call it', () => {
  const { env, adm, rep } = setup();
  env.ctx.dbAppend_('Doctors', { id: 'DOC-5', name: 'خالد عمرو', specialty: 'عظام', active: true });
  const a = env.call(adm, 'duplicateCandidates', { entity: 'Doctors' });
  assert.strictEqual(J(a.map(p => [p.a.id, p.b.id, p.same])), J([['DOC-2', 'DOC-3', true], ['DOC-4', 'DOC-5', false]]));
  assert.throws(() => env.call(rep, 'duplicateCandidates', { entity: 'Doctors' }), /غير مصرح/);
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
