// MedRep Pro — fault detection for the vendor. An hourly check of this copy (triggers that ran, backup age, mail quota, sheet
// size, error bursts in the audit log, errors reported by the reps' phones, required settings and tables). Alerts go to the
// VENDOR's own Telegram bot (not the company's): one message when something breaks, one when it is fixed, and a morning digest.
// Every message starts with the company name, so one bot serves every company copy.
// Outside Google, UptimeRobot watches ?ping=1 and the web app (it sees what this script cannot: the script itself down).

const VENDOR_TOKEN_KEY = 'VENDOR_TG_TOKEN', VENDOR_CHAT_KEY = 'VENDOR_TG_CHAT', HEALTH_STATE_KEY = 'HEALTH_STATE', HEALTH_DIGEST_KEY = 'HEALTH_DIGEST_DAY';
const HEALTH_LAST_KEY = 'HEALTH_LAST', TG_HOURLY_LAST_KEY = 'TG_HOURLY_LAST';
const HEALTH_DIGEST_HOUR = 8, HEALTH_BACKUP_DAYS = 8, HEALTH_MAIL_MIN = 20, HEALTH_CELLS_LIMIT = 10000000, HEALTH_CELLS_WARN = 0.7;
const HEALTH_AUDIT_TAIL = 3000, HEALTH_FAIL_ACTIONS = ['tg_failed', 'email_failed', 'reminder_failed'], HEALTH_FAIL_BURST = 5;
const CLIENT_ERR_KEEP = 5000, CLIENT_ERR_PER_USER_HOUR = 20, CLIENT_ERR_ANON_HOUR = 60;

