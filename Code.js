/**
 * MedRep Pro — Backend (Google Apps Script + Sheets)
 * Setup: bind to a Google Sheet -> run setup() once -> Deploy as Web App
 * (Execute as: Me, Access: Anyone). Optional: run setAdminPassword('...') once.
 * Layers: doGet/api() [transport] -> auth/role gate -> services -> sheets (db*).
 */
const T = {
  Settings: ['key', 'value'],
  Reps: ['id', 'name', 'codeHash', 'phone', 'active', 'email'],
  Admins: ['id', 'username', 'name', 'passwordHash', 'active', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
  Doctors: ['id', 'name', 'specialty', 'workplace', 'sector', 'lat', 'lng', 'radius', 'active', 'refState', 'refBy', 'addedBy', 'reviewed'],
  DoctorWorkplaces: ['id', 'doctorId', 'doctorName', 'workplace', 'sector', 'lat', 'lng', 'radius', 'active', 'refState', 'refBy', 'addedBy', 'reviewed'],
  Facilities: ['id', 'name', 'type', 'region', 'address', 'status', 'legacyEntity', 'legacyId', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
  FacilityLocations: ['id', 'facilityId', 'lat', 'lng', 'radius', 'source', 'state', 'proposedBy', 'proposedAt', 'approvedBy', 'approvedAt', 'version', 'active', 'note'],
  DoctorPlaces: ['id', 'doctorId', 'facilityId', 'workDays', 'notes', 'active', 'legacyWorkplaceId', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
  Pharmacies: ['id', 'name', 'location', 'nearFacility', 'lat', 'lng', 'radius', 'active', 'refState', 'refBy', 'addedBy', 'reviewed'],
  Products: ['id', 'name', 'category', 'status'],
  KPI: ['key', 'name', 'target', 'weight', 'active'],
  Reports: ['id', 'no', 'repId', 'date', 'status', 'notes', 'doctors', 'pharmacies', 'snapshot', 'createdAt', 'updatedAt', 'submittedAt', 'reviewNote', 'snapshot1', 'reopens'],
  Audit: ['ts', 'userId', 'role', 'action', 'ref', 'details'],
  Leaves: ['id', 'repId', 'from', 'to', 'type', 'note', 'createdAt', 'createdBy'],
  Holidays: ['id', 'date', 'name'],
  Monthly: ['id', 'ym', 'repId', 'repName', 'score', 'compliance', 'onTime', 'expected', 'visits', 'verified', 'gpsTotal', 'kpis', 'computedAt']
};
const PREFIX = { Reps: 'REP', Doctors: 'DOC', Pharmacies: 'PH', Products: 'PROD' };
const STATUS = ['مسودة', 'جاهز للمراجعة', 'مرسل', 'معتمد', 'معاد للمندوب']; // editable via Settings.statuses later
const SESSION_SEC = 6 * 3600;
let _SALT, _ST = null; // per-execution memo

/* ---------- transport ---------- */
// Used by Index.html: <?!= include('Style'); ?> pulls in the other HTML files (keeps every file small).
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

function doGet(e) {
  // Diagnostic: open <web-app-url>?ping=1 -> plain text 'OK' proves the deployment itself works.
  if (e && e.parameter && e.parameter.ping) return ContentService.createTextOutput('OK ' + new Date().toISOString());
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('MedRep Pro').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Single entry point called by google.script.run.api(token, action, payload)
function api(token, action, p) {
  p = p || {};
  try {
    if (action === 'login') return ok(login_(p));
    const s = session_(token);
    const route = ROUTES[action];
    if (!route) throw new Error('عملية غير معروفة');
    if (route.role !== 'any' && route.role !== s.role) throw new Error('غير مصرح');
    return ok(route.fn(s, p));
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
const ok = d => ({ ok: true, data: d });

const ROUTES = {
  logout:        { role: 'any',   fn: (s) => { CacheService.getScriptCache().remove('s_' + s.token); audit_(s, 'logout', s.uid); return true; } },
  bootstrap:     { role: 'any',   fn: bootstrap_ },
  masterList:    { role: 'admin', fn: masterList_ },
  masterAct:     { role: 'admin', fn: masterAct_ },
  workplacesList:{ role: 'admin', fn: workplacesList_ },
  workplaceAct:  { role: 'admin', fn: workplaceAct_ },
  addDoctorWorkplace: { role: 'rep', fn: (s, p) => addDoctorWorkplace_(s, p) },
  reopenReport:  { role: 'rep',   fn: reopenReport_ },
  prevInfo:      { role: 'rep',   fn: prevInfo_ },
  trend:         { role: 'admin', fn: trend_ },
  yearly:        { role: 'admin', fn: yearly_ },
  closeMonth:    { role: 'admin', fn: (s, p) => { ensureMonthly_(); const n = computeMonth_(p.ym, true).length; audit_(s, 'close_month', p.ym); return n; } },
  repsList:      { role: 'admin', fn: repsList_ },
  repSave:       { role: 'admin', fn: repSave_ },
  myReports:     { role: 'rep',   fn: myReports_ },
  myPerformance: { role: 'rep',   fn: myPerformance_ },
  kpiList:       { role: 'admin', fn: () => dbAll_('KPI') },
  setReminders:  { role: 'admin', fn: setReminders_ },
  leavesList:    { role: 'admin', fn: leavesList_ },
  leaveSave:     { role: 'admin', fn: leaveSave_ },
  leaveDelete:   { role: 'admin', fn: (s, p) => delRow_(s, 'Leaves', p.id, 'delete_leave') },
  holidaysList:  { role: 'admin', fn: () => { ensureSheet_('Holidays'); return dbAll_('Holidays').sort((a, b) => (a.date < b.date ? 1 : -1)); } },
  holidaySave:   { role: 'admin', fn: holidaySave_ },
  holidayDelete: { role: 'admin', fn: (s, p) => delRow_(s, 'Holidays', p.id, 'delete_holiday') },
  addDoctor:     { role: 'rep',   fn: (s, p) => addMaster_(s, 'Doctors', p) },
  addPharmacy:   { role: 'rep',   fn: (s, p) => addMaster_(s, 'Pharmacies', p) },
  loginAudit:    { role: 'any',   fn: (s) => { audit_(s, 'login', s.uid); return true; } },
  saveReport:    { role: 'rep',   fn: saveReport_ },
  submitReport:  { role: 'rep',   fn: submitReport_ },
  myReport:      { role: 'rep',   fn: myReport_ },
  getReport:     { role: 'any',   fn: getReport_ },
  listReports:   { role: 'any',   fn: listReports_ },
  reviewReport:  { role: 'admin', fn: reviewReport_ },
  list:          { role: 'admin', fn: (s, p) => dbAll_(entity_(p.entity)) },
  save:          { role: 'admin', fn: saveEntity_ },
  saveKpi:       { role: 'admin', fn: saveKpi_ },
  saveSettings:  { role: 'admin', fn: saveSettings_ },
  saveLogo:      { role: 'admin', fn: saveCompanyLogo_ },
  performance:   { role: 'admin', fn: performance_ },
  audit:         { role: 'admin', fn: (s, p) => dbAll_('Audit').slice(-(p.limit || 200)).reverse() }
};

/* ---------- auth (server-side; the UI never decides permissions) ---------- */
function hash_(v) {
  _SALT = _SALT || PropertiesService.getScriptProperties().getProperty('SALT'); const salt = _SALT;
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + v));
}
// Public functions can be called by any web-app visitor through google.script.run, so owner-only ones must refuse anyone else.
function ownerOnly_() { if (Session.getActiveUser().getEmail() !== Session.getEffectiveUser().getEmail()) throw new Error('غير مصرح'); }
function setAdminPassword(pw) {
  ownerOnly_();
  const password = String(pw || '');
  if (password.length < 12) throw new Error('كلمة مرور الإدارة يجب ألا تقل عن 12 حرفًا.');
  PropertiesService.getScriptProperties().setProperty('ADMIN_HASH', hash_(password));
}

// Run from the bound spreadsheet by the project owner to set a new admin password.
// The password is entered interactively and is never written into source code.
function configureAdminPassword() {
  ownerOnly_();
  const ui = SpreadsheetApp.getUi();
  const first = ui.prompt('تعيين كلمة مرور الإدارة', 'أدخل كلمة مرور جديدة لا تقل عن 12 حرفًا:', ui.ButtonSet.OK_CANCEL);
  if (first.getSelectedButton() !== ui.Button.OK) return;
  const password = first.getResponseText();
  if (password.length < 12) throw new Error('كلمة مرور الإدارة يجب ألا تقل عن 12 حرفًا.');
  const second = ui.prompt('تأكيد كلمة مرور الإدارة', 'أعد إدخال كلمة المرور للتأكيد:', ui.ButtonSet.OK_CANCEL);
  if (second.getSelectedButton() !== ui.Button.OK) return;
  if (password !== second.getResponseText()) throw new Error('كلمتا المرور غير متطابقتين.');
  setAdminPassword(password);
  ui.alert('تم حفظ كلمة مرور الإدارة. احفظها في مكان آمن.');
}

// One-time migration: deactivate known demo PINs without deleting reps or their report history.
function disableDemoRepAccounts() {
  ownerOnly_();
  const ui = SpreadsheetApp.getUi();
  const pins = ['001', '002', '003', '004'];
  const hashes = pins.map(pin => hash_(pin));
  const reps = dbAll_('Reps').filter(r => hashes.indexOf(String(r.codeHash)) >= 0 && String(r.active) !== 'false');
  if (!reps.length) {
    ui.alert('لم يتم العثور على حسابات نشطة تستخدم رموز الدخول التجريبية 001–004.');
    return;
  }
  const answer = ui.alert(
    'تعطيل حسابات المندوبين التجريبية',
    'سيتم تعطيل ' + reps.length + ' حساب/حسابات تستخدم الرموز التجريبية 001–004. لن تُحذف الحسابات أو التقارير. هل تريد المتابعة؟',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;
  const cache = CacheService.getScriptCache();
  reps.forEach(rep => {
    rep.active = false;
    dbUpsert_('Reps', 'id', rep);
    cache.put('off_' + rep.id, '1', SESSION_SEC);
  });
  clearCache_();
  audit_({ uid: 'SYSTEM', role: 'system' }, 'disable_demo_reps', reps.map(rep => rep.id).join(','));
  ui.alert('تم تعطيل الحسابات التجريبية: ' + reps.map(rep => rep.name).join('، '));
}

// Shared throttle for failed representative logins: 15 failures per 10-minute window.
// It is independent of the entered PIN, so rotating guessed codes cannot bypass it.
function repLoginThrottle_(recordFailure) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cache = CacheService.getScriptCache(), key = 'rep_login_global';
    const now = Date.now(), raw = cache.get(key);
    let state = raw ? JSON.parse(raw) : null;
    if (!state || now - state.start >= 600000) state = { start: now, count: 0 };
    if (!recordFailure && state.count >= 15) throw new Error('محاولات دخول كثيرة. حاول بعد 10 دقائق.');
    if (recordFailure) state.count++;
    const ttl = Math.max(1, Math.ceil((600000 - (now - state.start)) / 1000));
    cache.put(key, JSON.stringify(state), ttl);
  } finally {
    lock.releaseLock();
  }
}
function login_(p) {
  const isAdmin = p.role === 'admin';
  const cache = CacheService.getScriptCache(), key = 'try_' + (isAdmin ? 'admin' : p.code);
  if (!isAdmin) repLoginThrottle_(false);
  if (+cache.get(key) >= 5) throw new Error('محاولات كثيرة. حاول بعد 10 دقائق.');
  let user = null;
  if (isAdmin) {
    const username = String(p.username || '').trim().toLowerCase();
    const adminSheet = sheet_('Admins');
    let accounts = [];
    if (adminSheet) {
      const expected = T.Admins, actual = adminSheet.getRange(1, 1, 1, Math.max(adminSheet.getLastColumn(), expected.length)).getValues()[0];
      if (expected.some((h, i) => actual[i] !== h)) throw new Error('مخطط جدول حسابات الإدارة غير صحيح. راجع العناوين قبل تسجيل الدخول.');
      accounts = dbAll_('Admins');
    }
    if (accounts.length) {
      const a = accounts.find(x => String(x.username || '').trim().toLowerCase() === username && String(x.active) !== 'false');
      if (a && hash_(p.password || '') === String(a.passwordHash || '')) user = { id: a.id, name: a.name, username: a.username, role: 'admin' };
    } else if (hash_(p.password || '') === PropertiesService.getScriptProperties().getProperty('ADMIN_HASH')) {
      user = { id: 'ADMIN', name: 'الإدارة (حساب قديم)', username: '', role: 'admin' };
    }
  } else {
    const code = String(p.code || '').trim();
    const r = /^\d{5}$/.test(code)
      ? dbAll_('Reps').find(x => String(x.active) !== 'false' && x.codeHash === hash_(code))
      : null;
    if (r) user = { id: r.id, name: r.name, role: 'rep' };
  }
  if (!user) {
    cache.put(key, String((+cache.get(key) || 0) + 1), 600);
    if (!isAdmin) repLoginThrottle_(true);
    throw new Error('بيانات الدخول غير صحيحة');
  }
  cache.remove(key);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('s_' + token, JSON.stringify({ uid: user.id, name: user.name, role: user.role }), SESSION_SEC);
  const s = { uid: user.id, name: user.name, role: user.role, token: token };
  // one round trip: session + lookups + today's report (login audit is written by a follow-up call)
  return { token, user, boot: bootstrap_(s), report: user.role === 'rep' ? myReport_(s, {}) : null, prev: user.role === 'rep' ? prevInfo_(s) : null };
}
/* ---------- individual administrator accounts ---------- */
function ensureAdminSchema_() {
  const ss = SpreadsheetApp.getActive(); let sh = ss.getSheetByName('Admins');
  if (!sh) sh = ss.insertSheet('Admins');
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, T.Admins.length).setValues([T.Admins]); sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), T.Admins.length).setNumberFormat('@'); return sh;
  }
  const actual = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), T.Admins.length)).getValues()[0];
  if (actual.length !== T.Admins.length || T.Admins.some((h, i) => actual[i] !== h)) throw new Error('عناوين جدول Admins غير مطابقة. لم تُعدّل أي بيانات.');
  return sh;
}
function createAdminAccount() {
  ownerOnly_(); ensureAdminSchema_();
  const sp = PropertiesService.getScriptProperties(); if (!sp.getProperty('SALT')) sp.setProperty('SALT', Utilities.getUuid());
  const ui = SpreadsheetApp.getUi();
  const up = ui.prompt('إنشاء حساب مدير مستقل', 'اسم المستخدم (3–40 حرفًا: أحرف إنجليزية أو أرقام أو . _ -):', ui.ButtonSet.OK_CANCEL);
  if (up.getSelectedButton() !== ui.Button.OK) return { cancelled: true };
  const username = String(up.getResponseText() || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('اسم المستخدم غير صالح.');
  const rows = dbAll_('Admins');
  if (rows.some(a => String(a.username).toLowerCase() === username)) throw new Error('اسم المستخدم مسجّل مسبقًا.');
  const np = ui.prompt('اسم المدير', 'أدخل الاسم الظاهر في سجل التدقيق:', ui.ButtonSet.OK_CANCEL);
  if (np.getSelectedButton() !== ui.Button.OK) return { cancelled: true };
  const name = String(np.getResponseText() || '').trim().slice(0, 80);
  if (name.length < 2) throw new Error('اسم المدير قصير جدًا.');
  const pp = ui.prompt('كلمة المرور', 'أدخل كلمة مرور لا تقل عن 12 حرفًا:', ui.ButtonSet.OK_CANCEL);
  if (pp.getSelectedButton() !== ui.Button.OK) return { cancelled: true };
  const password = pp.getResponseText();
  if (password.length < 12) throw new Error('كلمة المرور يجب ألا تقل عن 12 حرفًا.');
  const cp = ui.prompt('تأكيد كلمة المرور', 'أعد إدخال كلمة المرور:', ui.ButtonSet.OK_CANCEL);
  if (cp.getSelectedButton() !== ui.Button.OK) return { cancelled: true };
  if (password !== cp.getResponseText()) throw new Error('كلمتا المرور غير متطابقتين.');
  const id = 'ADM-' + ('0000' + (rows.reduce((m, a) => Math.max(m, +(String(a.id).match(/(\d+)$/) || [0, 0])[1]), 0) + 1)).slice(-4);
  const now = new Date().toISOString();
  dbAppend_('Admins', { id: id, username: username, name: name, passwordHash: hash_(password), active: true, createdAt: now, createdBy: 'OWNER', updatedAt: now, updatedBy: 'OWNER' });
  audit_({ uid: 'OWNER', role: 'owner' }, 'create_admin_account', id, username); clearCache_();
  ui.alert('تم إنشاء حساب المدير ' + username + ' بمعرّف ' + id + '. استخدم اسم المستخدم وكلمة المرور عند دخول الإدارة.');
  return { id: id, username: username };
}
function setAdminAccountActive() {
  ownerOnly_(); ensureAdminSchema_();
  const ui = SpreadsheetApp.getUi(), rows = dbAll_('Admins');
  const up = ui.prompt('تفعيل / تعطيل حساب مدير', 'أدخل اسم المستخدم:', ui.ButtonSet.OK_CANCEL);
  if (up.getSelectedButton() !== ui.Button.OK) return { cancelled: true };
  const username = String(up.getResponseText() || '').trim().toLowerCase(), account = rows.find(a => String(a.username).toLowerCase() === username);
  if (!account) throw new Error('حساب المدير غير موجود.');
  const activeCount = rows.filter(a => String(a.active) !== 'false').length, nextActive = String(account.active) === 'false';
  if (!nextActive && activeCount <= 1) throw new Error('لا يمكن تعطيل آخر حساب مدير نشط.');
  const action = ui.alert('تأكيد تغيير حالة الحساب', (nextActive ? 'تفعيل' : 'تعطيل') + ' حساب ' + username + '؟', ui.ButtonSet.YES_NO);
  if (action !== ui.Button.YES) return { cancelled: true };
  account.active = nextActive; account.updatedAt = new Date().toISOString(); account.updatedBy = 'OWNER';
  dbUpsert_('Admins', 'id', account);
  audit_({ uid: 'OWNER', role: 'owner' }, nextActive ? 'enable_admin_account' : 'disable_admin_account', account.id, username);
  ui.alert('تم ' + (nextActive ? 'تفعيل' : 'تعطيل') + ' الحساب.');
  return { id: account.id, active: nextActive };
}
function assertIndependentLocationApproval_(s, entityId) {
  const rows = dbAll_('Audit');
  const proposals = rows.filter(a => String(a.ref) === String(entityId) && ['workplace_setLoc', 'master_setLoc'].indexOf(String(a.action)) >= 0);
  const latest = proposals.length ? proposals[proposals.length - 1] : null;
  if (!latest || !/^ADM-/.test(String(latest.userId || ''))) throw new Error('هذا الموقع لا يحمل اقتراحًا موثقًا بحساب مدير مستقل. أعد تحديده من الخريطة بعد إنشاء حسابات الإدارة الفردية.');
  if (String(latest.userId) === String(s.uid)) throw new Error('لا يمكن للمدير اعتماد الموقع الذي اقترحه بنفسه. اطلب من مدير آخر اعتماده.');
}

function session_(token) {
  const raw = token && CacheService.getScriptCache().get('s_' + token);
  if (!raw) throw new Error('انتهت الجلسة. سجّل الدخول من جديد.');
  const s = JSON.parse(raw); s.token = token;
  if (s.role === 'rep' && CacheService.getScriptCache().get('off_' + s.uid)) throw new Error('تم تعطيل هذا الحساب.');
  if (s.role === 'admin' && /^ADM-/.test(String(s.uid))) {
    const account = sheet_('Admins') ? dbAll_('Admins').find(a => String(a.id) === String(s.uid)) : null;
    if (!account || String(account.active) === 'false') {
      CacheService.getScriptCache().remove('s_' + token);
      throw new Error('تم تعطيل حساب الإدارة أو لم يعد موجودًا. سجّل الدخول بحساب نشط.');
    }
  }
  return s;
}

/* ---------- bootstrap: lookups + settings for the UI (nothing hardcoded client-side) ---------- */
function lookups_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('lk'); if (hit) return JSON.parse(hit);
  ensureDoctorWorkplaces_();
  const act = r => String(r.active) !== 'false';
  const workplaces = dbAll_('DoctorWorkplaces').filter(act).map(w => ({ id: w.id, doctorId: w.doctorId, workplace: w.workplace, sector: w.sector, active: w.active, reviewed: String(w.reviewed) === 'true', refState: w.refState || '' }));
  // GPS coordinates and internal review metadata remain server-side.
  const v = {
    doctors: dbAll_('Doctors').filter(act).map(r => ({ id: r.id, name: r.name, specialty: r.specialty, workplace: r.workplace, sector: r.sector, active: r.active, workplaces: workplaces.filter(w => w.doctorId === r.id) })),
    pharmacies: dbAll_('Pharmacies').filter(act).map(r => ({ id: r.id, name: r.name, location: r.location, nearFacility: r.nearFacility, active: r.active })),
    products: dbAll_('Products').filter(r => r.status !== 'متوقف').map(r => ({ id: r.id, name: r.name, category: r.category, status: r.status }))
  };
  try { cache.put('lk', JSON.stringify(v), 300); } catch (e) {}
  return v;
}
function clearCache_() { _ST = null; CacheService.getScriptCache().removeAll(['st', 'lk']); }
function bootstrap_(s) {
  const lk = lookups_();
  return {
    settings: (function () { const x = settings_(); if (s.role !== 'admin') { delete x.reportEmail; delete x.gpsRadius; delete x.gpsRefAcc; } return x; })(), statuses: STATUS,
    reps: s.role === 'admin' ? dbAll_('Reps').map(r => ({ id: r.id, name: r.name })) : null,
    doctors: s.role === 'admin' ? lk.doctors : lk.doctors.map(d => Object.assign({}, d, { workplaces: (d.workplaces || []).map(w => { const o = Object.assign({}, w); delete o.refState; return o; }) })),
    pharmacies: lk.pharmacies, products: lk.products,
    rep: s.role === 'rep' ? { id: s.uid, name: s.name } : null
  };
}

