// Local tests for Telegram alerts: linking with a one-time code, /stop, "report returned" to the rep, rep reminders,
// and the daily summary to admins and supervisors. Telegram itself is a fake UrlFetchApp.
// Run: node tests/telegram-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr';
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '0' }, { key: 'workDays', value: '0,1,2,3,4,5,6' },
    { key: 'remindEnabled', value: 'true' }, { key: 'companyName', value: 'شركة الأمل' }, { key: 'tgBot', value: 'AlAmal_MedRep_bot' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }, { id: 'REP-0002', name: 'البراء', active: true }, { id: 'REP-0003', name: 'متوقف', active: false }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Supervisors: [{ id: 'SUP-0001', username: 'salem', name: 'المشرف سالم', active: true }],
  Reports: [
    { id: 'R1', no: 'MR-1', repId: 'REP-0001', date: day(-1), status: 'مرسل', doctors: '[{"name":"د. علي"},{"name":"د. منى"}]', pharmacies: '[{"name":"صيدلية"}]' },
    { id: 'R2', no: 'MR-2', repId: 'REP-0002', date: day(-1), status: 'مسودة', doctors: '[]', pharmacies: '[]' }]
});
// Fake Telegram: records every call; getUpdates returns the queued messages once.
function fakeTelegram(env) {
  const tg = { calls: [], queue: [], nextId: 100 };
  env.ctx.UrlFetchApp = { fetch: (url, o) => {
    const method = url.split('/').pop(), body = JSON.parse(o.payload || '{}');
    assert.ok(url.indexOf('/bot' + TOKEN + '/') > 0, 'the token is used only in the URL');
    tg.calls.push({ method, body });
    let result = true;
    if (method === 'getUpdates') { result = tg.queue.filter(u => u.update_id >= (body.offset || 0)); tg.queue = []; }
    if (method === 'getMe') result = { username: 'AlAmal_MedRep_bot' };
    return { getContentText: () => JSON.stringify({ ok: true, result }), getResponseCode: () => 200 };
  } };
  tg.msg = (chatId, text) => tg.queue.push({ update_id: tg.nextId++, message: { chat: { id: chatId, type: 'private' }, text } });
  tg.sent = () => tg.calls.filter(c => c.method === 'sendMessage').map(c => ({ to: String(c.body.chat_id), text: c.body.text }));
  return tg;
}
const setup = (withToken) => {
  const env = makeEnv(SEED());
  if (withToken !== false) env.props.set('TG_BOT_TOKEN', TOKEN);
  const tg = fakeTelegram(env);
  return { env, tg, rep: env.session('REP-0001', 'rep'), rep2: env.session('REP-0002', 'rep'), adm: env.session('ADM-1', 'admin'), sup: env.session('SUP-0001', 'supervisor') };
};
const link = (env, tg, token, chatId) => {
  const code = env.call(token, 'tgLinkStart', {}).url.split('?start=')[1];
  tg.msg(chatId, '/start ' + code);
  return env.call(token, 'tgLinkCheck', {});
};
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('without a bot token Telegram is off: status disabled, no link, nothing is called', () => {
  const { env, tg, rep } = setup(false);
  assert.strictEqual(JSON.stringify(env.call(rep, 'tgStatus', {})), JSON.stringify({ enabled: false, bot: '', linked: false }));
  assert.throws(() => env.call(rep, 'tgLinkStart', {}), /غير مفعّل/);
  assert.strictEqual(tg.calls.length, 0);
});
test('linking: one-time t.me link, Start in Telegram, «تحقق» stores the chat, welcomes the user, advances the offset', () => {
  const { env, tg, rep } = setup();
  const url = env.call(rep, 'tgLinkStart', {}).url;
  assert.match(url, /^https:\/\/t\.me\/AlAmal_MedRep_bot\?start=[A-Za-z0-9]{24}$/);
  assert.strictEqual(env.call(rep, 'tgLinkCheck', {}).linked, false); // nothing pressed yet
  tg.msg(555, '/start ' + url.split('?start=')[1]);
  assert.strictEqual(JSON.stringify(env.call(rep, 'tgLinkCheck', {})), JSON.stringify({ enabled: true, bot: 'AlAmal_MedRep_bot', linked: true }));
  const row = env.rows('TgLinks')[0];
  assert.deepStrictEqual([row.userId, row.role, String(row.chatId)], ['REP-0001', 'rep', '555']);
  assert.ok(tg.sent().some(m => m.to === '555' && /تم ربط حسابك/.test(m.text)));
  assert.strictEqual(env.props.get('TG_OFFSET'), '101');
  assert.ok(env.rows('Audit').some(a => a.action === 'tg_link' && a.ref === 'REP-0001'));
});
test('a code works once; an unknown or used code links nothing and tells the chat to start again', () => {
  const { env, tg, rep } = setup();
  const code = env.call(rep, 'tgLinkStart', {}).url.split('?start=')[1];
  tg.msg(555, '/start ' + code); env.call(rep, 'tgLinkCheck', {});
  tg.msg(777, '/start ' + code); tg.msg(888, '/start ' + 'x'.repeat(24));
  env.call(rep, 'tgLinkCheck', {});
  assert.deepStrictEqual(env.rows('TgLinks').map(r => String(r.chatId)), ['555']);
  assert.strictEqual(tg.sent().filter(m => /انتهت صلاحية/.test(m.text)).length, 2);
});
test('one chat belongs to one account: linking the same phone to another account moves it', () => {
  const { env, tg, rep, rep2 } = setup();
  link(env, tg, rep, 555); link(env, tg, rep2, 555);
  assert.deepStrictEqual(env.rows('TgLinks').map(r => r.userId), ['REP-0002']);
  assert.strictEqual(env.call(rep, 'tgStatus', {}).linked, false);
});
test('unlink from the app or /stop in Telegram removes the chat', () => {
  const { env, tg, rep, adm } = setup();
  link(env, tg, rep, 555); link(env, tg, adm, 900);
  assert.strictEqual(env.call(rep, 'tgUnlink', {}).linked, false);
  assert.deepStrictEqual(env.rows('TgLinks').map(r => r.userId), ['ADM-1']);
  tg.msg(900, '/stop'); env.ctx.tgPoll_();
  assert.strictEqual(env.rows('TgLinks').length, 0);
  assert.ok(tg.sent().some(m => m.to === '900' && /تم إلغاء الربط/.test(m.text)));
});
test('a returned report alerts its rep with the note; an approval sends nothing', () => {
  const { env, tg, rep, adm } = setup();
  link(env, tg, rep, 555);
  const before = tg.sent().length;
  env.call(adm, 'reviewReport', { id: 'R1', approve: false, note: 'أضف المنتج في زيارة د. علي' });
  const m = tg.sent().slice(before);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].to, '555');
  assert.match(m[0].text, /أُعيد تقريرك/); assert.match(m[0].text, /أضف المنتج/);
});
test('a Telegram failure never blocks the review; it is written to the audit log', () => {
  const { env, tg, rep, adm } = setup();
  link(env, tg, rep, 555);
  env.ctx.UrlFetchApp = { fetch: () => { throw new Error('network down'); } };
  assert.strictEqual(env.call(adm, 'reviewReport', { id: 'R1', approve: false, note: 'صحح' }).status, 'معاد للمندوب');
  assert.ok(env.rows('Audit').some(a => a.action === 'tg_failed'));
});
test('reminders reach unsent reps on Telegram (not reps who sent, not inactive reps)', () => {
  const { env, tg, rep, rep2 } = setup();
  link(env, tg, rep, 555); link(env, tg, rep2, 666);
  const before = tg.sent().length;
  env.ctx.sendFinalReminder_();
  const m = tg.sent().slice(before);
  assert.deepStrictEqual(m.map(x => x.to), ['666']);
  assert.match(m[0].text, /البراء/);
});
test('daily summary: sent / expected, who has not sent, visit counts, waiting; to admins and supervisors only, once a day', () => {
  const { env, tg, rep, adm, sup } = setup();
  link(env, tg, rep, 555); link(env, tg, adm, 900); link(env, tg, sup, 901);
  const before = tg.sent().length;
  env.ctx.tgHourly();
  const m = tg.sent().slice(before);
  assert.deepStrictEqual(m.map(x => x.to).sort(), ['900', '901']);
  const t = m[0].text;
  assert.match(t, /ملخص تقارير يوم/); assert.match(t, /شركة الأمل/);
  assert.match(t, /أُرسل: 1 من 2/); assert.match(t, /لم يُرسل: البراء/);
  assert.match(t, /الزيارات: 3 \(أطباء 2، صيدليات 1\)/); assert.match(t, /بانتظار الاعتماد \(كل الأيام\): 1/);
  assert.ok(!/متوقف/.test(t), 'an inactive rep is not expected');
  env.ctx.tgHourly();
  assert.strictEqual(tg.sent().length, before + 2, 'sent once per day');
});
test('no summary on a day off (not a working day)', () => {
  const { env, tg, adm } = setup();
  link(env, tg, adm, 900);
  env.ctx.dbUpsert_('Settings', 'key', { key: 'workDays', value: String((new Date(day(-1) + 'T12:00:00Z').getUTCDay() + 1) % 7) });
  env.ctx.clearCache_();
  const before = tg.sent().length;
  env.ctx.tgHourly();
  assert.strictEqual(tg.sent().length, before);
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
