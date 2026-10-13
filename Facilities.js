// MedRep Pro — facility model V2: a facility (with its coordinates) is the single reference; doctors link to it.

/* ---------- Facility model V2: the facility (with its coordinates) is the single reference; a doctor only links to it ---------- */
const LINK_OK = 'معتمد', LINK_PENDING = 'بانتظار', LINK_REJECTED = 'مرفوض';
// Refuses to run on sheets the V2 migration has not prepared yet (the new columns would otherwise be written without headers).
function requireFacilityV2_() {
  const c = CacheService.getScriptCache(); if (c.get('v2_ok')) return;
  const head = n => { const sh = sheet_(n); return sh && sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : []; };
  if (['Facilities', 'DoctorWorkplaces'].some(n => { const h = head(n); return T[n].some((col, i) => h[i] !== col); }))
    throw new Error('لم يكتمل تحديث بنية المنشآت. يجب أن يشغّل مالك المشروع migrateFacilityModelV2 أولًا.');
  try { c.put('v2_ok', '1', CACHE_LONG_SEC); } catch (e) {}
}
function workplacePolicy_() { return String(settings_().workplacePolicy || '') === 'strict' ? 'strict' : 'soft'; }
// Follows merges (a few hops at most) so references to a merged facility reach the surviving one.
function facilityById_(id, facilities) {
  let f = null, k = String(id == null ? '' : id), hops = 0;
  while (k && hops++ < 6) { f = facilities.find(x => String(x.id) === k) || null; if (!f || !f.mergedInto) break; k = String(f.mergedInto); }
  return f;
}
function facilityApproved_(f) {
  return !!f && f.geoState === 'مؤكد' && f.geoSource === 'ADMIN_MAP' && !!f.geoBy && !!f.geoAt && gpsPointValidServer_(f.lat, f.lng);
}
// The GPS reference handed to geo_ / reportVisitGpsCheck_ (same shape as the legacy entities they accept).
function facilityRef_(f) {
  if (!f) return null;
  return { id: f.id, name: f.name, lat: f.lat, lng: f.lng, radius: f.radius, refBy: f.geoSource, refState: f.geoState,
    reviewed: facilityApproved_(f) ? 'true' : 'false', active: f.status !== 'معطل' && !f.mergedInto };
}
function linkApproved_(w) { return !!w && String(w.active) !== 'false' && (w.linkState || LINK_OK) === LINK_OK; }
function visitDoctor_(v, doctors) {
  if (v.doctorId) return doctors.find(d => String(d.id) === String(v.doctorId)) || null;
  const named = doctors.filter(d => normName_(d.name) === normName_(v.name));
  return named.length === 1 ? named[0] : null;
}
// Which facility a doctor visit refers to: its facilityId; else (older visits) its workplace row's facility; else, for a
// name-only visit, the one facility with that name the doctor is linked to. Never a facility merely because names match.
function visitFacility_(v, doctor, fx) {
  if (v.facilityId) return { facility: facilityById_(v.facilityId, fx.facilities), by: 'facilityId' };
  if (v.workplaceId) {
    const w = fx.workplaces.find(x => String(x.id) === String(v.workplaceId));
    return { facility: w ? facilityById_(w.facilityId, fx.facilities) : null, by: 'workplaceId' };
  }
  const key = normName_(v.place || '');
  if (!key || !doctor) return { facility: null, by: 'none' };
  const ids = Array.from(new Set(fx.workplaces.filter(w => String(w.doctorId) === String(doctor.id) && String(w.active) !== 'false')
    .map(w => facilityById_(w.facilityId, fx.facilities)).filter(f => f && normName_(f.name) === key).map(f => String(f.id))));
  return { facility: ids.length === 1 ? facilityById_(ids[0], fx.facilities) : null, by: 'name' };
}
// Save/submit rule. Returns { facility, link, pending, needLink } or { error }.
function resolveVisitLink_(v, doctor, fx, policy) {
  const r = visitFacility_(v, doctor, fx), f = r.facility;
  if (!f) return r.by === 'facilityId' || r.by === 'workplaceId' ? { error: 'مكان المنشأة غير صالح أو معطّل. أعد اختيار المنشأة.' } : { facility: null };
  if (f.status === 'معطل') return { error: 'المنشأة معطّلة. أعد اختيار المنشأة.' };
  if (!doctor) return { error: 'تعذّر تحديد الطبيب لهذه الزيارة. أعد اختيار الطبيب.' };
  const links = fx.workplaces.filter(w => String(w.doctorId) === String(doctor.id) && (facilityById_(w.facilityId, fx.facilities) || {}).id === f.id);
  const link = links.find(linkApproved_) || links[0] || null;
  if (linkApproved_(link)) return { facility: f, link: link };
  if (policy === 'strict') return { error: link && link.linkState === LINK_REJECTED ? 'رفضت الإدارة ربط هذا الطبيب بهذه المنشأة.'
    : 'هذا الطبيب غير مرتبط بهذه المنشأة بعد. أرسل طلب ربط وانتظر اعتماد الإدارة.' };
  return { facility: f, link: link, pending: true, needLink: !link };
}
function newLinkRow_(s, rows, doctorId, doctorName, f, sector) {
  const now = new Date().toISOString();
  return { id: nextWorkplaceId_(rows), doctorId: doctorId, doctorName: doctorName, workplace: f.name, sector: String(sector || '').slice(0, 30),
    active: true, addedBy: s.uid, reviewed: 'false', facilityId: f.id, linkState: LINK_PENDING, linkedBy: s.uid, linkedAt: now };
}
// Called by persistReport_ under the script lock: re-reads the links so concurrent saves never create two rows.
function createPendingLinks_(s, docs) {
  const rows = dbAll_('DoctorWorkplaces'), facilities = dbAll_('Facilities'), doctors = dbAll_('Doctors');
  docs.forEach(v => {
    if (!v._needLink) return;
    const doctorId = String(v._needLink); delete v._needLink;
    let w = rows.find(x => String(x.doctorId) === doctorId && String(x.facilityId) === String(v.facilityId));
    if (!w) {
      const f = facilityById_(v.facilityId, facilities), d = doctors.find(x => String(x.id) === doctorId);
      if (!f) return;
      w = newLinkRow_(s, rows, doctorId, d ? d.name : v.name, f, v.sector);
      dbAppend_('DoctorWorkplaces', w); rows.push(w);
      audit_(s, 'propose_doctor_link', w.id, (d ? d.name : v.name) + ' · ' + f.name + ' · facility=' + f.id);
    }
    v.workplaceId = w.id;
  });
  clearCache_();
}
// Strict policy: the rep asks the administration to link a doctor to a facility (no visit is needed).
function requestDoctorLink_(s, p) {
  requireFacilityV2_();
  const lock = acquireLock_(10000);
  try {
    const doctor = dbAll_('Doctors').find(d => String(d.id) === String(p.doctorId) && String(d.active) !== 'false');
    const f = facilityById_(p.facilityId, dbAll_('Facilities'));
    if (!doctor || !f || f.status === 'معطل') throw new Error('الطبيب أو المنشأة غير متاح.');
    const rows = dbAll_('DoctorWorkplaces'), existing = rows.find(w => String(w.doctorId) === String(doctor.id) && String(w.facilityId) === String(f.id));
    if (existing) return { id: existing.id, linkState: existing.linkState || LINK_OK, existing: true };
    const w = newLinkRow_(s, rows, doctor.id, doctor.name, f, p.sector);
    dbAppend_('DoctorWorkplaces', w); clearCache_();
    audit_(s, 'request_doctor_link', w.id, doctor.name + ' · ' + f.name + ' · facility=' + f.id);
    return { id: w.id, linkState: w.linkState, existing: false };
  } finally { lock.releaseLock(); }
}
function nextWorkplaceId_(rows) { return 'DWP-' + ('00000' + (rows.reduce((m, w) => Math.max(m, +(String(w.id).match(/(\d+)$/) || [0, 0])[1]), 0) + 1)).slice(-5); }
function gpsReference_(s, p) {
  // Admin-only lookup for the comparison window. It returns only an approved current reference.
  const kind = String(p.kind || '');
  let geo = null;
  if (kind === 'doctor') {
    const v = { facilityId: String(p.facilityId || ''), doctorId: String(p.doctorId || ''), name: p.doctorName || p.name || '', workplaceId: String(p.workplaceId || ''), place: p.place || '' };
    geo = readScope_(() => facilityRef_(visitFacility_(v, visitDoctor_(v, dbAll_('Doctors')),
      { facilities: dbAll_('Facilities'), workplaces: dbAll_('DoctorWorkplaces') }).facility));
  } else if (kind === 'pharmacy') {
    const pharmacyId = String(p.pharmacyId || '');
    const name = normName_(p.name || '');
    let pharmacy = pharmacyId ? dbAll_('Pharmacies').find(x => String(x.id) === pharmacyId) : null;
    if (!pharmacy && name) {
      const matches = dbAll_('Pharmacies').filter(x => normName_(x.name) === name);
      if (matches.length === 1) pharmacy = matches[0];
    }
    if (pharmacy) geo = facilityGeoEntity_('Pharmacies', pharmacy.id);
  } else {
    throw new Error('نوع الزيارة غير صالح');
  }
  if (!geo || String(geo.active) === 'false' || geo.refBy !== 'ADMIN_MAP' ||
      geo.refState !== 'مؤكد' || !isFinite(+geo.lat) || !isFinite(+geo.lng) ||
      geo.lat === '' || geo.lng === '') return null;
  return { id: String(geo.id || ''), name: String(geo.name || ''),
    lat: +geo.lat, lng: +geo.lng, radius: +geo.radius || 150,
    source: geo.refBy, state: geo.refState };
}

