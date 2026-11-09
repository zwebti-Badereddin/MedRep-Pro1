// MedRep Pro — counts for the admin / supervisor navigation («بانتظارك» and the badges) and the system status line.
// Cheap reads only, cached 30 seconds per role (the counts refresh as the admin moves between sections).

const NAV_CACHE_SEC = 30;
function navCounts_(s) {
  const key = 'navc_' + s.role, cache = CacheService.getScriptCache(), hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const out = { reports: reportsLight_().filter(r => r.status === 'مرسل').length };
  if (s.role === 'admin') {
    const safe = fn => { try { return fn(); } catch (e) { return 0; } };
    out.plans = safe(() => planRows_().filter(r => r.pendingCls).length);
    out.doctors = safe(() => dbAll_('Doctors').filter(d => d.addedBy && String(d.reviewed) !== 'true' && String(d.active) !== 'false').length);
    out.facilities = safe(() => dbAll_('Facilities').filter(f => f.geoState === 'مراجعة مطلوبة' && !String(f.mergedInto || '').trim() && f.status !== 'معطل').length +
      dbAll_('DoctorWorkplaces').filter(w => w.linkState === 'بانتظار' && String(w.active) !== 'false').length);
    out.stock = safe(() => stockBalances_('').filter(b => b.balance < 0).length);
    out.pharm = safe(() => pharmAlerts_(null, {}).alerts.length);
    out.health = navHealth_();
  }
  try { cache.put(key, JSON.stringify(out), NAV_CACHE_SEC); } catch (e) {}
  return out;
}
// From the vendor fault detector (Health.js): open problems and the time of the last automatic check.
function navHealth_() {
  const p = PropertiesService.getScriptProperties(), last = +p.getProperty(HEALTH_LAST_KEY) || 0;
  let state = {}; try { state = JSON.parse(p.getProperty(HEALTH_STATE_KEY) || '{}'); } catch (e) {}
  const issues = Object.keys(state).length;
  return { last: last ? new Date(last).toISOString() : '', issues: issues, ok: !!last && !issues };
}
