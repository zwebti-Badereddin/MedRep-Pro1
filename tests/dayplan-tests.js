// Local tests for daily visit plans: created by a supervisor or an admin, seen by the rep, done from the day's report, «تعذّرت»
// with a reason, copy, Telegram notice, visit fields (planId, feedback) and the feedback summary.
// Run: node tests/dayplan-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const J = x => JSON.stringify(x);
const today = new Date().toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const SEED = (extra) => Object.assign({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'gpsRadius', value: '150' }, { key: 'gpsRefAcc', value: '50' }, { key: 'workplacePolicy', value: 'soft' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }, { id: 'REP-0002', name: 'البراء', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Supervisors: [{ id: 'SUP-0001', username: 'salem', name: 'المشرف سالم', active: true }],
  Doctors: [{ id: 'DOC-1', name: 'د. علي', specialty: 'باطنة', active: true }, { id: 'DOC-2', name: 'د. منى', specialty: 'أطفال', active: true }],
  Products: [{ id: 'PROD-0001', name: 'Clodil', status: 'نشط' }]
}, extra || {});
const setup = (extra) => { const env = makeEnv(SEED(extra)); return { env, adm: env.session('ADM-1', 'admin'), sup: env.session('SUP-0001', 'supervisor'), rep: env.session('REP-0001', 'rep'), rep2: env.session('REP-0002', 'rep') }; };
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a supervisor adds items; the rep sees them (today and the next days), another rep does not', () => {
  const { env, sup, rep, rep2 } = setup();
  const a = env.call(sup, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-1', product: 'Clodil', purpose: 'feedback', note: 'اسأله عن الجرعة' });
  env.call(sup, 'dayPlanAdd', { repId: 'REP-0001', date: tomorrow, doctorId: 'DOC-2', purpose: 'intro' });
  assert.deepStrictEqual([a.doctorName, a.specialty, a.purposeName, a.status], ['د. علي', 'باطنة', 'أخذ انطباع', 'pending']);
  const mine = env.call(rep, 'myDayPlan', {});
  assert.strictEqual(J(mine.map(i => [i.date, i.doctorId])), J([[today, 'DOC-1'], [tomorrow, 'DOC-2']]));
  assert.strictEqual(env.call(rep2, 'myDayPlan', {}).length, 0);
});
test('validation: past day, unknown doctor or product, feedback needs a product; the same doctor twice updates the item', () => {
  const { env, adm } = setup();
  expectError(() => env.call(adm, 'dayPlanAdd', { repId: 'REP-0001', date: '2020-01-01', doctorId: 'DOC-1' }), /يوم مضى/);
  expectError(() => env.call(adm, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-9' }), /الطبيب غير موجود/);
  expectError(() => env.call(adm, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-1', product: 'X' }), /المنتج غير موجود/);
  expectError(() => env.call(adm, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-1', purpose: 'feedback' }), /أخذ انطباع/);
  env.call(adm, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-1', purpose: 'intro' });
  env.call(adm, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-1', purpose: 'remind', product: 'Clodil' });
  const rows = env.call(adm, 'dayPlanList', { from: today, to: today });
  assert.strictEqual(J(rows.map(r => [r.purpose, r.product])), J([['remind', 'Clodil']]));
});
test('done when the day\'s report has a visit (draft counts); the visit keeps planId and feedback; the summary counts it', () => {
  const { env, sup, rep } = setup({ Facilities: [{ id: 'FAC-PH-PH-0001', name: 'x', status: 'نشط', legacyEntity: 'Pharmacies', legacyId: 'PH-0001' }] });
  const it = env.call(sup, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-1', product: 'Clodil', purpose: 'feedback' });
  env.call(rep, 'saveReport', { date: env.today, doctors: [{ name: 'د. علي', doctorId: 'DOC-1', specialty: 'باطنة', intro: 'Clodil', time: 'صباحًا', sector: 'خاص',
    planId: it.id, fb: { product: 'Clodil', r: 'pos', n: '  يفضّله على المنافس  ' } }] });
  const v = JSON.parse(env.rows('Reports')[0].doctors)[0];
  assert.strictEqual(J([v.planId, v.fb]), J([it.id, { product: 'Clodil', r: 'pos', n: 'يفضّله على المنافس' }]));
  const row = env.call(sup, 'dayPlanList', { from: today, to: today })[0];
  assert.deepStrictEqual([row.status, row.fb.r, row.repName], ['done', 'pos', 'سارة']);
  env.sheets.Reports._data[1][4] = 'مرسل';
  const s = env.call(sup, 'feedbackSummary', { from: today, to: today });
  assert.strictEqual(J(s.products), J([{ product: 'Clodil', pos: 1, neu: 0, neg: 0, total: 1 }]));
  assert.strictEqual(s.items[0].doctor, 'د. علي');
});
test('bad visit fields are dropped: a malformed planId, a feedback without a known rating', () => {
  const { env } = setup(), o = {};
  env.ctx.cleanVisitExtras_(o, { planId: 'x', fb: { product: 'Clodil', r: 'great' } }, 'doctor');
  assert.strictEqual(J(o), J({}));
});
test('the rep marks «تعذّرت» with a reason (and can undo); only own items', () => {
  const { env, adm, rep, rep2 } = setup();
  const it = env.call(adm, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-2' });
  expectError(() => env.call(rep, 'dayPlanFail', { id: it.id, reason: '' }), /سبب/);
  expectError(() => env.call(rep2, 'dayPlanFail', { id: it.id, reason: 'مسافر' }), /غير موجود/);
  let mine = env.call(rep, 'dayPlanFail', { id: it.id, reason: 'الطبيب مسافر' });
  assert.deepStrictEqual([mine[0].status, mine[0].reason], ['failed', 'الطبيب مسافر']);
  mine = env.call(rep, 'dayPlanFail', { id: it.id, undo: true });
  assert.strictEqual(mine[0].status, 'pending');
});
test('copy to another rep and day; delete; Telegram notice lists the plan; rep cannot add', () => {
  const { env, adm, sup, rep } = setup();
  env.call(adm, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-1', product: 'Clodil', purpose: 'intro', note: 'عرض جديد' });
  assert.strictEqual(env.call(sup, 'dayPlanCopy', { fromRep: 'REP-0001', fromDate: today, toRep: 'REP-0002', toDate: tomorrow }), 1);
  const copied = env.call(adm, 'dayPlanList', { repId: 'REP-0002', from: tomorrow, to: tomorrow });
  assert.strictEqual(J(copied.map(c => [c.doctorId, c.note])), J([['DOC-1', 'عرض جديد']]));
  env.call(adm, 'dayPlanDelete', { id: copied[0].id });
  assert.strictEqual(env.call(adm, 'dayPlanList', { repId: 'REP-0002', from: tomorrow, to: tomorrow }).length, 0);
  const sent = []; env.props.set('TG_BOT_TOKEN', '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr');
  env.ctx.ensureSheet_('TgLinks'); env.ctx.dbAppend_('TgLinks', { userId: 'REP-0001', role: 'rep', name: 'سارة', chatId: '77', linkedAt: 'x' });
  env.ctx.UrlFetchApp = { fetch: (u, o) => { sent.push(JSON.parse(o.payload).text); return { getContentText: () => '{"ok":true,"result":true}', getResponseCode: () => 200 }; } };
  assert.strictEqual(env.call(sup, 'dayPlanNotify', { repId: 'REP-0001', date: today }), 1);
  assert.match(sent[0], /خطة زيارات ليوم/); assert.match(sent[0], /د\. علي \(باطنة\) — تعريف: Clodil/); assert.match(sent[0], /عرض جديد/);
  expectError(() => env.call(rep, 'dayPlanAdd', { repId: 'REP-0001', date: today, doctorId: 'DOC-2' }), /غير مصرح/);
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