/* ---------- reports ---------- */
// Called only from persistReport_ while its script lock is held.
function nextReportNo_() {
  const sp = PropertiesService.getScriptProperties(), n = (+sp.getProperty('REPORT_SEQ') || 0) + 1;
  sp.setProperty('REPORT_SEQ', String(n));
  const d = new Date(), pre = settings_().reportPrefix || 'MR';
  return pre + '-' + d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0000' + n).slice(-5);
}
const today_ = () => Utilities.formatDate(new Date(), settings_().timezone || Session.getScriptTimeZone(), 'yyyy-MM-dd');

/* ---------- edit windows: today; yesterday until closeHour; returned reports; reopen before approval ---------- */
function yesterday_() { return Utilities.formatDate(new Date(new Date(today_() + 'T12:00:00Z').getTime() - 864e5), 'UTC', 'yyyy-MM-dd'); }
function closeHour_(st) {
  const raw = st && st.closeHour;
  if (raw === '' || raw === null || raw === undefined) return 10;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 10;
}
function editable_(date, existing) {
  const td = today_(); if (date === td) return true;
  if (existing && existing.status === 'معاد للمندوب') return true;
  const st = settings_(), tz = st.timezone || Session.getScriptTimeZone(), hh = ('0' + closeHour_(st)).slice(-2);
  return date === yesterday_() && Date.now() <= Utilities.parseDate(td + ' ' + hh + ':00', tz, 'yyyy-MM-dd HH:mm').getTime();
}
function prevInfo_(s) {
  const y = yesterday_(), wd = String(settings_().workDays || '0,1,2,3,4').split(',').map(Number);
  const mine = dbAll_('Reports').filter(x => x.repId === s.uid), r = mine.find(x => x.date === y);
  return { date: y, status: r ? r.status : null, open: editable_(y, r), work: wd.indexOf(new Date(y + 'T12:00:00Z').getUTCDay()) >= 0 && offWeight_(offData_(), s.uid, y) < 1, returned: mine.filter(x => x.status === 'معاد للمندوب').length };
}
// The first submitted version stays frozen in snapshot1; every reopen is audited; re-sending after closeHour counts as late.
function reopenReport_(s, p) {
  const r = dbAll_('Reports').find(x => x.id === p.id && x.repId === s.uid);
  if (!r) throw new Error('التقرير غير موجود');
  if (r.status === 'معتمد') throw new Error('التقرير معتمد ولا يمكن إعادة فتحه. اطلب ذلك من الإدارة.');
  if (r.status !== 'مرسل') throw new Error('التقرير غير مرسل.');
  if (!editable_(r.date, null)) throw new Error('انتهت مهلة تعديل هذا التقرير. اطلب من الإدارة إعادته إليك.');
  if (!r.snapshot1) r.snapshot1 = r.snapshot;
  r.reopens = (+r.reopens || 0) + 1; r.status = 'مسودة';
  dbUpsert_('Reports', 'id', r); audit_(s, 'reopen_report', r.no, '#' + r.reopens);
  return { status: r.status, reopens: r.reopens };
}
function myReport_(s, p) {
  const date = p.date || today_();
  let r = dbAll_('Reports').find(x => x.repId === s.uid && x.date === date);
  if (!r) r = { id: null, no: null, repId: s.uid, date, status: 'مسودة', notes: '', doctors: [], pharmacies: [] };
  return repView_(parseReport_(r)); // route is rep-only
}
// Draft upsert. GPS is stored inside each visit (gps:{lat,lng,acc,ts}) and is never required.
function saveReport_(s, p) { const r = persistReport_(s, p); return { id: r.id, no: r.no, status: r.status, docs: repVisits_(JSON.parse(r.doctors)), phs: repVisits_(JSON.parse(r.pharmacies)) }; }
function persistReport_(s, p, lockHeld) {
  // Serialize report lookup + ID/number allocation + write to prevent concurrent saves overwriting each other.
  const lock = LockService.getScriptLock();
  if (!lockHeld) lock.waitLock(10000);
  try {
  const date = p.date || today_(), all = dbAll_('Reports');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('تاريخ غير صالح');
  let r = all.find(x => x.repId === s.uid && x.date === date);
  if (r && ['مسودة', 'معاد للمندوب'].indexOf(r.status) < 0) throw new Error('لا يمكن تعديل تقرير بعد إرساله. أعد فتحه أولًا.');
  if (!editable_(date, r)) throw new Error('انتهت مهلة كتابة هذا التقرير. اطلب من الإدارة إعادته إليك.');
  // GPS: client sends only raw {lat,lng,acc,ts}; the verdict is computed here and never taken from the client.
  const prevD = r ? JSON.parse(r.doctors || '[]') : [], prevP = r ? JSON.parse(r.pharmacies || '[]') : [];
  const clean = (list, prev) => (list || []).map((v, i) => {
    const o = Object.assign({}, v, { seq: i + 1 }), g = v.gps || {};
    delete o._v; // internal server-only flag; never accept it from the client
    const pv = prev.find(x => x.gps && x.gps.status && x.name === v.name && x.doctorId === v.doctorId && x.workplaceId === v.workplaceId && x.pharmacyId === v.pharmacyId && normName_(x.place || x.loc || '') === normName_(v.place || v.loc || '') && x.gps.ts === g.ts && x.gps.lat === g.lat && x.gps.lng === g.lng && x.gps.acc === g.acc);
    if (pv) o.gps = pv.gps;
    else if (typeof g.lat === 'number' && typeof g.lng === 'number') { o.gps = { lat: g.lat, lng: g.lng, acc: +g.acc || 0, ts: g.ts }; o._v = true; }
    else o.gps = { status: 'غير متاح' };
    return o;
  });
  const docs = clean(p.doctors, prevD), phs = clean(p.pharmacies, prevP);
  // Validate explicit master IDs even when GPS is unavailable; IDs are not trusted merely because the client sent them.
  const masterDoctors = dbAll_('Doctors'), masterWorkplaces = dbAll_('DoctorWorkplaces'), masterPharmacies = dbAll_('Pharmacies');
  docs.forEach(v => {
    const namedDoctors = masterDoctors.filter(d => normName_(d.name) === normName_(v.name));
    const doctor = v.doctorId
      ? masterDoctors.find(d => String(d.id) === String(v.doctorId))
      : (namedDoctors.length === 1 ? namedDoctors[0] : null);
    if (v.doctorId && (!doctor || normName_(doctor.name) !== normName_(v.name))) throw new Error('معرّف الطبيب لا يطابق اسم الزيارة. أعد اختيار الطبيب.');
    if (v.workplaceId) {
      const place = masterWorkplaces.find(w => String(w.id) === String(v.workplaceId));
      if (!doctor || !place || String(place.active) === 'false' || String(place.doctorId) !== String(doctor.id) ||
          (v.place && normName_(place.workplace) !== normName_(v.place))) {
        throw new Error('مكان العمل المحدد لا يتبع للطبيب المختار. أعد اختيار مكان العمل.');
      }
    }
  });
  phs.forEach(v => {
    if (!v.pharmacyId) return;
    const pharmacy = masterPharmacies.find(p => String(p.id) === String(v.pharmacyId));
    if (!pharmacy || String(pharmacy.active) === 'false' || normName_(pharmacy.name) !== normName_(v.name)) throw new Error('معرّف الصيدلية غير صالح أو أن الصيدلية معطّلة. أعد اختيار الصيدلية.');
  });
  if (docs.concat(phs).some(v => v._v)) {
    ensureDoctorWorkplaces_();
    const st = settings_(), D = dbAll_('Doctors'), W = dbAll_('DoctorWorkplaces'), P = dbAll_('Pharmacies');
    docs.forEach(v => { if (v._v) {
      const namedDoctors = D.filter(x => normName_(x.name) === normName_(v.name)); const doctor = v.doctorId ? D.find(x => String(x.id) === String(v.doctorId)) : (namedDoctors.length === 1 ? namedDoctors[0] : null);
      const doctorMatches = !!doctor && normName_(doctor.name) === normName_(v.name);
      let place = v.workplaceId ? W.find(x => x.id === v.workplaceId) : null;
      // Never accept a workplace ID belonging to another doctor or a stale/missing ID.
      if (v.workplaceId && !place) { geo_(v, null, 'DoctorWorkplaces', s, st); return; }
      if (place && (!doctorMatches || place.doctorId !== doctor.id)) { geo_(v, null, 'DoctorWorkplaces', s, st); return; }
      if (!place && !v.workplaceId && doctorMatches) place = W.find(x => x.doctorId === doctor.id && normName_(x.workplace) === normName_(v.place));
      if (place && doctorMatches && place.doctorId === doctor.id) v.workplaceId = place.id;
      else { geo_(v, null, 'DoctorWorkplaces', s, st); return; }
      const facilityGeo = facilityGeoEntity_('DoctorWorkplaces', place.id);
       geo_(v, facilityGeo || place, 'DoctorWorkplaces', s, st);
    }});
    phs.forEach(v => { if (v._v) {
      const pharmacyMatches = v.pharmacyId ? P.filter(x => String(x.id) === String(v.pharmacyId)) : P.filter(x => normName_(x.name) === normName_(v.name)); const pharmacy = pharmacyMatches.length === 1 ? pharmacyMatches[0] : null;
      if (!pharmacy || normName_(pharmacy.name) !== normName_(v.name)) geo_(v, null, 'Pharmacies', s, st);
      else { const facilityGeo = facilityGeoEntity_('Pharmacies', pharmacy.id); geo_(v, facilityGeo || pharmacy, 'Pharmacies', s, st); }
    }});
  }
  // facilityId is server-derived metadata; never trust a client-supplied facilityId.
  const hasFacilitySchema = !!sheet_('Facilities') && !!sheet_('DoctorPlaces');
  docs.concat(phs).forEach(v => { delete v.facilityId; });
  if (hasFacilitySchema) {
    const readMaster = name => sheet_(name) ? dbAll_(name) : [];
    const facilityRows = readMaster('Facilities'), relationRows = readMaster('DoctorPlaces');
    const doctorRows = readMaster('Doctors'), workplaceRows = readMaster('DoctorWorkplaces');
    const findDoctor = v => v.doctorId
      ? doctorRows.find(d => String(d.id) === String(v.doctorId))
      : doctorRows.filter(d => normName_(d.name) === normName_(v.name)).length === 1
        ? doctorRows.find(d => normName_(d.name) === normName_(v.name)) : null;
    docs.forEach(v => {
      const doctor = findDoctor(v);
      if (!doctor || normName_(doctor.name) !== normName_(v.name)) return;
      let candidates = [];
      if (v.workplaceId) {
        const w = workplaceRows.find(x => String(x.id) === String(v.workplaceId));
        if (w && String(w.doctorId) === String(doctor.id) && (!v.place || normName_(w.workplace) === normName_(v.place))) candidates = [w];
      } else {
        candidates = workplaceRows.filter(w => String(w.doctorId) === String(doctor.id) && normName_(w.workplace) === normName_(v.place));
      }
      const mapped = candidates.flatMap(w => relationRows.filter(rel => String(rel.legacyWorkplaceId) === String(w.id) && String(rel.doctorId) === String(doctor.id)));
      if (mapped.length === 1 && facilityRows.some(f => String(f.id) === String(mapped[0].facilityId))) v.facilityId = mapped[0].facilityId;
    });
    const pharmacyFacilities = facilityRows.filter(f => f.legacyEntity === 'Pharmacies');
    phs.forEach(v => {
      const candidates = v.pharmacyId
        ? pharmacyFacilities.filter(f => String(f.legacyId) === String(v.pharmacyId))
        : pharmacyFacilities.filter(f => normName_(f.name) === normName_(v.name));
      if (candidates.length === 1 && normName_(candidates[0].name) === normName_(v.name)) v.facilityId = candidates[0].id;
    });
  }
  const now = new Date().toISOString();
  const row = {
    id: r ? r.id : 'REPORT-' + Utilities.getUuid(), no: r ? r.no : nextReportNo_(), repId: s.uid, date,
    status: r ? r.status : 'مسودة', notes: String(p.notes || '').slice(0, 2000),
    doctors: JSON.stringify(docs), pharmacies: JSON.stringify(phs),
    snapshot: r ? r.snapshot : '', snapshot1: r ? r.snapshot1 : '', reopens: r ? (+r.reopens || 0) : 0, createdAt: r ? r.createdAt : now, updatedAt: now, submittedAt: r ? r.submittedAt : '', reviewNote: r ? r.reviewNote : ''
  };
  dbUpsert_('Reports', 'id', row);
  audit_(s, r ? 'edit_report' : 'create_report', row.no);
  return row;
  } finally {
    if (!lockHeld) lock.releaseLock();
  }
}
// Submit = validate + freeze historical snapshot (names/products copied as text, immune to later edits)
function submitReport_(s, p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let snap, result;
  try {
    const r = parseReport_(persistReport_(s, p, true));
    if (!r.doctors.length && !r.pharmacies.length) throw new Error('أضف زيارة واحدة على الأقل.');
    const bad = r.doctors.filter(v => !v.name || !v.specialty).length + r.pharmacies.filter(v => !v.name).length;
    if (bad) throw new Error('بعض الزيارات ينقصها الاسم أو التخصص.');
    const rep = dbAll_('Reps').find(x => x.id === s.uid);
    if (!rep) throw new Error('تعذّر العثور على حساب المندوب.');
    snap = { company: (function () { const x = settings_(); delete x.reportEmail; return x; })(), no: r.no, rep: rep.name, date: r.date, reopens: +r.reopens || 0, notes: r.notes, doctors: r.doctors, pharmacies: r.pharmacies, frozenAt: new Date().toISOString() };
    r.status = 'مرسل'; r.submittedAt = snap.frozenAt; r.snapshot = JSON.stringify(snap);
    r.doctors = JSON.stringify(r.doctors); r.pharmacies = JSON.stringify(r.pharmacies);
    dbUpsert_('Reports', 'id', r); audit_(s, 'submit_report', r.no);
    result = { no: r.no, status: r.status };
  } finally {
    lock.releaseLock();
  }
  notify_(snap);
  return result;
}
/* ---------- what a representative may see of GPS ----------
 * A rep gets back only his own raw capture fields (needed so the next save is recognised as unchanged).
 * The verdict, distance, reference coordinates and re-check history are management-only. */