/* ---------- the checks (each returns null when fine, or a short Arabic message) ---------- */
function healthChecks_() {
  const props = PropertiesService.getScriptProperties(), st = settings_(), now = Date.now(), H = 3600e3, out = [];
  const handlers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  const add = (key, fn) => { let msg = null; try { msg = fn(); } catch (e) { msg = 'تعذّر الفحص: ' + String(e && e.message || e).slice(0, 120); } out.push({ key: key, ok: !msg, msg: msg || '' }); };
  add('backup', () => {
    if (handlers.indexOf('weeklyBackup_') < 0) return 'مشغّل النسخ الاحتياطي الأسبوعي غير مثبّت';
    const it = DriveApp.getFoldersByName('MedRep Backups'); if (!it.hasNext()) return 'لا يوجد مجلد نسخ احتياطية';
    const prefix = SpreadsheetApp.getActive().getName() + ' — ', files = it.next().getFiles(); let last = 0;
    while (files.hasNext()) { const f = files.next(); if (f.getName().indexOf(prefix) === 0) last = Math.max(last, f.getDateCreated().getTime()); }
    if (!last) return 'لا توجد أي نسخة احتياطية لهذا الشيت';
    const days = Math.floor((now - last) / 864e5);
    return days > HEALTH_BACKUP_DAYS ? 'آخر نسخة احتياطية قبل ' + days + ' يومًا' : null;
  });
  add('gps', () => {
    if (handlers.indexOf(GPS_RETENTION_HANDLER) < 0) return 'مشغّل حذف بيانات الموقع والصور بعد 90 يومًا غير مثبّت';
    let s = null; try { s = JSON.parse(props.getProperty(GPS_RETENTION_STATUS_KEY) || 'null'); } catch (e) {}
    if (!s) return null; // installed but not run yet
    if (!s.ok) return 'فشل حذف بيانات الموقع: ' + String(s.error || '').slice(0, 120);
    const t = Date.parse(s.finishedAt || s.startedAt); return isFinite(t) && now - t > 50 * H ? 'حذف بيانات الموقع لم يعمل منذ ' + Math.floor((now - t) / 864e5) + ' أيام' : null;
  });
  add('telegram', () => {
    if (!tgToken_()) return null;
    if (handlers.indexOf('tgHourly') < 0) return 'مشغّل تيليجرام غير مثبّت (الملخص اليومي متوقف)';
    const t = +props.getProperty(TG_HOURLY_LAST_KEY) || 0; return t && now - t > 3 * H ? 'مشغّل تيليجرام لم يعمل منذ ' + Math.floor((now - t) / H) + ' ساعات' : null;
  });
  add('reminders', () => (String(st.remindEnabled) === 'true' && ['sendReminders_', 'sendFinalReminder_', 'sendEveningReminder_'].some(h => handlers.indexOf(h) < 0)
    ? 'التذكيرات مفعّلة لكن مشغّلاتها ناقصة (أعد حفظ إعدادات التذكير)' : null));
  add('mail', () => { const n = MailApp.getRemainingDailyQuota(); return n < HEALTH_MAIL_MIN ? 'حصة البريد اليومية شبه منتهية (متبقٍ ' + n + ')' : null; });
  add('size', () => {
    const cells = SpreadsheetApp.getActive().getSheets().reduce((n, sh) => n + sh.getMaxRows() * sh.getMaxColumns(), 0);
    return cells > HEALTH_CELLS_LIMIT * HEALTH_CELLS_WARN ? 'حجم الشيت ' + Math.round(cells / HEALTH_CELLS_LIMIT * 100) + '% من حد Google' : null;
  });
  add('external', () => {
    // The owner may not have granted "connect to an external service" (needed by Telegram, the vendor bot and Google Maps links).
    try { UrlFetchApp.fetch('https://api.telegram.org', { muteHttpExceptions: true, followRedirects: false }); return null; }
    catch (e) { return /permission|external_request|إذن/i.test(String(e && e.message)) ? 'صلاحية الاتصال بالخدمات الخارجية غير ممنوحة: من القائمة اختر «منح الصلاحيات»' : null; }
  });
  add('setup', () => {
    if (!props.getProperty('SALT')) return 'الإعداد السري SALT مفقود';
    const bad = ['Settings', 'Reps', 'Reports', 'Audit'].filter(n => { const sh = sheet_(n); if (!sh) return true; const h = sh.getRange(1, 1, 1, T[n].length).getValues()[0]; return T[n].some((c, i) => h[i] !== c); });
    return bad.length ? 'جداول ناقصة أو عناوينها مختلفة: ' + bad.join('، ') : null;
  });
  add('errors', () => {
    const since = now - 24 * H, rows = healthAuditTail_(), cnt = {};
    rows.forEach(a => { if (Date.parse(a.ts) >= since && HEALTH_FAIL_ACTIONS.indexOf(a.action) >= 0) cnt[a.action] = (cnt[a.action] || 0) + 1; });
    const names = { tg_failed: 'تيليجرام', email_failed: 'البريد', reminder_failed: 'التذكيرات' };
    const hot = Object.keys(cnt).filter(k => cnt[k] >= HEALTH_FAIL_BURST);
    return hot.length ? 'أخطاء متكررة خلال 24 ساعة: ' + hot.map(k => names[k] + ' ' + cnt[k]).join('، ') : null;
  });
  add('phones', () => {
    const c = clientErrSummary_(24); if (!c.top) return null;
    return c.top.users >= 2 ? 'خطأ يتكرر عند ' + c.top.users + ' مستخدمين: «' + c.top.msg.slice(0, 80) + '» (' + c.top.count + ' مرة)' : null;
  });
  return out;
}
// The last rows of the audit log only (it grows forever; reading it whole every hour would get slower and slower).
function healthAuditTail_() {
  const sh = sheet_('Audit'); if (!sh) return [];
  const last = sh.getLastRow(); if (last < 2) return [];
  const n = Math.min(HEALTH_AUDIT_TAIL, last - 1);
  return sh.getRange(last - n + 1, 1, n, T.Audit.length).getValues().map(r => rowObj_('Audit', r));
}

