// MedRep Pro — Telegram alerts: daily summary for admins and supervisors, reminders and "report returned" for reps.
// One bot per company. The owner pastes the bot token once (sheet menu → ربط بوت تيليجرام); it lives in Script Properties only.
// Linking: the app gives a one-time t.me link (?start=<code>, 15 min); the person presses Start, then «تحقق» in the app.
// Apps Script cannot receive Telegram webhooks (Google answers with a redirect), so updates are read with getUpdates:
// on «تحقق» and by the hourly trigger. Nothing here ever blocks a save, a submission or a review.

const TG_TOKEN_KEY = 'TG_BOT_TOKEN', TG_OFFSET_KEY = 'TG_OFFSET', TG_SUMMARY_KEY = 'TG_SUMMARY_LAST', TG_LINK_SEC = 900;
const TG_LINK_RE = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/;

function tgToken_() { return PropertiesService.getScriptProperties().getProperty(TG_TOKEN_KEY) || ''; }
function tgCall_(method, payload, token) {
  token = token || tgToken_(); if (!token) throw new Error('تيليجرام غير مفعّل لهذه الشركة.');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true });
  let out; try { out = JSON.parse(res.getContentText()); } catch (e) { out = null; }
  if (!out || !out.ok) throw new Error('Telegram ' + method + ': ' + ((out && out.description) || res.getResponseCode()));
  return out.result;
}
// Never throws: an alert that cannot be delivered is written to the audit log and the caller carries on.
function tgSend_(chatId, text) {
  try { tgCall_('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }); return true; }
  catch (e) { try { audit_({ uid: 'SYSTEM', role: 'system' }, 'tg_failed', String(chatId), String(e.message).slice(0, 200)); } catch (x) {} return false; }
}
function tgLinks_() { ensureSheet_('TgLinks'); return dbAll_('TgLinks'); }
// Sends to every linked chat of one user; returns how many were delivered.
function tgNotifyUser_(userId, text) {
  if (!tgToken_()) return 0;
  try { return tgLinks_().filter(l => String(l.userId) === String(userId)).reduce((n, l) => n + (tgSend_(l.chatId, text) ? 1 : 0), 0); }
  catch (e) { return 0; }
}
function tgNotifyRoles_(roles, text) {
  if (!tgToken_()) return 0;
  return tgLinks_().filter(l => roles.indexOf(l.role) >= 0).reduce((n, l) => n + (tgSend_(l.chatId, text) ? 1 : 0), 0);
}

/* ---------- linking (any signed-in user) ---------- */
function tgStatus_(s) {
  const bot = String(settings_().tgBot || ''), on = !!(bot && tgToken_());
  return { enabled: on, bot: on ? bot : '', linked: on && tgLinks_().some(l => String(l.userId) === String(s.uid)) };
}
function tgLinkStart_(s) {
  const st = tgStatus_(s); if (!st.enabled) throw new Error('تيليجرام غير مفعّل لهذه الشركة.');
  const code = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
  CacheService.getScriptCache().put('tgl_' + code, JSON.stringify({ uid: s.uid, role: s.role, name: s.name || '' }), TG_LINK_SEC);
  return { url: 'https://t.me/' + st.bot + '?start=' + code };
}
function tgLinkCheck_(s) { tgPoll_(); return tgStatus_(s); }
function tgUnlink_(s) {
  ensureSheet_('TgLinks');
  const sh = sheet_('TgLinks'), v = sh.getDataRange().getValues(), ci = T.TgLinks.indexOf('chatId'); let n = 0;
  for (let i = v.length - 1; i >= 1; i--) if (String(v[i][0]) === String(s.uid)) { tgSend_(v[i][ci], 'تم إلغاء ربط حسابك. لن تصلك تنبيهات MedRep Pro هنا.'); sh.deleteRow(i + 1); n++; }
  dropTableCache_('TgLinks'); if (_RM) delete _RM.TgLinks;
  if (n) audit_(s, 'tg_unlink', s.uid);
  return tgStatus_(s);
}
// Reads new Telegram messages: «/start <code>» links the chat to the account that asked for the code; «/stop» unlinks it.
// Under the script lock, so the offset is never processed twice.
function tgPoll_() {
  if (!tgToken_()) return 0;
  ensureSheet_('TgLinks');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties(), offset = +props.getProperty(TG_OFFSET_KEY) || 0;
    const updates = tgCall_('getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message'] }) || [];
    let last = offset - 1, linked = 0;
    const cache = CacheService.getScriptCache();
    updates.forEach(u => {
      last = Math.max(last, +u.update_id || 0);
      const m = u.message, chat = m && m.chat; if (!chat || chat.type !== 'private') return;
      const text = String(m.text || '').trim(), hit = TG_LINK_RE.exec(text);
      if (hit) {
        const raw = cache.get('tgl_' + hit[1]);
        if (!raw) { tgSend_(chat.id, 'انتهت صلاحية رابط الربط. اضغط «🔔 ربط تيليجرام» في التطبيق مرة أخرى.'); return; }
        cache.remove('tgl_' + hit[1]);
        const who = JSON.parse(raw);
        tgUnlinkChat_(chat.id); // one account per chat: re-linking a phone to another account moves it
        dbAppend_('TgLinks', { userId: who.uid, role: who.role, name: who.name, chatId: String(chat.id), linkedAt: new Date().toISOString() });
        audit_({ uid: who.uid, role: who.role }, 'tg_link', who.uid);
        tgSend_(chat.id, 'تم ربط حسابك في MedRep Pro: ' + who.name + '\nستصلك التنبيهات هنا. لإلغاء الربط أرسل /stop');
        linked++;
      } else if (/^\/stop\b/.test(text)) {
        if (tgUnlinkChat_(chat.id)) tgSend_(chat.id, 'تم إلغاء الربط. لن تصلك تنبيهات MedRep Pro هنا.');
      } else if (/^\/start\b/.test(text)) {
        tgSend_(chat.id, 'لربط حسابك افتح MedRep Pro واضغط «🔔 ربط تيليجرام».');
      }
    });
    if (updates.length) props.setProperty(TG_OFFSET_KEY, String(last + 1));
    return linked;
  } finally { lock.releaseLock(); }
}
function tgUnlinkChat_(chatId) {
  const sh = sheet_('TgLinks'), v = sh.getDataRange().getValues(), ci = T.TgLinks.indexOf('chatId'); let n = 0;
  for (let i = v.length - 1; i >= 1; i--) if (String(v[i][ci]) === String(chatId)) { sh.deleteRow(i + 1); n++; }
  if (n) { dropTableCache_('TgLinks'); if (_RM) delete _RM.TgLinks; }
  return n;
}