function repGps_(g) { g = g || {}; const o = {}; ['lat', 'lng', 'acc', 'ts'].forEach(k => { if (g[k] !== undefined && g[k] !== null) o[k] = g[k]; }); return o; }
function repVisits_(list) { return (list || []).map(v => Object.assign({}, v, { gps: repGps_(v && v.gps) })); }
function repView_(out) {
  const o = Object.assign({}, out);
  if (Array.isArray(o.doctors)) o.doctors = repVisits_(o.doctors);
  if (Array.isArray(o.pharmacies)) o.pharmacies = repVisits_(o.pharmacies);
  ['snapshot', 'snapshot1'].forEach(k => { if (o[k]) { const sn = Object.assign({}, o[k]); sn.doctors = repVisits_(sn.doctors); sn.pharmacies = repVisits_(sn.pharmacies); o[k] = sn; } });
  return o;
}
// Search text for listReports_: a rep must not be able to probe hidden verdict fields through the search box.
function searchText_(r, role) {
  if (role !== 'rep') return (r.doctors + r.pharmacies).toLowerCase();
  let d = [], p = [];
  try { d = JSON.parse(r.doctors || '[]'); p = JSON.parse(r.pharmacies || '[]'); } catch (e) {}
  return JSON.stringify(repVisits_(d).concat(repVisits_(p))).toLowerCase();
}
function getReport_(s, p) {
  const r = dbAll_('Reports').find(x => x.id === p.id);
  if (!r || (s.role === 'rep' && r.repId !== s.uid)) throw new Error('التقرير غير موجود');
  const out = parseReport_(r);
  if (r.snapshot) out.snapshot = JSON.parse(r.snapshot);
  if (r.snapshot1) out.snapshot1 = JSON.parse(r.snapshot1); // submitted reports render from the snapshot
  return s.role === 'rep' ? repView_(out) : out;
}
// Filters: repId, from, to, no, status, q (doctor / pharmacy / product text search)
function listReports_(s, p) {
  const q = (p.q || '').toLowerCase(), reps = {};
  dbAll_('Reps').forEach(r => reps[r.id] = r.name);
  return dbAll_('Reports').filter(r =>
    (s.role === 'admin' || r.repId === s.uid) &&
    (!p.repId || r.repId === p.repId) && (!p.status || r.status === p.status) &&
    (!p.no || String(r.no).indexOf(p.no) >= 0) && (!p.from || r.date >= p.from) && (!p.to || r.date <= p.to) &&
    (!q || searchText_(r, s.role).indexOf(q) >= 0)
  ).map(r => ({ id: r.id, no: r.no, date: r.date, status: r.status, repId: r.repId, repName: reps[r.repId], reopens: +r.reopens || 0,
    visits: JSON.parse(r.doctors || '[]').length + JSON.parse(r.pharmacies || '[]').length })).reverse();
}
function reviewReport_(s, p) {
  const r = dbAll_('Reports').find(x => x.id === p.id);
  if (!r || r.status !== 'مرسل') throw new Error('يمكن مراجعة التقارير المرسلة فقط.');
  r.status = p.approve ? 'معتمد' : 'معاد للمندوب'; r.reviewNote = p.note || '';
  dbUpsert_('Reports', 'id', r); audit_(s, p.approve ? 'approve_report' : 'return_report', r.no, r.reviewNote);
  return { status: r.status };
}
function parseReport_(r) {
  return Object.assign({}, r, { doctors: typeof r.doctors === 'string' ? JSON.parse(r.doctors || '[]') : r.doctors,
    pharmacies: typeof r.pharmacies === 'string' ? JSON.parse(r.pharmacies || '[]') : r.pharmacies });
}

/* ---------- rep adds a missing doctor/pharmacy (immediate, deduplicated by normalized name) ---------- */
function normName_(t) {
  return String(t || '').toLowerCase().replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/^\s*(?:د\s*\.?\s+|د\s*\.|dr\.\s+)/i, '').replace(/\s+/g, ' ').trim();
}
function addMaster_(s, sheet, p) {
  if (sheet === 'Doctors') ensureDoctorWorkplaces_();
  const name = String(p.name || '').trim().slice(0, 80);
  if (name.length < 3) throw new Error('الاسم قصير جدًا');
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const rows = dbAll_(sheet), n = normName_(name), dup = rows.find(r => normName_(r.name) === n);
    if (dup) return dup; // already exists: reuse it, never create a duplicate
    const cut = v => String(v || '').trim().slice(0, 80);
    const row = sheet === 'Doctors'
      ? { name: name, specialty: cut(p.specialty), workplace: cut(p.workplace), sector: cut(p.sector), active: true, addedBy: s.uid }
      : { name: name, location: cut(p.location), nearFacility: cut(p.nearFacility), active: true, addedBy: s.uid };
    const mx = rows.reduce((a, r) => Math.max(a, +String(r.id).split('-')[1] || 0), 0);
    row.id = PREFIX[sheet === 'Doctors' ? 'Doctors' : 'Pharmacies'] + '-' + ('0000' + (mx + 1)).slice(-4);
    dbAppend_(sheet, row);
    if (sheet === 'Doctors' && cut(p.workplace)) {
      const wp = addDoctorWorkplaceRow_(s, row, cut(p.workplace), cut(p.sector), false);
      row.workplaceId = wp.id;
    }
    clearCache_();
    audit_(s, 'add_' + sheet.toLowerCase(), row.id, name);
    return row;
  } finally { lock.releaseLock(); }
}

/* ---------- doctor workplaces: one doctor may work at multiple facilities ---------- */
function ensureDoctorWorkplaces_() {
  ensureSheet_('DoctorWorkplaces');
  const doctors = dbAll_('Doctors'), places = dbAll_('DoctorWorkplaces');
  doctors.forEach(d => {
    const name = String(d.workplace || '').trim();
    if (!name || places.some(w => w.doctorId === d.id && normName_(w.workplace) === normName_(name))) return;
    const w = { id: nextWorkplaceId_(places), doctorId: d.id, doctorName: d.name, workplace: name, sector: d.sector || '', lat: '', lng: '', radius: '', active: String(d.active) === 'false' ? false : true, refState: '', refBy: '', addedBy: d.addedBy || '', reviewed: String(d.reviewed) === 'true' || !d.addedBy ? 'true' : 'false' };
    dbAppend_('DoctorWorkplaces', w); places.push(w);
  });
}
function nextWorkplaceId_(rows) { return 'DWP-' + ('00000' + (rows.reduce((m, w) => Math.max(m, +(String(w.id).match(/(\d+)$/) || [0, 0])[1]), 0) + 1)).slice(-5); }
function addDoctorWorkplaceRow_(s, doctor, workplace, sector, reviewed) {
  const name = String(workplace || '').trim().slice(0, 100);
  if (name.length < 2) throw new Error('أدخل اسم مكان العمل.');
  const rows = dbAll_('DoctorWorkplaces'), old = rows.find(w => w.doctorId === doctor.id && normName_(w.workplace) === normName_(name));
  if (old) { if (String(old.active) === 'false') throw new Error('مكان العمل معطّل؛ اطلب من الإدارة تفعيله.'); return old; }
  const row = { id: nextWorkplaceId_(rows), doctorId: doctor.id, doctorName: doctor.name, workplace: name, sector: String(sector || doctor.sector || '').trim().slice(0, 30), active: true, addedBy: s.uid, reviewed: reviewed ? 'true' : 'false' };
  dbAppend_('DoctorWorkplaces', row); return row;
}
function addDoctorWorkplace_(s, p) {
  ensureDoctorWorkplaces_();
  const doctor = dbAll_('Doctors').find(d => d.id === p.doctorId && String(d.active) !== 'false');
  if (!doctor) throw new Error('اختر طبيبًا مسجلًا أولًا.');
  const name = String(p.workplace || '').trim();
  if (name.length < 2) throw new Error('أدخل اسم مكان العمل.');
  const row = addDoctorWorkplaceRow_(s, doctor, name, p.sector, false);
  clearCache_();
  audit_(s, 'propose_doctor_workplace', row.id, doctor.name + ' · ' + row.workplace);
  return { id: row.id, doctorId: row.doctorId, doctorName: row.doctorName, workplace: row.workplace, sector: row.sector, reviewed: String(row.reviewed) === 'true', refState: row.refState || '' };
}
function workplacesList_(s, p) {
  ensureDoctorWorkplaces_();
  const counts = {};
  dbAll_('Reports').forEach(r => {
    let visits; try { visits = JSON.parse(r.doctors || '[]'); } catch (e) { return; }
    visits.forEach(v => {
      const key = v.workplaceId || (v.name + '|' + (v.place || ''));
      counts[key] = (counts[key] || 0) + 1;
    });
  });
  return dbAll_('DoctorWorkplaces').map(w => {
    const geo = facilityGeoEntity_('DoctorWorkplaces', w.id);
    return Object.assign({}, w, geo ? { lat:geo.lat, lng:geo.lng, radius:geo.radius, refState:geo.refState,
      refBy:geo.refBy, reviewed:geo.reviewed } : {}, { uses: counts[w.id] || counts[w.doctorName + '|' + w.workplace] || 0 });
  });
}

