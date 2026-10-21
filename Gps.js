// MedRep Pro — GPS verdicts and the 90-day raw-coordinate retention.

function gpsPointValidServer_(lat, lng) {
  return lat !== '' && lat != null && lng !== '' && lng != null && isFinite(+lat) && isFinite(+lng) && +lat >= -90 && +lat <= 90 && +lng >= -180 && +lng <= 180;
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
const GPS_RETENTION_DAYS = 90, GPS_RETENTION_MARGIN_DAYS = 7, GPS_RETENTION_SCAN_KEY = 'GPS_RETENTION_SCAN_FROM';
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
    const ix = key => T.Reports.indexOf(key);
    const cutoff = Date.now() - GPS_RETENTION_DAYS * 86400000, reducedAt = new Date().toISOString();
    // A report last written before the previous run's cutoff had all its locations reduced by that run (every location in a
    // row is captured before the row's updatedAt), so only rows written since then are read in full. The mark keeps a margin
    // for phone clock drift; a missing mark or an unreadable updatedAt means a full read, as before.
    const props = PropertiesService.getScriptProperties(), mark = Date.parse(props.getProperty(GPS_RETENTION_SCAN_KEY) || '');
    const rows = reportsLight_().filter(r => !isFinite(mark) || !(Date.parse(r.updatedAt) < mark));
    let reportsUpdated = 0, visitsReduced = 0;
    const parseJson = raw => { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } };
    // values[i] = sheet row i + 1, as before; rows not selected stay empty. Nearby rows are read together, distant ones apart
    // (a reopened old report must not pull in every row between it and the recent ones).
    const values = [[]], groups = [];
    rows.forEach(r => { const g = groups[groups.length - 1]; if (g && r.rowNo - g.hi <= 20) { g.hi = r.rowNo; g.want.push(r.rowNo); } else groups.push({ lo: r.rowNo, hi: r.rowNo, want: [r.rowNo] }); });
    groups.forEach(g => { const block = sh.getRange(g.lo, 1, g.hi - g.lo + 1, T.Reports.length).getValues(); g.want.forEach(rn => { values[rn - 1] = block[rn - g.lo]; }); });
    for (let i = 1; i < values.length; i++) {
      if (!values[i] || !values[i][ix('id')]) continue;
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
    props.setProperty(GPS_RETENTION_SCAN_KEY, new Date(cutoff - GPS_RETENTION_MARGIN_DAYS * 86400000).toISOString()); // only after a complete run
    return { reportsUpdated: reportsUpdated, visitsReduced: visitsReduced, retentionDays: GPS_RETENTION_DAYS, reportsRead: rows.length };
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