/* ---------- daily summary for admins and supervisors (yesterday's reports, after the closing hour) ---------- */
function tgSummaryText_(day) {
  const st = settings_(), off = offData_(), reports = reportsLight_().filter(r => r.date === day);
  const sentSt = ['مرسل', 'معتمد'], expected = [], missing = [];
  dbAll_('Reps').filter(r => String(r.active) !== 'false').forEach(rep => {
    if (offWeight_(off, rep.id, day) >= 1) return;
    expected.push(rep);
    const r = reports.find(x => x.repId === rep.id);
    if (!r || sentSt.indexOf(r.status) < 0) missing.push(rep.name);
  });
  const sent = reports.filter(r => sentSt.indexOf(r.status) >= 0), body = reportsBody_(sent);
  let docs = 0, phs = 0, unverified = 0;
  readScope_(() => body.forEach(r => {
    const d = JSON.parse(r.doctors || '[]'), p = JSON.parse(r.pharmacies || '[]'); docs += d.length; phs += p.length;
    try { d.map(v => reportVisitGpsCheck_(v, 'doctor', st)).concat(p.map(v => reportVisitGpsCheck_(v, 'pharmacy', st)))
      .forEach(c => { if (c.status !== 'تم التحقق') unverified++; }); } catch (e) {}
  }));
  const waiting = reportsLight_().filter(r => r.status === 'مرسل').length;
  let planWaiting = 0; try { planWaiting = planRows_().filter(r => r.pendingCls).length; } catch (e) {}
  const stockOver = stockOverText_(), pharmAlert = pharmAlertText_();
  return ['📊 ملخص تقارير يوم ' + day.split('-').reverse().join('/') + (st.companyName ? ' — ' + st.companyName : ''),
    '',
    'أُرسل: ' + sent.length + ' من ' + expected.length,
    missing.length ? 'لم يُرسل: ' + missing.join('، ') : 'كل المندوبين أرسلوا ✅',
    'الزيارات: ' + (docs + phs) + ' (أطباء ' + docs + '، صيدليات ' + phs + ')',
    unverified ? '📍 زيارات لم يثبت موقعها: ' + unverified : '',
    'بانتظار الاعتماد (كل الأيام): ' + waiting,
    planWaiting ? 'تصنيفات أطباء بانتظار الاعتماد: ' + planWaiting : '',
    stockOver ? '⚠️ تجاوز رصيد العينات: ' + stockOver : '',
    pharmAlert ? '🏪 تنبيهات صيدليات (نفاد أو صلاحية قريبة): ' + pharmAlert : ''].filter(x => x !== '').join('\n');
}
// Hourly trigger: reads Telegram messages, and once a day, in the closing hour or later, sends yesterday's summary
// (only on a working day that is not a holiday). Re-reading closeHour every run means a changed setting needs no new trigger.
function tgHourly() {
  if (!tgToken_()) return;
  PropertiesService.getScriptProperties().setProperty(TG_HOURLY_LAST_KEY, String(Date.now())); // heartbeat for healthChecks_
  try { tgPoll_(); } catch (e) {}
  const st = settings_(), tz = st.timezone || Session.getScriptTimeZone(), hour = +Utilities.formatDate(new Date(), tz, 'H');
  if (hour < closeHour_(st)) return;
  const day = yesterday_(), props = PropertiesService.getScriptProperties();
  if (props.getProperty(TG_SUMMARY_KEY) === day) return;
  props.setProperty(TG_SUMMARY_KEY, day);
  const wd = String(st.workDays || '0,1,2,3,4').split(',').map(Number);
  if (wd.indexOf(new Date(day + 'T12:00:00Z').getUTCDay()) < 0 || offData_().hol[day]) return;
  tgNotifyRoles_(['admin', 'supervisor'], tgSummaryText_(day));
}