/* ---------- admin review of doctors/pharmacies ---------- */
function masterSheet_(e) {
  if (e !== 'Doctors' && e !== 'Pharmacies') throw new Error('كيان غير مسموح');
  return e;
}
function masterList_(s, p) {
  const sh = masterSheet_(p.entity), col = sh === 'Doctors' ? 'doctors' : 'pharmacies', cnt = {};
  dbAll_('Reports').forEach(r => {
    let visits; try { visits = JSON.parse(r[col] || '[]'); } catch (e) { return; }
    visits.forEach(v => { cnt[v.name] = (cnt[v.name] || 0) + 1; });
  });
  return dbAll_(sh).map(r => Object.assign({}, r, { uses: cnt[r.name] || 0 }));
}
// Update operational report names only; immutable submitted snapshots remain unchanged.
function rewriteNames_(sheet, from, to) {
  const ci = T.Reports.indexOf(sheet === 'Doctors' ? 'doctors' : 'pharmacies'), sh = sheet_('Reports'), vals = sh.getDataRange().getValues();
  let n = 0;
  for (let i = 1; i < vals.length; i++) {
    let arr; try { arr = JSON.parse(vals[i][ci] || '[]'); } catch (e) { continue; }
    let changed = false;
    arr.forEach(v => { if (v.name === from) { v.name = to; changed = true; } });
    if (changed) { sh.getRange(i + 1, ci + 1).setValue(JSON.stringify(arr)); n++; }
  }
  return n;
}
/* ---------- facility location authority (legacy UI adapter) ---------- */
function facilityForLegacy_(entity, legacyId) {
  if (!sheet_('Facilities')) return null;
  return dbAll_('Facilities').find(f => f.legacyEntity === entity && String(f.legacyId) === String(legacyId)) || null;
}
function facilityForLegacy_(entity, legacyId) {
  if (!sheet_('Facilities')) return null;
  // Doctor workplaces resolve through the shared facility relation first.
  if (entity === 'DoctorWorkplaces' && sheet_('DoctorPlaces')) {
    const rel = dbAll_('DoctorPlaces').find(x => String(x.legacyWorkplaceId) === String(legacyId) && String(x.active) !== 'false');
    if (rel) {
      const shared = dbAll_('Facilities').find(f => String(f.id) === String(rel.facilityId));
      if (shared) return shared;
    }
  }
  return dbAll_('Facilities').find(f => f.legacyEntity === entity && String(f.legacyId) === String(legacyId)) || null;
}
function ensureSharedDoctorFacility_(s, workplace, lat, lng) {
  if (!sheet_('Facilities') || !sheet_('FacilityLocations') || !sheet_('DoctorPlaces')) {
    throw new Error('جداول المنشآت غير مهيأة. شغّل تهيئة مخطط المنشآت من حساب مالك المشروع أولًا.');
  }
  const allW = dbAll_('DoctorWorkplaces');
  const same = allW.filter(w => normName_(w.workplace) === normName_(workplace.workplace));
  const facilities = dbAll_('Facilities');
  let facility = facilities.find(f => f.legacyEntity === 'SHARED_DOCTOR_FACILITY' && normName_(f.name) === normName_(workplace.workplace));
  const now = new Date().toISOString();
  if (!facility) {
    const id = 'FAC-SH-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
    facility = { id:id, name:String(workplace.workplace).trim(), type:'منشأة طبية', region:'', address:'',
      status:'نشط', legacyEntity:'SHARED_DOCTOR_FACILITY', legacyId:id, createdAt:now, createdBy:s.uid, updatedAt:now, updatedBy:s.uid };
    dbAppend_('Facilities', facility);
  }
  const relations = dbAll_('DoctorPlaces');
  same.forEach(w => {
    let rel = relations.find(x => String(x.legacyWorkplaceId) === String(w.id));
    if (!rel) {
      rel = { id:'DP-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase(), doctorId:w.doctorId,
        facilityId:facility.id, workDays:'', notes:'', active:String(w.active) !== 'false', legacyWorkplaceId:w.id,
        createdAt:now, createdBy:s.uid, updatedAt:now, updatedBy:s.uid };
      dbAppend_('DoctorPlaces', rel); relations.push(rel);
    } else {
      rel.facilityId=facility.id; rel.active=String(w.active) !== 'false'; rel.updatedAt=now; rel.updatedBy=s.uid;
      dbUpsert_('DoctorPlaces','id',rel);
    }
  });
  const locations = dbAll_('FacilityLocations');
  const active = locations.filter(l => String(l.facilityId) === String(facility.id) && String(l.active) !== 'false');
  const version = locations.filter(l => String(l.facilityId) === String(facility.id)).reduce((m,l)=>Math.max(m,+l.version||0),0)+1;
  active.forEach(l=>{l.active=false;dbUpsert_('FacilityLocations','id',l)});
  dbAppend_('FacilityLocations',{id:'LOC-'+facility.id+'-V'+version,facilityId:facility.id,lat:lat,lng:lng,
    radius:+workplace.radius||'',source:'ADMIN_MAP',state:'مؤكد',proposedBy:s.uid,proposedAt:now,
    approvedBy:s.uid,approvedAt:now,version:version,active:true,note:'موقع منشأة مشترك محدد من خريطة الإدارة'});
  facility.updatedAt=now;facility.updatedBy=s.uid;dbUpsert_('Facilities','id',facility);
  return {facilityId:facility.id, linkedWorkplaces:same.length, version:version};
}
function facilityGeoEntity_(entity, legacyId) {
  const facility = facilityForLegacy_(entity, legacyId);
  if (!facility || !sheet_('FacilityLocations')) return null;
  const legacyWorkplace = entity === 'DoctorWorkplaces' ? dbAll_('DoctorWorkplaces').find(w => String(w.id) === String(legacyId)) : null;
  const locs = dbAll_('FacilityLocations').filter(l => String(l.facilityId) === String(facility.id) && String(l.active) !== 'false').sort((a, b) => (+b.version || 0) - (+a.version || 0));
  const loc = locs[0];
  if (!loc) return { id: facility.id, name: facility.name, lat: '', lng: '', radius: '', refBy: '', refState: 'مراجعة مطلوبة', reviewed: 'false', active: facility.status !== 'معطل', doctorId: legacyWorkplace && legacyWorkplace.doctorId, doctorName: legacyWorkplace && legacyWorkplace.doctorName };
  return {
    id: facility.id, name: facility.name, lat: loc.lat, lng: loc.lng, radius: loc.radius,
    refBy: loc.source === 'ADMIN_MAP' ? 'ADMIN_MAP' : loc.source, refState: loc.state,
    reviewed: loc.state === 'مؤكد' && !!loc.approvedBy && !!loc.approvedAt ? 'true' : 'false',
    active: String(loc.active) !== 'false' && facility.status !== 'معطل' && (!legacyWorkplace || String(legacyWorkplace.active) !== 'false'),
    doctorId: legacyWorkplace && legacyWorkplace.doctorId, doctorName: legacyWorkplace && legacyWorkplace.doctorName
  };
}
function invalidateFacilityLocations_(entity, legacyId) {
  const facility = facilityForLegacy_(entity, legacyId);
  if (!facility || !sheet_('FacilityLocations')) return 0;
  let n = 0;
  dbAll_('FacilityLocations').filter(l => String(l.facilityId) === String(facility.id) && String(l.active) !== 'false').forEach(l => {
    l.active = false; l.state = 'مراجعة مطلوبة'; dbUpsert_('FacilityLocations', 'id', l); n++;
  });
  return n;
}
function proposeFacilityLocation_(s, entity, legacyId, lat, lng, radius) {
  const facility = facilityForLegacy_(entity, legacyId);
  if (!facility || !sheet_('FacilityLocations')) return null;
  const rows = dbAll_('FacilityLocations');
  const active = rows.filter(l => String(l.facilityId) === String(facility.id) && String(l.active) !== 'false');
  const version = rows.filter(l => String(l.facilityId) === String(facility.id)).reduce((m, l) => Math.max(m, +l.version || 0), 0) + 1;
  active.forEach(l => { l.active = false; dbUpsert_('FacilityLocations', 'id', l); });
  const now = new Date().toISOString(), id = 'LOC-' + String(facility.id) + '-V' + version;
  dbAppend_('FacilityLocations', { id: id, facilityId: facility.id, lat: lat, lng: lng, radius: radius === '' || radius == null ? '' : +radius, source: 'ADMIN_MAP', state: 'مراجعة مطلوبة', proposedBy: s.uid, proposedAt: now, approvedBy: '', approvedAt: '', version: version, active: true, note: 'موقع مقترح من خريطة الإدارة' });
  return { id: id, facilityId: facility.id, version: version };
}
function approveFacilityLocation_(s, entity, legacyId) {
  const facility = facilityForLegacy_(entity, legacyId);
  if (!facility || !sheet_('FacilityLocations')) return null;
  const rows = dbAll_('FacilityLocations').filter(l => String(l.facilityId) === String(facility.id) && String(l.active) !== 'false').sort((a, b) => (+b.version || 0) - (+a.version || 0));
  const loc = rows[0];
  if (!loc) throw new Error('لا يوجد موقع مقترح في سجل المنشآت الجديد. أعد تحديد الموقع من الخريطة.');
  if (loc.state !== 'مراجعة مطلوبة' || !loc.proposedBy) throw new Error('الموقع ليس في حالة انتظار اعتماد؛ أعد تحديده من الخريطة أولًا.');
  loc.state = 'مؤكد'; loc.approvedBy = s.uid; loc.approvedAt = new Date().toISOString();
  dbUpsert_('FacilityLocations', 'id', loc);
  return loc;
}

function workplaceAct_(s, p) {
  ensureDoctorWorkplaces_();
  const rows = dbAll_('DoctorWorkplaces'), w = rows.find(x => x.id === p.id);
  if (!w) throw new Error('مكان العمل غير موجود');
  let note = '';
  if (p.op === 'review') {
    if (w.lat === '' || w.lat == null || !isFinite(+w.lat) || +w.lat < -90 || +w.lat > 90 ||
        w.lng === '' || w.lng == null || !isFinite(+w.lng) || +w.lng < -180 || +w.lng > 180 ||
        w.refBy !== 'ADMIN_MAP') {
      throw new Error('افتح الخريطة وتحقق من المكان، ثم سجّل إحداثياته من الخريطة قبل الاعتماد.');
    }
    w.reviewed = 'true';
  } else if (p.op === 'setLoc') {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (p.lat === '' || p.lng === '' || !isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new Error('أدخل إحداثيات صحيحة من الخريطة.');
    }
    // One authoritative reference per facility name; all doctors at this facility share it.
    const shared = ensureSharedDoctorFacility_(s, w, lat, lng);
    const linked = dbAll_('DoctorWorkplaces').filter(x => normName_(x.workplace) === normName_(w.workplace));
    linked.forEach(x => { x.lat=''; x.lng=''; x.refState='مؤكد'; x.refBy='ADMIN_MAP'; x.reviewed='true'; dbUpsert_('DoctorWorkplaces','id',x); });
    note = 'shared facility location confirmed; facility=' + shared.facilityId + '; linkedWorkplaces=' + shared.linkedWorkplaces + '; version=' + shared.version;
    const reverificationCount = linked.reduce((n, row) => n + reverifyWorkplace_(row), 0);
    note += '; reverified visits: ' + reverificationCount;
  } else if (p.op === 'toggle') w.active = String(w.active) === 'false';
  else if (p.op === 'edit') {
    const name = String((p.row || {}).workplace || '').trim().slice(0, 100);
    if (name.length < 2) throw new Error('اسم مكان العمل قصير جدًا');
    if (rows.some(x => x.id !== w.id && x.doctorId === w.doctorId && normName_(x.workplace) === normName_(name))) throw new Error('هذا المكان مسجل للطبيب نفسه.');
    const nameChanged = normName_(name) !== normName_(w.workplace);
    w.workplace = name; w.sector = String((p.row || {}).sector || w.sector || '').trim().slice(0, 30);
    if (nameChanged) {
      w.reviewed = 'false'; w.lat = ''; w.lng = ''; w.refState = ''; w.refBy = '';
      invalidateFacilityLocations_('DoctorWorkplaces', w.id);
    }
  } else if (p.op === 'approveLoc') {
    // Approval is intentionally unnecessary: the manager's saved map pin is the reference.
    const facility = facilityForLegacy_('DoctorWorkplaces', w.id);
    const loc = facility && dbAll_('FacilityLocations').find(x => String(x.facilityId) === String(facility.id) && String(x.active) !== 'false');
    if (!loc || loc.lat === '' || loc.lng === '') throw new Error('حدد موقع المنشأة من الخريطة أولًا.');
    loc.state='مؤكد'; loc.approvedBy=s.uid; loc.approvedAt=new Date().toISOString(); dbUpsert_('FacilityLocations','id',loc);
    w.refState='مؤكد'; w.refBy='ADMIN_MAP'; w.reviewed='true'; note='reverified visits: '+reverifyWorkplace_(w);
  } else if (p.op === 'clearLoc') { 
    const facility=facilityForLegacy_('DoctorWorkplaces',w.id);
    if(facility) dbAll_('FacilityLocations').filter(x=>String(x.facilityId)===String(facility.id)&&String(x.active)!=='false').forEach(x=>{x.active=false;dbUpsert_('FacilityLocations','id',x)});
    dbAll_('DoctorWorkplaces').filter(x=>normName_(x.workplace)===normName_(w.workplace)).forEach(x=>{x.lat='';x.lng='';x.refState='';x.refBy='';dbUpsert_('DoctorWorkplaces','id',x)});
  }
  else throw new Error('عملية غير معروفة');
  dbUpsert_('DoctorWorkplaces', 'id', w); clearCache_(); audit_(s, 'workplace_' + p.op, w.id, note); return true;
}
function reverifyWorkplace_(ent) {
  const st = settings_(), geoEnt = facilityGeoEntity_('DoctorWorkplaces', ent.id) || ent, rad = Math.max(20, +geoEnt.radius || +st.gpsRadius || 150), refAcc = Math.max(1, +st.gpsRefAcc || 50), rs = sheet_('Reports'), vals = rs.getDataRange().getValues(), ix = k => T.Reports.indexOf(k), parse = t => { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };
  let n = 0;
  const fix = list => { let changed = false; (list || []).forEach(v => { const g = v.gps, identityMatches = (!v.doctorId || String(v.doctorId) === String(ent.doctorId)) && normName_(v.name) === normName_(ent.doctorName), matches = identityMatches && (v.workplaceId ? String(v.workplaceId) === String(ent.id) : normName_(v.place) === normName_(ent.workplace));
    if (matches && g && !g.rawLocationReducedAt && g.status === 'مرجع غير مؤكد' && typeof g.lat === 'number') { recordGpsReverification_(g, geoEnt, rad, refAcc); changed = true; n++; } }); return changed; };
  // Update only the operational visit data. snapshot/snapshot1 are immutable historical copies.
  for (let i = 1; i < vals.length; i++) { const op = parse(vals[i][ix('doctors')]); if (op && fix(op)) rs.getRange(i + 1, ix('doctors') + 1).setValue(JSON.stringify(op)); }
  return n;
}

