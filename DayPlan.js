// MedRep Pro — daily visit plans set by a supervisor or an admin: for a rep and a date, the doctors to visit, with the product,
// the purpose (introduce / remind / get the doctor's feedback) and a note. A rep with no plan sees nothing new; with a plan, the
// home screen lists it and a visit opened from it carries the doctor, the product and the plan item (planId). An item is done
// when that day's report has a visit to the doctor; the rep can mark it «تعذّرت» with a reason. Visits outside the plan stay
// allowed. Feedback (positive / neutral / negative + comment) is stored on the visit and summed per product.

const DP_PURPOSE = { intro: 'تعريف', remind: 'تذكير', feedback: 'أخذ انطباع' };
const FB_RATE = { pos: 'إيجابي', neu: 'محايد', neg: 'سلبي' };
const DP_AHEAD_DAYS = 2, DP_ID_RE = /^DP-[A-Z0-9]{10}$/;

function dpRows_() { ensureSheet_('DayPlans'); return dbAll_('DayPlans').filter(r => String(r.active) !== 'false'); }
const dpAddDays_ = (d, n) => Utilities.formatDate(new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5), 'UTC', 'yyyy-MM-dd');

// Status of each item from the rep's report of that date (any status: the visit happened even if the report is a draft).
function dpWithStatus_(items) {
  if (!items.length) return [];
  const want = {}; items.forEach(i => { want[i.repId + '|' + i.date] = 1; });
  const rows = reportsLight_().filter(r => want[r.repId + '|' + r.date]), cols = reportVisitColumns_(rows), byKey = {};
  rows.forEach(r => { byKey[r.repId + '|' + r.date] = cols[r.id].doctors; });
  let sch = null; try { sch = docSchedules_(null, {}); } catch (e) {} // the doctor's work schedule (Schedule.js), when he has one
  return items.map(i => {
    const w = sch ? schOnDate_(sch, i.doctorId, i.date) : null;
    const visits = byKey[i.repId + '|' + i.date] || [], v = visits.find(x => x.planId === i.id) || visits.find(x => String(x.doctorId) === String(i.doctorId)) ||
      visits.find(x => !x.doctorId && normName_(x.name) === normName_(i.doctorName)); // older visits without the doctor's id
    const status = v ? 'done' : i.status === 'failed' ? 'failed' : 'pending';
    return { id: i.id, repId: i.repId, date: i.date, doctorId: i.doctorId, doctorName: i.doctorName, specialty: i.specialty, product: i.product,
      purpose: i.purpose, purposeName: DP_PURPOSE[i.purpose] || '', note: i.note, status: status, reason: status === 'failed' ? i.reason : '',
      fb: v && v.fb ? v.fb : null, time: v && v.ci ? v.ci.t : '', schedOff: !!(w && w.off), schedAbsent: !!(w && w.absent), schedWhere: w ? w.where : '' };
  });
}

