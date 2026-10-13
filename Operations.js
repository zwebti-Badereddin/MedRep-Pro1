// MedRep Pro — sheet menu, leaves and holidays, reminders, backups and the audit log.

/* ---------- add reps from the Sheet (menu: MedRep Pro). Not reachable from the web app. ---------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('MedRep Pro').addItem('إضافة المندوبين من ورقة NewReps', 'addRepsFromSheet').addItem('نسخة احتياطية الآن', 'backupNow').addItem('تفعيل النسخ الاحتياطي الأسبوعي', 'installBackupTrigger').addItem('إعادة ضبط عدّادات الدخول', 'resetLoginThrottle').addItem('تحديث بيانات التطبيق (بعد تعديل الشيت يدويًا)', 'refreshAppCache').addItem('تفعيل تجهيز البيانات التلقائي (أسرع دخول)', 'installCacheWarmTrigger').addToUi();
}

/* ---------- leaves, permissions and official holidays (admin only) ---------- */
const LEAVE_TYPES = ['سنوية', 'مرضية', 'مهمة رسمية', 'إذن']; // 'إذن' = half-day permission: report still required
const isDate_ = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
function ensureSheet_(n) {
  const ss = SpreadsheetApp.getActive(); let sh = ss.getSheetByName(n);
  if (!sh) { sh = ss.insertSheet(n); sh.appendRow(T[n]); sh.setFrozenRows(1); sh.getRange(1, 1, sh.getMaxRows(), T[n].length).setNumberFormat('@'); }
}

// Holidays and leaves change only through leaveSave_ / holidaySave_ / delRow_, which drop this cache; read on every login otherwise.
const OFF_KEY = 'off';
function offData_() {
  const hit = cacheGetLarge_(OFF_KEY); if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  ensureSheet_('Leaves'); ensureSheet_('Holidays');
  const hol = {}, lv = {};
  dbAll_('Holidays').forEach(h => { hol[h.date] = h.name; });
  dbAll_('Leaves').forEach(l => { (lv[l.repId] = lv[l.repId] || []).push(l); });
  const out = { hol: hol, lv: lv };
  cachePutLarge_(OFF_KEY, JSON.stringify(out), CACHE_LONG_SEC);
  return out;
}
function dropOffCache_() {
  const keys = [OFF_KEY]; for (let i = 0; i < LARGE_MAX_CHUNKS; i++) keys.push(OFF_KEY + '_' + i);
  try { CacheService.getScriptCache().removeAll(keys); } catch (e) {}
}
// 1 = fully off (holiday or leave), 0.5 = permission, 0 = normal working day
function offWeight_(off, repId, day) {
  if (off.hol[day]) return 1;
  let w = 0; (off.lv[repId] || []).forEach(l => { if (day >= l.from && day <= l.to) w = Math.max(w, l.type === 'إذن' ? 0.5 : 1); });
  return w;
}
function workDays_(from, to, wd) {
  const f = d => Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'), out = [];
  for (let d = new Date(from + 'T12:00:00Z'); f(d) <= to; d = new Date(d.getTime() + 864e5)) if (wd.indexOf(d.getUTCDay()) >= 0) out.push(f(d));
  return out;
}
function nextId_(sheet, pre) { return pre + '-' + ('0000' + (dbAll_(sheet).reduce((a, r) => Math.max(a, +String(r.id).split('-')[1] || 0), 0) + 1)).slice(-4); }
function leavesList_(s, p) { ensureSheet_('Leaves'); return dbAll_('Leaves').filter(l => !p.repId || l.repId === p.repId).sort((a, b) => (a.from < b.from ? 1 : -1)); }
function leaveSave_(s, p) {
  ensureSheet_('Leaves'); const r = p.row || {};
  if (!dbAll_('Reps').some(x => x.id === r.repId)) throw new Error('المندوب غير موجود');
  if (LEAVE_TYPES.indexOf(r.type) < 0) throw new Error('نوع غير صالح');
  if (!isDate_(r.from) || !isDate_(r.to) || r.to < r.from) throw new Error('التواريخ غير صحيحة');
  if ((new Date(r.to) - new Date(r.from)) / 864e5 > 120) throw new Error('الفترة أطول من المسموح (120 يومًا)');
  if (dbAll_('Leaves').some(l => l.repId === r.repId && !(r.to < l.from || r.from > l.to))) throw new Error('تتداخل مع إجازة مسجّلة لنفس المندوب');
  const id = nextId_('Leaves', 'LV');
  dbAppend_('Leaves', { id: id, repId: r.repId, from: r.from, to: r.to, type: r.type, note: String(r.note || '').slice(0, 200), createdAt: new Date().toISOString(), createdBy: s.uid });
  audit_(s, 'add_leave', id, r.repId + ' ' + r.from + ' to ' + r.to + ' ' + r.type); return id;
}
function holidaySave_(s, p) {
  ensureSheet_('Holidays'); const r = p.row || {}, name = String(r.name || '').trim().slice(0, 80);
  if (!isDate_(r.date)) throw new Error('التاريخ غير صحيح');
  if (name.length < 2) throw new Error('أدخل اسم العطلة');
  if (dbAll_('Holidays').some(h => h.date === r.date)) throw new Error('هذا التاريخ مسجّل كعطلة');
  const id = nextId_('Holidays', 'HOL'); dbAppend_('Holidays', { id: id, date: r.date, name: name });
  audit_(s, 'add_holiday', id, r.date + ' ' + name); return id;
}
function delRow_(s, sheet, id, action) {
  const sh = sheet_(sheet), v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) if (String(v[i][0]) === String(id)) { sh.deleteRow(i + 1); if (sheet === 'Leaves' || sheet === 'Holidays') dropOffCache_(); audit_(s, action, id); return true; }
  throw new Error('السجل غير موجود');
}