function reverify_(sheet, ent) {
  const st = settings_(), geoEnt = facilityGeoEntity_('Pharmacies', ent.id) || ent, rad = Math.max(20, +geoEnt.radius || +st.gpsRadius || 150), refAcc = Math.max(1, +st.gpsRefAcc || 50), rs = sheet_('Reports'), vals = rs.getDataRange().getValues();
  const ix = k => T.Reports.indexOf(k), mine = sheet === 'Doctors' ? 'doctors' : 'pharmacies';
  const parse = t => { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };
  let n = 0;
  const fix = list => { let ch = false; (list || []).forEach(v => { const g = v.gps;
    if ((v.pharmacyId ? String(v.pharmacyId) === String(ent.id) && normName_(v.name) === normName_(ent.name) : normName_(v.name) === normName_(ent.name)) && g && !g.rawLocationReducedAt && g.status === 'مرجع غير مؤكد' && typeof g.lat === 'number') {
      recordGpsReverification_(g, geoEnt, rad, refAcc); ch = true; n++; } }); return ch; };
  // Update only the operational visit data. snapshot/snapshot1 are immutable historical copies.
  for (let i = 1; i < vals.length; i++) {
    const op = parse(vals[i][ix(mine)]);
    if (op && fix(op)) rs.getRange(i + 1, ix(mine) + 1).setValue(JSON.stringify(op));
  }
  return n;
}

function mergeDoctorWorkplaces_(fromDoctor, toDoctor) {
  ensureDoctorWorkplaces_(); const rows = dbAll_('DoctorWorkplaces');
  rows.filter(w => w.doctorId === fromDoctor.id).forEach(w => {
    const duplicate = rows.find(x => x.doctorId === toDoctor.id && normName_(x.workplace) === normName_(w.workplace) && String(x.active) !== 'false');
    if (duplicate) { w.active = false; w.reviewed = 'true'; }
    else { w.doctorId = toDoctor.id; w.doctorName = toDoctor.name; }
    dbUpsert_('DoctorWorkplaces', 'id', w);
  });
}
function masterAct_(s, p) {
  const sh = masterSheet_(p.entity), rows = dbAll_(sh), r = rows.find(x => x.id === p.id);
  if (!r) throw new Error('السجل غير موجود');
  let note = '';
  if (p.op === 'review') r.reviewed = 'true';
  else if (p.op === 'toggle') r.active = String(r.active) === 'false';
  else if (p.op === 'merge') {
    const t = rows.find(x => x.id === p.into);
    if (!t || t.id === r.id) throw new Error('اختر سجلًا صحيحًا للدمج');
    note = 'into ' + t.id + ', reports: ' + rewriteNames_(sh, r.name, t.name);
    if (sh === 'Doctors') mergeDoctorWorkplaces_(r, t);
    r.active = false; r.reviewed = 'true';
  } else if (p.op === 'edit') {
    const row = p.row || {}, nm = String(row.name || '').trim().slice(0, 80), cut = v => String(v || '').trim().slice(0, 80);
    if (nm.length < 3) throw new Error('الاسم قصير جدًا');
    if (rows.some(x => x.id !== r.id && normName_(x.name) === normName_(nm))) throw new Error('الاسم موجود مسبقًا. استخدم «دمج».');
    if (nm !== r.name) {
      note = 'rename, reports: ' + rewriteNames_(sh, r.name, nm); r.name = nm;
      if (sh === 'Pharmacies') invalidateFacilityLocations_('Pharmacies', r.id);
      if (sh === 'Doctors') { ensureDoctorWorkplaces_(); dbAll_('DoctorWorkplaces').filter(w => w.doctorId === r.id).forEach(w => { w.doctorName = nm; dbUpsert_('DoctorWorkplaces', 'id', w); }); }
    }
    (sh === 'Doctors' ? ['specialty', 'sector'] : ['location', 'nearFacility']).forEach(k => { r[k] = cut(row[k]); });
    r.reviewed = 'true';
  } else if (p.op === 'setLoc') {
    if (sh === 'Doctors') throw new Error('مرجع الزيارة هو مكان عمل الطبيب، وليس سجل الطبيب نفسه. استخدم «أماكن عمل الأطباء».');
    const lat = Number(p.lat), lng = Number(p.lng);
    if (p.lat === '' || p.lng === '' || !isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('حدد إحداثيات صحيحة من الخريطة.');
    r.lat = lat; r.lng = lng; r.refState = 'مؤقت'; r.refBy = 'ADMIN_MAP';
    const facilityProposal = proposeFacilityLocation_(s, 'Pharmacies', r.id, lat, lng, r.radius);
    note = 'admin map location proposed' + (facilityProposal ? '; facility=' + facilityProposal.facilityId + '; version=' + facilityProposal.version : '');
  } else if (p.op === 'approveLoc') {
    if (sh === 'Doctors') throw new Error('لا يمكن اعتماد موقع جغرافي لسجل الطبيب؛ اعتمد موقع مكان عمله من قسم «أماكن عمل الأطباء».');
    if (r.lat === '' || r.lat == null || !isFinite(+r.lat) || r.lat < -90 || r.lat > 90 || r.lng === '' || r.lng == null || !isFinite(+r.lng) || r.lng < -180 || r.lng > 180 || r.refBy !== 'ADMIN_MAP') throw new Error('حدد الموقع من خريطة الإدارة أولًا؛ لا تُقبل إحداثيات الهاتف كمرجع.');
    approveFacilityLocation_(s, 'Pharmacies', r.id);
    r.refState = 'مؤكد'; note = 'reverified visits: ' + reverify_(sh, r);
  } else if (p.op === 'clearLoc') { r.lat = ''; r.lng = ''; r.refState = ''; r.refBy = ''; invalidateFacilityLocations_('Pharmacies', r.id); }
  else throw new Error('عملية غير معروفة');
  dbUpsert_(sh, 'id', r); clearCache_(); audit_(s, 'master_' + p.op, r.id, note);
  return true;
}

/* ---------- admin: master data, settings, KPI ---------- */
function entity_(n) { if (!PREFIX[n]) throw new Error('كيان غير مسموح'); return n; }
function saveEntity_(s, p) {
  const sheet = entity_(p.entity); let row = Object.assign({}, p.row);
  if (sheet === 'Products') {
    if (!row.id && !row.name) throw new Error('أدخل اسم المنتج');
    if (row.name !== undefined) {
      const nm = String(row.name).trim().slice(0, 80);
      if (nm.length < 2) throw new Error('اسم المنتج قصير جدًا');
      if (dbAll_('Products').some(r => r.id !== row.id && normName_(r.name) === normName_(nm))) throw new Error('المنتج موجود مسبقًا');
      row.name = nm;
    }
    if (row.category !== undefined) row.category = String(row.category).trim().slice(0, 60);
    if (row.status !== undefined && ['نشط', 'متوقف'].indexOf(row.status) < 0) row.status = 'نشط';
    if (!row.id) row.status = row.status || 'نشط';
  }
  if (sheet === 'Reps') { // login code is stored hashed only
    if (row.code) { if (!/^\d{5}$/.test(String(row.code))) throw new Error('رمز الدخول يجب أن يتكون من 5 أرقام بالضبط'); 
      if (dbAll_('Reps').some(r => r.id !== row.id && r.codeHash === hash_(row.code))) throw new Error('الرمز مستخدم');
      row.codeHash = hash_(row.code); }
    delete row.code;
  }
  if (!row.id) row.id = PREFIX[sheet] + '-' + ('0000' + (dbAll_(sheet).length + 1)).slice(-4);
  else { const old = dbAll_(sheet).find(r => r.id === row.id); row = Object.assign({}, old, row); }
  dbUpsert_(sheet, 'id', row); clearCache_(); audit_(s, 'save_' + sheet.toLowerCase(), row.id);
  return row.id;
}
function settings_() {
  let o;
  if (_ST) o = Object.assign({}, _ST);
  else {
    const cache = CacheService.getScriptCache(), hit = cache.get('st');
    if (hit) o = JSON.parse(hit);
    else {
      o = {}; dbAll_('Settings').forEach(r => o[r.key] = r.value);
      try { cache.put('st', JSON.stringify(o), 300); } catch (e) {}
    }
    _ST = Object.assign({}, o);
  }
  return settingsForDisplay_(o);
}
// Store a logo URL only; this feature does not require DriveApp permissions.
function settingsForDisplay_(o) {
  o = Object.assign({}, o);
  const v = String(o.logo || '');
  // Backward compatibility for an older Drive file ID saved by the previous uploader.
  if (v.indexOf('drive:') === 0) o.logo = 'https://drive.google.com/uc?export=view&id=' + encodeURIComponent(v.slice(6));
  return o;
}
function saveCompanyLogo_(s, p) {
  let next = String((p && p.url) || '').trim();
  if (next) {
    if (!/^https?:\/\//i.test(next)) throw new Error('أدخل رابط صورة يبدأ بـ https:// أو http://');
    // Accept common Google Drive share links and convert them to an image URL.
    const driveId = next.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*?id=)([A-Za-z0-9_-]+)/);
    if (driveId) next = 'https://drive.google.com/uc?export=view&id=' + encodeURIComponent(driveId[1]);
    if (next.length > 2000) throw new Error('رابط الصورة طويل جدًا.');
  }
  dbUpsert_('Settings', 'key', { key: 'logo', value: next });
  clearCache_();
  audit_(s, next ? 'save_logo_url' : 'remove_logo', 'Settings');
  return next;
}
const SETTING_KEYS = ['companyName', 'shortName', 'brandColor', 'reportTitle', 'phone', 'address', 'reportEmail', 'closeHour', 'workDays', 'gpsRadius', 'gpsRefAcc'];
function saveSettings_(s, p) {
  const v = p.values || {};
  Object.keys(v).forEach(k => {
    if (SETTING_KEYS.indexOf(k) < 0) throw new Error('إعداد غير مسموح: ' + k);
    let x = String(v[k] === null || v[k] === undefined ? '' : v[k]).trim();
    if (k === 'brandColor' && !/^#[0-9a-fA-F]{6}$/.test(x)) throw new Error('لون غير صالح');
    if (k === 'gpsRadius' && (!/^\d+(?:\.\d+)?$/.test(x) || +x < 20 || +x > 5000)) throw new Error('نطاق الموقع يجب أن يكون بين 20 و5000 متر.');
    if (k === 'gpsRefAcc' && (!/^\d+(?:\.\d+)?$/.test(x) || +x < 1 || +x > 500)) throw new Error('أقصى دقة GPS يجب أن تكون بين 1 و500 متر.');
    x = x.slice(0, 200);
    dbUpsert_('Settings', 'key', { key: k, value: x });
  });
  clearCache_(); audit_(s, 'save_settings', 'Settings', Object.keys(v).filter(k => k !== 'logo').join(',')); return true;
}
function saveKpi_(s, p) {
  (p.rows || []).forEach(r => {
    if (+r.weight < 0 || +r.target < 0) throw new Error('قيم غير صالحة');
    dbUpsert_('KPI', 'key', r);
  });
  audit_(s, 'save_kpi', 'KPI'); return true;
}

/* ---------- KPI: Target -> Actual -> Achievement% -> Weight -> Weighted Score ---------- */
// Actuals are computed from submitted/approved reports in [from,to]; targets & weights come from the KPI sheet.
function performance_(s, p) {
  const from = p.from, to = p.to, cfg = dbAll_('KPI').filter(k => String(k.active) !== 'false');
  const comp = compliance_(from, to);
  // Targets for visits/coverage shrink with the rep's available working days (holidays, leaves, half-day permissions).
  const wdays = String(settings_().workDays || '0,1,2,3,4').split(',').map(Number), off = offData_(), allDays = workDays_(from, to, wdays);
  const SCALED = ['visits', 'doctor_cov', 'pharmacy_cov'];
  const availOf = id => allDays.reduce((a, d) => a + (1 - offWeight_(off, id, d)), 0);
  const reports = dbAll_('Reports').filter(r => r.date >= from && r.date <= to && ['مرسل', 'معتمد'].indexOf(r.status) >= 0).map(parseReport_);
  const totalW = cfg.reduce((a, k) => a + (+k.weight || 0), 0) || 1;
  return dbAll_('Reps').filter(r => String(r.active) !== 'false').map(rep => {
    const rs = reports.filter(r => r.repId === rep.id), docs = [].concat.apply([], rs.map(r => r.doctors)), phs = [].concat.apply([], rs.map(r => r.pharmacies));
    const uniq = a => a.filter((v, i) => a.indexOf(v) === i).length;
    const complete = rs.length ? rs.reduce((a, r) => a + (r.notes ? 1 : 0.8) * (r.doctors.concat(r.pharmacies).filter(v => v.name).length / Math.max(1, r.doctors.length + r.pharmacies.length)), 0) / rs.length : 0;
    const actuals = { visits: docs.length + phs.length, doctor_cov: uniq(docs.map(v => v.name)), pharmacy_cov: uniq(phs.map(v => v.name)),
      product_activity: uniq(docs.map(v => v.intro).concat(phs.map(v => v.product)).filter(Boolean)), compliance: rs.length, quality: Math.round(complete * 100) };
    const rows = cfg.map(k => {
      const cc = comp[rep.id], frac = allDays.length ? availOf(rep.id) / allDays.length : 1, target = k.key === 'compliance' ? cc.expected : (SCALED.indexOf(k.key) >= 0 ? Math.round((+k.target || 0) * frac) : (+k.target || 0)), actual = k.key === 'compliance' ? cc.onTime : (actuals[k.key] || 0), ach = target ? Math.min(100, Math.round(actual / target * 100)) : (SCALED.indexOf(k.key) >= 0 && frac === 0 ? 100 : 0);
      return { key: k.key, name: k.name, target, actual, achievement: ach, weight: +k.weight, weighted: +(ach * k.weight / totalW).toFixed(1) };
    });
    return { repId: rep.id, name: rep.name, compliance: comp[rep.id], off: { total: allDays.length, avail: availOf(rep.id) }, gps: { total: docs.length + phs.length, ver: docs.concat(phs).filter(v => v.gps && v.gps.status === 'تم التحقق').length, out: docs.concat(phs).filter(v => v.gps && v.gps.status === 'خارج النطاق').length, pending: docs.concat(phs).filter(v => !v.gps || ['تم التحقق', 'خارج النطاق'].indexOf(v.gps.status) < 0).length }, score: Math.round(rows.reduce((a, r) => a + r.weighted, 0)), kpis: rows };
  }).sort((a, b) => b.score - a.score).map((r, i) => Object.assign(r, { rank: i + 1 }));
}

/* ---------- GPS verification (visit never blocked; verdict is for management) ----------
 * Only an administrator-approved map reference is authoritative. Visit readings never create or move it.
 * Boundary overlap or weak/invalid accuracy produces 'غير حاسم'; missing coordinates produce 'غير متاح'. */
function dist_(a, b, c, d) {
  const t = x => x * Math.PI / 180, dl = t(c - a), dg = t(d - b);
  const h = Math.pow(Math.sin(dl / 2), 2) + Math.cos(t(a)) * Math.cos(t(c)) * Math.pow(Math.sin(dg / 2), 2);
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
}
// Conservative geofence verdict: include the reported GPS accuracy as an uncertainty margin.
function geoVerdict_(distance, accuracy, radius, maxAccuracy) {
  if (!isFinite(+accuracy) || +accuracy <= 0 || +accuracy > maxAccuracy) return 'غير حاسم';
  if (distance + accuracy <= radius) return 'تم التحقق';
  if (distance - accuracy > radius) return 'خارج النطاق';
  return 'غير حاسم';
}
function geoReferenceSnapshot_(ent, radius, maxAccuracy) {
  return {
    id: String(ent.id || ''), lat: +ent.lat, lng: +ent.lng, radius: radius,
    source: ent.refBy || '', state: ent.refState || '', accuracyLimit: maxAccuracy,
    checkedAt: new Date().toISOString()
  };
}
function recordGpsReverification_(g, ent, radius, maxAccuracy) {
  const previousStatus = g.status, previousDistance = g.dist;
  const reference = geoReferenceSnapshot_(ent, radius, maxAccuracy);
  const distance = dist_(reference.lat, reference.lng, g.lat, g.lng);
  const status = geoVerdict_(distance, g.acc, radius, maxAccuracy);
  g.recheck = {
    checkedAt: reference.checkedAt, previousStatus: previousStatus || '',
    previousDistance: previousDistance == null ? '' : previousDistance,
    status: status, distance: distance, reference: reference
  };
  g.dist = distance; g.status = status; g.reference = reference;
}
function geo_(v, ent, sheet, s, st) {
  delete v._v;
  const g = v.gps, rad = Math.max(20, +ent?.radius || +st.gpsRadius || 150), refAcc = Math.max(1, +st.gpsRefAcc || 50);
  if (!g || typeof g.lat !== 'number' || typeof g.lng !== 'number' ||
      !isFinite(g.lat) || !isFinite(g.lng) || g.lat < -90 || g.lat > 90 || g.lng < -180 || g.lng > 180) {
    v.gps = { status: 'غير متاح' };
    return;
  }
  if (!ent || ent.active === false || String(ent.active) === 'false') {
    g.status = 'مرجع غير مؤكد';
    return;
  }

  // A visit's phone reading is evidence only; it must NEVER create or move a master reference.
  // References are valid only when an administrator explicitly placed them on the map.
  const hasReference = ent.lat !== '' && ent.lat != null && isFinite(+ent.lat) &&
    ent.lng !== '' && ent.lng != null && isFinite(+ent.lng);
  if (!hasReference || ent.refBy !== 'ADMIN_MAP' || ent.refState !== 'مؤكد' ||
      (sheet === 'DoctorWorkplaces' && String(ent.reviewed) !== 'true')) {
    g.status = 'مرجع غير مؤكد';
    delete g.dist;
    return;
  }

  g.dist = dist_(+ent.lat, +ent.lng, g.lat, g.lng);
  // Freeze the exact approved reference and thresholds used for this visit.
  g.reference = geoReferenceSnapshot_(ent, rad, refAcc);
  g.status = geoVerdict_(g.dist, g.acc, rad, refAcc);
}

/* ---------- GPS retention: remove precise visit coordinates after 90 days ---------- */
/*
 * The report itself and its historical snapshots remain intact. Only the raw device
 * coordinates/accuracy/timestamp are removed after 90 days; the stored verdict,
 * distance and facility-reference snapshot remain for auditability.
 * Run installGpsRetentionTrigger() once as the spreadsheet owner.
 */
const GPS_RETENTION_DAYS = 90;
function gpsCapturedAt_(gps, reportDate) {
  const raw = gps && gps.ts;
  let ms = NaN;
  if (typeof raw === 'number' && isFinite(raw)) ms = raw < 1000000000000 ? raw * 1000 : raw;
  else if (raw !== '' && raw != null) {
    const n = Number(raw);
    if (isFinite(n) && String(raw).trim() !== '') ms = n < 1000000000000 ? n * 1000 : n;
    else ms = Date.parse(String(raw));
  }
  if (!isFinite(ms) && /^\d{4}-\d{2}-\d{2}$/.test(String(reportDate || ''))) {
    ms = Date.parse(String(reportDate) + 'T12:00:00Z');
  }
  return ms;
}
function reduceGpsVisits_(visits, reportDate, cutoff, reducedAt) {
  let changed = false, count = 0;
  if (!Array.isArray(visits)) return { changed: false, count: 0 };
  visits.forEach(v => {
    const g = v && v.gps;
    if (!g || g.rawLocationReducedAt || (!Object.prototype.hasOwnProperty.call(g, 'lat') && !Object.prototype.hasOwnProperty.call(g, 'lng'))) return;
    const captured = gpsCapturedAt_(g, reportDate);
    if (!isFinite(captured) || captured >= cutoff) return;
    delete g.lat;
    delete g.lng;
    delete g.acc;
    delete g.ts;
    g.rawLocationReducedAt = reducedAt;
    g.rawLocationRetentionDays = GPS_RETENTION_DAYS;
    changed = true;
    count++;
  });
  return { changed: changed, count: count };
}
function reduceExpiredGpsData_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_('Reports');
    if (!sh || sh.getLastRow() < 2) return { reportsUpdated: 0, visitsReduced: 0 };
    const values = sh.getDataRange().getValues(), ix = key => T.Reports.indexOf(key);
    const cutoff = Date.now() - GPS_RETENTION_DAYS * 86400000, reducedAt = new Date().toISOString();
    let reportsUpdated = 0, visitsReduced = 0;
    const parseJson = raw => { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };
    for (let i = 1; i < values.length; i++) {
      if (!values[i][ix('id')]) continue;
      const date = String(values[i][ix('date')] || '');
      let rowChanged = false;
      ['doctors', 'pharmacies'].forEach(key => {
        const arr = parseJson(values[i][ix(key)]);
        if (!Array.isArray(arr)) return;
        const result = reduceGpsVisits_(arr, date, cutoff, reducedAt);
        if (result.changed) {
          sh.getRange(i + 1, ix(key) + 1).setValue(JSON.stringify(arr));
          rowChanged = true;
          visitsReduced += result.count;
        }
      });
      ['snapshot', 'snapshot1'].forEach(key => {
        const snap = parseJson(values[i][ix(key)]);
        if (!snap || typeof snap !== 'object') return;
        let changed = false;
        ['doctors', 'pharmacies'].forEach(field => {
          const result = reduceGpsVisits_(snap[field], snap.date || date, cutoff, reducedAt);
          if (result.changed) { changed = true; visitsReduced += result.count; }
        });
        if (changed) {
          sh.getRange(i + 1, ix(key) + 1).setValue(JSON.stringify(snap));
          rowChanged = true;
        }
      });
      if (rowChanged) reportsUpdated++;
    }
    if (reportsUpdated) audit_({ uid: 'SYSTEM', role: 'system' }, 'gps_retention_reduce', String(reportsUpdated), 'visits=' + visitsReduced + '; retentionDays=' + GPS_RETENTION_DAYS);
    return { reportsUpdated: reportsUpdated, visitsReduced: visitsReduced, retentionDays: GPS_RETENTION_DAYS };
  } finally {
    lock.releaseLock();
  }
}
const GPS_RETENTION_HANDLER = 'gpsRetentionTriggerHandler';
const GPS_RETENTION_STATUS_KEY = 'GPS_RETENTION_LAST_RUN';