/* ---------- admin / supervisor ---------- */
function dayPlanAdd_(s, p) {
  ensureSheet_('DayPlans');
  const rep = dbAll_('Reps').find(r => String(r.id) === String(p.repId) && String(r.active) !== 'false'); if (!rep) throw new Error('المندوب غير موجود.');
  if (!isDate_(p.date)) throw new Error('اختر تاريخ الخطة.');
  if (p.date < today_()) throw new Error('لا يمكن إضافة خطة ليوم مضى.');
  const doc = dbAll_('Doctors').find(d => String(d.id) === String(p.doctorId) && String(d.active) !== 'false'); if (!doc) throw new Error('الطبيب غير موجود في السجل.');
  const product = String(p.product || '').trim();
  if (product && !dbAll_('Products').some(x => String(x.name).trim() === product)) throw new Error('المنتج غير موجود في قائمة المنتجات.');
  const purpose = DP_PURPOSE[p.purpose] ? p.purpose : 'intro';
  if (purpose === 'feedback' && !product) throw new Error('اختر المنتج المطلوب أخذ انطباع الطبيب عنه.');
  const note = String(p.note || '').replace(/\s+/g, ' ').trim().slice(0, 300), now = new Date().toISOString();
  const lock = acquireLock_(20000);
  try {
    const cur = dpRows_().find(r => String(r.repId) === String(rep.id) && r.date === p.date && String(r.doctorId) === String(doc.id));
    const o = Object.assign({}, cur || { id: 'DP-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase(), repId: rep.id, date: p.date, doctorId: doc.id, createdAt: now, createdBy: s.uid, status: '', reason: '' },
      { doctorName: doc.name, specialty: doc.specialty || '', product: product, purpose: purpose, note: note, active: true, updatedAt: now });
    if (cur) dbUpsert_('DayPlans', 'id', o); else dbAppend_('DayPlans', o);
    audit_(s, 'dayplan_add', rep.id + ' ' + p.date + ' ' + doc.id, purpose);
    return dpWithStatus_([o])[0];
  } finally { lock.releaseLock(); }
}
function dayPlanDelete_(s, p) {
  const r = dpRows_().find(x => x.id === p.id); if (!r) throw new Error('البند غير موجود.');
  dbUpsert_('DayPlans', 'id', Object.assign({}, r, { active: false, updatedAt: new Date().toISOString() }));
  audit_(s, 'dayplan_delete', r.repId + ' ' + r.date + ' ' + r.doctorId);
  return true;
}
// Copy one rep's plan of a day to another rep and/or day (items already there are kept).
function dayPlanCopy_(s, p) {
  if (!isDate_(p.toDate) || p.toDate < today_()) throw new Error('اختر يومًا قادمًا للنسخ إليه.');
  const from = dpRows_().filter(r => String(r.repId) === String(p.fromRep) && r.date === p.fromDate); if (!from.length) throw new Error('لا توجد خطة لنسخها.');
  let n = 0;
  from.forEach(r => { try { dayPlanAdd_(s, { repId: p.toRep || r.repId, date: p.toDate, doctorId: r.doctorId, product: r.product, purpose: r.purpose, note: r.note }); n++; } catch (e) {} });
  return n;
}
function dayPlanList_(s, p) {
  const from = isDate_(p.from) ? p.from : today_(), to = isDate_(p.to) ? p.to : from;
  const names = repNames_();
  return dpWithStatus_(dpRows_().filter(r => r.date >= from && r.date <= to && (!p.repId || String(r.repId) === String(p.repId))))
    .map(i => Object.assign(i, { repName: names[i.repId] || i.repId })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.repName).localeCompare(String(b.repName), 'ar')));
}
// Telegram to the rep: the day's plan as a list.
function dayPlanNotify_(s, p) {
  const items = dpRows_().filter(r => String(r.repId) === String(p.repId) && r.date === p.date); if (!items.length) throw new Error('لا توجد خطة لهذا اليوم.');
  const text = '🗓️ خطة زيارات ليوم ' + p.date.split('-').reverse().join('/') + ' من ' + (s.name || 'الإدارة') + ':\n' +
    items.map((r, i) => (i + 1) + '. ' + r.doctorName + (r.specialty ? ' (' + r.specialty + ')' : '') + (r.product ? ' — ' + (DP_PURPOSE[r.purpose] || '') + ': ' + r.product : '') + (r.note ? '\n   ' + r.note : '')).join('\n') +
    '\nتجدها في الصفحة الرئيسية لـ MedRep Pro.';
  const n = tgNotifyUser_(p.repId, text);
  audit_(s, 'dayplan_notify', p.repId + ' ' + p.date, String(n));
  return n;
}

/* ---------- rep ---------- */
function myDayPlan_(s) {
  const td = today_(), to = dpAddDays_(td, DP_AHEAD_DAYS), y = yesterday_();
  return dpWithStatus_(dpRows_().filter(r => String(r.repId) === String(s.uid) && r.date >= y && r.date <= to));
}
function dayPlanFail_(s, p) {
  const r = dpRows_().find(x => x.id === p.id && String(x.repId) === String(s.uid)); if (!r) throw new Error('البند غير موجود.');
  const reason = String(p.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (p.undo) dbUpsert_('DayPlans', 'id', Object.assign({}, r, { status: '', reason: '', updatedAt: new Date().toISOString() }));
  else {
    if (reason.length < 3) throw new Error('اكتب سبب تعذّر الزيارة.');
    dbUpsert_('DayPlans', 'id', Object.assign({}, r, { status: 'failed', reason: reason, updatedAt: new Date().toISOString() }));
  }
  audit_(s, p.undo ? 'dayplan_undo' : 'dayplan_failed', r.id, reason);
  return myDayPlan_(s);
}

/* ---------- visit fields (from cleanVisitExtras_) and the feedback summary ---------- */
function cleanPlanFields_(o, v) {
  if (DP_ID_RE.test(String(v.planId || ''))) o.planId = String(v.planId); else delete o.planId;
  const fb = v.fb && typeof v.fb === 'object' ? v.fb : null, product = fb ? String(fb.product || '').trim().slice(0, 80) : '';
  if (fb && product && FB_RATE[fb.r]) { o.fb = { product: product, r: fb.r }; const n = String(fb.n || '').replace(/\s+/g, ' ').trim().slice(0, 300); if (n) o.fb.n = n; }
  else delete o.fb;
}
function fbText_(v) { return v.fb ? v.fb.product + ': ' + FB_RATE[v.fb.r] + (v.fb.n ? ' — ' + v.fb.n : '') : ''; }
function feedbackSummary_(s, p) {
  const per = planPeriod_(p), by = {}, items = [];
  marketVisits_(per.from, per.to).forEach(x => x.docs.forEach(v => {
    if (!v.fb) return;
    const b = by[v.fb.product] || (by[v.fb.product] = { product: v.fb.product, pos: 0, neu: 0, neg: 0, total: 0 });
    b[v.fb.r]++; b.total++;
    items.push({ date: x.r.date, rep: x.rep, doctor: v.name, specialty: v.specialty || '', product: v.fb.product, r: v.fb.r, rName: FB_RATE[v.fb.r], note: v.fb.n || '' });
  }));
  return { from: per.from, to: per.to, products: Object.keys(by).map(k => by[k]).sort((a, b) => b.total - a.total), items: items.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 500) };
}
