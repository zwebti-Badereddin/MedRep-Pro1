// Local tests for the vendor fault detector: the hourly checks, alerts on change only (broken / fixed), the morning digest,
// and the phones' error reports (accepted without a session, rate-limited, trimmed).
// Run: node tests/health-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const VTOKEN = '987654321:ZZyyXXwwVVuuTTssRRqqPPooNNmmLLkkJJi';
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'companyName', value: 'شركة الأمل' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }, { id: 'REP-0002', name: 'البراء', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Reports: [], Audit: []
});
const day = 864e5;
function setup(o) {
  o = Object.assign({ triggers: ['weeklyBackup_', 'gpsRetentionTriggerHandler', 'healthHourly'], backupAgeDays: 2, quota: 100, cells: 50000, hour: 9 }, o);
  const env = makeEnv(SEED()), sent = [];
  env.props.set('VENDOR_TG_TOKEN', VTOKEN); env.props.set('VENDOR_TG_CHAT', '42');
  env.props.set('GPS_RETENTION_LAST_RUN', JSON.stringify({ ok: true, finishedAt: new Date(Date.now() - day).toISOString() }));
  env.ctx.ScriptApp.getProjectTriggers = () => o.triggers.map(h => ({ getHandlerFunction: () => h, getUniqueId: () => h }));
  const files = o.backupAgeDays == null ? [] : [{ getName: () => 'test — 2026-01-01 23:00', getDateCreated: () => new Date(Date.now() - o.backupAgeDays * day) },
    { getName: () => 'another sheet — 2026-01-01', getDateCreated: () => new Date() }];
  const iter = a => { let i = 0; return { hasNext: () => i < a.length, next: () => a[i++] }; };
  env.ctx.DriveApp = { getFoldersByName: () => iter([{ getFiles: () => iter(files) }]) };
  env.ctx.MailApp.getRemainingDailyQuota = () => o.quota;
  const ss = env.ctx.SpreadsheetApp.getActive(); ss.getSheets = () => [{ getMaxRows: () => o.cells, getMaxColumns: () => 1 }];
  env.ctx.UrlFetchApp = { fetch: (url, opt) => { if (!opt.payload) return { getResponseCode: () => 404 }; const b = JSON.parse(opt.payload); sent.push({ url, text: b.text, chat: b.chat_id }); return { getContentText: () => '{"ok":true,"result":true}', getResponseCode: () => 200 }; } };
  const fmt = env.ctx.Utilities.formatDate; env.ctx.Utilities.formatDate = (d, tz, f) => (f === 'H' ? String(o.hour) : fmt(d, tz, f));
  return { env, sent, o };
}
const bad = env => Array.from(env.ctx.healthChecks_().filter(c => !c.ok), c => c.key);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a healthy copy: every check passes', () => {
  const { env } = setup();
  assert.deepStrictEqual(bad(env), []);
});
test('detects: missing backup trigger, old backup, failed GPS cleanup, low mail quota, a big sheet, missing SALT', () => {
  assert.deepStrictEqual(bad(setup({ triggers: ['gpsRetentionTriggerHandler'] }).env), ['backup']);
  const old = setup({ backupAgeDays: 10 }).env.ctx.healthChecks_().find(c => c.key === 'backup');
  assert.match(old.msg, /آخر نسخة احتياطية قبل 10 يومًا/);
  const g = setup(); g.env.props.set('GPS_RETENTION_LAST_RUN', JSON.stringify({ ok: false, error: 'quota' }));
  assert.match(g.env.ctx.healthChecks_().find(c => c.key === 'gps').msg, /فشل حذف بيانات الموقع: quota/);
  assert.deepStrictEqual(bad(setup({ quota: 5 }).env), ['mail']);
  assert.deepStrictEqual(bad(setup({ cells: 8000000 }).env), ['size']);
  const s = setup(); s.env.props.delete('SALT'); assert.deepStrictEqual(bad(s.env), ['setup']);
});
test('Telegram: an installed company bot whose hourly run stopped is reported', () => {
  const { env } = setup({ triggers: ['weeklyBackup_', 'gpsRetentionTriggerHandler', 'tgHourly'] });
  env.props.set('TG_BOT_TOKEN', '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr');
  env.props.set('TG_HOURLY_LAST', String(Date.now() - 5 * 3600e3));
  assert.match(env.ctx.healthChecks_().find(c => c.key === 'telegram').msg, /لم يعمل منذ 5 ساعات/);
});
test('error bursts in the audit log (24 h) are reported; older ones are not', () => {
  const { env } = setup();
  for (let i = 0; i < 6; i++) env.ctx.audit_({ uid: 'SYSTEM', role: 'system' }, 'tg_failed', 'x', 'down');
  env.ctx.audit_({ uid: 'SYSTEM', role: 'system' }, 'email_failed', 'x', 'q');
  assert.match(env.ctx.healthChecks_().find(c => c.key === 'errors').msg, /تيليجرام 6/);
});
test('alerts on change only: broken once, nothing while still broken, fixed once; every message names the company', () => {
  const s = setup({ quota: 5, hour: 3 });
  s.env.ctx.healthHourly();
  assert.strictEqual(s.sent.length, 1); assert.match(s.sent[0].text, /^🏢 شركة الأمل\n⚠️ عطل: حصة البريد/); assert.strictEqual(s.sent[0].chat, '42');
  assert.ok(s.sent[0].url.indexOf(VTOKEN) > 0, 'the vendor bot, not the company bot');
  s.env.ctx.healthHourly(); assert.strictEqual(s.sent.length, 1);
  s.o.quota = 100; s.env.ctx.healthHourly();
  assert.strictEqual(s.sent.length, 2); assert.match(s.sent[1].text, /✅ عاد سليمًا: حصة البريد/);
});
test('morning digest once a day after 8:00, with the checks, yesterday\'s reports and phone errors', () => {
  const s = setup({ hour: 9 });
  s.env.ctx.clientErr_(null, { errors: [{ kind: 'js', msg: 'x is undefined' }] });
  s.env.ctx.healthHourly(); s.env.ctx.healthHourly();
  const d = s.sent.filter(m => /التقرير الصباحي/.test(m.text));
  assert.strictEqual(d.length, 1);
  assert.match(d[0].text, /✅ كل الفحوص سليمة/); assert.match(d[0].text, /أخطاء الهواتف \(24 ساعة\): 1/);
  const early = setup({ hour: 6 }); early.env.ctx.healthHourly();
  assert.strictEqual(early.sent.filter(m => /التقرير الصباحي/.test(m.text)).length, 0);
});
test('no vendor bot linked: checks still run, nothing is sent and nothing breaks', () => {
  const s = setup({ quota: 5 }); s.env.props.delete('VENDOR_TG_TOKEN');
  assert.strictEqual(s.env.ctx.healthHourly().length > 0, true); assert.strictEqual(s.sent.length, 0);
});
test('phone errors: accepted without a valid session, fields trimmed, rate-limited per user, the same error on 2 users is flagged', () => {
  const { env } = setup();
  const r = env.ctx.api('expired-token', 'clientErr', { errors: [{ kind: 'js', screen: 'اليوم', msg: 'boom\nline2 ' + 'x'.repeat(400), ver: 'web', ua: 'Android' }] });
  assert.deepStrictEqual([r.ok, r.data], [true, 1]);
  const row = env.rows('ClientErrors')[0];
  assert.deepStrictEqual([row.userId, row.kind, row.screen, row.msg.length, row.msg.indexOf('\n')], ['', 'js', 'اليوم', 240, -1]);
  const rep1 = env.session('REP-0001', 'rep'), rep2 = env.session('REP-0002', 'rep');
  const many = Array.from({ length: 10 }, (_, i) => ({ kind: 'js', msg: 'same bug' }));
  assert.strictEqual(env.call(rep1, 'clientErr', { errors: many }), 10);
  assert.strictEqual(env.call(rep1, 'clientErr', { errors: many }), 10);
  assert.strictEqual(env.call(rep1, 'clientErr', { errors: many }), 0, '20 an hour per user');
  assert.strictEqual(env.rows('ClientErrors')[1].userId, 'REP-0001');
  assert.deepStrictEqual(bad(env), [], 'one user only: not flagged yet');
  env.call(rep2, 'clientErr', { errors: [{ kind: 'js', msg: 'same bug' }] });
  assert.match(env.ctx.healthChecks_().find(c => c.key === 'phones').msg, /عند 2 مستخدمين: «same bug» \(21 مرة\)/);
});
test('blocked saves: the same message 3 times by 2 users (or 5 by one) in a day alerts once, kept apart from the phone errors, counted in the digest', () => {
  const s = setup({ hour: 9 }), { env } = s;
  const rep1 = env.session('REP-0001', 'rep'), rep2 = env.session('REP-0002', 'rep');
  const blk = { kind: 'block', screen: 'اليوم', msg: 'زيارة طبيب · من الخطة | أدخل اسم الطبيب' };
  env.call(rep1, 'clientErr', { errors: [blk, blk] });
  env.call(rep1, 'clientErr', { errors: [blk, blk, { kind: 'block', msg: 'زيارة طبيب | اختر المنتج' }] });
  assert.ok(!bad(env).some(k => k.indexOf('block_') === 0), 'one user, 4 times: not yet (a rep fixing their own mistake)');
  env.call(rep2, 'clientErr', { errors: [blk, { kind: 'block', msg: 'زيارة طبيب | اختر المنتج' }] });
  const b = env.ctx.healthChecks_().filter(c => c.key.indexOf('block_') === 0 && !c.ok);
  assert.strictEqual(b.length, 1);
  assert.match(b[0].msg, /تكررت 5 مرة عند 2 مستخدمين.*من الخطة \| أدخل اسم الطبيب/);
  assert.strictEqual(env.ctx.healthChecks_().find(c => c.key === 'phones').ok, true, 'blocks are not phone errors');
  assert.strictEqual(env.ctx.clientErrSummary_(24).total, 0);
  env.ctx.healthHourly();
  const digest = s.sent.map(m => m.text).find(t => /رسائل منعت الحفظ/.test(t));
  assert.ok(digest && /رسائل منعت الحفظ \(24 ساعة\): 7 — الأكثر: «زيارة طبيب · من الخطة \| أدخل اسم الطبيب» ×5/.test(digest), digest);
  assert.ok(s.sent.some(m => /رسالة تمنع الحفظ تكررت/.test(m.text)), 'alerted');
  const n = s.sent.length; env.ctx.healthHourly();
  assert.ok(!s.sent.slice(n).some(m => /رسالة تمنع الحفظ تكررت/.test(m.text)), 'not twice');
});
test('phone errors are trimmed to the last 5,000 rows', () => {
  const { env } = setup();
  env.ctx.ensureSheet_('ClientErrors');
  const sh = env.sheets.ClientErrors || env.ctx.sheet_('ClientErrors');
  for (let i = 0; i < 5003; i++) sh.appendRow([new Date().toISOString(), '', '', 'js', '', 'e' + i, '', '']);
  env.ctx.trimClientErrors_();
  assert.strictEqual(sh.getLastRow() - 1, 5000);
  assert.strictEqual(env.rows('ClientErrors')[0].msg, 'e3');
});

test('the external-connection permission: missing → reported with the menu item to use', () => {
  const { env } = setup();
  env.ctx.UrlFetchApp = { fetch: () => { throw new Error('You do not have permission to call UrlFetchApp.fetch. Required permissions: https://www.googleapis.com/auth/script.external_request'); } };
  assert.match(env.ctx.healthChecks_().find(c => c.key === 'external').msg, /منح الصلاحيات/);
});
let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