function gpsRetentionStatus_(status) {
  PropertiesService.getScriptProperties().setProperty(GPS_RETENTION_STATUS_KEY, JSON.stringify(status));
}
function gpsRetentionTriggerHandler(e) {
  const triggerUid = e && e.triggerUid != null ? String(e.triggerUid) : '';
  const trigger = triggerUid && ScriptApp.getProjectTriggers().find(t =>
    t.getHandlerFunction() === GPS_RETENTION_HANDLER && String(t.getUniqueId()) === triggerUid
  );
  if (!trigger) throw new Error('تشغيل مرفوض: هذا المعالج مخصص للمشغّل المثبّت فقط.');
  const startedAt = new Date().toISOString();
  try {
    const result = reduceExpiredGpsData_();
    gpsRetentionStatus_({ ok: true, startedAt: startedAt, finishedAt: new Date().toISOString(), triggerUid: triggerUid, result: result });
    return result;
  } catch (err) {
    gpsRetentionStatus_({ ok: false, startedAt: startedAt, failedAt: new Date().toISOString(), triggerUid: triggerUid, error: String(err && err.message || err) });
    throw err;
  }
}
// Manual owner-only test/run. The scheduled handler uses the trigger identity check above.
function reduceExpiredGpsData() {
  ownerOnly_();
  const startedAt = new Date().toISOString();
  try {
    const result = reduceExpiredGpsData_();
    gpsRetentionStatus_({ ok: true, manual: true, startedAt: startedAt, finishedAt: new Date().toISOString(), result: result });
    return result;
  } catch (err) {
    gpsRetentionStatus_({ ok: false, manual: true, startedAt: startedAt, failedAt: new Date().toISOString(), error: String(err && err.message || err) });
    throw err;
  }
}
function installGpsRetentionTrigger() {
  ownerOnly_();
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === GPS_RETENTION_HANDLER);
  let trigger = triggers[0] || null, created = false;
  if (!trigger) {
    trigger = ScriptApp.newTrigger(GPS_RETENTION_HANDLER).timeBased().everyDays(1).atHour(3).create();
    created = true;
  }
  triggers.slice(1).forEach(t => ScriptApp.deleteTrigger(t));
  PropertiesService.getScriptProperties().setProperty('GPS_RETENTION_TRIGGER_ID', trigger.getUniqueId());
  return { installed: true, created: created, duplicatesRemoved: Math.max(0, triggers.length - 1), handler: GPS_RETENTION_HANDLER, triggerId: trigger.getUniqueId(), retentionDays: GPS_RETENTION_DAYS };
}
function verifyGpsRetentionTrigger() {
  ownerOnly_();
  const triggers = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === GPS_RETENTION_HANDLER);
  const raw = PropertiesService.getScriptProperties().getProperty(GPS_RETENTION_STATUS_KEY);
  let lastRun = null;
  try { lastRun = raw ? JSON.parse(raw) : null; } catch (e) { lastRun = { ok: false, error: 'تعذر قراءة حالة التشغيل المحفوظة' }; }
  return {
    installed: triggers.length === 1,
    triggerCount: triggers.length,
    triggerIds: triggers.map(t => t.getUniqueId()),
    savedTriggerId: PropertiesService.getScriptProperties().getProperty('GPS_RETENTION_TRIGGER_ID') || '',
    retentionDays: GPS_RETENTION_DAYS,
    lastRun: lastRun
  };
}

/* ---------- email notification (never blocks submission) ---------- */
function notify_(snap) {
  try {
    const to = String(settings_().reportEmail || '').trim(); if (!to) return;
    MailApp.sendEmail({ to: to, name: snap.company.companyName || 'MedRep Pro',
      subject: 'تقرير زيارات جديد — ' + snap.no + ' — ' + snap.rep + (snap.reopens ? ' (معدّل بعد الإرسال)' : ''),
      body: [snap.company.companyName, 'المندوب: ' + snap.rep, 'التاريخ: ' + snap.date, 'رقم التقرير: ' + snap.no,
        'الزيارات: ' + (snap.doctors.length + snap.pharmacies.length) + ' (أطباء ' + snap.doctors.length + '، صيدليات ' + snap.pharmacies.length + ')',
        '', 'للمراجعة: ' + ScriptApp.getService().getUrl()].join('\n') });
  } catch (e) { audit_({ uid: 'SYSTEM', role: 'system' }, 'email_failed', snap.no, String(e.message)); }
}

/* ---------- compliance: on-time = submitted before (day+1) at closeHour, on workDays (0=Sun) ---------- */
function compliance_(from, to) {
  const st = settings_(), tz = st.timezone || Session.getScriptTimeZone(), close = ('0' + closeHour_(st)).slice(-2);
  const wd = String(st.workDays || '0,1,2,3,4').split(',').map(Number), DAY = 864e5, f = d => Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  const yesterday = f(new Date(new Date(today_() + 'T12:00:00Z').getTime() - DAY)), end = to < yesterday ? to : yesterday, days = [];
  for (let d = new Date(from + 'T12:00:00Z'); f(d) <= end; d = new Date(d.getTime() + DAY)) if (wd.indexOf(d.getUTCDay()) >= 0) days.push(f(d));
  const reports = dbAll_('Reports').filter(x => ['مرسل', 'معتمد'].indexOf(x.status) >= 0), out = {}, off = offData_();
  dbAll_('Reps').forEach(rep => {
    let onTime = 0, late = 0;
    const rd = days.filter(d => offWeight_(off, rep.id, d) < 1); // holidays and full-day leaves are not required days
    rd.forEach(day => {
      const r = reports.find(x => x.repId === rep.id && x.date === day); if (!r) return;
      const dl = Utilities.parseDate(f(new Date(new Date(day + 'T12:00:00Z').getTime() + DAY)) + ' ' + close + ':00', tz, 'yyyy-MM-dd HH:mm').getTime();
      if (new Date(r.submittedAt).getTime() <= dl) onTime++; else late++;
    });
    out[rep.id] = { expected: rd.length, onTime: onTime, late: late, missing: rd.length - onTime - late, pct: rd.length ? Math.round(onTime / rd.length * 100) : 0, exempt: days.length - rd.length };
  });
  return out;
}

/* ---------- monthly history: frozen monthly scores per rep (survive KPI target changes) ---------- */
function ensureMonthly_() {
  const ss = SpreadsheetApp.getActive(); let sh = ss.getSheetByName('Monthly');
  if (!sh) { sh = ss.insertSheet('Monthly'); sh.appendRow(T.Monthly); sh.setFrozenRows(1); sh.getRange(1, 1, sh.getMaxRows(), T.Monthly.length).setNumberFormat('@'); }
}
function computeMonth_(ym, save) {
  const a = ym.split('-'), last = new Date(Date.UTC(+a[0], +a[1], 0)).getUTCDate(), now = new Date().toISOString();
  return performance_(null, { from: ym + '-01', to: ym + '-' + ('0' + last).slice(-2) }).map(r => {
    const row = { id: ym + '|' + r.repId, ym: ym, repId: r.repId, repName: r.name, score: r.score, compliance: r.compliance.pct, onTime: r.compliance.onTime,
      expected: r.compliance.expected, visits: r.gps.total, verified: r.gps.ver, gpsTotal: r.gps.total, kpis: JSON.stringify(r.kpis), computedAt: now };
    if (save) dbUpsert_('Monthly', 'id', row);
    return row;
  });
}
const slimM_ = r => ({ repId: r.repId, score: +r.score, compliance: +r.compliance, visits: +r.visits, verified: +r.verified });
// 12 months of one year. Closed months are read from 'Monthly' (computed once, then frozen); the current month is live.
function trend_(s, p) {
  ensureMonthly_();
  const y = +p.year, curYm = today_().slice(0, 7), reps = dbAll_('Reps').filter(r => String(r.active) !== 'false');
  const first = dbAll_('Reports').reduce((a, r) => (!a || r.date < a ? r.date : a), ''), firstYm = first ? first.slice(0, 7) : curYm;
  const stored = {}; dbAll_('Monthly').forEach(r => { (stored[r.ym] = stored[r.ym] || []).push(r); });
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const ym = y + '-' + ('0' + m).slice(-2);
    if (ym > curYm || ym < firstYm) { months.push({ ym: ym, rows: null }); continue; }
    let rows = ym === curYm ? computeMonth_(ym, false) : (stored[ym] || []);
    if (!rows.length) rows = computeMonth_(ym, true);
    months.push({ ym: ym, rows: rows.map(slimM_) });
  }
  return { year: y, months: months, reps: reps.map(r => ({ id: r.id, name: r.name })) };
}
// Average monthly score per rep per year (months with no visits are ignored).
function yearly_(s, p) {
  const ys = (p.years || []).slice(0, 4).map(Number), sum = {};
  ys.forEach(y => trend_(s, { year: y }).months.forEach(m => (m.rows || []).forEach(r => {
    if (r.visits > 0) { const o = (sum[r.repId] = sum[r.repId] || {}); (o[y] = o[y] || []).push(r.score); }
  })));
  const avg = {}; Object.keys(sum).forEach(id => { avg[id] = {}; Object.keys(sum[id]).forEach(y => { const a = sum[id][y]; avg[id][y] = Math.round(a.reduce((x, z) => x + z, 0) / a.length); }); });
  return { years: ys, avg: avg };
}
// Run once from the editor: closes the previous month automatically on the 2nd of every month.
function installMonthlyTrigger() {
  ownerOnly_();
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'monthlyClose_') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('monthlyClose_').timeBased().onMonthDay(2).atHour(3).create();
}
function monthlyClose_() {
  ensureMonthly_();
  computeMonth_(Utilities.formatDate(new Date(new Date(today_() + 'T12:00:00Z').getTime() - 3 * 864e5), 'UTC', 'yyyy-MM'), true);
}

