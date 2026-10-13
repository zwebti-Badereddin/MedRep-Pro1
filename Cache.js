// MedRep Pro — long-lived caches: lookups for the app, rep names, manual refresh and the cache-warming trigger.

/* ---------- bootstrap: lookups + settings for the UI (nothing hardcoded client-side) ---------- */
// CacheService values are limited to 100KB: large JSON is split into chunks (30k chars keeps Arabic text under the limit).
const LARGE_CHUNK = 30000, LARGE_MAX_CHUNKS = 20;
function cacheGetLarge_(key) {
  const c = CacheService.getScriptCache(), n = +c.get(key);
  if (!(n >= 1 && n <= LARGE_MAX_CHUNKS)) return null;
  const keys = []; for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  const parts = c.getAll(keys), out = [];
  for (let i = 0; i < n; i++) { const x = parts[key + '_' + i]; if (x == null) return null; out.push(x); }
  return out.join('');
}
function cachePutLarge_(key, str, sec) {
  const n = Math.ceil(str.length / LARGE_CHUNK); if (n < 1 || n > LARGE_MAX_CHUNKS) return false;
  const all = {}; for (let i = 0; i < n; i++) all[key + '_' + i] = str.slice(i * LARGE_CHUNK, (i + 1) * LARGE_CHUNK);
  all[key] = String(n);
  try { CacheService.getScriptCache().putAll(all, sec); return true; } catch (e) { return false; }
}
// V2 lookups use their own cache key: a value cached by the previous (workplace-based) deployment can never be served as V2.
const LOOKUPS_KEY = 'lk2';
// Lookups and settings change only through the app, and every such write calls clearCache_(), so they can be cached for the
// CacheService maximum (6 h). A manual edit in the sheet shows after 6 h, or at once via the menu item refreshAppCache.
const CACHE_LONG_SEC = 21600;
function lookups_() {
  const hit = cacheGetLarge_(LOOKUPS_KEY); if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  return readScope_(lookupsBuild_); // each sheet read once (Doctors and Settings are also read by specialtyList_)
}
function lookupsBuild_() {
  requireFacilityV2_();
  const act = r => String(r.active) !== 'false';
  // Facility choices come straight from Facilities (one row per facility, shared by all doctors). Pharmacy facilities are separate.
  const allFacilities = dbAll_('Facilities');
  const facilities = allFacilities.filter(f => f.legacyEntity !== 'Pharmacies' && !f.mergedInto && f.status !== 'معطل')
    .map(f => ({ id: f.id, workplace: f.name, type: f.type, active: true, reviewed: facilityApproved_(f) }));
  const live = {}; facilities.forEach(f => { live[f.id] = f; });
  // Each doctor carries the facilities he is linked to (approved or awaiting approval). GPS coordinates stay server-side.
  const byDoctor = {};
  dbAll_('DoctorWorkplaces').forEach(w => {
    if (!act(w) || !w.doctorId || w.linkState === LINK_REJECTED) return;
    const f = facilityById_(w.facilityId, allFacilities), item = f && live[f.id];
    if (!item) return;
    const seen = (byDoctor[w.doctorId] || []).find(x => x.id === item.id);
    if (seen) { seen.linked = seen.linked || linkApproved_(w); return; }
    (byDoctor[w.doctorId] = byDoctor[w.doctorId] || []).push({ id: item.id, workplace: item.workplace, reviewed: item.reviewed, linked: linkApproved_(w) });
  });
  const v = {
    facilities: facilities,
    doctors: dbAll_('Doctors').filter(act).map(r => ({ id: r.id, name: r.name, specialty: r.specialty, workplace: r.workplace, sector: r.sector, active: r.active, workplaces: byDoctor[r.id] || [] })),
    pharmacies: dbAll_('Pharmacies').filter(act).map(r => ({ id: r.id, name: r.name, location: r.location, nearFacility: r.nearFacility, active: r.active })),
    products: dbAll_('Products').filter(r => r.status !== 'متوقف').map(r => ({ id: r.id, name: r.name, category: r.category, status: r.status })),
    specialties: specialtyList_()
  };
  cachePutLarge_(LOOKUPS_KEY, JSON.stringify(v), CACHE_LONG_SEC);
  return v;
}
function clearCache_() {
  _ST = null;
  const keys = ['st', 'lk', LOOKUPS_KEY, 'dwp_ok', REP_NAMES_KEY, LICENSE_KEY];
  for (let i = 0; i < LARGE_MAX_CHUNKS; i++) keys.push('lk_' + i, LOOKUPS_KEY + '_' + i, REP_NAMES_KEY + '_' + i);
  VALIDATION_TABLES.forEach(n => { keys.push(TABLE_CACHE + n); for (let i = 0; i < LARGE_MAX_CHUNKS; i++) keys.push(TABLE_CACHE + n + '_' + i); });
  CacheService.getScriptCache().removeAll(keys);
}
function bootstrap_(s) {
  const lk = lookups_();
  return {
    settings: (function () { const x = settings_(); if (s.role !== 'admin') { delete x.reportEmail; delete x.gpsRadius; delete x.gpsRefAcc; } return x; })(), statuses: STATUS,
    reps: s.role === 'admin' ? dbAll_('Reps').map(r => ({ id: r.id, name: r.name })) : null,
    doctors: lk.doctors,
    facilities: lk.facilities || [], pharmacies: lk.pharmacies, products: lk.products, specialties: lk.specialties || [],
    rep: s.role === 'rep' ? { id: s.uid, name: s.name } : null,
    license: licenseForClient_(s)
  };
}
// Filters: repId, from, to, no, status, q (doctor / pharmacy / product text search)
// Rep id -> name, cached with the other long-lived lookups (every rep change goes through saveEntity_, which clears it).
const REP_NAMES_KEY = 'repn';
function repNames_() {
  const hit = cacheGetLarge_(REP_NAMES_KEY); if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const reps = {}; dbAll_('Reps').forEach(r => { reps[r.id] = r.name; });
  cachePutLarge_(REP_NAMES_KEY, JSON.stringify(reps), CACHE_LONG_SEC);
  return reps;
}
// Owner-only (menu): after editing master data directly in the sheet, drop the long-lived caches so the app shows it at once.
function refreshAppCache() {
  ownerOnly_();
  clearCache_(); dropOffCache_();
  const c = CacheService.getScriptCache(), keys = ['v2_ok', 'uc_fac', 'uc_wp', 'uc_doctors', 'uc_pharmacies'];
  keys.slice(1).forEach(k => { for (let i = 0; i < LARGE_MAX_CHUNKS; i++) keys.push(k + '_' + i); });
  c.removeAll(keys);
  try { SpreadsheetApp.getUi().alert('تم تحديث بيانات التطبيق. ستظهر التعديلات عند الدخول التالي.'); } catch (e) {} // also runnable from the editor
  return true;
}
// Cache warming: an in-app change clears the lookups, and the first rep to log in afterwards would rebuild them (~4 s).
// A time trigger rebuilds them every 10 minutes when missing; when they are cached the run costs a few cache reads only.
const WARM_HANDLER = 'warmCachesTriggerHandler', WARM_EVERY_MIN = 10;
function warmCaches_() {
  const t = Date.now(), wasCached = !!cacheGetLarge_(LOOKUPS_KEY);
  lookups_(); settings_(); offData_(); repNames_();
  return { lookupsWereCached: wasCached, ms: Date.now() - t };
}
// Public because triggers can only call top-level functions; it refuses any caller but its own installed trigger.
function warmCachesTriggerHandler(e) {
  const uid = e && e.triggerUid != null ? String(e.triggerUid) : '';
  if (!uid || !ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === WARM_HANDLER && String(t.getUniqueId()) === uid))
    throw new Error('تشغيل مرفوض: هذا المعالج مخصص للمشغّل المثبّت فقط.');
  return warmCaches_();
}
function installCacheWarmTrigger() {
  ownerOnly_();
  const old = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === WARM_HANDLER);
  old.forEach(t => ScriptApp.deleteTrigger(t));
  const trigger = ScriptApp.newTrigger(WARM_HANDLER).timeBased().everyMinutes(WARM_EVERY_MIN).create();
  const first = warmCaches_();
  try { SpreadsheetApp.getUi().alert('تم تفعيل تجهيز بيانات التطبيق تلقائيًا كل ' + WARM_EVERY_MIN + ' دقائق.'); } catch (err) {}
  return { installed: true, replaced: old.length, triggerId: trigger.getUniqueId(), everyMinutes: WARM_EVERY_MIN, firstRun: first };
}
