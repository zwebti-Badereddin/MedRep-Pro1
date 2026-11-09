// MedRep Pro — market information recorded during visits: competitor notes (doctor and pharmacy visits), our products' stock
// and nearest expiry in a pharmacy, and the pharmacy order as product × quantity. Cleaned on the server like every visit field;
// summed for the admin (competitor summary, pharmacy alerts), the English report and the Telegram summary.

const COMP_TYPES = { price: 'سعر أقل', promo: 'عرض أو بونص', objection: 'اعتراض', shortage: 'نقص منتجنا', other: 'غير ذلك' };
const STOCK_STATES = { ok: 'متوفر', low: 'قليل', out: 'نفد' };
const MARKET_EXPIRY_DAYS = 90;

/* ---------- cleaning (called from prepareReport_ for every visit) ---------- */
function cleanVisitExtras_(o, v, kind) {
  const txt = (x, n) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
  const comp = (Array.isArray(v.comp) ? v.comp : []).slice(0, 5).map(c => ({ p: txt(c && c.p, 60), t: COMP_TYPES[c && c.t] ? c.t : 'other', n: txt(c && c.n, 200) }))
    .filter(c => c.p.length >= 2).map(c => (c.n ? c : { p: c.p, t: c.t }));
  if (comp.length) o.comp = comp; else delete o.comp;
  if (kind === 'doctor') cleanPlanFields_(o, v); else { delete o.planId; delete o.fb; } // daily plan link and feedback (DayPlan.js)
  if (kind !== 'pharmacy') { delete o.stock; delete o.orderItems; return; }
  const stock = (Array.isArray(v.stock) ? v.stock : []).slice(0, 20).map(s => {
    const r = { product: txt(s && s.product, 80), st: STOCK_STATES[s && s.st] ? s.st : 'ok' };
    const q = Math.round(+(s && s.qty)); if (isFinite(q) && q >= 0 && q <= 100000 && s && s.qty !== '' && s.qty != null) r.qty = q;
    const e = String((s && s.exp) || ''); if (/^20\d\d-(0[1-9]|1[0-2])$/.test(e)) r.exp = e;
    return r;
  }).filter(s => s.product && s.product !== '—');
  if (stock.length) o.stock = stock; else delete o.stock;
  const items = (Array.isArray(v.orderItems) ? v.orderItems : []).slice(0, 20).map(x => ({ product: txt(x && x.product, 80), qty: Math.round(+(x && x.qty)) }))
    .filter(x => x.product && x.product !== '—' && x.qty >= 1 && x.qty <= 100000);
  if (items.length) o.orderItems = items; else delete o.orderItems;
}
// An expiry 'YYYY-MM' counts as the last day of that month.
function marketExpiryDays_(exp, now) {
  const y = +exp.slice(0, 4), m = +exp.slice(5, 7);
  return Math.floor((Date.UTC(y, m, 0) - now) / 864e5);
}
function marketVisits_(from, to) {
  const rows = reportsLight_().filter(r => r.date >= from && r.date <= to && ['مرسل', 'معتمد'].indexOf(r.status) >= 0);
  const cols = reportVisitColumns_(rows), names = repNames_();
  return rows.map(r => ({ r: r, rep: names[r.repId] || r.repId, docs: cols[r.id].doctors, phs: cols[r.id].pharmacies }));
}

/* ---------- admin: competitor summary for a period (sent and approved reports) ---------- */
function compSummary_(s, p) {
  const per = planPeriod_(p), list = [];
  marketVisits_(per.from, per.to).forEach(x => {
    x.docs.concat(x.phs).forEach((v, i) => (v.comp || []).forEach(c => list.push({ date: x.r.date, rep: x.rep, where: v.name, kind: i < x.docs.length ? 'طبيب' : 'صيدلية',
      product: c.p, type: c.t, typeName: COMP_TYPES[c.t] || COMP_TYPES.other, note: c.n || '' })));
  });
  const by = {};
  list.forEach(c => {
    const k = normName_(c.product) || c.product, b = by[k] || (by[k] = { product: c.product, count: 0, types: {} });
    b.count++; b.types[c.typeName] = (b.types[c.typeName] || 0) + 1;
  });
  const products = Object.keys(by).map(k => by[k]).sort((a, b) => b.count - a.count);
  const types = {}; list.forEach(c => { types[c.typeName] = (types[c.typeName] || 0) + 1; });
  return { from: per.from, to: per.to, total: list.length, products: products, types: types, items: list.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 500) };
}

