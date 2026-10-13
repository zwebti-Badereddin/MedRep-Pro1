// MedRep Pro — facility model V2 migration (read-only preview + idempotent execution).

/*
 * Facility model V2 — the facility (with its coordinates) is the single reference; DoctorWorkplaces only links doctor ↔ facility.
 * This section is READ-ONLY: it plans the migration and reports blockers, duplicates and visit coverage. Nothing is written.
 * The same planner will drive the (separately approved) execution, so preview and execution cannot disagree.
 */
const FACILITY_V2_COLUMNS = {
  Facilities: ['lat', 'lng', 'radius', 'geoState', 'geoSource', 'geoBy', 'geoAt', 'geoVersion', 'mergedInto'],
  DoctorWorkplaces: ['facilityId', 'linkState', 'linkedBy', 'linkedAt']
};
const FACILITY_V2_NEAR_M = 100; // "similar facility": same normalized name OR closer than this

// Reads a sheet by its header row (not by T position), so columns appended by the V2 migration are visible too.
function readByHeader_(name) {
  const sh = sheet_(name);
  if (!sh || sh.getLastRow() < 1) return { exists: !!sh, header: [], rows: [] };
  const v = sh.getDataRange().getValues(), header = v[0].map(h => String(h).trim());
  return { exists: true, header: header, rows: v.slice(1).filter(r => r[0] !== '').map(r => {
    const o = {}; header.forEach((h, i) => { if (h) o[h] = cellVal_(h, r[i]); }); return o;
  }) };
}

