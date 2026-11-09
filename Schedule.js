// MedRep Pro — doctor work schedules: where each doctor works on each weekday (facility + day + period).
// Shared per doctor (not per rep): any rep, supervisor or admin may edit it, with no approval. A doctor may have any number of
// slots, several facilities on the same day (morning in one, evening in another). Edits keep history: a removed slot is ended
// (active=false, who and when), never deleted. «غير متواجد اليوم» marks one day only (DocAbsent) and expires by itself.
// The schedule only helps, it never blocks: it picks the facility in the visit form, shows «اليوم: …» in «أطبائي», and warns
// in «خطط اليوم» when a doctor does not work on the plan's day. A doctor without a schedule behaves exactly as before.

const SCH_PERIOD = { am: 'صباحًا', pm: 'مساءً', all: 'يوم كامل' };
const SCH_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const SCH_MAX_SLOTS = 42;

function schRows_() { ensureSheet_('DocSchedule'); return dbAll_('DocSchedule'); }
function schAbsentRows_() { ensureSheet_('DocAbsent'); return dbAll_('DocAbsent').filter(r => String(r.active) !== 'false'); }
function schWeekday_(date) { return new Date(Date.parse(date + 'T12:00:00Z')).getUTCDay(); }
const schOn_ = r => String(r.active) !== 'false';

// Every doctor's schedule: { sched: { doctorId: { slots: [{ f, n, d, p }], by, at } }, absent: { doctorId: [dates] }, today }.
function docSchedules_(s, p) {
  const facs = dbAll_('Facilities'), out = {}, absent = {}, today = today_();
  schRows_().forEach(r => {
    const o = out[r.doctorId] || (out[r.doctorId] = { slots: [], by: '', at: '' });
    if (schOn_(r)) {
      const f = facilityById_(r.facilityId, facs);
      o.slots.push({ f: f ? String(f.id) : String(r.facilityId), n: f ? f.name : r.facilityName, d: +r.day, p: r.period });
    }
    [[r.addedAt, r.addedByName], [r.endedAt, r.endedByName]].forEach(([at, by]) => { if (at && String(at) > o.at) { o.at = String(at); o.by = by || ''; } });
  });
  Object.keys(out).forEach(k => { if (!out[k].slots.length) delete out[k]; else out[k].slots.sort((a, b) => a.d - b.d || (a.p > b.p ? 1 : -1)); });
  schAbsentRows_().forEach(r => { if (String(r.date) >= today) (absent[r.doctorId] = absent[r.doctorId] || []).push(String(r.date)); });
  return { sched: out, absent: absent, today: today };
}

// Replace a doctor's schedule with p.slots = [{ facilityId, day (0 = Sunday … 6), period: am|pm|all }]. Unchanged slots stay.
function docScheduleSave_(s, p) {
  const doc = dbAll_('Doctors').find(d => String(d.id) === String(p.doctorId) && String(d.active) !== 'false');
  if (!doc) throw new Error('الطبيب غير موجود في السجل.');
  const facs = dbAll_('Facilities'), want = {}, list = Array.isArray(p.slots) ? p.slots : [];
  if (list.length > SCH_MAX_SLOTS) throw new Error('عدد الفترات كبير جدًا.');
  list.forEach(x => {
    const day = +x.day, per = String(x.period || '');
    if (!(day >= 0 && day <= 6 && Math.floor(day) === day)) throw new Error('يوم غير صحيح.');
    if (!SCH_PERIOD[per]) throw new Error('اختر الفترة: صباحًا أو مساءً أو يوم كامل.');
    const f = facilityById_(x.facilityId, facs);
    if (!f || f.status === 'معطل') throw new Error('المنشأة غير موجودة في السجل.');
    want[f.id + '|' + day + '|' + per] = { facilityId: String(f.id), facilityName: f.name, day: day, period: per };
  });
  ensureSheet_('DocSchedule');
  const lock = acquireLock_(20000), now = new Date().toISOString(), who = { uid: s.uid, name: s.name || '' };
  let added = 0, ended = 0;
  try {
    const rows = schRows_(), cur = rows.filter(r => String(r.doctorId) === String(doc.id) && schOn_(r)), keep = {};
    cur.forEach(r => {
      const f = facilityById_(r.facilityId, facs), k = (f ? f.id : r.facilityId) + '|' + (+r.day) + '|' + r.period;
      if (want[k] && !keep[k]) { keep[k] = 1; return; }
      dbUpsert_('DocSchedule', 'id', { id: r.id, active: false, endedAt: now, endedBy: who.uid, endedByName: who.name }); ended++;
    });
    let n = rows.reduce((m, r) => Math.max(m, +(String(r.id).match(/(\d+)$/) || [0, 0])[1]), 0);
    Object.keys(want).filter(k => !keep[k]).forEach(k => {
      dbAppend_('DocSchedule', Object.assign({ id: 'SCH-' + ('00000' + (++n)).slice(-6), doctorId: doc.id, active: true,
        addedAt: now, addedBy: who.uid, addedByName: who.name, endedAt: '', endedBy: '', endedByName: '' }, want[k])); added++;
    });
    if (added || ended) audit_(s, 'doc_schedule', doc.id, '+' + added + ' -' + ended);
  } finally { lock.releaseLock(); }
  return docSchedules_(s, {});
}

// «غير متواجد اليوم» (p.undo clears it). Today only, unless an admin/supervisor gives a later p.date.
function docAbsent_(s, p) {
  const doc = dbAll_('Doctors').find(d => String(d.id) === String(p.doctorId) && String(d.active) !== 'false');
  if (!doc) throw new Error('الطبيب غير موجود في السجل.');
  const today = today_(), date = s.role === 'rep' || !p.date ? today : String(p.date);
  if (!isDate_(date) || date < today) throw new Error('تاريخ غير صحيح.');
  ensureSheet_('DocAbsent');
  const lock = acquireLock_(20000);
  try {
    const cur = schAbsentRows_().find(r => String(r.doctorId) === String(doc.id) && String(r.date) === date);
    if (p.undo) { if (cur) dbUpsert_('DocAbsent', 'id', { id: cur.id, active: false }); }
    else if (!cur) dbAppend_('DocAbsent', { id: 'ABS-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase(), doctorId: doc.id, date: date,
      by: s.uid, byName: s.name || '', at: new Date().toISOString(), active: true });
    audit_(s, p.undo ? 'doc_absent_undo' : 'doc_absent', doc.id, date);
  } finally { lock.releaseLock(); }
  return docSchedules_(s, {});
}

// For a date: null when the doctor has no schedule; else { off, where: 'المنشأة صباحًا · …' }.
function schOnDate_(all, doctorId, date) {
  const o = all.sched[doctorId];
  if (!o) return null;
  const d = schWeekday_(date), slots = o.slots.filter(x => x.d === d), away = (all.absent[doctorId] || []).indexOf(date) >= 0;
  return { off: away || !slots.length, absent: away, where: slots.map(x => x.n + ' ' + SCH_PERIOD[x.p]).join(' · ') };
}
