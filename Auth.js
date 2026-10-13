// MedRep Pro — passwords, login throttling, sessions and administrator accounts.

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

// ---- Login throttling (cache counters only: no script lock, so logins never queue behind report saves) ----
// An outsider must not be able to lock legitimate users out:
//  * Admin: the failure counter is per username.
//  * Rep: one shared counter (the 5-digit code is the only identifier) that blocks UNKNOWN devices only.
//  * A device that already logged in holds a signed device token (HMAC with the server salt). A trusted
//    device is never blocked by the shared counters; it has its own per-account limit instead.
function salt_() { _SALT = _SALT || PropertiesService.getScriptProperties().getProperty('SALT'); return _SALT || ''; }
function deviceToken_(uid) {
  const k = salt_(); if (!k || !uid) return '';
  return uid + '.' + Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature('dev|' + uid, k));
}
function deviceUid_(token) {
  const t = String(token || ''), i = t.lastIndexOf('.');
  if (i < 1 || t.length > 200) return '';
  const uid = t.slice(0, i);
  return deviceToken_(uid) === t ? uid : '';
}
function loginFailures_(key) {
  const raw = CacheService.getScriptCache().get(key); if (!raw) return 0;
  try { const st = JSON.parse(raw); return Date.now() - st.start >= LOGIN_WINDOW_MS ? 0 : (+st.count || 0); } catch (e) { return 0; }
}
function bumpFailures_(key) {
  const cache = CacheService.getScriptCache(), raw = cache.get(key), now = Date.now();
  let st = null; try { st = raw ? JSON.parse(raw) : null; } catch (e) {}
  if (!st || now - st.start >= LOGIN_WINDOW_MS) st = { start: now, count: 0 };
  st.count++;
  cache.put(key, JSON.stringify(st), Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - st.start)) / 1000)));
}
function login_(p) {
  const isAdmin = p.role === 'admin', cache = CacheService.getScriptCache();
  const trusted = deviceUid_(p.device);
  const uname = isAdmin ? String(p.username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 40) : '';
  const sharedKey = isAdmin ? 'try_admin_' + uname : 'rep_login_global', sharedLimit = isAdmin ? ADMIN_USER_LIMIT : REP_UNKNOWN_LIMIT;
  const trustedKey = trusted ? 'try_u_' + trusted : '';
  const sharedLocked = loginFailures_(sharedKey) >= sharedLimit;
  const tooMany = new Error('محاولات كثيرة. حاول بعد 10 دقائق.');
  if (trusted) { if (loginFailures_(trustedKey) >= TRUSTED_LIMIT) throw tooMany; }
  else if (sharedLocked) throw tooMany;
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
  if (user && sharedLocked && String(user.id) !== String(trusted)) user = null; // while locked, only the trusted account may pass
  if (!user) {
    bumpFailures_(trusted ? trustedKey : sharedKey);
    throw new Error('بيانات الدخول غير صحيحة');
  }
  cache.remove('try_u_' + user.id);
  if (isAdmin && !sharedLocked) cache.remove(sharedKey);
  const now = Date.now(), token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('s_' + token, JSON.stringify({ uid: user.id, name: user.name, role: user.role, iat: now, ts: now }), SESSION_SEC);
  const s = { uid: user.id, name: user.name, role: user.role, token: token };
  // one round trip: session + lookups + today's report (login audit is written by a follow-up call)
  let t = Date.now();
  const boot = bootstrap_(s); phase_('bootstrap', t); t = Date.now();
  // Login is read-only from here on: today's report and yesterday's info share ONE read of the Reports index.
  const rep = user.role === 'rep' ? reportsLightOnce_(() => {
    const r = myReport_(s, {}); phase_('todayReport', t); t = Date.now();
    const p = prevInfo_(s); phase_('prevInfo', t); return { report: r, prev: p };
  }) : { report: null, prev: null };
  return { token, device: deviceToken_(user.id), user, boot, report: rep.report, prev: rep.prev };
}
// Owner-only: clears the shared login counters (menu: MedRep Pro).
function resetLoginThrottle() {
  ownerOnly_();
  const ui = SpreadsheetApp.getUi(), r = ui.prompt('إعادة ضبط عدّادات الدخول', 'أدخل اسم مستخدم الإدارة المقفل (أو اتركه فارغًا لإعادة ضبط عدّاد المندوبين فقط):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const u = String(r.getResponseText() || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 40);
  const keys = ['rep_login_global']; if (u) keys.push('try_admin_' + u);
  CacheService.getScriptCache().removeAll(keys);
  ui.alert('تمت إعادة ضبط العدّادات.');
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
  CacheService.getScriptCache().remove('adm_ok_' + account.id); // a disabled admin is refused at his very next request
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
  const cache = CacheService.getScriptCache(), raw = token && cache.get('s_' + token);
  if (!raw) throw new Error('انتهت الجلسة. سجّل الدخول من جديد.');
  const s = JSON.parse(raw); s.token = token;
  if (s.role === 'rep' && cache.get('off_' + s.uid)) throw new Error('تم تعطيل هذا الحساب.');
  // An administrator account is re-checked in the Admins sheet at most every 5 minutes (it used to be read on every admin
  // request); disabling an account drops this mark at once (setAdminAccountActive).
  if (s.role === 'admin' && /^ADM-/.test(String(s.uid)) && !cache.get('adm_ok_' + s.uid)) {
    const account = sheet_('Admins') ? dbAll_('Admins').find(a => String(a.id) === String(s.uid)) : null;
    if (!account || String(account.active) === 'false') {
      cache.remove('s_' + token);
      throw new Error('تم تعطيل حساب الإدارة أو لم يعد موجودًا. سجّل الدخول بحساب نشط.');
    }
    try { cache.put('adm_ok_' + s.uid, '1', 300); } catch (e) {}
  }
  // Sliding session: renewed while the user is active, with an absolute cap per login.
  // The cache TTL cannot exceed 6h, so the rep account is re-checked at every renewal (the 'off_' flag also expires).
  const now = Date.now();
  if (s.iat && now - s.iat > SESSION_MAX_MS) { cache.remove('s_' + token); throw new Error('انتهت الجلسة. سجّل الدخول من جديد.'); }
  if (!s.ts || now - s.ts > SESSION_TOUCH_MS) {
    if (s.role === 'rep') {
      const acc = dbAll_('Reps').find(x => String(x.id) === String(s.uid));
      if (!acc || String(acc.active) === 'false') { cache.remove('s_' + token); throw new Error('تم تعطيل هذا الحساب.'); }
    }
    cache.put('s_' + token, JSON.stringify({ uid: s.uid, name: s.name, role: s.role, iat: s.iat || now, ts: now }), SESSION_SEC);
  }
  return s;
}
