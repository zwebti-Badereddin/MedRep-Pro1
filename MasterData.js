// MedRep Pro — doctors, pharmacies, products, specialties, reps, settings and KPI.

/* ---------- rep-managed medical specialties (stored in Settings; no schema migration) ---------- */
function specialtyList_() {
  const out = [], add = value => {
    const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (name && !out.some(x => normName_(x) === normName_(name))) out.push(name);
  };
  const row = dbAll_('Settings').find(r => String(r.key) === 'specialties');
  if (row && row.value) { try { const values = JSON.parse(row.value); if (Array.isArray(values)) values.forEach(add); } catch (e) {} }
  dbAll_('Doctors').forEach(d => add(d.specialty));
  return out;
}
function addSpecialty_(s, p) {
  const name = String(p.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (name.length < 2) throw new Error('اسم التخصص قصير جدًا.');
  const lock = acquireLock_(10000);
  try {
    const list = specialtyList_(), existing = list.find(x => normName_(x) === normName_(name));
    if (existing) return { name: existing, existing: true, specialties: list };
    list.push(name);
    dbUpsert_('Settings', 'key', { key: 'specialties', value: JSON.stringify(list) });
    clearCache_(); audit_(s, 'add_specialty', 'Settings', name);
    return { name: name, existing: false, specialties: list };
  } finally { lock.releaseLock(); }
}

/* ---------- rep adds a missing doctor/pharmacy (immediate, deduplicated by normalized name) ---------- */
function normName_(t) {
  return String(t || '').toLowerCase().replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/^\s*(?:د\s*\.?\s+|د\s*\.|dr\.\s+)/i, '').replace(/\s+/g, ' ').trim();
}
function addMaster_(s, sheet, p) {
  const name = String(p.name || '').trim().slice(0, 80);
  if (name.length < 3) throw new Error('الاسم قصير جدًا');
  const lock = acquireLock_(10000);
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
    // Facility model V2: a new doctor gets his facility links from his visits (or a link request), never from free text.
    clearCache_();
    audit_(s, 'add_' + sheet.toLowerCase(), row.id, name);
    return row;
  } finally { lock.releaseLock(); }
}

/* ---------- admin review of doctors/pharmacies ---------- */
function masterSheet_(e) {
  if (e !== 'Doctors' && e !== 'Pharmacies') throw new Error('كيان غير مسموح');
  return e;
}
function masterList_(s, p) {
  const sh = masterSheet_(p.entity), col = sh === 'Doctors' ? 'doctors' : 'pharmacies', cnt = usageCounts_(col);
  return dbAll_(sh).map(r => Object.assign({}, r, { uses: cnt[r.name] || 0 }));
}
// Update operational report names only; immutable submitted snapshots remain unchanged.
function rewriteNames_(sheet, from, to, fromId, toId, wpMap) {
  const ci = T.Reports.indexOf(sheet === 'Doctors' ? 'doctors' : 'pharmacies'), idKey = sheet === 'Doctors' ? 'doctorId' : 'pharmacyId', sh = sheet_('Reports'), vals = sh.getDataRange().getValues();
  let n = 0;
  for (let i = 1; i < vals.length; i++) {
    let arr; try { arr = JSON.parse(vals[i][ci] || '[]'); } catch (e) { continue; }
    let changed = false;
    arr.forEach(v => { const byId = fromId != null && v[idKey]; if (byId ? String(v[idKey]) === String(fromId) : v.name === from) { v.name = to; if (byId) v[idKey] = toId; changed = true; } if (wpMap && v.workplaceId && wpMap[v.workplaceId]) { v.workplaceId = wpMap[v.workplaceId]; changed = true; } });
    if (changed) { sh.getRange(i + 1, ci + 1).setValue(JSON.stringify(arr)); n++; }
  }
  return n;
}

