// MedRep Pro — pharmacy GPS references (still on the earlier FacilityLocations model).

/* ---------- facility location authority (legacy UI adapter) ---------- */
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

function reverify_(sheet, ent) {
  const st = settings_(), geoEnt = facilityGeoEntity_('Pharmacies', ent.id) || ent, rad = Math.max(20, +geoEnt.radius || +st.gpsRadius || 150), refAcc = Math.max(1, +st.gpsRefAcc || 50), rs = sheet_('Reports'), vals = rs.getDataRange().getValues();
  const ix = k => T.Reports.indexOf(k), mine = sheet === 'Doctors' ? 'doctors' : 'pharmacies';
  const parse = t => { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };
  let n = 0;
  const fix = list => { let ch = false; (list || []).forEach(v => { const g = v.gps;
    if ((v.pharmacyId ? String(v.pharmacyId) === String(ent.id) && normName_(v.name) === normName_(ent.name) : normName_(v.name) === normName_(ent.name)) && g && !g.rawLocationReducedAt && typeof g.lat === 'number' && typeof g.lng === 'number' && isFinite(g.lat) && isFinite(g.lng)) {
      recordGpsReverification_(g, geoEnt, rad, refAcc); ch = true; n++; } }); return ch; };
  // Update only the operational visit data. snapshot/snapshot1 are immutable historical copies.
  for (let i = 1; i < vals.length; i++) {
    const op = parse(vals[i][ix(mine)]);
    if (op && fix(op)) rs.getRange(i + 1, ix(mine) + 1).setValue(JSON.stringify(op));
  }
  return n;
}