/* ---------- Facility model V2: administration ---------- */
function facilitiesList_(s, p) {
  requireFacilityV2_();
  return readScope_(() => {
    const facilities = dbAll_('Facilities').filter(f => f.legacyEntity !== 'Pharmacies'), links = dbAll_('DoctorWorkplaces'), doctors = dbAll_('Doctors');
    const counts = usageCounts_('fac'), wpFac = {}, uses = {};
    links.forEach(w => { wpFac[w.id] = w.facilityId; });
    Object.keys(counts).forEach(k => { const f = facilityById_(k.indexOf('wp:') === 0 ? wpFac[k.slice(3)] : k, facilities); if (f) uses[f.id] = (uses[f.id] || 0) + counts[k]; });
    const doctorName = id => (doctors.find(d => String(d.id) === String(id)) || {}).name || '';
    return facilities.map(f => Object.assign({}, f, { approved: facilityApproved_(f), uses: uses[f.id] || 0,
      links: links.filter(w => String(w.facilityId) === String(f.id)).map(w => ({ id: w.id, doctorId: w.doctorId, doctorName: doctorName(w.doctorId) || w.doctorName,
        linkState: w.linkState || LINK_OK, active: String(w.active) !== 'false' })) }));
  });
}
// FacilityLocations is now only a write-only history of each facility's coordinates (same row shape as before).
function facilityLocationHistory_(s, f, note) {
  if (!sheet_('FacilityLocations')) return;
  const rows = dbAll_('FacilityLocations'), mine = rows.filter(l => String(l.facilityId) === String(f.id)), now = new Date().toISOString();
  mine.filter(l => String(l.active) !== 'false').forEach(l => { l.active = false; dbUpsert_('FacilityLocations', 'id', l); });
  if (!gpsPointValidServer_(f.lat, f.lng)) return;
  const version = mine.reduce((m, l) => Math.max(m, +l.version || 0), 0) + 1;
  dbAppend_('FacilityLocations', { id: 'LOC-' + f.id + '-V' + version, facilityId: f.id, lat: f.lat, lng: f.lng, radius: f.radius, source: f.geoSource,
    state: f.geoState, proposedBy: s.uid, proposedAt: now, approvedBy: f.geoBy, approvedAt: f.geoAt, version: version, active: true, note: note || '' });
}
// After a facility's reference changes: ONE read of the Reports doctors column, then only the affected cells are written.
// Operational visit data only; snapshot/snapshot1 are immutable historical copies.
function reverifyFacility_(facilityId) {
  const fx = { facilities: dbAll_('Facilities'), workplaces: dbAll_('DoctorWorkplaces') }, doctors = dbAll_('Doctors');
  const f = facilityById_(facilityId, fx.facilities), ent = facilityRef_(f);
  const rs = sheet_('Reports'), last = rs ? rs.getLastRow() : 0;
  if (!ent || ent.reviewed !== 'true' || last < 2) return 0;
  const st = settings_(), rad = Math.max(20, +ent.radius || +st.gpsRadius || 150), refAcc = Math.max(1, +st.gpsRefAcc || 50);
  const col = T.Reports.indexOf('doctors') + 1, vals = rs.getRange(2, col, last - 1, 1).getValues();
  let n = 0;
  vals.forEach((row, i) => {
    let arr; try { arr = JSON.parse(row[0] || '[]'); } catch (e) { return; }
    if (!Array.isArray(arr)) return;
    let changed = false;
    arr.forEach(v => {
      const g = v && v.gps;
      if (!g || g.rawLocationReducedAt || typeof g.lat !== 'number' || typeof g.lng !== 'number' || !isFinite(g.lat) || !isFinite(g.lng)) return;
      const vf = visitFacility_(v, visitDoctor_(v, doctors), fx).facility;
      if (vf && String(vf.id) === String(f.id)) { recordGpsReverification_(g, ent, rad, refAcc); changed = true; n++; }
    });
    if (changed) rs.getRange(i + 2, col).setValue(JSON.stringify(arr));
  });
  return n;
}
// A new facility, proposed by a rep (coordinates required, awaiting review) or created by an administrator.
// Similar facilities (same normalized name or closer than FACILITY_V2_NEAR_M) are returned first unless confirmNew is set.
function proposeFacility_(s, p) {
  requireFacilityV2_();
  const name = String(p.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (name.length < 2) throw new Error('أدخل اسم المنشأة.');
  const isAdmin = s.role === 'admin', has = p.lat !== '' && p.lat != null && p.lng !== '' && p.lng != null, lat = Number(p.lat), lng = Number(p.lng);
  if ((has || !isAdmin) && !gpsPointValidServer_(has ? lat : '', has ? lng : '')) throw new Error('أدخل خط العرض وخط الطول الصحيحين للمنشأة الجديدة.');
  const lock = acquireLock_(10000);
  try {
    const live = dbAll_('Facilities').filter(f => f.legacyEntity !== 'Pharmacies' && !f.mergedInto && f.status !== 'معطل');
    const similar = live.map(f => ({ f: f, d: has && gpsPointValidServer_(f.lat, f.lng) ? dist_(+f.lat, +f.lng, lat, lng) : null }))
      .filter(x => normName_(x.f.name) === normName_(name) || (x.d != null && x.d < FACILITY_V2_NEAR_M))
      .map(x => ({ id: x.f.id, name: x.f.name, distance: x.d, approved: facilityApproved_(x.f) }));
    if (similar.length && !p.confirmNew) return { similar: similar };
    const now = new Date().toISOString(), id = 'FAC-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
    const f = { id: id, name: name, type: String(p.type || 'منشأة طبية').trim().slice(0, 40), region: '', address: String(p.address || '').trim().slice(0, 180),
      status: 'نشط', legacyEntity: 'DOCTOR_FACILITY', legacyId: id, createdAt: now, createdBy: s.uid, updatedAt: now, updatedBy: s.uid,
      lat: has ? lat : '', lng: has ? lng : '', radius: '', geoState: has ? (isAdmin ? 'مؤكد' : 'مراجعة مطلوبة') : '',
      geoSource: has ? (isAdmin ? 'ADMIN_MAP' : 'REP_PROPOSAL') : '', geoBy: has && isAdmin ? s.uid : '', geoAt: has && isAdmin ? now : '',
      geoVersion: has ? 1 : '', mergedInto: '' };
    dbAppend_('Facilities', f);
    if (has) facilityLocationHistory_(s, f, isAdmin ? 'منشأة أنشأتها الإدارة' : 'إحداثيات مقترحة من المندوب؛ ليست مرجعًا معتمدًا');
    let linkId = '';
    const doctor = p.doctorId ? dbAll_('Doctors').find(d => String(d.id) === String(p.doctorId) && String(d.active) !== 'false') : null;
    if (doctor) { const rows = dbAll_('DoctorWorkplaces'), w = newLinkRow_(s, rows, doctor.id, doctor.name, f, p.sector); dbAppend_('DoctorWorkplaces', w); linkId = w.id; }
    clearCache_();
    audit_(s, 'propose_facility', id, name + (has ? ' · lat=' + lat + ' · lng=' + lng : '') + (doctor ? ' · doctor=' + doctor.id : '') + (similar.length ? ' · similarConfirmed=' + similar.map(x => x.id).join(',') : ''));
    return { facility: { id: id, workplace: name, reviewed: facilityApproved_(f), linked: false }, linkId: linkId };
  } finally { lock.releaseLock(); }
}
function facilityAct_(s, p) {
  if (p.op === 'create') return proposeFacility_(s, Object.assign({}, p.row || {}, { confirmNew: !!p.confirmNew })); // takes its own lock
  requireFacilityV2_();
  const lock = acquireLock_(10000);
  try { return facilityActLocked_(s, p); } finally { lock.releaseLock(); }
}
function facilityActLocked_(s, p) {
  const now = new Date().toISOString(), all = dbAll_('Facilities');
  const f = all.find(x => String(x.id) === String(p.id) && x.legacyEntity !== 'Pharmacies');
  if (!f) throw new Error('المنشأة غير موجودة');
  const save = x => { x.updatedAt = now; x.updatedBy = s.uid; dbUpsert_('Facilities', 'id', x); };
  let note = '';
  if (p.op === 'setLoc') {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (p.lat === '' || p.lng === '' || p.lat == null || p.lng == null || !gpsPointValidServer_(lat, lng)) throw new Error('أدخل إحداثيات صحيحة من الخريطة.');
    // The administrator's map pin is the approved reference (unchanged policy); every doctor at the facility shares it.
    Object.assign(f, { lat: lat, lng: lng, geoState: 'مؤكد', geoSource: 'ADMIN_MAP', geoBy: s.uid, geoAt: now, geoVersion: (+f.geoVersion || 0) + 1 });
    save(f); facilityLocationHistory_(s, f, 'موقع المنشأة من خريطة الإدارة');
    note = 'version=' + f.geoVersion + '; reverified visits: ' + reverifyFacility_(f.id);
  } else if (p.op === 'clearLoc') {
    Object.assign(f, { lat: '', lng: '', geoState: '', geoSource: '', geoBy: '', geoAt: '', geoVersion: (+f.geoVersion || 0) + 1 });
    save(f); facilityLocationHistory_(s, f, '');
  } else if (p.op === 'edit') {
    const row = p.row || {}, name = String(row.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (name.length < 2) throw new Error('اسم المنشأة قصير جدًا');
    f.name = name; // renaming keeps the coordinates: the name is not the location
    if (row.type !== undefined) f.type = String(row.type || '').trim().slice(0, 40);
    if (row.address !== undefined) f.address = String(row.address || '').trim().slice(0, 180);
    save(f); note = 'name=' + name;
  } else if (p.op === 'toggle') {
    if (f.mergedInto) throw new Error('هذه المنشأة مدموجة في منشأة أخرى ولا يمكن تفعيلها.');
    f.status = f.status === 'معطل' ? 'نشط' : 'معطل'; save(f); note = 'status=' + f.status; // doctors' links are left untouched
  } else if (p.op === 'merge') {
    const target = all.find(x => String(x.id) === String(p.into));
    if (!target || target.id === f.id || target.status === 'معطل' || target.mergedInto || f.mergedInto || target.legacyEntity === 'Pharmacies') throw new Error('اختر منشأة نشطة صحيحة للدمج');
    const links = dbAll_('DoctorWorkplaces');
    let moved = 0;
    links.filter(w => String(w.facilityId) === String(f.id)).forEach(w => {
      const dup = links.find(x => x !== w && String(x.doctorId) === String(w.doctorId) && String(x.facilityId) === String(target.id));
      if (dup) {
        if (linkApproved_(w) && !linkApproved_(dup)) { dup.active = true; dup.linkState = LINK_OK; dbUpsert_('DoctorWorkplaces', 'id', dup); }
        w.active = false;
      } else { w.facilityId = target.id; w.workplace = target.name; moved++; }
      dbUpsert_('DoctorWorkplaces', 'id', w);
    });
    if (!gpsPointValidServer_(target.lat, target.lng) && gpsPointValidServer_(f.lat, f.lng)) {
      ['lat', 'lng', 'radius', 'geoState', 'geoSource', 'geoBy', 'geoAt'].forEach(k => { target[k] = f[k]; });
      target.geoVersion = (+target.geoVersion || 0) + 1; save(target); facilityLocationHistory_(s, target, 'منقول عند دمج ' + f.id);
    }
    f.mergedInto = target.id; f.status = 'معطل'; save(f);
    // Old visits keep their facilityId; facilityById_ follows mergedInto, so they now resolve to the target.
    note = 'into ' + target.id + '; links moved: ' + moved + '; reverified visits: ' + reverifyFacility_(target.id);
  } else throw new Error('عملية غير معروفة');
  clearCache_(); audit_(s, 'facility_' + p.op, f.id, note);
  return true;
}
function linkAct_(s, p) {
  requireFacilityV2_();
  const lock = acquireLock_(10000);
  try {
    const w = dbAll_('DoctorWorkplaces').find(x => String(x.id) === String(p.id));
    if (!w) throw new Error('الارتباط غير موجود');
    if (p.op === 'approve') { w.active = true; w.linkState = LINK_OK; w.reviewed = 'true'; }
    else if (p.op === 'reject') w.linkState = LINK_REJECTED;
    else if (p.op === 'toggle') w.active = String(w.active) === 'false';
    else throw new Error('عملية غير معروفة');
    w.linkedBy = s.uid; w.linkedAt = new Date().toISOString();
    dbUpsert_('DoctorWorkplaces', 'id', w); clearCache_();
    audit_(s, 'link_' + p.op, w.id, String(w.doctorName || w.doctorId) + ' · facility=' + w.facilityId);
    return true;
  } finally { lock.releaseLock(); }
}
