// MedRep Pro — license period: a warning before the end date, a short grace period, then no new reports (data stays readable).

/*
 * Script Properties (owner only; the company never sees them, no redeploy needed to change them):
 *   LICENSE_UNTIL       last licensed day, YYYY-MM-DD. Absent = no license limit (the app behaves as before).
 *   LICENSE_WARN_DAYS   days before LICENSE_UNTIL the admin sees a warning (default 14).
 *   LICENSE_GRACE_DAYS  days after LICENSE_UNTIL work continues with a notice (default 3).
 * After the grace period the routes in LICENSE_WRITE_ROUTES are refused. Login, reading, review and export keep working,
 * and no data is ever deleted. Changes apply within LICENSE_CACHE_SEC, or at once after refreshAppCache.
 */
const LICENSE_WRITE_ROUTES = ['saveReport', 'submitReport', 'reopenReport', 'proposeFacility', 'requestDoctorLink', 'addDoctor', 'addPharmacy', 'addSpecialty'];
const LICENSE_KEY = 'lic', LICENSE_CACHE_SEC = 600;
const LICENSE_EXPIRED_MSG = 'انتهى ترخيص النظام، ولا يمكن إنشاء التقارير أو تعديلها حتى التجديد. راجع الإدارة.';

// Pure: state of the license on day `today` (both YYYY-MM-DD).
function licenseState_(until, today, warnDays, graceDays) {
  const u = String(until || '').trim();
  if (!u) return { state: 'none' };
  const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
  if (!okDate(u)) return { state: 'invalid', until: u };
  const num = (v, d) => { const n = parseInt(v, 10); return n >= 0 ? n : d; }, warn = num(warnDays, 14), grace = num(graceDays, 3);
  const days = Math.round((Date.parse(u + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
  const graceEnd = new Date(Date.parse(u + 'T00:00:00Z') + grace * 864e5).toISOString().slice(0, 10);
  const state = days > warn ? 'ok' : days >= 0 ? 'warn' : days >= -grace ? 'grace' : 'expired';
  return { state: state, until: u, days: days, graceEnd: graceEnd };
}
function licenseProps_() {
  const cache = CacheService.getScriptCache(), hit = cache.get(LICENSE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const sp = PropertiesService.getScriptProperties();
  const o = { until: sp.getProperty('LICENSE_UNTIL') || '', warn: sp.getProperty('LICENSE_WARN_DAYS') || '', grace: sp.getProperty('LICENSE_GRACE_DAYS') || '',
    support: sp.getProperty('SUPPORT_CONTACT') || '' };
  cache.put(LICENSE_KEY, JSON.stringify(o), LICENSE_CACHE_SEC);
  return o;
}
function license_() { const p = licenseProps_(); return licenseState_(p.until, today_(), p.warn, p.grace); }
function licenseGuard_(action) {
  if (LICENSE_WRITE_ROUTES.indexOf(action) >= 0 && license_().state === 'expired') throw new Error(LICENSE_EXPIRED_MSG);
}
// What the client may know: the admin sees the dates; a rep only learns that the license has ended.
function licenseForClient_(s) {
  const l = license_();
  if (s.role === 'admin') return l.state === 'none' || l.state === 'invalid' ? null : l;
  return l.state === 'expired' ? { state: 'expired' } : null;
}