/* ---------- admin: pharmacy alerts — the latest observation per pharmacy × product: out of stock, or expiry within 90 days ---------- */
function pharmAlerts_(s, p) {
  const per = planPeriod_(Object.assign({ from: Utilities.formatDate(new Date(Date.now() - 30 * 864e5), 'UTC', 'yyyy-MM-dd') }, p)), latest = {}, now = Date.now();
  marketVisits_(per.from, per.to).forEach(x => x.phs.forEach(v => (v.stock || []).forEach(st => {
    const k = (v.pharmacyId || normName_(v.name)) + '|' + st.product, cur = latest[k];
    if (!cur || x.r.date >= cur.date) latest[k] = { key: k, date: x.r.date, rep: x.rep, pharmacy: v.name, loc: v.loc || '', product: st.product, st: st.st, qty: st.qty, exp: st.exp || '' };
  })));
  const alerts = [], acks = pharmAcks_(), done = [];
  Object.keys(latest).forEach(k => {
    const a = latest[k], days = a.exp ? marketExpiryDays_(a.exp, now) : null, reasons = [];
    if (a.st === 'out') reasons.push('نفد');
    if (days != null && days <= MARKET_EXPIRY_DAYS) reasons.push(days < 0 ? 'منتهي الصلاحية' : 'صلاحية خلال ' + days + ' يومًا');
    if (!reasons.length) return;
    Object.assign(a, { stName: STOCK_STATES[a.st], reasons: reasons, days: days });
    const ack = acks[k]; // «تم التوفير» covers observations up to its date; a newer one brings the alert back
    if (ack && ack.date && a.date <= String(ack.date)) done.push(Object.assign(a, { ackBy: ack.byName || ack.by, ackAt: ack.at })); else alerts.push(a);
  });
  return { from: per.from, to: per.to, done: done.sort((a, b) => (a.ackAt < b.ackAt ? 1 : -1)).slice(0, 30), alerts: alerts.sort((a, b) => (a.st === 'out' ? 0 : 1) - (b.st === 'out' ? 0 : 1) || (a.days == null ? 999 : a.days) - (b.days == null ? 999 : b.days)) };
}
function pharmAcks_() {
  const out = {};
  try { ensureSheet_('PharmAck'); dbAll_('PharmAck').forEach(r => { out[String(r.key)] = r; }); } catch (e) {}
  return out;
}
// «تم التوفير»: the admin confirms the pharmacy was supplied (undo: p.undo). Returns the refreshed alerts for the same period.
function pharmAlertAck_(s, p) {
  const key = String(p.key || '').slice(0, 300), obs = String(p.date || '');
  if (!key || key.indexOf('|') < 0) throw new Error('تنبيه غير معروف.');
  if (!p.undo && !/^\d{4}-\d{2}-\d{2}$/.test(obs)) throw new Error('تاريخ الملاحظة غير صحيح.');
  ensureSheet_('PharmAck');
  const lock = acquireLock_(20000);
  try {
    dbUpsert_('PharmAck', 'key', { key: key, pharmacy: String(p.pharmacy || '').slice(0, 120), product: String(p.product || '').slice(0, 120),
      date: p.undo ? '' : obs, by: s.uid, byName: s.name || '', at: new Date().toISOString() });
    audit_(s, p.undo ? 'pharm_ack_undo' : 'pharm_ack', key, obs);
  } finally { lock.releaseLock(); }
  try { CacheService.getScriptCache().remove('navc_admin'); } catch (e) {}
  return pharmAlerts_(s, { from: p.from, to: p.to });
}
function pharmAlertText_() {
  try { const a = pharmAlerts_(null, {}).alerts; return a.length ? a.length + ' (' + a.slice(0, 3).map(x => x.pharmacy + ': ' + x.product + ' ' + x.reasons[0]).join('، ') + (a.length > 3 ? '…' : '') + ')' : ''; }
  catch (e) { return ''; }
}
// Visit-level text for the export (same wording as the report).
function compText_(v) { return (v.comp || []).map(c => c.p + ' (' + (COMP_TYPES[c.t] || COMP_TYPES.other) + ')' + (c.n ? ': ' + c.n : '')).join(' · '); }
function stockText_(v) { return (v.stock || []).map(s => s.product + ': ' + STOCK_STATES[s.st] + (s.qty != null ? ' (' + s.qty + ')' : '') + (s.exp ? ' صلاحية ' + s.exp : '')).join(' · '); }
function orderItemsText_(v) { return (v.orderItems || []).map(x => x.product + ' ×' + x.qty).join(' · '); }
