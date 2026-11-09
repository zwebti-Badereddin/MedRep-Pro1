// MedRep Pro — daily visit plans set by a supervisor or an admin: for a rep and a date, the doctors to visit, with the product,
// the purpose (introduce / remind / get the doctor's feedback) and a note. A rep with no plan sees nothing new; with a plan, the
// home screen lists it and a visit opened from it carries the doctor, the product and the plan item (planId). An item is done
// when that day's report has a visit to the doctor; the rep can mark it «تعذّرت» with a reason. Visits outside the plan stay
// allowed. Feedback (positive / neutral / negative + comment) is stored on the visit and summed per product.

const DP_PURPOSE = { intro: 'تعريف', remind: 'تذكير', feedback: 'أخذ انطباع' };
const FB_RATE = { pos: 'إيجابي', neu: 'محايد', neg: 'سلبي' };
const DP_AHEAD_DAYS = 2, DP_ID_RE = /^DP-[A-Z0-9]{10}$/;

function dpRows_() { ensureSheet_('DayPlans'); dpHeader_(); return dbAll_('DayPlans').filter(r => String(r.active) !== 'false'); }
// Sheets made before the draft columns: add their headers once (rows are read by position).
function dpHeader_() {
  try { const sh = sheet_('DayPlans'), n = T.DayPlans.length; if (sh.getLastColumn() < n) sh.getRange(1, 1, 1, n).setValues([T.DayPlans]); } catch (e) {}
}
const dpDraft_ = r => String(r.draft) === 'true';
const dpAddDays_ = (d, n) => Utilities.formatDate(new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5), 'UTC', 'yyyy-MM-dd');
// Dates are always written as the weekday and the date («الثلاثاء · 10 نوفمبر 2026»), never «اليوم» / «غدًا».
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
function dpLong_(d) { const t = new Date(Date.parse(d + 'T12:00:00Z')); return SCH_DAYS[t.getUTCDay()] + ' · ' + t.getUTCDate() + ' ' + AR_MONTHS[t.getUTCMonth()] + ' ' + t.getUTCFullYear(); }
function dpShort_(d) { const t = new Date(Date.parse(d + 'T12:00:00Z')); return SCH_DAYS[t.getUTCDay()] + ' ' + t.getUTCDate() + '/' + (t.getUTCMonth() + 1); }
function dpApptText_(r) { return [SCH_PERIOD[r.period] || '', r.facilityName || ''].filter(Boolean).join(' · '); }
function dpStaffNames_() { const n = {}; ['Admins', 'Supervisors'].forEach(t => { try { dbAll_(t).forEach(x => { n[x.id] = x.name; }); } catch (e) {} }); return n; }
function dpWho_(s) { return s.name && s.name !== s.uid ? s.name : (dpStaffNames_()[s.uid] || 'الإدارة'); }
const dpEdited_ = r => String(r.edited) === 'true';
// Product, purpose and note of an item: a product is required to introduce it or to get the doctor's feedback on it.
function dpFields_(p) {
  const product = String(p.product || '').trim();
  if (product && !dbAll_('Products').some(x => String(x.name).trim() === product)) throw new Error('المنتج غير موجود في قائمة المنتجات.');
  const purpose = DP_PURPOSE[p.purpose] ? p.purpose : 'intro';
  if (purpose === 'feedback' && !product) throw new Error('اختر المنتج المطلوب أخذ انطباع الطبيب عنه.');
  if (purpose === 'intro' && !product) throw new Error('اختر المنتج المراد التعريف به.');
  return { product: product, purpose: purpose, note: String(p.note || '').replace(/\s+/g, ' ').trim().slice(0, 300) };
}

// Status of each item from the rep's report of that date (any status: the visit happened even if the report is a draft).
function dpWithStatus_(items) {
  if (!items.length) return [];
  const want = {}; items.forEach(i => { want[i.repId + '|' + i.date] = 1; });
  const rows = reportsLight_().filter(r => want[r.repId + '|' + r.date]), cols = reportVisitColumns_(rows), byKey = {};
  rows.forEach(r => { byKey[r.repId + '|' + r.date] = cols[r.id].doctors; });
  let sch = null; try { sch = docSchedules_(null, {}); } catch (e) {} // the doctor's work schedule (Schedule.js), when he has one
  const staff = dpStaffNames_();
  return items.map(i => {
    const w = sch ? schOnDate_(sch, i.doctorId, i.date) : null;
    const visits = byKey[i.repId + '|' + i.date] || [], v = visits.find(x => x.planId === i.id) || visits.find(x => String(x.doctorId) === String(i.doctorId)) ||
      visits.find(x => !x.doctorId && normName_(x.name) === normName_(i.doctorName)); // older visits without the doctor's id
    const status = v ? 'done' : i.status === 'failed' ? 'failed' : 'pending';
    return { id: i.id, repId: i.repId, date: i.date, doctorId: i.doctorId, doctorName: i.doctorName, specialty: i.specialty, product: i.product,
      purpose: i.purpose, purposeName: DP_PURPOSE[i.purpose] || '', note: i.note, status: status, reason: status === 'failed' ? i.reason : '',
      fb: v && v.fb ? v.fb : null, time: v && v.ci ? v.ci.t : '', draft: dpDraft_(i),
      period: i.period || '', periodName: SCH_PERIOD[i.period] || '', facilityId: i.facilityId || '', facilityName: i.facilityName || '', repState: i.repState || '', repNote: i.repNote || '', prevAppt: i.prevAppt || '', edited: dpEdited_(i), byName: staff[i.createdBy] || '', schedOff: !!(w && w.off), schedAbsent: !!(w && w.absent), schedWhere: w ? w.where : '' };
  });
}