// Pure planner: t = { headers, doctors, workplaces, facilities, locations, places, reports:[{id, doctors:[visits]|null}] }.
function facilityModelV2Plan_(t, now) {
  const S = x => String(x == null ? '' : x).trim(), on = r => S(r.active) !== 'false';
  const validPt = r => !!r && gpsPointValidServer_(r.lat, r.lng);
  const uniq = a => Array.from(new Set(a));
  const blockers = [], warnings = [];

  // 1. Schema: the new columns may only be appended after the current T columns.
  const schema = {};
  ['Facilities', 'DoctorWorkplaces'].forEach(n => {
    const extra = FACILITY_V2_COLUMNS[n], h = (t.headers && t.headers[n]) || [], base = T[n].slice(0, T[n].length - extra.length);
    if (h.length && base.some((c, i) => h[i] !== c)) blockers.push({ type: 'unexpectedHeader', sheet: n });
    const tail = h.slice(base.length).filter(Boolean);
    if (tail.some((c, i) => c !== extra[i])) blockers.push({ type: 'unexpectedExtraColumns', sheet: n, found: tail });
    schema[n] = { present: !!h.length, columnsToAppend: extra.filter(c => tail.indexOf(c) < 0) };
  });

  // 2. Identity integrity: duplicate IDs make any upsert ambiguous.
  [['Doctors', t.doctors], ['DoctorWorkplaces', t.workplaces], ['Facilities', t.facilities], ['FacilityLocations', t.locations], ['DoctorPlaces', t.places]].forEach(([n, rows]) => {
    const seen = {}, dup = [];
    rows.forEach(r => { const k = S(r.id); if (!k) return; if (seen[k]) dup.push(k); seen[k] = 1; });
    if (dup.length) blockers.push({ type: 'duplicateIds', sheet: n, ids: uniq(dup) });
  });

  const doctorsById = new Map(t.doctors.map(d => [S(d.id), d]));
  const facById = new Map(); t.facilities.forEach(f => { if (!facById.has(S(f.id))) facById.set(S(f.id), f); });
  const activeRel = {}; t.places.forEach(p => { const k = S(p.legacyWorkplaceId); if (k && on(p)) (activeRel[k] = activeRel[k] || []).push(p); });
  const legacyFac = {}; t.facilities.forEach(f => { if (f.legacyEntity === 'DoctorWorkplaces' && !legacyFac[S(f.legacyId)]) legacyFac[S(f.legacyId)] = f; });
  const latestLoc = {};
  t.locations.forEach(l => { if (!on(l)) return; const k = S(l.facilityId), p = latestLoc[k]; if (!p || (+l.version || 0) > (+p.version || 0)) latestLoc[k] = l; });
  const usedIds = new Set(t.facilities.map(f => S(f.id)));
  const newId = base => { let id = base, n = 2; while (usedIds.has(id)) id = base + '-' + n++; usedIds.add(id); return id; };

  // 3. Doctors that still have only the legacy text workplace (the migration seeds a row for them, as the former ensureDoctorWorkplaces_ did).
  const withRows = new Set(t.workplaces.map(w => S(w.doctorId)));
  const seedDoctors = t.doctors.filter(d => S(d.workplace) && !withRows.has(S(d.id))).map(d => ({ doctorId: S(d.id), workplace: S(d.workplace) }));

  // 4. Facility of every workplace row — the same resolution the current code uses (facilityForLegacy_), so no verdict changes.
  const created = [], workplaces = [];
  t.workplaces.forEach(w => {
    const wid = S(w.id); if (!wid) return;
    if (!S(w.doctorId) || !doctorsById.has(S(w.doctorId))) warnings.push({ type: 'orphanWorkplace', workplaceId: wid, doctorId: S(w.doctorId) });
    const rels = activeRel[wid] || [], current = S(w.facilityId);
    let fac = null, how = '';
    // Once migrated, a row's facilityId is authoritative (it may have moved by a merge or come from a V2 link).
    if (current) { fac = facById.get(current) || null; how = 'existing'; if (!fac) blockers.push({ type: 'facilityIdMissing', workplaceId: wid, facilityId: current }); }
    if (!fac && rels.length > 1) warnings.push({ type: 'multipleActiveRelations', workplaceId: wid, facilityIds: uniq(rels.map(r => S(r.facilityId))) });
    if (!fac && rels.length) {
      fac = facById.get(S(rels[0].facilityId)) || null; how = 'relation';
      if (!fac) warnings.push({ type: 'relationToMissingFacility', workplaceId: wid, facilityId: S(rels[0].facilityId) });
    }
    if (!fac && legacyFac[wid]) { fac = legacyFac[wid]; how = 'legacyFacility'; }
    if (!fac) {
      fac = { id: newId('FAC-V2-' + wid), name: S(w.workplace), status: on(w) ? 'نشط' : 'معطل', legacyEntity: 'DoctorWorkplaces', legacyId: wid, _new: true, _row: w };
      facById.set(fac.id, fac); legacyFac[wid] = fac; created.push(fac.id); how = 'create';
    }
    workplaces.push({ workplaceId: wid, doctorId: S(w.doctorId), active: on(w), facilityId: S(fac.id), how: how, unchanged: current === S(fac.id) });
  });

  // 5. Current coordinates copied onto the facility row (latest active version; legacy row only when no facility existed).
  const facilities = uniq(workplaces.map(x => x.facilityId)).map(id => {
    const f = facById.get(id), loc = latestLoc[id];
    let geo = { lat: '', lng: '', radius: '', geoState: '', geoSource: '', geoBy: '', geoAt: '', geoVersion: '', from: 'none' };
    if (S(f.geoVersion) || S(f.geoState)) { // already migrated: the facility row is the reference
      geo = { lat: f.lat, lng: f.lng, radius: f.radius, geoState: S(f.geoState), geoSource: S(f.geoSource), geoBy: S(f.geoBy), geoAt: S(f.geoAt),
        geoVersion: f.geoVersion, from: validPt(f) ? 'facility' : 'none' };
    } else if (validPt(loc)) {
      geo = { lat: +loc.lat, lng: +loc.lng, radius: loc.radius === '' || loc.radius == null ? '' : +loc.radius, geoState: S(loc.state), geoSource: S(loc.source),
        geoBy: S(loc.approvedBy), geoAt: S(loc.approvedAt), geoVersion: +loc.version || 1, from: 'FacilityLocations' };
    } else if (f._new && validPt(f._row)) {
      const w = f._row, approved = w.refBy === 'ADMIN_MAP' && w.refState === 'مؤكد' && S(w.reviewed) === 'true';
      geo = { lat: +w.lat, lng: +w.lng, radius: w.radius === '' || w.radius == null ? '' : +w.radius, geoState: approved ? 'مؤكد' : 'مراجعة مطلوبة',
        geoSource: approved ? 'ADMIN_MAP' : 'LEGACY', geoBy: approved ? 'MIGRATION_V2' : '', geoAt: approved ? now : '', geoVersion: 1, from: 'legacyWorkplaceRow' };
    }
    const approved = geo.geoState === 'مؤكد' && geo.geoSource === 'ADMIN_MAP' && !!geo.geoBy && !!geo.geoAt && validPt(geo);
    return { id: id, name: S(f.name), status: S(f.status) || 'نشط', isNew: !!f._new, mergedInto: S(f.mergedInto), approved: approved, geo: geo,
      doctors: uniq(workplaces.filter(x => x.facilityId === id).map(x => x.doctorId)).length };
  });

  // 6. Possible duplicates among active facilities: reported for an admin decision, never merged automatically.
  const live = facilities.filter(f => f.status !== 'معطل' && !f.mergedInto), duplicates = [];
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j], sameName = !!normName_(a.name) && normName_(a.name) === normName_(b.name);
    const d = validPt(a.geo) && validPt(b.geo) ? dist_(+a.geo.lat, +a.geo.lng, +b.geo.lat, +b.geo.lng) : null;
    if (sameName || (d != null && d < FACILITY_V2_NEAR_M)) duplicates.push({ a: a.id, b: b.id, nameA: a.name, nameB: b.name, sameName: sameName, distance: d });
  }

  // 7. Visit coverage: every historical doctor visit must still reach a facility (Reports are never rewritten).
  const wpById = new Map(t.workplaces.map(w => [S(w.id), w])), facOfWp = new Map(workplaces.map(x => [x.workplaceId, x.facilityId]));
  const visits = { total: 0, viaOwnWorkplace: 0, viaColleagueWorkplace: 0, missingWorkplace: 0, nameOnly: 0, noPlace: 0, malformedReports: 0 };
  (t.reports || []).forEach(r => {
    if (!Array.isArray(r.doctors)) { visits.malformedReports++; return; }
    r.doctors.forEach(v => {
      visits.total++;
      const wid = S(v && v.workplaceId);
      if (wid) {
        const w = wpById.get(wid);
        if (!w || !facOfWp.has(wid)) visits.missingWorkplace++;
        else if (S(v.doctorId) && S(w.doctorId) !== S(v.doctorId)) visits.viaColleagueWorkplace++; // V2 resolves these to the right facility
        else visits.viaOwnWorkplace++;
      } else if (S(v && v.place)) visits.nameOnly++;
      else visits.noPlace++;
    });
  });

  // 8. Facilities nobody points to any more (e.g. per-doctor copies left behind by shared facilities, or ADMIN_FACILITY rows).
  const referenced = new Set(facilities.map(f => f.id));
  const unreferenced = t.facilities.filter(f => !referenced.has(S(f.id)) && f.legacyEntity !== 'Pharmacies')
    .map(f => ({ id: S(f.id), name: S(f.name), legacyEntity: S(f.legacyEntity) }));
  if (unreferenced.some(f => f.legacyEntity === 'ADMIN_FACILITY')) warnings.push({ type: 'adminFacilityRows', count: unreferenced.filter(f => f.legacyEntity === 'ADMIN_FACILITY').length });

  return {
    readOnly: true, plannedAt: now, ready: !blockers.length, blockers: blockers, warnings: warnings, schema: schema,
    counts: {
      workplaces: workplaces.length, activeWorkplaces: workplaces.filter(x => x.active).length, workplacesAlreadyMigrated: workplaces.filter(x => x.unchanged).length,
      facilities: facilities.length, facilitiesToCreate: created.length, approvedFacilities: facilities.filter(f => f.approved).length,
      facilitiesWithoutCoordinates: facilities.filter(f => f.geo.from === 'none').length, possibleDuplicatePairs: duplicates.length,
      seedDoctors: seedDoctors.length, unreferencedFacilities: unreferenced.length
    },
    visits: visits, facilities: facilities, workplaces: workplaces, duplicates: duplicates, seedDoctors: seedDoctors, unreferenced: unreferenced
  };
}