/* ---------- vendor Telegram ---------- */
function vendorSend_(text) {
  const p = PropertiesService.getScriptProperties(), token = p.getProperty(VENDOR_TOKEN_KEY), chat = p.getProperty(VENDOR_CHAT_KEY);
  if (!token || !chat) return false;
  try { tgCall_('sendMessage', { chat_id: chat, text: ('🏢 ' + (settings_().companyName || SpreadsheetApp.getActive().getName()) + '\n' + text).slice(0, 4000), disable_web_page_preview: true }, token); return true; }
  catch (e) { return false; }
}
function healthText_(checks) {
  const bad = checks.filter(c => !c.ok);
  return bad.length ? bad.map(c => '⚠️ ' + c.msg).join('\n') : '✅ كل الفحوص سليمة';
}
// Hourly trigger: alert on changes only (a new problem, a fixed one), and one morning digest a day.
function healthHourly() {
  const props = PropertiesService.getScriptProperties(), checks = healthChecks_(), now = new Date();
  props.setProperty(HEALTH_LAST_KEY, String(now.getTime()));
  let prev = {}; try { prev = JSON.parse(props.getProperty(HEALTH_STATE_KEY) || '{}'); } catch (e) {}
  const cur = {}; checks.filter(c => !c.ok).forEach(c => { cur[c.key] = c.msg; });
  const broke = Object.keys(cur).filter(k => !prev[k]), fixed = Object.keys(prev).filter(k => !cur[k]);
  const lines = broke.map(k => '⚠️ عطل: ' + cur[k]).concat(fixed.map(k => '✅ عاد سليمًا: ' + prev[k]));
  if (lines.length && vendorSend_(lines.join('\n'))) props.setProperty(HEALTH_STATE_KEY, JSON.stringify(cur));
  else if (!lines.length) props.setProperty(HEALTH_STATE_KEY, JSON.stringify(cur));
  const tz = settings_().timezone || Session.getScriptTimeZone(), day = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  if (+Utilities.formatDate(now, tz, 'H') >= HEALTH_DIGEST_HOUR && props.getProperty(HEALTH_DIGEST_KEY) !== day) {
    const c = clientErrSummary_(24), y = yesterday_(), sent = reportsLight_().filter(r => r.date === y && ['مرسل', 'معتمد'].indexOf(r.status) >= 0).length;
    const text = '☀️ التقرير الصباحي\n' + healthText_(checks) + '\nتقارير الأمس المرسلة: ' + sent + '\nأخطاء الهواتف (24 ساعة): ' + c.total + (c.top ? ' — الأكثر: «' + c.top.msg.slice(0, 60) + '» ×' + c.top.count : '');
    if (vendorSend_(text)) props.setProperty(HEALTH_DIGEST_KEY, day);
  }
  trimClientErrors_();
  return checks;
}

/* ---------- errors reported by the phones (no report content: kind, screen, message, app version, device) ---------- */
function clientErr_(s, p) {
  const cache = CacheService.getScriptCache(), who = s ? String(s.uid) : 'anon', key = 'cerr_' + who + '_' + Math.floor(Date.now() / 3600e3);
  const n = +cache.get(key) || 0, max = s ? CLIENT_ERR_PER_USER_HOUR : CLIENT_ERR_ANON_HOUR;
  const list = (Array.isArray(p.errors) ? p.errors : [p]).slice(0, 10), room = Math.max(0, max - n);
  if (!room) return 0;
  ensureSheet_('ClientErrors');
  const cut = (v, k) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, k);
  const rows = list.slice(0, room).filter(e => e && cut(e.msg, 1)).map(e => {
    const t = Date.parse(e.ts), ts = isFinite(t) && Math.abs(Date.now() - t) < 7 * 864e5 ? new Date(t).toISOString() : new Date().toISOString();
    return [ts, s ? s.uid : '', s ? s.role : '', cut(e.kind, 30), cut(e.screen, 40), cut(e.msg, 240), cut(e.ver, 24), cut(e.ua, 120)];
  });
  if (rows.length) { const sh = sheet_('ClientErrors'); sh.getRange(sh.getLastRow() + 1, 1, rows.length, T.ClientErrors.length).setValues(rows); dropTableCache_('ClientErrors'); }
  try { cache.put(key, String(n + rows.length), 3700); } catch (e) {}
  return rows.length;
}
function clientErrSummary_(hours) {
  const sh = sheet_('ClientErrors'); if (!sh || sh.getLastRow() < 2) return { total: 0, top: null };
  const last = sh.getLastRow(), n = Math.min(2000, last - 1), since = Date.now() - hours * 3600e3, by = {};
  let total = 0;
  sh.getRange(last - n + 1, 1, n, T.ClientErrors.length).getValues().forEach(r => {
    const t = r[0] instanceof Date ? r[0].getTime() : Date.parse(r[0]); if (!(t >= since)) return;
    total++; const k = String(r[5]); const b = by[k] || (by[k] = { msg: k, count: 0, users: {} }); b.count++; b.users[r[1] || 'anon'] = 1;
  });
  const top = Object.keys(by).map(k => ({ msg: by[k].msg, count: by[k].count, users: Object.keys(by[k].users).length }))
    .sort((a, b) => b.users - a.users || b.count - a.count)[0] || null;
  return { total: total, top: top };
}
function trimClientErrors_() {
  const sh = sheet_('ClientErrors'); if (!sh) return;
  const extra = sh.getLastRow() - 1 - CLIENT_ERR_KEEP; if (extra > 0) sh.deleteRows(2, extra);
}

