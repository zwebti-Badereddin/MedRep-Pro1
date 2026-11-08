// MedRep Pro — visit check-in / check-out. Opening a new visit (today's report) records the check-in on the phone (time + first
// GPS fix, kept on the device so it survives closing the form or the app); saving the visit records the check-out (time + GPS).
// The server keeps only well-formed points and computes the duration itself. Flags are warnings for the reviewer, never a block:
// very short, unusually long, check-out far from check-in, phone clock off, overlapping another visit of the same report.

const VT_SHORT_MIN = 2, VT_LONG_MIN = 120, VT_FAR_M = 200, VT_SKEW_MIN = 5, VT_MAX_MS = 24 * 3600e3;

function vtPoint_(x) {
  if (!x || typeof x !== 'object') return null;
  const t = Date.parse(x.t); if (!isFinite(t)) return null;
  const o = { t: new Date(t).toISOString() };
  if (typeof x.lat === 'number' && typeof x.lng === 'number' && gpsPointValidServer_(x.lat, x.lng)) {
    o.lat = x.lat; o.lng = x.lng; o.acc = Math.max(0, Math.min(5000, Math.round(+x.acc) || 0));
  }
  return o;
}
// o = the visit being stored, v = as sent, prev = the stored visits of this report, skewMin = server − phone clock (minutes) or null.
// A visit already stored with the same times keeps its clock mark; the duration is never taken from the phone.
function vtClean_(o, v, prev, skewMin) {
  delete o.ci; delete o.co; delete o.dur; delete o.sk;
  const ci = vtPoint_(v.ci), co = vtPoint_(v.co); if (!ci || !co) return;
  const ms = Date.parse(co.t) - Date.parse(ci.t); if (ms < 0 || ms > VT_MAX_MS) return;
  o.ci = ci; o.co = co; o.dur = Math.round(ms / 60000);
  const pv = (prev || []).find(x => x && x.ci && x.co && x.ci.t === ci.t && x.co.t === co.t);
  if (pv) { if (pv.sk) o.sk = pv.sk; }
  else if (skewMin != null && Math.abs(skewMin) >= VT_SKEW_MIN) o.sk = skewMin;
}
// Warnings for one visit; all = every visit of the same report (for overlaps).
function vtFlags_(v, all) {
  if (!v || !v.ci || !v.co) return [];
  const out = [], a = Date.parse(v.ci.t), b = Date.parse(v.co.t);
  if (v.dur < VT_SHORT_MIN) out.push('زيارة قصيرة جدًا');
  if (v.dur > VT_LONG_MIN) out.push('مدة طويلة غير معتادة');
  if (typeof v.ci.lat === 'number' && typeof v.co.lat === 'number') {
    const d = Math.round(dist_(v.ci.lat, v.ci.lng, v.co.lat, v.co.lng));
    if (d > Math.max(VT_FAR_M, (v.ci.acc || 0) + (v.co.acc || 0))) out.push('الخروج بعيد عن الدخول (' + d + ' م)');
  }
  if (v.sk) out.push('ساعة الهاتف غير دقيقة (' + Math.abs(v.sk) + ' د)');
  if ((all || []).some(x => x !== v && x && x.ci && x.co && Math.min(b, Date.parse(x.co.t)) - Math.max(a, Date.parse(x.ci.t)) > 60000)) out.push('متداخلة مع زيارة أخرى');
  return out;
}
function vtClock_(t, tz) { return t ? Utilities.formatDate(new Date(t), tz, 'HH:mm') : ''; }