/* ---------- owner setup (sheet menu) ---------- */
function tgSetup() {
  ownerOnly_();
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('ربط بوت تيليجرام', 'الصق مفتاح البوت (Bot Token) من @BotFather:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const token = String(r.getResponseText() || '').trim();
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token)) { ui.alert('المفتاح غير صالح. انسخه كما هو من @BotFather.'); return; }
  let me; try { me = tgCall_('getMe', {}, token); } catch (e) { ui.alert('تعذر التحقق من البوت: ' + e.message); return; }
  try { tgCall_('deleteWebhook', {}, token); } catch (e) {} // getUpdates does not work while a webhook is set
  const props = PropertiesService.getScriptProperties();
  props.setProperty(TG_TOKEN_KEY, token); props.deleteProperty(TG_OFFSET_KEY);
  ensureSheet_('TgLinks');
  dbUpsert_('Settings', 'key', { key: 'tgBot', value: String(me.username || '') }); clearCache_();
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'tgHourly') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tgHourly').timeBased().everyHours(1).create();
  audit_({ uid: 'OWNER', role: 'admin' }, 'tg_setup', '@' + me.username);
  ui.alert('تم ربط البوت @' + me.username + '.\nيظهر الآن زر «🔔» في التطبيق لكل مستخدم ليربط حسابه.');
}
function tgDisable() {
  ownerOnly_();
  PropertiesService.getScriptProperties().deleteProperty(TG_TOKEN_KEY);
  dbUpsert_('Settings', 'key', { key: 'tgBot', value: '' }); clearCache_();
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'tgHourly') ScriptApp.deleteTrigger(t); });
  audit_({ uid: 'OWNER', role: 'admin' }, 'tg_disable', '');
  try { SpreadsheetApp.getUi().alert('تم إيقاف تنبيهات تيليجرام.'); } catch (e) {}
}