function previewFacilityModelV2_(now) {
  const read = n => readByHeader_(n), D = read('Doctors'), W = read('DoctorWorkplaces'), F = read('Facilities'), L = read('FacilityLocations'), P = read('DoctorPlaces');
  // Only the id and doctors columns of Reports are read (snapshots are the bulk of each row and are not needed).
  const sh = sheet_('Reports'), last = sh ? sh.getLastRow() : 0, reports = [];
  if (last >= 2) {
    const ids = sh.getRange(2, 1, last - 1, 1).getValues(), docs = sh.getRange(2, T.Reports.indexOf('doctors') + 1, last - 1, 1).getValues();
    ids.forEach((r, i) => { if (r[0] === '') return; let a = null; try { a = JSON.parse(docs[i][0] || '[]'); } catch (e) {} reports.push({ id: String(r[0]), doctors: Array.isArray(a) ? a : null }); });
  }
  return facilityModelV2Plan_({ headers: { Facilities: F.header, DoctorWorkplaces: W.header }, doctors: D.rows, workplaces: W.rows,
    facilities: F.rows, locations: L.rows, places: P.rows, reports: reports }, now);
}
// Owner-only, read-only. Run from the Apps Script editor; the summary is written to the execution log only.
function previewFacilityModelV2() {
  ownerOnly_();
  const plan = previewFacilityModelV2_(new Date().toISOString()), cap = (a, n) => a.slice(0, n);
  Logger.log('MEDREP_FACILITY_V2_PREVIEW\n' + JSON.stringify({ readOnly: true, ready: plan.ready, counts: plan.counts, visits: plan.visits, schema: plan.schema,
    blockers: plan.blockers, warnings: cap(plan.warnings, 100), duplicates: cap(plan.duplicates, 100), seedDoctors: cap(plan.seedDoctors, 100),
    unreferenced: cap(plan.unreferenced, 100) }, null, 2));
  return plan;
}