/* ---------- reminders (daily trigger): rep with email + summary to the manager ---------- */
// One engine for all reminders: sends only to active reps who are not on leave/holiday and have not sent that day's report.
function remindCore_(day, subject, bodyFn, tellManager) {
  const st = settings_(); if (String(st.remindEnabled) !== 'true') return;
  const wd = String(st.workDays || '0,1,2,3,4').split(',').map(Number), off = offData_();
  if (wd.indexOf(new Date(day + 'T12:00:00Z').getUTCDay()) < 0 || off.hol[day]) return;
  const reports = reportsLight_().filter(r => r.date === day), missing = [], url = ScriptApp.getService().getUrl(), hh = ('0' + closeHour_(st)).slice(-2);
  dbAll_('Reps').filter(r => String(r.active) !== 'false').forEach(rep => {
    if (offWeight_(off, rep.id, day) >= 1) return; // on leave
    const r = reports.find(x => x.repId === rep.id);
    if (r && ['مرسل', 'معتمد'].indexOf(r.status) >= 0) return;
    missing.push(rep.name);
    if (!rep.email) return;
    try { MailApp.sendEmail({ to: rep.email, name: st.companyName || 'MedRep Pro', subject: subject, body: bodyFn(rep, url, hh) }); }
    catch (e) { audit_({ uid: 'SYSTEM', role: 'system' }, 'reminder_failed', rep.id, String(e.message)); }
  });
  if (tellManager && missing.length && st.reportEmail) {
    try { MailApp.sendEmail({ to: st.reportEmail, name: st.companyName || 'MedRep Pro', subject: subject + ' — ' + missing.length + ' مندوب', body: missing.join('\n') }); }
    catch (e) { audit_({ uid: 'SYSTEM', role: 'system' }, 'reminder_failed', 'manager', String(e.message)); }
  }
}
function sendReminders_() { // morning: yesterday's report
  const y = yesterday_();
  remindCore_(y, 'تذكير: تقرير ' + y + ' لم يُرسل بعد', (rep, url, hh) => 'مرحبًا ' + rep.name + '،\nتقرير يوم ' + y + ' لم يُرسل بعد. آخر موعد اليوم الساعة ' + hh + ':00.\n' + url, true);
}
function sendFinalReminder_() { // one hour before the deadline: still unsent
  const y = yesterday_();
  remindCore_(y, 'آخر ساعة: تقرير ' + y + ' لم يُرسل', (rep, url, hh) => 'مرحبًا ' + rep.name + '،\nتبقّت ساعة تقريبًا على إغلاق تقرير يوم ' + y + ' (الساعة ' + hh + ':00)، وبعدها يُحتسب متأخرًا.\n' + url, true);
}
function sendEveningReminder_() { // evening: today's report
  const d = today_();
  remindCore_(d, 'تذكير: أرسل تقرير اليوم ' + d, (rep, url, hh) => 'مرحبًا ' + rep.name + '،\nتقرير اليوم لم يُرسل بعد. أرسله قبل الساعة ' + hh + ':00 صباح الغد.\n' + url, false);
}
function setReminders_(s, p) {
  const clamp = (v, d) => Math.min(23, Math.max(0, isNaN(+v) || v === '' || v === null || v === undefined ? d : +v));
  const on = !!p.enabled, h1 = clamp(p.hour, 8), h2 = clamp(p.evening, 18), hf = Math.max(0, closeHour_(settings_()) - 1);
  dbUpsert_('Settings', 'key', { key: 'remindEnabled', value: on ? 'true' : 'false' });
  dbUpsert_('Settings', 'key', { key: 'remindHour', value: String(h1) }); dbUpsert_('Settings', 'key', { key: 'remindEvening', value: String(h2) });
  const names = ['sendReminders_', 'sendFinalReminder_', 'sendEveningReminder_'];
  ScriptApp.getProjectTriggers().forEach(t => { if (names.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
  if (on) {
    ScriptApp.newTrigger('sendReminders_').timeBased().everyDays(1).atHour(h1).create();
    ScriptApp.newTrigger('sendFinalReminder_').timeBased().everyDays(1).atHour(hf).create();
    ScriptApp.newTrigger('sendEveningReminder_').timeBased().everyDays(1).atHour(h2).create();
  }
  clearCache_(); audit_(s, 'set_reminders', on ? 'on ' + h1 + '/' + hf + '/' + h2 : 'off'); return true;
}

/* ---------- automatic backup: weekly copy of this spreadsheet into Drive, keeps the last 8 ---------- */
function weeklyBackup_() {
  const ss = SpreadsheetApp.getActive(), it = DriveApp.getFoldersByName('MedRep Backups');
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder('MedRep Backups');
  DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' — ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'), folder);
  const files = [], fi = folder.getFiles(); while (fi.hasNext()) files.push(fi.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated()).slice(8).forEach(f => f.setTrashed(true));
  audit_({ uid: 'SYSTEM', role: 'system' }, 'backup', folder.getName());
}
function backupNow() { ownerOnly_(); weeklyBackup_(); SpreadsheetApp.getUi().alert('تم إنشاء نسخة احتياطية في مجلد MedRep Backups بدرايف.'); }
function installBackupTrigger() {
  ownerOnly_();
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'weeklyBackup_') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('weeklyBackup_').timeBased().onWeekDay(ScriptApp.WeekDay.THURSDAY).atHour(23).create();
}

/* ---------- audit ---------- */
function audit_(s, action, ref, details) {
  dbAppend_('Audit', { ts: new Date().toISOString(), userId: s.uid || s.userId || '', role: s.role, action, ref: ref || '', details: details || '' });
}
