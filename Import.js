// MedRep Pro — admin bulk import of doctors / pharmacies pasted from Excel. Preview first; adding re-checks everything.

const IMPORT_MAX_ROWS = 1000;
const IMPORT_COLUMNS = { Doctors: ['name', 'specialty', 'sector'], Pharmacies: ['name', 'location', 'nearFacility'], Facilities: ['name', 'type', 'address', 'lat', 'lng'] };
// Facilities that count for duplicates: every doctor facility not merged away (a disabled one is still "existing": re-enable it instead).
const importFacilitiesExisting_ = rows => (rows || []).filter(f => f.legacyEntity !== 'Pharmacies' && !String(f.mergedInto || '').trim());

// Pure: rows = [[cell, ...], ...] in IMPORT_COLUMNS order; existing = current sheet rows. Duplicates use normName_ like manual adds.
function importPlan_(entity, rows, existing) {
  const cols = IMPORT_COLUMNS[entity]; if (!cols) throw new Error('كيان غير مسموح');
  const cut = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  const known = {}; (existing || []).forEach(r => { const k = normName_(r.name); if (k && !known[k]) known[k] = String(r.name); });
  const add = [], dup = [], invalid = [], seen = {};
  (rows || []).slice(0, IMPORT_MAX_ROWS + 1).forEach((cells, i) => {
    const line = i + 1, c = Array.isArray(cells) ? cells : [];
    if (!c.some(x => cut(x, 200))) return; // empty line
    if (i === 0 && /^(الاسم|اسم|name)/i.test(cut(c[0], 40))) return; // header row
    const o = {}; cols.forEach((k, j) => { o[k] = cut(c[j], k === 'name' ? (entity === 'Facilities' ? 120 : 80) : k === 'address' ? 180 : 60); });
    if (entity === 'Facilities') {
      // Coordinates: two cells, or "lat, lng" pasted from Google Maps into the first one. Optional, but never half or invalid.
      if (o.lat && !o.lng && /[,،]/.test(o.lat)) { const q = o.lat.split(/[,،]/); o.lat = cut(q[0], 30); o.lng = cut(q[1], 30); }
      o.type = o.type || 'منشأة طبية';
      if (o.lat || o.lng) {
        const lat = Number(o.lat), lng = Number(o.lng);
        if (!o.lat || !o.lng || !gpsPointValidServer_(lat, lng)) { invalid.push({ line: line, name: o.name, reason: 'إحداثيات غير صحيحة' }); return; }
        o.lat = lat; o.lng = lng;
      } else { o.lat = ''; o.lng = ''; }
    }
    if (entity === 'Doctors') o.sector = /عام|حكوم/.test(o.sector) ? 'عام' : /خاص/.test(o.sector) ? 'خاص' : '';
    const k = normName_(o.name);
    if (o.name.length < 3 || !k) { invalid.push({ line: line, name: o.name, reason: 'الاسم قصير جدًا أو فارغ' }); return; }
    if (known[k]) { dup.push({ line: line, name: o.name, existing: known[k] }); return; }
    if (seen[k]) { dup.push({ line: line, name: o.name, existing: 'مكرر في السطر ' + seen[k] }); return; }
    seen[k] = line; add.push(o);
  });
  if (add.length + dup.length + invalid.length > IMPORT_MAX_ROWS) throw new Error('أقصى عدد في المرة الواحدة ' + IMPORT_MAX_ROWS + ' سطر.');
  return { entity: entity, add: add, dup: dup, invalid: invalid };
}
function importMaster_(s, p) {
  const entity = p.entity, cols = IMPORT_COLUMNS[entity]; if (!cols) throw new Error('كيان غير مسموح');
  if (entity === 'Facilities') requireFacilityV2_();
  const current = () => (entity === 'Facilities' ? importFacilitiesExisting_(dbAll_(entity)) : dbAll_(entity));
  if (!p.commit) return importPlan_(entity, p.rows, current());
  const lock = acquireLock_(30000);
  try {
    const existing = current(), plan = importPlan_(entity, p.rows, existing);
    if (!plan.add.length) return Object.assign(plan, { added: 0 });
    let mx = existing.reduce((a, r) => Math.max(a, +String(r.id).split('-')[1] || 0), 0);
    const now = new Date().toISOString();
    const values = plan.add.map(o => {
      const row = entity === 'Facilities' ? importFacilityRow_(s, o, now)
        : Object.assign({ id: PREFIX[entity] + '-' + ('0000' + (++mx)).slice(-4), active: true, addedBy: s.uid, reviewed: 'true' }, o);
      return T[entity].map(c => (row[c] === undefined ? '' : row[c]));
    });
    const sh = sheet_(entity);
    sh.getRange(sh.getLastRow() + 1, 1, values.length, T[entity].length).setValues(values);
    dropTableCache_(entity); if (_RM) delete _RM[entity]; clearCache_();
    audit_(s, 'import_' + entity.toLowerCase(), values[0][0] + '..' + values[values.length - 1][0], String(values.length));
    return Object.assign(plan, { added: values.length });
  } finally { lock.releaseLock(); }
}
// A new facility row. Imported coordinates are a PROPOSAL (like a rep's): the admin approves each on the map before visits are checked against it.
function importFacilityRow_(s, o, now) {
  const id = 'FAC-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase(), has = o.lat !== '';
  return { id: id, name: o.name, type: o.type.slice(0, 40), region: '', address: o.address, status: 'نشط', legacyEntity: 'DOCTOR_FACILITY', legacyId: id,
    createdAt: now, createdBy: s.uid, updatedAt: now, updatedBy: s.uid, lat: o.lat, lng: o.lng, radius: '',
    geoState: has ? 'مراجعة مطلوبة' : '', geoSource: has ? 'ADMIN_IMPORT' : '', geoBy: '', geoAt: '', geoVersion: has ? 1 : '', mergedInto: '' };
}
