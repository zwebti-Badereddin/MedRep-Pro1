// MedRep Pro — daily reports: edit windows, save/submit, reopen, lists, admin review.

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
  const mine = reportsLight_().filter(x => x.repId === s.uid), r = mine.find(x => x.date === y);
  return { date: y, status: r ? r.status : null, open: editable_(y, r), work: wd.indexOf(new Date(y + 'T12:00:00Z').getUTCDay()) >= 0 && offWeight_(offData_(), s.uid, y) < 1, returned: mine.filter(x => x.status === 'معاد للمندوب').length };
}
// The first submitted version stays frozen in snapshot1; every reopen is audited; re-sending after closeHour counts as late.
function reopenReport_(s, p) {
  let t = Date.now();
  const hit = findReportRowById_(p.id), r = hit && hit.r;
  if (!r || r.repId !== s.uid) throw new Error('التقرير غير موجود');
  phase_('find', t); t = Date.now();
  if (r.status === 'معتمد') throw new Error('التقرير معتمد ولا يمكن إعادة فتحه. اطلب ذلك من الإدارة.');
  if (r.status !== 'مرسل') throw new Error('التقرير غير مرسل.');
  if (!editable_(r.date, null)) throw new Error('انتهت مهلة تعديل هذا التقرير. اطلب من الإدارة إعادته إليك.');
  const firstReopen = !r.snapshot1;
  if (firstReopen) r.snapshot1 = r.snapshot;
  r.reopens = (+r.reopens || 0) + 1; r.status = 'مسودة';
  // Only status, reopens and (first time) snapshot1 change: the large visit/snapshot cells are not rewritten.
  dbWriteCells_('Reports', hit.rowNo, 'id', r, firstReopen ? ['status', 'snapshot1', 'reopens'] : ['status', 'reopens']);
  phase_('write', t); t = Date.now();
  audit_(s, 'reopen_report', r.no, '#' + r.reopens);
  phase_('audit', t); t = Date.now();
  // The reopened draft and yesterday's info come back in this response: the phone needs no second round trip.
  const out = { status: r.status, reopens: r.reopens, report: repView_(parseReport_(r)), prev: prevInfo_(s) };
  phase_('reload', t);
  return out;
}
function myReport_(s, p) {
  const date = p.date || today_();
  let r = findReport_(x => x.repId === s.uid && x.date === date);
  if (!r) r = { id: null, no: null, repId: s.uid, date, status: 'مسودة', notes: '', doctors: [], pharmacies: [] };
  return repView_(parseReport_(r)); // route is rep-only
}
// Draft upsert. GPS is stored inside each visit (gps:{lat,lng,acc,ts}) and is never required.
function saveReport_(s, p) {
  const r = persistReport_(s, p); return { id: r.id, no: r.no, status: r.status, docs: repVisits_(JSON.parse(r.doctors)), phs: repVisits_(JSON.parse(r.pharmacies)) }; }