/* ---------- owner menu ---------- */
function vendorSetup() {
  ownerOnly_();
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('ربط بوت المزوّد', 'أرسل أي رسالة لبوتك الخاص أولًا، ثم الصق مفتاحه (Bot Token) هنا:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const token = String(r.getResponseText() || '').trim();
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token)) { ui.alert('المفتاح غير صالح. انسخه كما هو من @BotFather.'); return; }
  let chat = null;
  try {
    tgCall_('getMe', {}, token);
    const ups = tgCall_('getUpdates', { timeout: 0, allowed_updates: ['message'] }, token) || [];
    ups.forEach(u => { if (u.message && u.message.chat && u.message.chat.type === 'private') chat = String(u.message.chat.id); });
  } catch (e) { ui.alert('تعذّر الاتصال بالبوت: ' + e.message); return; }
  if (!chat) { ui.alert('لم أجد رسالة منك. افتح البوت في تيليجرام، اضغط Start أو أرسل أي رسالة، ثم أعد المحاولة.'); return; }
  const props = PropertiesService.getScriptProperties();
  props.setProperty(VENDOR_TOKEN_KEY, token); props.setProperty(VENDOR_CHAT_KEY, chat); props.deleteProperty(HEALTH_STATE_KEY);
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'healthHourly') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('healthHourly').timeBased().everyHours(1).create();
  audit_({ uid: 'OWNER', role: 'admin' }, 'vendor_setup', '');
  vendorSend_('✅ تم ربط كاشف الأعطال بهذه النسخة.\n' + healthText_(healthChecks_()));
  ui.alert('تم الربط. ستصلك رسالة الآن، ثم تنبيه عند أي عطل وتقرير كل صباح.');
}
// Sheet menu: uses every Google service the system needs, so Google asks the owner for any permission not granted yet
// (with Google's per-permission screen, tick every box). Then shows the result.
function grantPermissions() {
  ownerOnly_();
  UrlFetchApp.fetch('https://api.telegram.org', { muteHttpExceptions: true, followRedirects: false });
  DriveApp.getRootFolder(); MailApp.getRemainingDailyQuota(); ScriptApp.getProjectTriggers();
  SpreadsheetApp.getUi().alert('✅ كل الصلاحيات ممنوحة: الاتصال بالخدمات الخارجية، وDrive، والبريد، والمشغّلات.');
}
function healthNow() {
  ownerOnly_();
  const checks = healthChecks_(), names = { external: 'صلاحية الاتصال الخارجي', backup: 'النسخ الاحتياطي', gps: 'حذف بيانات الموقع', telegram: 'تيليجرام', reminders: 'التذكيرات', mail: 'حصة البريد', size: 'حجم الشيت', setup: 'الإعدادات والجداول', errors: 'أخطاء الخادم', phones: 'أخطاء الهواتف' };
  const c = clientErrSummary_(24), last = +PropertiesService.getScriptProperties().getProperty(HEALTH_LAST_KEY) || 0;
  SpreadsheetApp.getUi().alert('فحص النظام', checks.map(x => (x.ok ? '✅ ' : '⚠️ ') + names[x.key] + (x.ok ? '' : ': ' + x.msg)).join('\n') +
    '\n\nأخطاء الهواتف خلال 24 ساعة: ' + c.total + '\nآخر فحص تلقائي: ' + (last ? new Date(last).toLocaleString() : 'لم يُفعّل بعد (ربط بوت المزوّد)'), SpreadsheetApp.getUi().ButtonSet.OK);
}