// Doctor merge: links move by facility ID (never by name). A link the target doctor already has is kept; the old one is disabled.
function mergeDoctorWorkplaces_(fromDoctor, toDoctor) {
  const rows = dbAll_('DoctorWorkplaces'), moved = {};
  rows.filter(w => w.doctorId === fromDoctor.id).forEach(w => {
    const duplicate = rows.find(x => x.doctorId === toDoctor.id && w.facilityId && String(x.facilityId) === String(w.facilityId) && String(x.active) !== 'false');
    if (duplicate) {
      if (linkApproved_(w) && !linkApproved_(duplicate)) { duplicate.linkState = LINK_OK; dbUpsert_('DoctorWorkplaces', 'id', duplicate); }
      w.active = false; moved[w.id] = duplicate.id;
    }
    else { w.doctorId = toDoctor.id; w.doctorName = toDoctor.name; }
    dbUpsert_('DoctorWorkplaces', 'id', w);
  });
  return moved;
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
    const wpMap = sh === 'Doctors' ? mergeDoctorWorkplaces_(r, t) : null;
    note = 'into ' + t.id + ', reports: ' + rewriteNames_(sh, r.name, t.name, r.id, t.id, wpMap);
    r.active = false; r.reviewed = 'true';
  } else if (p.op === 'edit') {
    const row = p.row || {}, nm = String(row.name || '').trim().slice(0, 80), cut = v => String(v || '').trim().slice(0, 80);
    if (nm.length < 3) throw new Error('الاسم قصير جدًا');
    if (rows.some(x => x.id !== r.id && normName_(x.name) === normName_(nm))) throw new Error('الاسم موجود مسبقًا. استخدم «دمج».');
    if (nm !== r.name) {
      note = 'rename, reports: ' + rewriteNames_(sh, r.name, nm); r.name = nm;
      if (sh === 'Pharmacies') invalidateFacilityLocations_('Pharmacies', r.id);
      if (sh === 'Doctors') { dbAll_('DoctorWorkplaces').filter(w => w.doctorId === r.id).forEach(w => { w.doctorName = nm; dbUpsert_('DoctorWorkplaces', 'id', w); }); }
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
  const lock = acquireLock_(10000); // the new ID and the write must not interleave with another save
  try { return saveEntityLocked_(s, p); } finally { lock.releaseLock(); }
}
function saveEntityLocked_(s, p) {
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
  // New rows take max+1 (row count + 1 can repeat an existing ID) and are appended, so they can never overwrite a record.
  // An edit must name an existing record; an unknown ID is refused instead of being created with a client-chosen ID.
  const isNew = !row.id;
  if (isNew) row.id = nextId_(sheet, PREFIX[sheet]);
  else { const old = dbAll_(sheet).find(r => String(r.id) === String(row.id)); if (!old) throw new Error('السجل غير موجود'); row = Object.assign({}, old, row); }
  if (isNew) dbAppend_(sheet, row); else dbUpsert_(sheet, 'id', row);
  clearCache_(); audit_(s, 'save_' + sheet.toLowerCase(), row.id);
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
      try { cache.put('st', JSON.stringify(o), CACHE_LONG_SEC); } catch (e) {} // every settings write calls clearCache_()
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
const SETTING_KEYS = ['companyName', 'shortName', 'brandColor', 'reportTitle', 'phone', 'address', 'reportEmail', 'closeHour', 'workDays', 'gpsRadius', 'gpsRefAcc', 'repPerformanceEnabled', 'workplacePolicy', 'theme', 'mapKey'];
function saveSettings_(s, p) {
  const v = p.values || {};
  Object.keys(v).forEach(k => {
    if (SETTING_KEYS.indexOf(k) < 0) throw new Error('إعداد غير مسموح: ' + k);
    let x = String(v[k] === null || v[k] === undefined ? '' : v[k]).trim();
    if (k === 'brandColor' && !/^#[0-9a-fA-F]{6}$/.test(x)) throw new Error('لون غير صالح');
    if (k === 'gpsRadius' && (!/^\d+(?:\.\d+)?$/.test(x) || +x < 20 || +x > 5000)) throw new Error('نطاق الموقع يجب أن يكون بين 20 و5000 متر.');
    if (k === 'gpsRefAcc' && (!/^\d+(?:\.\d+)?$/.test(x) || +x < 1 || +x > 500)) throw new Error('أقصى دقة GPS يجب أن تكون بين 1 و500 متر.');
    if (k === 'workplacePolicy' && ['soft', 'strict'].indexOf(x) < 0) throw new Error('سياسة ربط الأطباء بالمنشآت غير صالحة.');
    if (k === 'theme' && ['auto', 'light', 'dark'].indexOf(x) < 0) throw new Error('مظهر الألوان غير صالح.');
    if (k === 'mapKey' && x && !/^[A-Za-z0-9._-]{20,600}$/.test(x)) throw new Error('مفتاح الخرائط غير صالح: الصقه كما هو دون مسافات.');
    x = x.slice(0, k === 'mapKey' ? 600 : 200); // map API keys can be longer than other settings
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

/* ---------- reps management (admin page): add, edit, change code, disable ---------- */
function repsList_() {
  const last = {}, cnt = {};
  reportsLight_().forEach(r => { cnt[r.repId] = (cnt[r.repId] || 0) + 1; if (!last[r.repId] || r.date > last[r.repId]) last[r.repId] = r.date; });
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