// Takes the script lock, or fails fast with a message the client recognises and retries automatically.
function acquireLock_(ms) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(ms); } catch (e) { throw new Error('النظام مشغول لحظيًا، ستُعاد المحاولة تلقائيًا.'); }
  return lock;
}
// The rep's report for a date. The client sends the report id once it knows it: one id lookup instead of the full index.
// The id is only a hint: the row must belong to this rep and date, otherwise the index search decides.
function repReportRow_(s, date, id) {
  const byId = id ? findReportRowById_(id) : null;
  if (byId && byId.r.repId === s.uid && byId.r.date === date) return byId;
  return findReportRow_(x => x.repId === s.uid && x.date === date);
}
const reportStamp_ = r => r ? [r.id, r.status, r.updatedAt, r.reopens].join('|') : '';
// Heavy part of a save (reads every master table, validates ids, computes GPS verdicts). It runs WITHOUT the script lock,
// reading each sheet once. The result carries a stamp of the report row it was based on; persistReport_ re-checks it under the lock.
function prepareReport_(s, p) {
  const date = p.date || today_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('تاريخ غير صالح');
  const hit = repReportRow_(s, date, p.id), r = hit ? hit.r : null;
  if (r && ['مسودة', 'معاد للمندوب'].indexOf(r.status) < 0) throw new Error('لا يمكن تعديل تقرير بعد إرساله. أعد فتحه أولًا.');
  if (!editable_(date, r)) throw new Error('انتهت مهلة كتابة هذا التقرير. اطلب من الإدارة إعادته إليك.');
  requireFacilityV2_();
  return readScope_(() => {
    const tM = Date.now();
    VALIDATION_TABLES.forEach(n => { if (sheet_(n) && !_RM[n]) _RM[n] = cachedTable_(n); });
    phase_('masters', tM);
    // GPS: client sends only raw {lat,lng,acc,ts}; the verdict is computed here and never taken from the client.
    const prevD = r ? JSON.parse(r.doctors || '[]') : [], prevP = r ? JSON.parse(r.pharmacies || '[]') : [];
    const clean = (list, prev) => (list || []).map((v, i) => {
      const o = Object.assign({}, v, { seq: i + 1 }), g = v.gps || {};
      delete o._v; delete o._needLink; delete o.linkPending; // server-only flags; never accepted from the client
      // Free samples [{product, qty}]: at most 20 rows, product text up to 80 chars, quantity 1–99; anything else is dropped.
      if (Array.isArray(v.samples)) o.samples = v.samples.slice(0, 20).map(x => ({ product: String((x && x.product) || '').trim().slice(0, 80),
        qty: Math.max(1, Math.min(99, Math.round(+(x && x.qty)) || 1)) })).filter(x => x.product && x.product !== '—');
      else delete o.samples;
      const pv = prev.find(x => x.gps && x.gps.status && x.name === v.name && x.doctorId === v.doctorId && x.workplaceId === v.workplaceId && x.pharmacyId === v.pharmacyId && normName_(x.place || x.loc || '') === normName_(v.place || v.loc || '') && x.gps.ts === g.ts && x.gps.lat === g.lat && x.gps.lng === g.lng && x.gps.acc === g.acc);
      if (pv) o.gps = pv.gps;
      else if (typeof g.lat === 'number' && typeof g.lng === 'number') { o.gps = { lat: g.lat, lng: g.lng, acc: +g.acc || 0, ts: g.ts }; o._v = true; }
      else o.gps = { status: 'غير متاح' };
      return o;
    });
    const docs = clean(p.doctors, prevD), phs = clean(p.pharmacies, prevP);
    // Validate explicit master IDs even when GPS is unavailable; IDs are not trusted merely because the client sent them.
    const masterDoctors = dbAll_('Doctors'), masterPharmacies = dbAll_('Pharmacies');
    const fx = { facilities: dbAll_('Facilities'), workplaces: dbAll_('DoctorWorkplaces') }, policy = workplacePolicy_();
    docs.forEach(v => {
      const namedDoctors = masterDoctors.filter(d => normName_(d.name) === normName_(v.name));
      const doctor = v.doctorId
        ? masterDoctors.find(d => String(d.id) === String(v.doctorId))
        : (namedDoctors.length === 1 ? namedDoctors[0] : null);
      if (v.doctorId && (!doctor || normName_(doctor.name) !== normName_(v.name))) throw new Error('معرّف الطبيب لا يطابق اسم الزيارة. أعد اختيار الطبيب.');
      if (v.doctorId && String(doctor.active) === 'false') throw new Error('هذا الطبيب معطّل أو مدموج في سجل آخر. أعد اختيار الطبيب.');
      // The facility is the reference; the doctor ↔ facility link is checked per policy (soft: saved and flagged; strict: refused).
      const res = resolveVisitLink_(v, doctor, fx, policy);
      if (res.error) throw new Error(res.error);
      if (res.facility) { v.facilityId = res.facility.id; v.place = res.facility.name; v.workplaceId = res.link ? res.link.id : ''; }
      else delete v.facilityId;
      if (res.pending) v.linkPending = true;
      if (res.needLink) v._needLink = doctor.id; // the link row is written under the lock in persistReport_
    });
    phs.forEach(v => {
      if (!v.pharmacyId) return;
      const pharmacy = masterPharmacies.find(p => String(p.id) === String(v.pharmacyId));
      if (!pharmacy || String(pharmacy.active) === 'false' || normName_(pharmacy.name) !== normName_(v.name)) throw new Error('معرّف الصيدلية غير صالح أو أن الصيدلية معطّلة. أعد اختيار الصيدلية.');
    });
    if (docs.concat(phs).some(v => v._v)) {
      const st = settings_(), P = masterPharmacies;
      // One read: the visit's facility row carries the approved coordinates.
      docs.forEach(v => { if (v._v) geo_(v, facilityRef_(v.facilityId ? facilityById_(v.facilityId, fx.facilities) : null), 'DoctorWorkplaces', s, st); });
      phs.forEach(v => { if (v._v) {
        const pharmacyMatches = v.pharmacyId ? P.filter(x => String(x.id) === String(v.pharmacyId)) : P.filter(x => normName_(x.name) === normName_(v.name)); const pharmacy = pharmacyMatches.length === 1 ? pharmacyMatches[0] : null;
        if (!pharmacy || normName_(pharmacy.name) !== normName_(v.name)) geo_(v, null, 'Pharmacies', s, st);
        else { const facilityGeo = facilityGeoEntity_('Pharmacies', pharmacy.id); geo_(v, facilityGeo || pharmacy, 'Pharmacies', s, st); }
      }});
    }
    // Pharmacy facilityId is server-derived metadata; never trust a client-supplied one. (Doctor visits were resolved above.)
    phs.forEach(v => { delete v.facilityId; });
    if (sheet_('Facilities')) {
      const pharmacyFacilities = fx.facilities.filter(f => f.legacyEntity === 'Pharmacies');
      phs.forEach(v => {
        const candidates = v.pharmacyId
          ? pharmacyFacilities.filter(f => String(f.legacyId) === String(v.pharmacyId))
          : pharmacyFacilities.filter(f => normName_(f.name) === normName_(v.name));
        if (candidates.length === 1 && normName_(candidates[0].name) === normName_(v.name)) v.facilityId = candidates[0].id;
      });
    }
    return { date: date, docs: docs, phs: phs, existing: r, rowNo: hit ? hit.rowNo : 0, stamp: reportStamp_(r) };
  });
}
// Draft upsert. Only the short read-compare-write section holds the script lock.
function persistReport_(s, p, lockHeld, pre, dry) {
  let lock = null, saved = null, isNew = false;
  if (!lockHeld) { let t = Date.now(); pre = pre || prepareReport_(s, p); phase_('prepare', t); t = Date.now(); lock = acquireLock_(10000); phase_('lockWait', t); }
  const tF = Date.now();
  try {
    if (!pre) pre = prepareReport_(s, p);
    // Freshness check under the lock. An existing report: read just its row. A new one: the small-column index (duplicate guard).
    let curStamp;
    if (pre.rowNo) {
      const cur = rowObj_('Reports', sheet_('Reports').getRange(pre.rowNo, 1, 1, T.Reports.length).getValues()[0]);
      curStamp = String(cur.id) === String(pre.existing.id) ? reportStamp_(cur) : '#moved';
    } else curStamp = reportStamp_(reportsLight_().find(x => x.repId === s.uid && x.date === pre.date) || null);
    if (curStamp !== pre.stamp) pre = prepareReport_(s, p); // the row changed since validation: redo it under the lock
    const r = pre.existing, date = pre.date, docs = pre.docs, phs = pre.phs;
    if (docs.some(v => v._needLink)) createPendingLinks_(s, docs); // soft policy: first visit of a doctor at a facility
    const now = new Date().toISOString();
    const row = {
      id: r ? r.id : 'REPORT-' + Utilities.getUuid(), no: r ? r.no : nextReportNo_(), repId: s.uid, date,
      status: r ? r.status : 'مسودة', notes: String(p.notes || '').slice(0, 2000),
      doctors: JSON.stringify(docs), pharmacies: JSON.stringify(phs),
      snapshot: r ? r.snapshot : '', snapshot1: r ? r.snapshot1 : '', reopens: r ? (+r.reopens || 0) : 0, createdAt: r ? r.createdAt : now, updatedAt: now, submittedAt: r ? r.submittedAt : '', reviewNote: r ? r.reviewNote : ''
    };
    if (dry) return row; // caller writes the final row itself (submit: one write instead of two)
    // An existing row (checked fresh above, under the lock): only the cells a draft save changes. The snapshots are not rewritten.
    if (r && pre.rowNo) dbWriteCells_('Reports', pre.rowNo, 'id', row, ['notes', 'doctors', 'pharmacies', 'updatedAt']);
    else dbUpsert_('Reports', 'id', row);
    phase_('write', tF);
    saved = row; isNew = !r;
    try { CacheService.getScriptCache().put('vc_' + row.id + '_' + row.updatedAt, String(docs.length + phs.length), 21600); } catch (e) {}
  } finally {
    if (lock) lock.releaseLock();
  }
  const tA = Date.now();
  if (isNew || auditDue_(saved.id)) audit_(s, isNew ? 'create_report' : 'edit_report', saved.no);
  phase_('audit', tA);
  return saved;
}
// Autosave fires on every edit; one audit line per report per 15 minutes is enough (creation, submit, reopen, review stay individually logged).
function auditDue_(id) {
  const c = CacheService.getScriptCache(), k = 'ae_' + id;
  if (c.get(k)) return false; c.put(k, '1', 900); return true;
}
// Submit = validate + freeze historical snapshot (names/products copied as text, immune to later edits)
function submitReport_(s, p) {
  let t0 = Date.now();
  const pre = prepareReport_(s, p); // heavy validation outside the lock
  phase_('prepare', t0); t0 = Date.now();
  const lock = acquireLock_(10000);
  phase_('lockWait', t0);
  let snap, result;
  try {
    t0 = Date.now();
    const draft = persistReport_(s, p, true, pre, true), r = parseReport_(draft);
    phase_('freshness', t0);
    const fail = msg => { dbUpsert_('Reports', 'id', draft); throw new Error(msg); }; // an invalid submit still keeps the draft
    if (!r.doctors.length && !r.pharmacies.length) fail('أضف زيارة واحدة على الأقل.');
    const bad = r.doctors.filter(v => !v.name || !v.specialty).length + r.pharmacies.filter(v => !v.name).length;
    if (bad) fail('بعض الزيارات ينقصها الاسم أو التخصص.');
    const rep = dbAll_('Reps').find(x => x.id === s.uid);
    if (!rep) fail('تعذّر العثور على حساب المندوب.');
    t0 = Date.now();
    snap = { company: (function () { const x = settings_(); delete x.reportEmail; return x; })(), no: r.no, rep: rep.name, date: r.date, reopens: +r.reopens || 0, notes: r.notes, doctors: r.doctors, pharmacies: r.pharmacies, frozenAt: new Date().toISOString() };
    r.status = 'مرسل'; r.submittedAt = snap.frozenAt; r.snapshot = JSON.stringify(snap);
    r.doctors = JSON.stringify(r.doctors); r.pharmacies = JSON.stringify(r.pharmacies);
    const nVisits = JSON.parse(r.doctors).length + JSON.parse(r.pharmacies).length;
    dbUpsert_('Reports', 'id', r);
    phase_('write', t0); t0 = Date.now();
    try { CacheService.getScriptCache().put('vc_' + r.id + '_' + r.updatedAt, String(nVisits), 21600); } catch (e) {}
    if (!pre.existing) audit_(s, 'create_report', r.no);
    audit_(s, 'submit_report', r.no);
    phase_('audit', t0);
    result = { no: r.no, status: r.status };
  } finally {
    lock.releaseLock();
  }
  t0 = Date.now(); notify_(snap); phase_('email', t0);
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
  const r = findReportById_(p.id);
  if (!r || (s.role === 'rep' && r.repId !== s.uid)) throw new Error('التقرير غير موجود');
  const out = parseReport_(r);
  if (r.snapshot) out.snapshot = JSON.parse(r.snapshot);
  if (r.snapshot1) out.snapshot1 = JSON.parse(r.snapshot1); // submitted reports render from the snapshot
  return s.role === 'rep' ? repView_(out) : out;
}
function listReports_(s, p) {
  if (p.q) return listReportsFull_(s, p); // free-text search needs the visit contents
  let t = Date.now();
  const reps = repNames_(); phase_('reps', t); t = Date.now();
  const rows = reportsLight_().filter(r =>
    (s.role === 'admin' || r.repId === s.uid) &&
    (!p.repId || r.repId === p.repId) && (!p.status || r.status === p.status) &&
    (!p.no || String(r.no).indexOf(p.no) >= 0) && (!p.from || r.date >= p.from) && (!p.to || r.date <= p.to));
  phase_('index', t); t = Date.now();
  const vc = visitCounts_(rows); phase_('counts', t);
  return rows.map(r => ({ id: r.id, no: r.no, date: r.date, status: r.status, repId: r.repId, repName: reps[r.repId], reopens: +r.reopens || 0, visits: vc[r.id] || 0 })).reverse();
}
function listReportsFull_(s, p) {
  const q = (p.q || '').toLowerCase(), reps = repNames_();
  // Filter on the small-column index first; only the surviving rows' visit columns are read for the text search.
  return reportsBody_(reportsLight_().filter(r =>
    (s.role === 'admin' || r.repId === s.uid) &&
    (!p.repId || r.repId === p.repId) && (!p.status || r.status === p.status) &&
    (!p.no || String(r.no).indexOf(p.no) >= 0) && (!p.from || r.date >= p.from) && (!p.to || r.date <= p.to))
  ).filter(r => !q || searchText_(r, s.role).indexOf(q) >= 0).map(r => ({ id: r.id, no: r.no, date: r.date, status: r.status, repId: r.repId, repName: reps[r.repId], reopens: +r.reopens || 0,
    visits: JSON.parse(r.doctors || '[]').length + JSON.parse(r.pharmacies || '[]').length })).reverse();
}
function reportVisitGpsCheck_(v, kind, st) {
  const g = v && v.gps || {};
  if (!gpsPointValidServer_(g.lat, g.lng)) return { status:'غير متاح', distance:null, reference:null };
  let ent = null;
  if (kind === 'doctor') {
    const fx = { facilities: dbAll_('Facilities'), workplaces: dbAll_('DoctorWorkplaces') };
    ent = facilityRef_(visitFacility_(v, visitDoctor_(v, dbAll_('Doctors')), fx).facility);
  } else {
    const rows = dbAll_('Pharmacies');
    const p = v.pharmacyId ? rows.find(x => String(x.id) === String(v.pharmacyId)) : rows.filter(x => normName_(x.name) === normName_(v.name)).length === 1 ? rows.find(x => normName_(x.name) === normName_(v.name)) : null;
    if (p && String(p.active) !== 'false') ent = facilityGeoEntity_('Pharmacies', p.id) || p;
  }
  if (!ent || String(ent.active) === 'false' || ent.refBy !== 'ADMIN_MAP' || ent.refState !== 'مؤكد' ||
      (kind === 'doctor' && String(ent.reviewed) !== 'true') ||
      !gpsPointValidServer_(ent.lat, ent.lng)) return { status:'مرجع غير مؤكد', distance:null, reference:ent ? String(ent.name || ent.workplace || '') : null };
  const radius = Math.max(20, +ent.radius || +st.gpsRadius || 150), maxAcc = Math.max(1, +st.gpsRefAcc || 50);
  const distance = dist_(+ent.lat, +ent.lng, +g.lat, +g.lng);
  return { status:geoVerdict_(distance, g.acc, radius, maxAcc), distance:distance, reference:String(ent.name || ent.workplace || '') };
}
function gpsReviewSummary_(s, p) {
  const r = findReportById_(p.id);
  if (!r) throw new Error('التقرير غير موجود.');
  const st = settings_(), doctors = JSON.parse(r.doctors || '[]'), pharmacies = JSON.parse(r.pharmacies || '[]');
  const visits = readScope_(() => doctors.map(v => Object.assign({kind:'طبيب',name:v.name||'',place:v.place||''}, reportVisitGpsCheck_(v, 'doctor', st)))
    .concat(pharmacies.map(v => Object.assign({kind:'صيدلية',name:v.name||'',place:v.loc||''}, reportVisitGpsCheck_(v, 'pharmacy', st)))));
  return { reportId:r.id, status:r.status, matched:visits.filter(v=>v.status==='تم التحقق').length,
    exceptions:visits.filter(v=>v.status!=='تم التحقق').length, visits:visits,
    pendingLinks:doctors.filter(v => v.linkPending).map(v => ({ name:v.name||'', place:v.place||'' })) };
}
// Approving a report also approves the doctor ↔ facility links its visits created (the admin confirms this explicitly).
function approveVisitLinks_(s, doctors) {
  const rows = dbAll_('DoctorWorkplaces'), now = new Date().toISOString();
  let n = 0;
  doctors.forEach(v => {
    if (!v.linkPending) return;
    const w = rows.find(x => String(x.id) === String(v.workplaceId));
    if (w && !linkApproved_(w)) {
      w.active = true; w.linkState = LINK_OK; w.reviewed = 'true'; w.linkedBy = s.uid; w.linkedAt = now;
      dbUpsert_('DoctorWorkplaces', 'id', w); audit_(s, 'approve_doctor_link', w.id, String(v.name || '') + ' · ' + String(v.place || '')); n++;
    }
    delete v.linkPending;
  });
  if (n) clearCache_();
  return n;
}
function reviewReport_(s, p) {
  const hit = findReportRowById_(p.id), r = hit && hit.r;
  if (!r || r.status !== 'مرسل') throw new Error('يمكن مراجعة التقارير المرسلة فقط.');
  let linksChanged = false;
  const note = String(p.note || '').trim().slice(0, 1000);
  if (p.approve) {
    const st = settings_(), doctors = JSON.parse(r.doctors || '[]'), pharmacies = JSON.parse(r.pharmacies || '[]');
    const checks = readScope_(() => doctors.map(v => reportVisitGpsCheck_(v, 'doctor', st)).concat(pharmacies.map(v => reportVisitGpsCheck_(v, 'pharmacy', st))));
    const exceptions = checks.filter(x => x.status !== 'تم التحقق');
    if (exceptions.length && note.length < 5) throw new Error('توجد زيارة لم يثبت تطابق موقعها. اكتب سبب الاعتماد الاستثنائي (5 أحرف على الأقل)، أو أعد التقرير للمندوب.');
    if (doctors.some(v => v.linkPending) && !p.approveLinks) throw new Error('يتضمن التقرير ارتباطات أطباء بمنشآت بانتظار الاعتماد. أكّد اعتمادها مع التقرير.');
    if (exceptions.length) audit_(s, 'gps_exception_approval', r.no, JSON.stringify(exceptions.map(x => ({status:x.status,distance:x.distance,reference:x.reference}))) + ' · ' + note);
    if (doctors.some(v => v.linkPending)) { approveVisitLinks_(s, doctors); r.doctors = JSON.stringify(doctors); linksChanged = true; } // operational copy only; snapshots stay frozen
  }
  r.status = p.approve ? 'معتمد' : 'معاد للمندوب'; r.reviewNote = note;
  // Only the changed cells are written (the visits cell only when links were approved); snapshots are never rewritten.
  dbWriteCells_('Reports', hit.rowNo, 'id', r, linksChanged ? ['status', 'doctors', 'reviewNote'] : ['status', 'reviewNote']);
  audit_(s, p.approve ? 'approve_report' : 'return_report', r.no, r.reviewNote);
  return { status: r.status };
}
function parseReport_(r) {
  return Object.assign({}, r, { doctors: typeof r.doctors === 'string' ? JSON.parse(r.doctors || '[]') : r.doctors,
    pharmacies: typeof r.pharmacies === 'string' ? JSON.parse(r.pharmacies || '[]') : r.pharmacies });
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

/* ---------- rep self-service: own report history and own score ---------- */
function myReports_(s) {
  const mine = reportsLight_().filter(r => r.repId === s.uid).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 60), vc = visitCounts_(mine);
  return mine.map(r => ({
    id: r.id, no: r.no, date: r.date, status: r.status, reopens: +r.reopens || 0, reviewNote: r.status === 'معاد للمندوب' ? r.reviewNote : '',
    visits: vc[r.id] || 0 }));
}
