// MedRep Pro — Sheets data layer: reads, writes, per-request memo and validation-table cache.

/* ---------- sheets data layer (swap for another DB without touching services) ---------- */
function sheet_(n) {
  if (_SHEETS[n]) return _SHEETS[n];
  _SS = _SS || SpreadsheetApp.getActive();
  const sh = _SS.getSheetByName(n); if (sh) _SHEETS[n] = sh; // never cache a missing sheet: ensureSheet_ may create it
  return sh;
}
// Read scope: inside readScope_(fn) every sheet is read at most once. Use ONLY for read-only work
// (dbAppend_/dbUpsert_ drop the memo of the sheet they touch, as a safety net).
function readScope_(fn) {
  const prev = _RM; _RM = prev || {};
  try { return fn(); } finally { _RM = prev; }
}
function dbAll_(n) {
  if (_RM) { if (!_RM[n]) _RM[n] = dbAllRaw_(n); return _RM[n]; }
  return dbAllRaw_(n);
}
function cellVal_(c, v) {
  if (!(v instanceof Date)) return v;
  _SS = _SS || SpreadsheetApp.getActive();
  return (c === 'date' || c === 'from' || c === 'to') ? Utilities.formatDate(v, _SS.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : v.toISOString();
}
function rowObj_(n, r) { const o = {}; T[n].forEach((c, i) => o[c] = cellVal_(c, r[i])); return o; }
function dbAllRaw_(n) {
  const sh = sheet_(n), v = sh.getDataRange().getValues();
  return v.slice(1).filter(r => r[0] !== '').map(r => rowObj_(n, r));
}
// The Reports sheet is by far the heaviest (big JSON cells in every row). Hot paths must not read it whole.
// reportsLight_ reads only the small columns (3 narrow range reads); findReport_ then reads ONE full row.
// Read-only scope that reuses one reportsLight_() result. Used ONLY by login: the save path must keep reading fresh rows under
// its lock (duplicate guard), so nothing that writes may run inside this scope.
let _RL = null;
function reportsLightOnce_(fn) {
  const prev = _RL; _RL = { rows: null };
  try { return fn(); } finally { _RL = prev; }
}
function reportsLight_() {
  if (_RL) return _RL.rows || (_RL.rows = reportsLightRead_());
  return reportsLightRead_();
}
function reportsLightRead_() {
  const sh = sheet_('Reports'), last = sh.getLastRow(); if (last < 2) return [];
  const H = T.Reports, n = last - 1, c1 = H.indexOf('createdAt') + 1, c2 = H.indexOf('reopens') + 1;
  const a = sh.getRange(2, 1, n, 5).getValues(), b = sh.getRange(2, c1, n, 4).getValues(), d = sh.getRange(2, c2, n, 1).getValues(), out = [];
  for (let i = 0; i < n; i++) {
    if (a[i][0] === '') continue;
    out.push({ rowNo: i + 2, id: a[i][0], no: a[i][1], repId: a[i][2], date: cellVal_('date', a[i][3]), status: a[i][4],
      createdAt: cellVal_('createdAt', b[i][0]), updatedAt: cellVal_('updatedAt', b[i][1]), submittedAt: cellVal_('submittedAt', b[i][2]), reviewNote: b[i][3], reopens: d[i][0] });
  }
  return out;
}
// reportsLight_ rows + notes/doctors/pharmacies (stored JSON text). Only those 3 adjacent columns are read: the snapshots,
// the bulk of every submitted row, are never needed by lists, search, export or KPI.
function reportsBody_(rows) {
  if (!rows.length) return [];
  const sh = sheet_('Reports'), H = T.Reports, c0 = H.indexOf('notes') + 1, w = H.indexOf('pharmacies') + 2 - c0;
  const lo = Math.min.apply(null, rows.map(r => r.rowNo)), hi = Math.max.apply(null, rows.map(r => r.rowNo));
  const block = rows.length > 8 ? sh.getRange(lo, c0, hi - lo + 1, w).getValues() : null;
  return rows.map(r => {
    const v = block ? block[r.rowNo - lo] : sh.getRange(r.rowNo, c0, 1, w).getValues()[0];
    return Object.assign({}, r, { notes: v[0], doctors: v[H.indexOf('doctors') + 1 - c0], pharmacies: v[H.indexOf('pharmacies') + 1 - c0] });
  });
}
// Number of visits per report without reading the JSON of every report on every call.
// Cached per (id, updatedAt): a changed report gets a new key, so counts never go stale. Only cache misses touch the sheet.
function visitCounts_(rows) {
  const c = CacheService.getScriptCache(), out = {}, keyOf = r => 'vc_' + r.id + '_' + r.updatedAt, got = {}, miss = [];
  const keys = rows.map(keyOf);
  for (let i = 0; i < keys.length; i += 100) Object.assign(got, c.getAll(keys.slice(i, i + 100)));
  rows.forEach((r, i) => { const v = got[keys[i]]; if (v != null) out[r.id] = +v; else miss.push(r); });
  if (miss.length) {
    const sh = sheet_('Reports'), H = T.Reports, cd = H.indexOf('doctors') + 1, cp = H.indexOf('pharmacies') + 1; // adjacent columns
    const len = x => { try { return JSON.parse(x || '[]').length; } catch (e) { return 0; } }, put = {};
    let block = null, lo = 0;
    if (miss.length > 8) { lo = Math.min.apply(null, miss.map(r => r.rowNo)); const hi = Math.max.apply(null, miss.map(r => r.rowNo)); block = sh.getRange(lo, cd, hi - lo + 1, cp - cd + 1).getValues(); }
    miss.forEach(r => {
      const v = block ? block[r.rowNo - lo] : sh.getRange(r.rowNo, cd, 1, cp - cd + 1).getValues()[0], n = len(v[0]) + len(v[cp - cd]);
      out[r.id] = n; put[keyOf(r)] = String(n);
    });
    const ks = Object.keys(put);
    for (let i = 0; i < ks.length; i += 100) { const part = {}; ks.slice(i, i + 100).forEach(k => part[k] = put[k]); try { c.putAll(part, 21600); } catch (e) {} }
  }
  return out;
}
// Display-only usage counters scan every report's JSON, so they are cached for 30 minutes.
function usageCounts_(kind) {
  const hit = cacheGetLarge_('uc_' + kind); if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const counts = {}, col = kind === 'pharmacies' ? 'pharmacies' : 'doctors';
  // Only the one column that holds the visits is read (the snapshots are the bulk of every row and are not needed here).
  const sh = sheet_('Reports'), last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, T.Reports.indexOf(col) + 1, last - 1, 1).getValues().forEach(row => {
    let visits; try { visits = JSON.parse(row[0] || '[]'); } catch (e) { return; }
    visits.forEach(v => {
      const key = kind === 'fac' ? (v.facilityId || (v.workplaceId ? 'wp:' + v.workplaceId : '')) : kind === 'wp' ? (v.workplaceId || (v.name + '|' + (v.place || ''))) : v.name;
      if (key) counts[key] = (counts[key] || 0) + 1;
    });
  });
  cachePutLarge_('uc_' + kind, JSON.stringify(counts), 1800);
  return counts;
}
function findReportRow_(match) {
  const hit = reportsLight_().find(match); if (!hit) return null;
  const full = rowObj_('Reports', sheet_('Reports').getRange(hit.rowNo, 1, 1, T.Reports.length).getValues()[0]);
  if (String(full.id) !== String(hit.id)) { const f = dbAll_('Reports').find(x => String(x.id) === String(hit.id)); return f ? { r: f, rowNo: 0 } : null; } // rows shifted: safe fallback
  return { r: full, rowNo: hit.rowNo };
}
function findReport_(match) { const x = findReportRow_(match); return x && x.r; }
// A report whose id is known: ONE TextFinder call on the id column (exact, case-sensitive) instead of the 3-column index,
// then that single row. The row's id is re-checked, so a wrong match can never be returned.
function findReportRowById_(id) {
  id = String(id == null ? '' : id); if (!id) return null;
  const sh = sheet_('Reports'), last = sh.getLastRow(); if (last < 2) return null;
  const cell = sh.getRange(2, 1, last - 1, 1).createTextFinder(id).matchEntireCell(true).matchCase(true).findNext();
  if (!cell) return null;
  const rowNo = cell.getRow(), r = rowObj_('Reports', sh.getRange(rowNo, 1, 1, T.Reports.length).getValues()[0]);
  return String(r.id) === id ? { r: r, rowNo: rowNo } : null;
}
function findReportById_(id) { const x = findReportRowById_(id); return x && x.r; }
// Writes only the listed columns of a known row (adjacent columns in one call) after confirming the row still holds this
// record. Used where a full-row upsert would rewrite the large JSON cells for nothing.
function dbWriteCells_(n, rowNo, key, o, cols) {
  const sh = sheet_(n), H = T[n], ki = H.indexOf(key);
  if (String(sh.getRange(rowNo, ki + 1).getValue()) !== String(o[key])) throw new Error('تغيّر موضع السجل أثناء الحفظ. أعد المحاولة.');
  const idx = cols.map(c => H.indexOf(c)).filter(i => i >= 0).sort((a, b) => a - b);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    sh.getRange(rowNo, idx[i] + 1, 1, j - i + 1).setValues([idx.slice(i, j + 1).map(k => o[H[k]] === undefined ? '' : o[H[k]])]);
    i = j + 1;
  }
  dropTableCache_(n); if (_RM) delete _RM[n];
}
// Reference tables used to validate a visit and judge its GPS. Cached for 2 minutes, but ONLY the report save/submit path
// reads them from the cache (ID generation and admin screens always read the sheet), and every write through
// dbAppend_/dbUpsert_ drops the table's cache at once.
// Facility model V2: doctor visits need only Doctors + DoctorWorkplaces + Facilities. FacilityLocations stays for pharmacy
// references (unchanged), DoctorPlaces is no longer read.
// Versioned key: rows cached by the previous deployment (old column layout) are never read by this one.
const TABLE_CACHE = 'm2_';
const VALIDATION_TABLES = ['Doctors', 'DoctorWorkplaces', 'Pharmacies', 'Facilities', 'FacilityLocations'];
function dropTableCache_(n) {
  if (n === 'Leaves' || n === 'Holidays') { dropOffCache_(); return; } // every app write to them goes through dbAppend_/dbUpsert_
  if (VALIDATION_TABLES.indexOf(n) < 0) return;
  const keys = [TABLE_CACHE + n]; for (let i = 0; i < LARGE_MAX_CHUNKS; i++) keys.push(TABLE_CACHE + n + '_' + i);
  try { CacheService.getScriptCache().removeAll(keys); } catch (e) {}
}
function cachedTable_(n) {
  const hit = cacheGetLarge_(TABLE_CACHE + n);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const rows = dbAllRaw_(n);
  cachePutLarge_(TABLE_CACHE + n, JSON.stringify(rows), 120);
  return rows;
}
function dbAppend_(n, o) { dropTableCache_(n); if (_RM) delete _RM[n]; sheet_(n).appendRow(T[n].map(c => o[c] === undefined ? '' : o[c])); }
// Upsert reads only the key column, then just the matching row (not the whole sheet).
function dbUpsert_(n, key, o) {
  dropTableCache_(n);
  if (_RM) delete _RM[n];
  const sh = sheet_(n), ki = T[n].indexOf(key), last = sh.getLastRow();
  if (last >= 2) {
    const ids = sh.getRange(2, ki + 1, last - 1, 1).getValues(), whole = T[n].every(c => o[c] !== undefined);
    for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(o[key])) {
      const rowNo = i + 2, cur = whole ? null : sh.getRange(rowNo, 1, 1, T[n].length).getValues()[0]; // a complete row needs no read
      sh.getRange(rowNo, 1, 1, T[n].length).setValues([T[n].map((c, j) => o[c] === undefined ? cur[j] : o[c])]); return;
    }
  }
  dbAppend_(n, o);
}