/* ---------- admin / supervisor ---------- */
function dayPlanAdd_(s, p) {
  ensureSheet_('DayPlans');
  const rep = dbAll_('Reps').find(r => String(r.id) === String(p.repId) && String(r.active) !== 'false'); if (!rep) throw new Error('المندوب غير موجود.');
  const appts = Array.isArray(p.appts) ? p.appts.filter(a => a && typeof a === 'object') : null; // [{ date, period, facilityId }]: one or more appointments
  const dates = Array.from(new Set(appts ? appts.map(a => a.date) : Array.isArray(p.dates) ? p.dates : [p.date])); // one doctor on several days of the plan at once
  if (!dates.length || dates.length > 7 || !dates.every(isDate_)) throw new Error('اختر تاريخ الخطة.');
  if (dates.some(d => d < today_())) throw new Error('لا يمكن إضافة خطة ليوم مضى.');
  const doc = dbAll_('Doctors').find(d => String(d.id) === String(p.doctorId) && String(d.active) !== 'false'); if (!doc) throw new Error('الطبيب غير موجود في السجل.');
  const f = dpFields_(p), product = f.product, purpose = f.purpose, note = f.note, now = new Date().toISOString();
  // The appointment of each day: the period and facility chosen by the supervisor, else taken from the doctor's work schedule for that weekday.
  const facs = dbAll_('Facilities'); let sch = null; try { sch = docSchedules_(null, {}); } catch (e) {}
  const facOf = id => { const x = facilityById_(id, facs); if (!x || x.status === 'معطل') throw new Error('المنشأة غير موجودة في السجل.'); return x; };
  const pickFac = p.facilityId ? facOf(p.facilityId) : null;
  if (appts) appts.forEach(a => { if (a.facilityId) facOf(a.facilityId); });
  const apptFor = date => {
    const a = appts ? appts.filter(x => x.date === date).pop() : null, src = a || p;
    let per = SCH_PERIOD[src.period] ? src.period : '', fac = a ? (a.facilityId ? facOf(a.facilityId) : null) : pickFac;
    if (!per || !fac) {
      const slots = sch && sch.sched[doc.id] ? sch.sched[doc.id].slots.filter(x => x.d === schWeekday_(date)) : [];
      const sl = slots.find(x => (!per || x.p === per || x.p === 'all') && (!fac || String(x.f) === String(fac.id))) || (fac ? null : slots[0]);
      if (sl) { if (!per) per = sl.p; if (!fac) fac = facilityById_(sl.f, facs); }
    }
    return { period: per, facilityId: fac ? String(fac.id) : '', facilityName: fac ? fac.name : '' };
  };
  const lock = acquireLock_(20000);
  try {
    const rows = dpRows_(), out = dates.map(date => {
      const cur = rows.find(r => String(r.repId) === String(rep.id) && r.date === date && String(r.doctorId) === String(doc.id));
      // a new item is a draft until «إرسال الخطة»; editing an item keeps whether the rep already sees it
      const o = Object.assign({}, cur || { id: 'DP-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase(), repId: rep.id, date: date, doctorId: doc.id, createdAt: now, createdBy: s.uid, status: '', reason: '', draft: true, sentAt: '', sentBy: '' },
        { doctorName: doc.name, specialty: doc.specialty || '', product: product, purpose: purpose, note: note, active: true, updatedAt: now }, apptFor(date));
      if (cur && (cur.period !== o.period || String(cur.facilityId) !== String(o.facilityId))) Object.assign(o, { repState: '', repNote: '', repAt: '', prevAppt: '' }); // a new appointment: the rep's confirmation no longer applies
      if (cur && !dpDraft_(cur)) o.edited = true; // the rep already has it: the next «إرسال» tells him it changed
      if (cur) dbUpsert_('DayPlans', 'id', o); else dbAppend_('DayPlans', o);
      audit_(s, 'dayplan_add', rep.id + ' ' + date + ' ' + doc.id, purpose);
      return o;
    });
    const list = dpWithStatus_(out);
    return Array.isArray(p.dates) || appts ? list : list[0];
  } finally { lock.releaseLock(); }
}
// «تعديل» from the plan screen: one item's appointment (day, period, facility), purpose, product and note.
function dayPlanUpdate_(s, p) {
  const f = dpFields_(p), now = new Date().toISOString(), lock = acquireLock_(20000);
  try {
    const rows = dpRows_(), r = rows.find(x => x.id === p.id); if (!r) throw new Error('البند غير موجود.');
    const date = isDate_(p.date) ? p.date : r.date;
    if (date < today_()) throw new Error('لا يمكن نقل الموعد إلى يوم مضى.');
    if (date !== r.date && rows.some(x => x.id !== r.id && String(x.repId) === String(r.repId) && x.date === date && String(x.doctorId) === String(r.doctorId))) throw new Error('هذا الطبيب موجود في خطة ذلك اليوم.');
    let fac = null; if (p.facilityId) { fac = facilityById_(p.facilityId, dbAll_('Facilities')); if (!fac || fac.status === 'معطل') throw new Error('المنشأة غير موجودة في السجل.'); }
    const o = Object.assign({ id: r.id, date: date, period: SCH_PERIOD[p.period] ? p.period : '', facilityId: fac ? String(fac.id) : '', facilityName: fac ? fac.name : '', updatedAt: now }, f);
    if (o.date !== r.date || o.period !== (r.period || '') || o.facilityId !== String(r.facilityId || '')) Object.assign(o, { repState: '', repNote: '', repAt: '', prevAppt: '' });
    if (!dpDraft_(r)) o.edited = true;
    dbUpsert_('DayPlans', 'id', o);
    audit_(s, 'dayplan_update', r.id, o.date + ' ' + o.period + ' ' + o.facilityId);
    return dpWithStatus_([Object.assign({}, r, o)])[0];
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
// «إرسال الخطة»: the rep's drafts in [from, to] become visible; a bell notification and a Telegram message with the plan.
function dayPlanSend_(s, p) {
  const from = isDate_(p.from) ? p.from : today_(), to = isDate_(p.to) ? p.to : from;
  if (to < from || (Date.parse(to) - Date.parse(from)) / 864e5 > 6) throw new Error('اختر فترة لا تزيد على أسبوع.');
  const rep = dbAll_('Reps').find(r => String(r.id) === String(p.repId)); if (!rep) throw new Error('المندوب غير موجود.');
  const now = new Date().toISOString(), lock = acquireLock_(20000);
  let items, sent = 0;
  try {
    items = dpRows_().filter(r => String(r.repId) === String(rep.id) && r.date >= from && r.date <= to);
    if (!items.length) throw new Error('لا توجد خطة في هذه الأيام.');
    items.filter(r => dpDraft_(r) || dpEdited_(r)).forEach(r => { dbUpsert_('DayPlans', 'id', { id: r.id, draft: false, edited: false, sentAt: now, sentBy: s.uid }); sent++; });
  } finally { lock.releaseLock(); }
  if (!sent && !p.again) throw new Error('الخطة مرسلة مسبقًا ولا توجد إضافات جديدة. استخدم «إعادة الإرسال» لتذكير المندوب.');
  const days = Array.from(new Set(items.map(r => r.date))).sort(), who = dpWho_(s), wasSent = items.some(r => r.sentAt && !dpDraft_(r) && !dpEdited_(r));
  const head = !sent ? 'تذكير بخطة زياراتك' : wasSent || items.some(dpEdited_) ? 'عُدّلت خطة زياراتك' : 'خطة زيارات جديدة';
  const daysTxt = days.map(dpShort_).join(' و') + '/' + days[days.length - 1].slice(0, 4);
  notifPush_(rep.id, 'plan', head + ' من ' + who + ' — ' + daysTxt + ' · ' + items.length + ' طبيب', { from: days[0], to: days[days.length - 1], by: who, head: head });
  const text = '🗓️ ' + head + '\nإلى: ' + rep.name + '   من: ' + who + '\n' + days.map(d => '\n📅 ' + dpLong_(d) + '\n' + items.filter(r => r.date === d).map((r, i) => (i + 1) + '. ' + r.doctorName + (r.specialty ? ' (' + r.specialty + ')' : '') +
    (dpApptText_(r) ? '\n   🕘 ' + dpApptText_(r) : '') + (r.product || r.purpose ? '\n   🎯 ' + (DP_PURPOSE[r.purpose] || '') + (r.product ? ': ' + r.product : '') : '') + (r.note ? '\n   📝 ' + r.note : '')).join('\n')).join('\n') + '\n\nتجدها في الصفحة الرئيسية لـ MedRep Pro.';
  const tg = tgNotifyUser_(rep.id, text);
  audit_(s, 'dayplan_send', rep.id + ' ' + from + '..' + to, sent + ' tg ' + tg);
  return { sent: sent, total: items.length, tg: tg };
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
  return dpWithStatus_(dpRows_().filter(r => String(r.repId) === String(s.uid) && r.date >= y && r.date <= to && !dpDraft_(r)));
}
// The rep (optional): «✓ مؤكد», or a corrected appointment (day, period, facility) with a note; the plan's author is notified.
// p.updateSchedule also moves the slot in the doctor's work schedule (the old weekday/facility/period → the new one).
function dayPlanConfirm_(s, p) {
  const now = new Date().toISOString();
  let r, upd = null, lock = acquireLock_(20000);
  try {
    const rows = dpRows_(); r = rows.find(x => x.id === p.id && String(x.repId) === String(s.uid) && !dpDraft_(x)); if (!r) throw new Error('البند غير موجود.');
    if (p.ok) dbUpsert_('DayPlans', 'id', { id: r.id, repState: 'ok', repNote: '', repAt: now });
    else {
      const date = isDate_(p.date) ? p.date : r.date;
      if (date < today_()) throw new Error('لا يمكن نقل الموعد إلى يوم مضى.');
      if (date !== r.date && rows.some(x => x.id !== r.id && String(x.repId) === String(r.repId) && x.date === date && String(x.doctorId) === String(r.doctorId))) throw new Error('هذا الطبيب موجود في خطة ذلك اليوم.');
      const per = SCH_PERIOD[p.period] ? p.period : (r.period || '');
      let fac = null; if (p.facilityId) { fac = facilityById_(p.facilityId, dbAll_('Facilities')); if (!fac || fac.status === 'معطل') throw new Error('المنشأة غير موجودة في السجل.'); }
      const note = String(p.note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const prev = r.repState === 'changed' && r.prevAppt ? r.prevAppt : dpLong_(r.date) + (dpApptText_(r) ? ' · ' + dpApptText_(r) : '');
      upd = { prevAppt: prev, id: r.id, date: date, period: per, facilityId: fac ? String(fac.id) : (r.facilityId || ''), facilityName: fac ? fac.name : (r.facilityName || ''), repState: 'changed', repNote: note, repAt: now, updatedAt: now };
      if (upd.date === r.date && upd.period === (r.period || '') && String(upd.facilityId) === String(r.facilityId || '') && !note) throw new Error('لم يتغير شيء في الموعد.');
      dbUpsert_('DayPlans', 'id', upd);
    }
    audit_(s, p.ok ? 'dayplan_confirm' : 'dayplan_change', r.id, upd ? upd.date + ' ' + upd.period + ' ' + upd.facilityId : '');
  } finally { lock.releaseLock(); }
  if (upd) {
    if (p.updateSchedule && upd.facilityId && upd.period) { // the doctor's work schedule follows the corrected appointment
      const cur = (docSchedules_(s, {}).sched[r.doctorId] || { slots: [] }).slots, oldD = schWeekday_(r.date);
      const keep = cur.filter(x => !(x.d === oldD && String(x.f) === String(r.facilityId) && x.p === r.period));
      keep.push({ f: upd.facilityId, d: schWeekday_(upd.date), p: upd.period });
      docScheduleSave_(s, { doctorId: r.doctorId, slots: keep.map(x => ({ facilityId: x.f, day: x.d, period: x.p })) });
    }
    const repName = repNames_()[s.uid] || s.name || 'المندوب', to = dpLong_(upd.date) + (dpApptText_(upd) ? ' · ' + dpApptText_(upd) : '');
    const text = repName + ' عدّل موعد ' + r.doctorName + '\nمن: ' + upd.prevAppt + '\nإلى: ' + to + (upd.repNote ? '\nملاحظة: ' + upd.repNote : '');
    notifPush_(r.createdBy, 'plan', text, { repId: r.repId, from: upd.date, to: upd.date, change: true });
    tgNotifyUser_(r.createdBy, '✎ ' + text);
  }
  return myDayPlan_(s);
}
function dayPlanFail_(s, p) {
  const r = dpRows_().find(x => x.id === p.id && String(x.repId) === String(s.uid) && !dpDraft_(x)); if (!r) throw new Error('البند غير موجود.');
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