/* ---------- reps management (admin page): add, edit, change code, disable ---------- */
function repsList_() {
  const last = {}, cnt = {};
  dbAll_('Reports').forEach(r => { cnt[r.repId] = (cnt[r.repId] || 0) + 1; if (!last[r.repId] || r.date > last[r.repId]) last[r.repId] = r.date; });
  return dbAll_('Reps').map(r => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, active: r.active, count: cnt[r.id] || 0, last: last[r.id] || '' })); // codeHash never leaves the server
}
function repSave_(s, p) {
  const row = p.row || {}, reps = dbAll_('Reps'), clean = { id: row.id };
  if (!row.id && (!row.name || !row.code)) throw new Error('أدخل الاسم ورمز الدخول');
  if (row.name !== undefined) {
    const nm = String(row.name).trim().slice(0, 80);
    if (nm.length < 2) throw new Error('الاسم قصير جدًا');
    if (reps.some(x => x.id !== row.id && normName_(x.name) === normName_(nm))) throw new Error('الاسم موجود مسبقًا');
    clean.name = nm;
  }
  if (row.phone !== undefined) clean.phone = String(row.phone).trim().slice(0, 30);
  if (row.email !== undefined) { const em = String(row.email).trim().slice(0, 120); if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new Error('بريد إلكتروني غير صالح'); clean.email = em; }
  if (row.code) clean.code = String(row.code).trim();
  if (row.active !== undefined) clean.active = !!row.active;
  const id = saveEntity_(s, { entity: 'Reps', row: clean }), cache = CacheService.getScriptCache();
  if (clean.active === false) cache.put('off_' + id, '1', SESSION_SEC); // ends the rep's open session at once
  else if (clean.active === true) cache.remove('off_' + id);
  return id;
}

/* ---------- add reps from the Sheet (menu: MedRep Pro). Not reachable from the web app. ---------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('MedRep Pro').addItem('إضافة المندوبين من ورقة NewReps', 'addRepsFromSheet').addItem('نسخة احتياطية الآن', 'backupNow').addItem('تفعيل النسخ الاحتياطي الأسبوعي', 'installBackupTrigger').addToUi();
}
function addRepsFromSheet() {
  ownerOnly_();
  const ui = SpreadsheetApp.getUi(), ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('NewReps');
  if (!sh) {
    sh = ss.insertSheet('NewReps'); sh.getRange(1, 1, 1, 2).setValues([['الاسم', 'رمز الدخول (5 أرقام)']]);
    sh.getRange(2, 2, 200, 1).setNumberFormat('@'); sh.setFrozenRows(1);
    ui.alert('أُنشئت ورقة NewReps.\nاكتب الاسم في العمود الأول والرمز في الثاني، ثم شغّل الأمر من القائمة مرة أخرى.'); return;
  }
  sh.getRange(1, 1, 1, 2).setValues([['الاسم', 'رمز الدخول (5 أرقام)']]);
  sh.getRange(2, 2, Math.max(200, sh.getMaxRows() - 1), 1).setNumberFormat('@');
  const n = Math.max(sh.getLastRow() - 1, 0); if (!n) { ui.alert('لا توجد أسماء في ورقة NewReps.'); return; }
  const vals = sh.getRange(2, 1, n, 2).getValues(), errs = []; let done = 0;
  vals.forEach((r, i) => {
    const name = String(r[0]).trim(), raw = String(r[1]).trim(); if (!name && !raw) return;
    try {
      if (name.length < 2) throw new Error('الاسم قصير');
      if (!/^\d{5}$/.test(raw)) throw new Error('رمز الدخول يجب أن يتكون من 5 أرقام بالضبط');
      if (dbAll_('Reps').some(x => normName_(x.name) === normName_(name))) throw new Error('الاسم موجود مسبقًا');
      saveEntity_({ uid: 'ADMIN', role: 'admin' }, { entity: 'Reps', row: { name: name, code: raw, active: true } });
      sh.getRange(i + 2, 1, 1, 2).clearContent(); // the plain-text code is removed right after it is stored hashed
      done++;
    } catch (e) { errs.push('الصف ' + (i + 2) + ': ' + e.message); }
  });
  ui.alert('تمت إضافة ' + done + ' مندوب.' + (errs.length ? '\n\nلم تتم إضافة:\n' + errs.join('\n') : ''));
}

/* ---------- leaves, permissions and official holidays (admin only) ---------- */
const LEAVE_TYPES = ['سنوية', 'مرضية', 'مهمة رسمية', 'إذن']; // 'إذن' = half-day permission: report still required
const isDate_ = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
function ensureSheet_(n) {
  const ss = SpreadsheetApp.getActive(); let sh = ss.getSheetByName(n);
  if (!sh) { sh = ss.insertSheet(n); sh.appendRow(T[n]); sh.setFrozenRows(1); sh.getRange(1, 1, sh.getMaxRows(), T[n].length).setNumberFormat('@'); }
}

/*
 * Safe additive migration: create only the new facility schema.
 * It never rewrites headers or data in existing non-empty sheets.
 * Run manually from the bound Apps Script editor after taking a spreadsheet backup.
 */
function initializeFacilitySchema() {
  ownerOnly_();
  const ss = SpreadsheetApp.getActive();
  const names = ['Facilities', 'FacilityLocations', 'DoctorPlaces'];
  const plan = names.map(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() === 0) return { name: name, sheet: sh, create: !sh, initialize: true };
    const expected = T[name], actual = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), expected.length)).getValues()[0];
    if (actual.length !== expected.length || expected.some((h, i) => actual[i] !== h)) {
      throw new Error('توقف الترحيل دون تعديل البيانات: عناوين جدول ' + name + ' لا تطابق المخطط المتوقع.');
    }
    return { name: name, sheet: sh, create: false, initialize: false };
  });
  const created = [];
  plan.forEach(item => {
    let sh = item.sheet;
    if (item.create) sh = ss.insertSheet(item.name);
    if (item.initialize) {
      sh.getRange(1, 1, 1, T[item.name].length).setValues([T[item.name]]);
      sh.setFrozenRows(1);
      created.push(item.name);
    }
    // Keep IDs and ISO timestamps as text; this changes formatting only, never cell values.
    sh.getRange(1, 1, sh.getMaxRows(), T[item.name].length).setNumberFormat('@');
  });
  return { created: created, verified: names.filter(name => created.indexOf(name) < 0), message: 'تم تجهيز مخطط المنشآت الإضافي دون نقل أو تعديل أي سجل قديم.' };
}


// Read-only pre-migration inventory. It reports counts and ambiguities without changing any sheet.
function previewFacilityMigration() {
  ownerOnly_();
  const read = name => { const sh = sheet_(name); return sh ? dbAll_(name) : []; };
  const parse = value => { try { return value ? JSON.parse(value) : []; } catch (e) { return null; } };
  const doctors = read('Doctors'), workplaces = read('DoctorWorkplaces'), pharmacies = read('Pharmacies'), reports = read('Reports');
  const doctorIds = new Set(doctors.map(d => String(d.id)));
  const norm = value => normName_(String(value || ''));
  const workplaceKeys = new Set(workplaces.map(w => String(w.doctorId) + '|' + norm(w.workplace)));
  const doctorsWithoutWorkplaceRecord = doctors.filter(d => String(d.workplace || '').trim() && !workplaceKeys.has(String(d.id) + '|' + norm(d.workplace))).length;
  const groupNames = (rows, key) => {
    const groups = {};
    rows.forEach(row => { const name = norm(key(row)); if (name) (groups[name] = groups[name] || []).push(row); });
    return Object.keys(groups).filter(name => groups[name].length > 1).map(name => ({ normalizedName: name, count: groups[name].length }));
  };
  let doctorVisits = 0, pharmacyVisits = 0, doctorVisitsWithoutPlaceId = 0, orphanWorkplaces = 0;
  let malformedReportFields = 0, reportsWithSnapshots = 0;
  reports.forEach(report => {
    const docs = parse(report.doctors), phs = parse(report.pharmacies);
    if (docs === null || phs === null) { malformedReportFields++; return; }
    doctorVisits += docs.length; pharmacyVisits += phs.length;
    doctorVisitsWithoutPlaceId += docs.filter(v => !v.workplaceId && String(v.place || '').trim()).length;
    if (report.snapshot || report.snapshot1) reportsWithSnapshots++;
  });
  orphanWorkplaces = workplaces.filter(w => w.doctorId && !doctorIds.has(String(w.doctorId))).length;
  const result = {
    readOnly: true,
    counts: {
      doctors: doctors.length, doctorWorkplaces: workplaces.length, pharmacies: pharmacies.length,
      reports: reports.length, doctorVisits: doctorVisits, pharmacyVisits: pharmacyVisits,
      doctorVisitsWithoutPlaceId: doctorVisitsWithoutPlaceId, orphanWorkplaces: orphanWorkplaces,
      doctorsWithoutWorkplaceRecord: doctorsWithoutWorkplaceRecord,
      reportsWithSnapshots: reportsWithSnapshots, malformedReportFields: malformedReportFields
    },
    possibleDuplicates: {
      doctors: groupNames(doctors, r => r.name),
      pharmacies: groupNames(pharmacies, r => r.name),
      workplaces: groupNames(workplaces, r => r.workplace)
    },
    warning: 'هذه معاينة فقط؛ لا تُدمج الأسماء المتشابهة تلقائيًا ولا تُنقل أي بيانات.'
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}


/*
 * Additive, idempotent migration of legacy master rows only.
 * It writes to Facilities / FacilityLocations / DoctorPlaces and never edits legacy sheets or Reports.
 * Run only after reviewing previewFacilityMigration() and making a spreadsheet backup.
 */
function migrateLegacyFacilitiesV1() {
  ownerOnly_();
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'ترحيل المنشآت — إضافة فقط',
    'سيتم إنشاء سجلات منشآت وعلاقات جديدة من بيانات الأطباء وأماكن عملهم والصيدليات. لن تُعدّل التقارير أو الجداول القديمة، ولن تُدمج الأسماء المتشابهة. تأكد من أخذ نسخة احتياطية ومراجعة المعاينة. هل تريد المتابعة؟',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return { cancelled: true };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    initializeFacilitySchema();
    const read = name => { const sh = sheet_(name); return sh ? dbAll_(name) : []; };
    const validPoint = row => row.lat !== '' && row.lat != null && row.lng !== '' && row.lng != null &&
      isFinite(+row.lat) && isFinite(+row.lng) && +row.lat >= -90 && +row.lat <= 90 && +row.lng >= -180 && +row.lng <= 180;
    const now = new Date().toISOString();
    let facilitiesAdded = 0, locationsAdded = 0, relationsAdded = 0, skippedRelations = 0;
    const facilities = read('Facilities'), locations = read('FacilityLocations'), relations = read('DoctorPlaces');
    const workplaces = read('DoctorWorkplaces'), doctors = read('Doctors');
    const workplaceKeys = new Set(workplaces.map(w => String(w.doctorId) + '|' + normName_(String(w.workplace || ''))));
    const missingWorkplaces = doctors.filter(d => String(d.workplace || '').trim() &&
      !workplaceKeys.has(String(d.id) + '|' + normName_(String(d.workplace || ''))));
    if (missingWorkplaces.length) throw new Error('توقف الترحيل قبل نقل البيانات: يوجد ' + missingWorkplaces.length +
      ' طبيبًا له مكان عمل في السجل الأساسي دون سجل مطابق في DoctorWorkplaces. راجع معاينة الترحيل أولًا.');
    const existingFacility = (entity, id) => facilities.find(f => f.legacyEntity === entity && String(f.legacyId) === String(id));
    const addFacility = (entity, legacy, type, name, address, active) => {
      const oldId = String(legacy.id || '').trim();
      if (!oldId || String(name || '').trim().length < 2) return null;
      const old = existingFacility(entity, oldId);
      if (old) return old;
      const prefix = entity === 'DoctorWorkplaces' ? 'FAC-DW-' : 'FAC-PH-';
      const row = {
        id: prefix + oldId, name: String(name || '').trim(), type: type, region: '', address: String(address || '').trim(),
        status: String(active) === 'false' ? 'معطل' : 'نشط', legacyEntity: entity, legacyId: oldId,
        createdAt: now, createdBy: 'MIGRATION_V1', updatedAt: now, updatedBy: 'MIGRATION_V1'
      };
      dbAppend_('Facilities', row); facilities.push(row); facilitiesAdded++; return row;
    };
    const addLocation = (entity, legacy, facility, reviewed) => {
      if (!validPoint(legacy)) return;
      const id = (entity === 'DoctorWorkplaces' ? 'LOC-DW-' : 'LOC-PH-') + String(legacy.id);
      if (locations.some(l => l.id === id)) return;
      const confirmed = legacy.refBy === 'ADMIN_MAP' && legacy.refState === 'مؤكد' &&
        (entity !== 'DoctorWorkplaces' || String(legacy.reviewed) === 'true');
      const row = {
        id: id, facilityId: facility.id, lat: +legacy.lat, lng: +legacy.lng,
        radius: legacy.radius === '' || legacy.radius == null ? '' : +legacy.radius,
        source: legacy.refBy || 'LEGACY', state: confirmed ? 'مؤكد' : 'مراجعة مطلوبة',
        proposedBy: '', proposedAt: '', approvedBy: '', approvedAt: '', version: 1,
        active: String(legacy.active) === 'false' ? false : true,
        note: 'منقول دون تعديل من ' + entity + ' / ' + legacy.id
      };
      dbAppend_('FacilityLocations', row); locations.push(row); locationsAdded++;
    };
    workplaces.forEach(w => {
      const facility = addFacility('DoctorWorkplaces', w, 'منشأة طبية', w.workplace, '', w.active);
      if (!facility) return;
      addLocation('DoctorWorkplaces', w, facility, w.reviewed);
      if (!w.doctorId) { skippedRelations++; return; }
      const id = 'DPL-' + String(w.id);
      if (!relations.some(r => r.id === id || String(r.legacyWorkplaceId) === String(w.id))) {
        const row = {
          id: id, doctorId: w.doctorId, facilityId: facility.id, workDays: '', notes: '',
          active: String(w.active) === 'false' ? false : true, legacyWorkplaceId: w.id,
          createdAt: now, createdBy: 'MIGRATION_V1', updatedAt: now, updatedBy: 'MIGRATION_V1'
        };
        dbAppend_('DoctorPlaces', row); relations.push(row); relationsAdded++;
      }
    });
    const pharmacies = read('Pharmacies');
    pharmacies.forEach(p => {
      const facility = addFacility('Pharmacies', p, 'صيدلية', p.name, p.location, p.active);
      if (facility) addLocation('Pharmacies', p, facility, p.reviewed);
    });
    clearCache_();
    const result = {
      cancelled: false, facilitiesAdded: facilitiesAdded, locationsAdded: locationsAdded,
      doctorPlacesAdded: relationsAdded, skippedRelations: skippedRelations,
      message: 'اكتملت الإضافة إلى الجداول الجديدة فقط. لم تُعدّل التقارير أو الجداول القديمة.'
    };
    ui.alert('نتيجة ترحيل المنشآت', 'منشآت جديدة: ' + facilitiesAdded + '\nمراجع جغرافية: ' + locationsAdded +
      '\nروابط أطباء ومنشآت: ' + relationsAdded + '\nعلاقات لم تكتمل: ' + skippedRelations +
      '\n\nلم تُعدّل التقارير أو الجداول القديمة.');
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    lock.releaseLock();
  }
}