/*
 * Execution of the facility model V2 migration. Owner-only, run once from the Apps Script editor (no dialog needed).
 * Driven by the SAME planner as previewFacilityModelV2, refuses to run on any blocker, and is idempotent (a rerun changes nothing).
 * Writes: header cells appended to Facilities / DoctorWorkplaces, facility rows (new + coordinates copied), facilityId on each
 * DoctorWorkplaces row, left-over per-workplace facilities disabled, Settings.workplacePolicy=soft if missing.
 * Never writes Reports, snapshots, DoctorPlaces or FacilityLocations.
 */
function appendFacilityV2Columns_(n) {
  if (!sheet_(n)) ensureSheet_(n); // a missing sheet is created with the full V2 header
  const sh = sheet_(n), extra = FACILITY_V2_COLUMNS[n], base = T[n].length - extra.length;
  if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, T[n].length).setValues([T[n]]); return extra.length; }
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
  if (extra.every((c, i) => head[base + i] === c)) return 0;
  if (sh.getMaxColumns() < T[n].length) sh.insertColumnsAfter(sh.getMaxColumns(), T[n].length - sh.getMaxColumns());
  sh.getRange(1, base + 1, 1, extra.length).setValues([extra]);
  sh.getRange(1, base + 1, sh.getMaxRows(), extra.length).setNumberFormat('@'); // IDs and ISO timestamps stay text
  return extra.length;
}
function migrateFacilityModelV2() {
  ownerOnly_();
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const now = new Date().toISOString(), sys = { uid: 'MIGRATION_V2', role: 'system' };
    let plan = previewFacilityModelV2_(now);
    if (!plan.ready) throw new Error('توقف الترحيل دون أي كتابة. الموانع: ' + JSON.stringify(plan.blockers).slice(0, 1500));
    const out = { columnsAdded: 0, seededWorkplaces: 0, facilitiesCreated: 0, facilityLocationsCopied: 0, workplacesLinked: 0, facilitiesDisabled: 0, policySet: false };
    out.columnsAdded = appendFacilityV2Columns_('Facilities') + appendFacilityV2Columns_('DoctorWorkplaces');
    _SHEETS = {}; clearCache_();
    // Doctors that only have the legacy text workplace get their row first (the rule of the former ensureDoctorWorkplaces_), then re-plan.
    if (plan.seedDoctors.length) {
      const rows = dbAll_('DoctorWorkplaces'), doctors = dbAll_('Doctors');
      plan.seedDoctors.forEach(sd => {
        const d = doctors.find(x => String(x.id) === sd.doctorId); if (!d) return;
        const w = { id: nextWorkplaceId_(rows), doctorId: d.id, doctorName: d.name, workplace: sd.workplace, sector: d.sector || '', lat: '', lng: '', radius: '',
          active: String(d.active) === 'false' ? false : true, refState: '', refBy: '', addedBy: d.addedBy || '', reviewed: String(d.reviewed) === 'true' || !d.addedBy ? 'true' : 'false' };
        dbAppend_('DoctorWorkplaces', w); rows.push(w); out.seededWorkplaces++;
      });
      plan = previewFacilityModelV2_(now);
      if (!plan.ready) throw new Error('توقف الترحيل بعد إضافة أماكن العمل القديمة. الموانع: ' + JSON.stringify(plan.blockers).slice(0, 1500));
    }
    const current = new Map(readByHeader_('Facilities').rows.map(f => [String(f.id), f]));
    const geoKeys = ['lat', 'lng', 'radius', 'geoState', 'geoSource', 'geoBy', 'geoAt', 'geoVersion'];
    plan.facilities.forEach(f => {
      const geo = {}; geoKeys.forEach(k => { geo[k] = f.geo[k]; });
      if (f.isNew) {
        const wp = plan.workplaces.find(x => x.facilityId === f.id);
        dbAppend_('Facilities', Object.assign({ id: f.id, name: f.name, type: 'منشأة طبية', region: '', address: '', status: f.status, legacyEntity: 'DoctorWorkplaces',
          legacyId: wp ? wp.workplaceId : '', createdAt: now, createdBy: sys.uid, updatedAt: now, updatedBy: sys.uid, mergedInto: '' }, geo));
        out.facilitiesCreated++;
        return;
      }
      const row = current.get(f.id);
      if (!row || String(row.geoState || '') || String(row.geoVersion || '') || f.geo.from === 'none') return; // already migrated, or nothing to copy
      dbUpsert_('Facilities', 'id', Object.assign({ id: f.id, updatedAt: now, updatedBy: sys.uid }, geo)); out.facilityLocationsCopied++;
    });
    const wrows = new Map(readByHeader_('DoctorWorkplaces').rows.map(w => [String(w.id), w]));
    plan.workplaces.forEach(x => {
      if (x.unchanged) return;
      const w = wrows.get(x.workplaceId);
      dbUpsert_('DoctorWorkplaces', 'id', { id: x.workplaceId, facilityId: x.facilityId, linkState: (w && w.linkState) || LINK_OK, linkedBy: sys.uid, linkedAt: now });
      out.workplacesLinked++;
    });
    plan.unreferenced.filter(f => f.legacyEntity === 'DoctorWorkplaces').forEach(f => {
      const row = current.get(f.id); if (!row || row.status === 'معطل') return;
      dbUpsert_('Facilities', 'id', { id: f.id, status: 'معطل', updatedAt: now, updatedBy: sys.uid }); out.facilitiesDisabled++;
    });
    if (settings_().workplacePolicy === undefined) { dbAppend_('Settings', { key: 'workplacePolicy', value: 'soft' }); out.policySet = true; }
    clearCache_(); CacheService.getScriptCache().remove('v2_ok');
    const after = previewFacilityModelV2_(new Date().toISOString());
    out.after = { ready: after.ready, counts: after.counts, blockers: after.blockers };
    audit_(sys, 'migrate_facility_model_v2', 'Facilities', JSON.stringify(Object.assign({}, out, { after: after.counts })));
    Logger.log('MEDREP_FACILITY_V2_MIGRATION\n' + JSON.stringify(out, null, 2));
    return out;
  } finally { lock.releaseLock(); }
}
