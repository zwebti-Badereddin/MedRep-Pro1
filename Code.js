/**
 * MedRep Pro — Backend (Google Apps Script + Sheets)
 * Setup: bind to a Google Sheet -> run setup() once -> Deploy as Web App
 * (Execute as: Me, Access: Anyone). Optional: run setAdminPassword('...') once.
 * Layers: doGet/api() [transport] -> auth/role gate -> services -> sheets (db*).
 */
const T = {
  Settings: ['key', 'value'],
  Reps: ['id', 'name', 'codeHash', 'phone', 'active', 'email'],
  Doctors: ['id', 'name', 'specialty', 'workplace', 'sector', 'lat', 'lng', 'radius', 'active', 'refState', 'refBy', 'addedBy', 'reviewed'],
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

function login_(p) {
  const cache = CacheService.getScriptCache(), key = 'try_' + (p.role === 'admin' ? 'admin' : p.code);
  if (+cache.get(key) >= 5) throw new Error('محاولات كثيرة. حاول بعد 10 دقائق.');
  let user = null;
  if (p.role === 'admin') {
    if (hash_(p.password || '') === PropertiesService.getScriptProperties().getProperty('ADMIN_HASH')) user = { id: 'ADMIN', name: 'الإدارة', role: 'admin' };
  } else {
    const h = hash_(String(p.code || '')); const r = dbAll_('Reps').find(x => String(x.active) !== 'false' && x.codeHash === h);
    if (r) user = { id: r.id, name: r.name, role: 'rep' };
  }
  if (!user) { cache.put(key, String((+cache.get(key) || 0) + 1), 600); throw new Error('بيانات الدخول غير صحيحة'); }
  cache.remove(key);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('s_' + token, JSON.stringify({ uid: user.id, name: user.name, role: user.role }), SESSION_SEC);
  const s = { uid: user.id, name: user.name, role: user.role, token: token };
  // one round trip: session + lookups + today's report (login audit is written by a follow-up call)
  return { token, user, boot: bootstrap_(s), report: user.role === 'rep' ? myReport_(s, {}) : null, prev: user.role === 'rep' ? prevInfo_(s) : null };
}
function session_(token) {
  const raw = token && CacheService.getScriptCache().get('s_' + token);
  if (!raw) throw new Error('انتهت الجلسة. سجّل الدخول من جديد.');
  const s = JSON.parse(raw); s.token = token;
  if (s.role === 'rep' && CacheService.getScriptCache().get('off_' + s.uid)) throw new Error('تم تعطيل هذا الحساب.');
  return s;
}

/* ---------- bootstrap: lookups + settings for the UI (nothing hardcoded client-side) ---------- */
function lookups_() {
  const cache = CacheService.getScriptCache(), hit = cache.get('lk'); if (hit) return JSON.parse(hit);
  const act = r => String(r.active) !== 'false';
  // Only send fields needed to fill a visit. Reference GPS coordinates and internal review metadata
  // remain server-side and are available to administrators through masterList_.
  const v = {
    doctors: dbAll_('Doctors').filter(act).map(r => ({ id: r.id, name: r.name, specialty: r.specialty, workplace: r.workplace, sector: r.sector, active: r.active })),
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
    settings: (function () { const x = settings_(); if (s.role !== 'admin') delete x.reportEmail; return x; })(), statuses: STATUS,
    reps: s.role === 'admin' ? dbAll_('Reps').map(r => ({ id: r.id, name: r.name })) : null,
    doctors: lk.doctors, pharmacies: lk.pharmacies, products: lk.products,
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
  return parseReport_(r);
}
// Draft upsert. GPS is stored inside each visit (gps:{lat,lng,acc,ts}) and is never required.
function saveReport_(s, p) { const r = persistReport_(s, p); return { id: r.id, no: r.no, status: r.status, docs: JSON.parse(r.doctors), phs: JSON.parse(r.pharmacies) }; }
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
    const pv = prev.find(x => x.gps && x.gps.status && x.name === v.name && x.gps.ts === g.ts && x.gps.lat === g.lat);
    if (pv) o.gps = pv.gps;
    else if (typeof g.lat === 'number' && typeof g.lng === 'number') { o.gps = { lat: g.lat, lng: g.lng, acc: +g.acc || 0, ts: g.ts }; o._v = true; }
    else o.gps = { status: 'غير متاح' };
    return o;
  });
  const docs = clean(p.doctors, prevD), phs = clean(p.pharmacies, prevP);
  if (docs.concat(phs).some(v => v._v)) {
    const st = settings_(), D = dbAll_('Doctors'), P = dbAll_('Pharmacies');
    docs.forEach(v => { if (v._v) geo_(v, D.find(x => x.name === v.name), 'Doctors', s, st); });
    phs.forEach(v => { if (v._v) geo_(v, P.find(x => x.name === v.name), 'Pharmacies', s, st); });
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
function getReport_(s, p) {
  const r = dbAll_('Reports').find(x => x.id === p.id);
  if (!r || (s.role === 'rep' && r.repId !== s.uid)) throw new Error('التقرير غير موجود');
  const out = parseReport_(r);
  if (r.snapshot) out.snapshot = JSON.parse(r.snapshot);
  if (r.snapshot1) out.snapshot1 = JSON.parse(r.snapshot1); // submitted reports render from the snapshot
  return out;
}
// Filters: repId, from, to, no, status, q (doctor / pharmacy / product text search)
function listReports_(s, p) {
  const q = (p.q || '').toLowerCase(), reps = {};
  dbAll_('Reps').forEach(r => reps[r.id] = r.name);
  return dbAll_('Reports').filter(r =>
    (s.role === 'admin' || r.repId === s.uid) &&
    (!p.repId || r.repId === p.repId) && (!p.status || r.status === p.status) &&
    (!p.no || String(r.no).indexOf(p.no) >= 0) && (!p.from || r.date >= p.from) && (!p.to || r.date <= p.to) &&
    (!q || (r.doctors + r.pharmacies).toLowerCase().indexOf(q) >= 0)
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
    .replace(/^\s*(د\s*\.?|dr\.?)\s*/i, '').replace(/\s+/g, ' ').trim();
}
function addMaster_(s, sheet, p) {
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
    dbAppend_(sheet, row); clearCache_();
    audit_(s, 'add_' + sheet.toLowerCase(), row.id, name);
    return row;
  } finally { lock.releaseLock(); }
}

/* ---------- admin review of doctors/pharmacies (review, edit/rename, merge, disable) ---------- */
function masterSheet_(e) { if (e !== 'Doctors' && e !== 'Pharmacies') throw new Error('كيان غير مسموح'); return e; }
function masterList_(s, p) {
  const sh = masterSheet_(p.entity), col = sh === 'Doctors' ? 'doctors' : 'pharmacies', cnt = {};
  dbAll_('Reports').forEach(r => JSON.parse(r[col] || '[]').forEach(v => { cnt[v.name] = (cnt[v.name] || 0) + 1; }));
  return dbAll_(sh).map(r => Object.assign({}, r, { uses: cnt[r.name] || 0 }));
}
// Rewrites names in the operational report columns (used by KPI coverage). Frozen snapshots are never touched.
function rewriteNames_(sheet, from, to) {
  const ci = T.Reports.indexOf(sheet === 'Doctors' ? 'doctors' : 'pharmacies'), sh = sheet_('Reports'), vals = sh.getDataRange().getValues();
  let n = 0;
  for (let i = 1; i < vals.length; i++) {
    let arr; try { arr = JSON.parse(vals[i][ci] || '[]'); } catch (e) { continue; }
    let ch = false; arr.forEach(v => { if (v.name === from) { v.name = to; ch = true; } });
    if (ch) { sh.getRange(i + 1, ci + 1).setValue(JSON.stringify(arr)); n++; }
  }
  return n;
}
// After the admin approves a reference, visits that were waiting ('مرجع غير مؤكد') get their real verdict.
// Only the GPS verdict/distance of pending visits is updated (also inside snapshots); no other content changes.
function reverify_(sheet, ent) {
  const st = settings_(), rad = +ent.radius || +st.gpsRadius || 150, rs = sheet_('Reports'), vals = rs.getDataRange().getValues();
  const ix = k => T.Reports.indexOf(k), mine = sheet === 'Doctors' ? 'doctors' : 'pharmacies';
  const parse = t => { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };
  let n = 0;
  const fix = list => { let ch = false; (list || []).forEach(v => { const g = v.gps;
    if (v.name === ent.name && g && g.status === 'مرجع غير مؤكد' && typeof g.lat === 'number') {
      g.dist = dist_(+ent.lat, +ent.lng, g.lat, g.lng); g.status = g.acc > rad ? 'غير متاح' : (g.dist <= rad ? 'تم التحقق' : 'خارج النطاق'); ch = true; n++; } }); return ch; };
  for (let i = 1; i < vals.length; i++) {
    const w = [], op = parse(vals[i][ix(mine)]); if (op && fix(op)) w.push([ix(mine), op]);
    ['snapshot', 'snapshot1'].forEach(k => { const o = parse(vals[i][ix(k)]); if (o && fix(o[mine])) w.push([ix(k), o]); });
    w.forEach(x => rs.getRange(i + 1, x[0] + 1).setValue(JSON.stringify(x[1])));
  }
  return n;
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
    r.active = false; r.reviewed = 'true';
  } else if (p.op === 'edit') {
    const row = p.row || {}, nm = String(row.name || '').trim().slice(0, 80), cut = v => String(v || '').trim().slice(0, 80);
    if (nm.length < 3) throw new Error('الاسم قصير جدًا');
    if (rows.some(x => x.id !== r.id && normName_(x.name) === normName_(nm))) throw new Error('الاسم موجود مسبقًا. استخدم «دمج».');
    if (nm !== r.name) { note = 'rename, reports: ' + rewriteNames_(sh, r.name, nm); r.name = nm; }
    (sh === 'Doctors' ? ['specialty', 'workplace', 'sector'] : ['location', 'nearFacility']).forEach(k => { r[k] = cut(row[k]); });
    r.reviewed = 'true';
  } else if (p.op === 'approveLoc') {
    if (r.lat === '' || r.lat == null || isNaN(+r.lat)) throw new Error('لا يوجد موقع مسجّل لهذا السجل بعد.');
    r.refState = 'مؤكد'; note = 'reverified visits: ' + reverify_(sh, r);
  } else if (p.op === 'clearLoc') { r.lat = ''; r.lng = ''; r.refState = ''; r.refBy = ''; }
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
    if (row.code) { if (!/^\d{3}$/.test(row.code)) throw new Error('الرمز يجب أن يكون 3 أرقام'); 
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
const SETTING_KEYS = ['companyName', 'shortName', 'brandColor', 'reportTitle', 'phone', 'address', 'reportEmail', 'closeHour', 'workDays', 'gpsRadius'];
function saveSettings_(s, p) {
  const v = p.values || {};
  Object.keys(v).forEach(k => {
    if (SETTING_KEYS.indexOf(k) < 0) throw new Error('إعداد غير مسموح: ' + k);
    let x = String(v[k] === null || v[k] === undefined ? '' : v[k]).trim();
    if (k === 'brandColor' && !/^#[0-9a-fA-F]{6}$/.test(x)) throw new Error('لون غير صالح');
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
    return { repId: rep.id, name: rep.name, compliance: comp[rep.id], off: { total: allDays.length, avail: availOf(rep.id) }, gps: { total: docs.length + phs.length, ver: docs.concat(phs).filter(v => v.gps && v.gps.status === 'تم التحقق').length, out: docs.concat(phs).filter(v => v.gps && v.gps.status === 'خارج النطاق').length }, score: Math.round(rows.reduce((a, r) => a + r.weighted, 0)), kpis: rows };
  }).sort((a, b) => b.score - a.score).map((r, i) => Object.assign(r, { rank: i + 1 }));
}

/* ---------- GPS verification (visit never blocked; verdict is for management) ----------
 * Reference = first good reading (acc <= gpsRefAcc) -> 'مؤقت'; confirmed ('مؤكد') when a DIFFERENT rep
 * reads within gpsRadius; otherwise 'متعارض' + audit entry for admin to fix lat/lng/refState in the sheet. */
function dist_(a, b, c, d) {
  const t = x => x * Math.PI / 180, dl = t(c - a), dg = t(d - b);
  const h = Math.pow(Math.sin(dl / 2), 2) + Math.cos(t(a)) * Math.cos(t(c)) * Math.pow(Math.sin(dg / 2), 2);
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
}
function geo_(v, ent, sheet, s, st) {
  delete v._v;
  const g = v.gps, rad = +st.gpsRadius || 150, refAcc = +st.gpsRefAcc || 50, save = () => dbUpsert_(sheet, 'id', ent);
  if (!ent) { g.status = 'غير متاح'; return; }
  if (ent.lat === '' || ent.lat == null || isNaN(+ent.lat)) {
    if (g.acc > refAcc) { g.status = 'غير متاح'; return; }
    ent.lat = g.lat; ent.lng = g.lng; ent.refState = 'مؤقت'; ent.refBy = s.uid; save();
    g.status = 'مرجع غير مؤكد'; g.dist = 0; return;
  }
  g.dist = dist_(+ent.lat, +ent.lng, g.lat, g.lng);
  const r = +ent.radius || rad;
  if (g.acc > r) { g.status = 'غير متاح'; return; }
  if (ent.refState === 'مؤقت') {
    if (ent.refBy === s.uid) { g.status = 'مرجع غير مؤكد'; return; }
    if (g.dist <= rad) { ent.refState = 'مؤكد'; save(); g.status = 'تم التحقق'; }
    else { ent.refState = 'متعارض'; save(); audit_(s, 'gps_conflict', ent.id, 'dist ' + g.dist + 'm'); g.status = 'مرجع غير مؤكد'; }
    return;
  }
  if (ent.refState === 'متعارض') { g.status = 'مرجع غير مؤكد'; return; }
  g.status = g.dist <= r ? 'تم التحقق' : 'خارج النطاق';
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
    sh = ss.insertSheet('NewReps'); sh.getRange(1, 1, 1, 2).setValues([['الاسم', 'الرمز (3 أرقام)']]);
    sh.getRange(2, 2, 200, 1).setNumberFormat('@'); sh.setFrozenRows(1);
    ui.alert('أُنشئت ورقة NewReps.\nاكتب الاسم في العمود الأول والرمز في الثاني، ثم شغّل الأمر من القائمة مرة أخرى.'); return;
  }
  const n = Math.max(sh.getLastRow() - 1, 0); if (!n) { ui.alert('لا توجد أسماء في ورقة NewReps.'); return; }
  const vals = sh.getRange(2, 1, n, 2).getValues(), errs = []; let done = 0;
  vals.forEach((r, i) => {
    const name = String(r[0]).trim(), raw = String(r[1]).trim(); if (!name && !raw) return;
    try {
      if (name.length < 2) throw new Error('الاسم قصير');
      if (!/^\d{1,3}$/.test(raw)) throw new Error('الرمز يجب أن يكون 3 أرقام');
      if (dbAll_('Reps').some(x => normName_(x.name) === normName_(name))) throw new Error('الاسم موجود مسبقًا');
      saveEntity_({ uid: 'ADMIN', role: 'admin' }, { entity: 'Reps', row: { name: name, code: ('00' + raw).slice(-3), active: true } });
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
  Object.keys(T).forEach(n => {
    const sh = ss.getSheetByName(n) || ss.insertSheet(n);
    if (sh.getLastRow() === 0) { sh.appendRow(T[n]); sh.setFrozenRows(1); }
    sh.getRange(1, 1, 1, T[n].length).setValues([T[n]]); // keep headers in sync after schema additions
  });
  ['Reports', 'Audit', 'Monthly', 'Leaves', 'Holidays'].forEach(n => ss.getSheetByName(n).getRange(1, 1, ss.getSheetByName(n).getMaxRows(), T[n].length).setNumberFormat('@')); // keep dates/JSON as plain text
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