/*
 * Link historical operational visit JSON to the new facility IDs when the match is unique.
 * Only adds facilityId to Reports.doctors / Reports.pharmacies; frozen snapshots are never written.
 */
function linkLegacyVisitFacilitiesV1() {
  ownerOnly_();
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'ربط الزيارات بالمنشآت',
    'سيُضاف facilityId للزيارات التي يمكن ربطها بسجل واحد بشكل واضح. لن تُدمج الأسماء ولن تُعدّل snapshot أو snapshot1. خذ نسخة احتياطية قبل المتابعة. هل تريد المتابعة؟',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return { cancelled: true };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    initializeFacilitySchema();
    const facilities = dbAll_('Facilities'), relations = dbAll_('DoctorPlaces');
    if (!facilities.length) throw new Error('لم تُرحّل بيانات المنشآت بعد. نفّذ معاينة الترحيل ثم migrateLegacyFacilitiesV1 أولًا.');
    const doctors = dbAll_('Doctors'), workplaces = dbAll_('DoctorWorkplaces'), pharmacies = dbAll_('Pharmacies');
    const byDoctorId = new Map(doctors.map(d => [String(d.id), d]));
    const doctorNames = {};
    doctors.forEach(d => { const k = normName_(d.name); (doctorNames[k] = doctorNames[k] || []).push(d); });
    const byWorkplaceId = new Map(workplaces.map(w => [String(w.id), w]));
    const relationByWorkplace = {};
    relations.forEach(r => { const k = String(r.legacyWorkplaceId || ''); if (k) (relationByWorkplace[k] = relationByWorkplace[k] || []).push(r); });
    const facilityByLegacy = {};
    facilities.forEach(f => { if (f.legacyEntity && f.legacyId) facilityByLegacy[f.legacyEntity + '|' + f.legacyId] = f; });
    const facilityByPharmacyName = {};
    facilities.filter(f => f.legacyEntity === 'Pharmacies').forEach(f => {
      const k = normName_(f.name); if (k) (facilityByPharmacyName[k] = facilityByPharmacyName[k] || []).push(f);
    });
    const rs = sheet_('Reports'), values = rs.getDataRange().getValues();
    const di = T.Reports.indexOf('doctors'), pi = T.Reports.indexOf('pharmacies');
    const parseArray = (raw, rowNo, field) => {
      try { const a = JSON.parse(raw || '[]'); if (!Array.isArray(a)) throw new Error('not array'); return a; }
      catch (e) { throw new Error('توقف الربط قبل تعديل التقارير: JSON غير صالح في الصف ' + rowNo + '، الحقل ' + field + '.'); }
    };
    const plans = [];
    let linkedDoctors = 0, linkedPharmacies = 0, ambiguousDoctors = 0, ambiguousPharmacies = 0, unresolvedDoctors = 0, unresolvedPharmacies = 0;
    for (let i = 1; i < values.length; i++) {
      if (!values[i][0]) continue;
      const docs = parseArray(values[i][di], i + 1, 'doctors'), phs = parseArray(values[i][pi], i + 1, 'pharmacies');
      let changedDocs = false, changedPhs = false;
      docs.forEach(v => {
        if (v.facilityId) return;
        let doctor = v.doctorId ? byDoctorId.get(String(v.doctorId)) : null;
        if (!doctor) {
          const candidates = doctorNames[normName_(v.name)] || [];
          if (candidates.length === 1) doctor = candidates[0];
          else { if (candidates.length > 1) ambiguousDoctors++; else unresolvedDoctors++; return; }
        }
        if (normName_(doctor.name) !== normName_(v.name)) { ambiguousDoctors++; return; }
        let wps = [];
        if (v.workplaceId) {
          const w = byWorkplaceId.get(String(v.workplaceId));
          if (w && String(w.doctorId) === String(doctor.id) && (!v.place || normName_(w.workplace) === normName_(v.place))) wps = [w];
          else { ambiguousDoctors++; return; }
        } else {
          wps = workplaces.filter(w => String(w.doctorId) === String(doctor.id) && normName_(w.workplace) === normName_(v.place));
        }
        const mapped = wps.flatMap(w => (relationByWorkplace[String(w.id)] || []).filter(r => String(r.doctorId) === String(doctor.id)));
        if (mapped.length === 1 && facilities.some(f => f.id === mapped[0].facilityId)) { v.facilityId = mapped[0].facilityId; changedDocs = true; linkedDoctors++; }
        else if (mapped.length > 1) ambiguousDoctors++;
        else unresolvedDoctors++;
      });
      phs.forEach(v => {
        if (v.facilityId) return;
        let facility = null;
        if (v.pharmacyId) facility = facilityByLegacy['Pharmacies|' + String(v.pharmacyId)] || null;
        else {
          const candidates = facilityByPharmacyName[normName_(v.name)] || [];
          if (candidates.length === 1) facility = candidates[0];
          else { if (candidates.length > 1) ambiguousPharmacies++; else unresolvedPharmacies++; return; }
        }
        if (facility && normName_(facility.name) === normName_(v.name)) { v.facilityId = facility.id; changedPhs = true; linkedPharmacies++; }
        else { unresolvedPharmacies++; }
      });
      if (changedDocs || changedPhs) plans.push({ row: i + 1, docs: changedDocs ? JSON.stringify(docs) : null, phs: changedPhs ? JSON.stringify(phs) : null });
    }
    // All JSON is validated and all mappings planned before the first report cell is written.
    plans.forEach(p => {
      if (p.docs !== null) rs.getRange(p.row, di + 1).setValue(p.docs);
      if (p.phs !== null) rs.getRange(p.row, pi + 1).setValue(p.phs);
    });
    clearCache_();
    const result = {
      cancelled: false, reportsUpdated: plans.length, linkedDoctors: linkedDoctors, linkedPharmacies: linkedPharmacies,
      ambiguousDoctors: ambiguousDoctors, ambiguousPharmacies: ambiguousPharmacies,
      unresolvedDoctors: unresolvedDoctors, unresolvedPharmacies: unresolvedPharmacies,
      snapshotsChanged: false,
      message: 'تمت إضافة روابط المنشآت المطابقة فقط. الحالات الملتبسة تُركت دون تعديل.'
    };
    ui.alert('نتيجة ربط الزيارات', 'تقارير تم تحديثها: ' + plans.length +
      '\nزيارات أطباء مرتبطة: ' + linkedDoctors + '\nزيارات صيدليات مرتبطة: ' + linkedPharmacies +
      '\nمطابقات ملتبسة: ' + (ambiguousDoctors + ambiguousPharmacies) +
      '\nزيارات غير مرتبطة: ' + (unresolvedDoctors + unresolvedPharmacies) +
      '\n\nالنسخ التاريخية لم تُعدّل.');
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function offData_() {
  ensureSheet_('Leaves'); ensureSheet_('Holidays');
  const hol = {}, lv = {};
  dbAll_('Holidays').forEach(h => { hol[h.date] = h.name; });
  dbAll_('Leaves').forEach(l => { (lv[l.repId] = lv[l.repId] || []).push(l); });
  return { hol: hol, lv: lv };
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
  for (let i = 1; i < v.length; i++) if (String(v[i][0]) === String(id)) { sh.deleteRow(i + 1); audit_(s, action, id); return true; }
  throw new Error('السجل غير موجود');
}

/* ---------- rep self-service: own report history and own score ---------- */
function myReports_(s) {
  return dbAll_('Reports').filter(r => r.repId === s.uid).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 60).map(r => ({
    id: r.id, no: r.no, date: r.date, status: r.status, reopens: +r.reopens || 0, reviewNote: r.status === 'معاد للمندوب' ? r.reviewNote : '',
    visits: JSON.parse(r.doctors || '[]').length + JSON.parse(r.pharmacies || '[]').length }));
}
function myPerformance_(s, p) {
  ensureMonthly_();
  const cur = today_().slice(0, 7), ym = /^\d{4}-\d{2}$/.test(p.ym || '') ? p.ym : cur;
  let row = ym < cur ? dbAll_('Monthly').find(r => r.id === ym + '|' + s.uid) : null;
  if (!row) row = computeMonth_(ym, false).find(r => r.repId === s.uid);
  if (!row) throw new Error('لا توجد بيانات لهذا الشهر');
  return { ym: ym, score: +row.score, compliance: +row.compliance, onTime: +row.onTime, expected: +row.expected, visits: +row.visits, kpis: JSON.parse(row.kpis || '[]') };
}

/* ---------- reminders (daily trigger): rep with email + summary to the manager ---------- */
// One engine for all reminders: sends only to active reps who are not on leave/holiday and have not sent that day's report.
function remindCore_(day, subject, bodyFn, tellManager) {
  const st = settings_(); if (String(st.remindEnabled) !== 'true') return;
  const wd = String(st.workDays || '0,1,2,3,4').split(',').map(Number), off = offData_();
  if (wd.indexOf(new Date(day + 'T12:00:00Z').getUTCDay()) < 0 || off.hol[day]) return;
  const reports = dbAll_('Reports').filter(r => r.date === day), missing = [], url = ScriptApp.getService().getUrl(), hh = ('0' + closeHour_(st)).slice(-2);
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

/* ---------- sheets data layer (swap for another DB without touching services) ---------- */
function sheet_(n) { return SpreadsheetApp.getActive().getSheetByName(n); }
function dbAll_(n) {
  const sh = sheet_(n), v = sh.getDataRange().getValues(), h = T[n];
  return v.slice(1).filter(r => r[0] !== '').map(r => { const o = {}; h.forEach((c, i) => o[c] = r[i] instanceof Date ? ((c === 'date' || c === 'from' || c === 'to') ? Utilities.formatDate(r[i], SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd') : r[i].toISOString()) : r[i]); return o; });
}
function dbAppend_(n, o) { sheet_(n).appendRow(T[n].map(c => o[c] === undefined ? '' : o[c])); }
function dbUpsert_(n, key, o) {
  const sh = sheet_(n), vals = sh.getDataRange().getValues(), ki = T[n].indexOf(key);
  for (let i = 1; i < vals.length; i++) if (String(vals[i][ki]) === String(o[key])) {
    sh.getRange(i + 1, 1, 1, T[n].length).setValues([T[n].map((c, j) => o[c] === undefined ? vals[i][j] : o[c])]); return;
  }
  dbAppend_(n, o);
}

/* ---------- one-time setup + demo seed (Pharma Care is demo data only) ---------- */
function setup() {
  ownerOnly_();
  clearCache_();
  const sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('SALT')) sp.setProperty('SALT', Utilities.getUuid());
  const ss = SpreadsheetApp.getActive();
  const names = Object.keys(T);
  // Preflight every existing table before writing anything. Never overwrite a non-empty header row.
  const plan = names.map(n => {
    const sh = ss.getSheetByName(n);
    if (!sh || sh.getLastRow() === 0) return { name: n, sheet: sh, initialize: true, create: !sh };
    const expected = T[n], width = Math.max(sh.getLastColumn(), expected.length);
    const actual = sh.getRange(1, 1, 1, width).getValues()[0];
    if (width !== expected.length || expected.some((h, i) => actual[i] !== h)) {
      throw new Error('توقف الإعداد دون تعديل البيانات: عناوين جدول ' + n + ' لا تطابق المخطط الحالي. يلزم ترحيل مخطط منفصل بعد أخذ نسخة احتياطية.');
    }
    return { name: n, sheet: sh, initialize: false, create: false };
  });
  plan.forEach(item => {
    let sh = item.sheet;
    if (item.create) sh = ss.insertSheet(item.name);
    if (item.initialize) { sh.appendRow(T[item.name]); sh.setFrozenRows(1); }
  });
  ['Reports', 'Audit', 'Monthly', 'Leaves', 'Holidays', 'Facilities', 'FacilityLocations', 'DoctorPlaces'].forEach(n => ss.getSheetByName(n).getRange(1, 1, ss.getSheetByName(n).getMaxRows(), T[n].length).setNumberFormat('@')); // preserve JSON, IDs and ISO timestamps as text
  if (!dbAll_('Settings').length) {
    Object.entries({ companyName: 'فارما كير للدعاية الطبية', shortName: 'PC', brandColor: '#0b6b6f', reportTitle: 'تقرير الزيارات اليومية للمندوب الطبي', reportPrefix: 'MR', timezone: 'Africa/Tripoli', phone: '', address: '' })
      .forEach(([k, v]) => dbAppend_('Settings', { key: k, value: v }));
    [['د. أحمد سالم', 'باطنة', 'عيادة النور', 'خاص'], ['د. محمد علي', 'قلب', 'مصحة الشفاء', 'خاص']]
      .forEach(r => saveEntity_({ uid: 'SETUP', role: 'admin' }, { entity: 'Doctors', row: { name: r[0], specialty: r[1], workplace: r[2], sector: r[3], active: true } }));
    saveEntity_({ uid: 'SETUP', role: 'admin' }, { entity: 'Pharmacies', row: { name: 'صيدلية الشفاء', location: 'شارع بن عاشور', nearFacility: 'مصحة الشفاء', active: true } });
    ['CardioPlus', 'GastroCare', 'NeuroVit'].forEach(n => saveEntity_({ uid: 'SETUP', role: 'admin' }, { entity: 'Products', row: { name: n, category: 'عام', status: 'نشط' } }));
    [['visits', 'تحقيق هدف الزيارات', 100, 30], ['doctor_cov', 'تغطية الأطباء', 40, 20], ['pharmacy_cov', 'تغطية الصيدليات', 30, 15],
     ['product_activity', 'نشاط المنتجات', 5, 10], ['compliance', 'الالتزام بالتقارير', 22, 15], ['quality', 'جودة واكتمال التقرير', 100, 10]]
      .forEach(k => dbUpsert_('KPI', 'key', { key: k[0], name: k[1], target: k[2], weight: k[3], active: true }));
  }
  Object.entries({ reportEmail: '', closeHour: '10', workDays: '0,1,2,3,4', gpsRadius: '150', gpsRefAcc: '50' }).forEach(([k, v]) => { if (settings_()[k] === undefined) dbAppend_('Settings', { key: k, value: v }); });
  clearCache_();
  // No default admin password is created. Run configureAdminPassword() manually.
}
