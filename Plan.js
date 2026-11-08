// MedRep Pro — monthly visit plan: each rep's doctor list with a class (A/B/C), proposed by the rep and approved by an admin,
// and the plan coverage (visits done against visits required) shown to the rep, the admin and the supervisor, and used as a KPI.
// One row per (rep, doctor): a doctor may be on several reps' lists, each with its own class.
//   cls        the approved class ('' until an admin approves the first proposal)
//   pendingCls a class waiting for approval (a new doctor, or a class change); '' when nothing is pending
// Coverage of one doctor = min(visits, required) / required: extra visits to one doctor never make up for another.
// Required = ceil(visits per month of the class × "months" of available work in the period): leaves and holidays lower it.

const PLAN_CLASSES = ['A', 'B', 'C'], PLAN_DEFAULT = { A: 4, B: 2, C: 1 }, PLAN_IMPORT_MAX = 2000;
const PLAN_KPI = { key: 'plan_cov', name: 'تغطية خطة الزيارات', target: 100, weight: 0, active: true };

function planFreq_(st) {
  const out = {}; st = st || settings_();
  PLAN_CLASSES.forEach(c => { const n = Number(st['plan' + c]); out[c] = Number.isInteger(n) && n >= 0 && n <= 31 ? n : PLAN_DEFAULT[c]; });
  return out;
}
function planRows_() { ensureSheet_('RepDoctors'); return dbAll_('RepDoctors').filter(r => String(r.active) !== 'false'); }
const planCls_ = v => { const x = String(v || '').trim().toUpperCase().replace('أ', 'A').replace('ب', 'B').replace('ج', 'C'); return PLAN_CLASSES.indexOf(x) >= 0 ? x : ''; };
// The KPI row is added once (weight 0, so existing scores do not change until the admin gives it a weight).
function ensurePlanKpi_() {
  if (!dbAll_('KPI').some(k => k.key === PLAN_KPI.key)) dbAppend_('KPI', PLAN_KPI);
}

/* ---------- coverage (pure on its inputs; used by the screens and by performance_) ---------- */
// "Months" of work for one rep in [from, to]: for each calendar month touched, available work days in the period / work days of
// the whole month. A full month without leave = 1; half of it on leave = 0.5; two full months = 2.
function planMonths_(repId, from, to, off, wd) {
  let total = 0;
  for (let ym = from.slice(0, 7); ym <= to.slice(0, 7); ym = planNextYm_(ym)) {
    const first = ym + '-01', last = ym + '-' + ('0' + new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5), 0)).getUTCDate()).slice(-2);
    const all = workDays_(first, last, wd); if (!all.length) continue;
    const a = from > first ? from : first, b = to < last ? to : last;
    const avail = workDays_(a, b, wd).reduce((n, d) => n + (1 - offWeight_(off, repId, d)), 0);
    total += avail / all.length;
  }
  return total;
}
function planNextYm_(ym) { const y = +ym.slice(0, 4), m = +ym.slice(5); return m === 12 ? (y + 1) + '-01' : y + '-' + ('0' + (m + 1)).slice(-2); }
// visitsByRep: { repId: [doctor visit, ...] }. Returns one entry per rep that has a list (approved or pending rows).
function planCoverageCore_(reps, rows, visitsByRep, from, to, ctx) {
  const freq = ctx.freq, byName = {};
  (ctx.doctors || []).forEach(d => { const k = normName_(d.name); if (k && !byName[k]) byName[k] = String(d.id); });
  return reps.map(rep => {
    const mine = rows.filter(r => String(r.repId) === String(rep.id)); if (!mine.length) return null;
    const months = planMonths_(rep.id, from, to, ctx.off, ctx.wd), count = {};
    (visitsByRep[rep.id] || []).forEach(v => { const id = v.doctorId ? String(v.doctorId) : byName[normName_(v.name)]; if (id) count[id] = (count[id] || 0) + 1; });
    const cls = {}; PLAN_CLASSES.forEach(c => { cls[c] = { doctors: 0, req: 0, done: 0 }; });
    let never = 0;
    const doctors = mine.map(r => {
      const visits = count[String(r.doctorId)] || 0, c = r.cls, req = c ? Math.ceil(freq[c] * months - 1e-9) : 0, done = Math.min(visits, req);
      if (c) { cls[c].doctors++; cls[c].req += req; cls[c].done += done; if (req && !visits) never++; }
      return { id: r.id, doctorId: r.doctorId, name: r.doctorName, cls: c, pendingCls: r.pendingCls || '', visits: visits, req: req };
    }).sort((a, b) => (a.cls ? 0 : 1) - (b.cls ? 0 : 1) || (a.req && !a.visits ? 0 : 1) - (b.req && !b.visits ? 0 : 1) || PLAN_CLASSES.indexOf(a.cls) - PLAN_CLASSES.indexOf(b.cls) || String(a.name).localeCompare(String(b.name), 'ar'));
    const req = PLAN_CLASSES.reduce((n, c) => n + cls[c].req, 0), done = PLAN_CLASSES.reduce((n, c) => n + cls[c].done, 0);
    // No required visit: a rep fully on leave counts as covered; a rep with no approved list has no coverage yet (null).
    const pct = req ? Math.round(done / req * 100) : (months === 0 && doctors.some(d => d.cls) ? 100 : null);
    return { repId: rep.id, name: rep.name, months: +months.toFixed(2), req: req, done: done, pct: pct, never: never, cls: cls,
      pending: doctors.filter(d => d.pendingCls).length, doctors: doctors };
  }).filter(Boolean);
}
function planCtx_() {
  const st = settings_();
  return { freq: planFreq_(st), off: offData_(), wd: String(st.workDays || '0,1,2,3,4').split(',').map(Number), doctors: dbAll_('Doctors') };
}
// Doctor visits per rep in [from, to] from reports with the given statuses (one read of the two visit columns).
function planVisits_(from, to, statuses, repId) {
  const rows = reportsLight_().filter(r => r.date >= from && r.date <= to && statuses.indexOf(r.status) >= 0 && (!repId || r.repId === repId));
  const cols = reportVisitColumns_(rows), out = {};
  rows.forEach(r => { (out[r.repId] = out[r.repId] || []).push.apply(out[r.repId], cols[r.id].doctors); });
  return out;
}
const PLAN_SENT = ['مرسل', 'معتمد'], PLAN_ALL = ['مسودة', 'جاهز للمراجعة', 'مرسل', 'معتمد', 'معاد للمندوب'];
function planPeriod_(p) {
  const td = today_(), from = isDate_(p && p.from) ? p.from : td.slice(0, 8) + '01', to = isDate_(p && p.to) ? p.to : td;
  if (to < from) throw new Error('تاريخ البداية بعد تاريخ النهاية.');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 366) throw new Error('اختر فترة لا تزيد على سنة.');
  return { from: from, to: to };
}

/* ---------- rep: my list (this month, drafts included) ---------- */
function myPlan_(s) {
  const td = today_(), from = td.slice(0, 8) + '01', last = new Date(Date.UTC(+td.slice(0, 4), +td.slice(5, 7), 0)).getUTCDate();
  const to = td.slice(0, 8) + ('0' + last).slice(-2); // the whole month: the target is monthly
  const ctx = planCtx_(), rows = planRows_().filter(r => String(r.repId) === String(s.uid));
  const cov = planCoverageCore_([{ id: s.uid, name: s.name }], rows, planVisits_(from, td, PLAN_ALL, s.uid), from, to, ctx)[0];
  return { month: td.slice(0, 7), freq: ctx.freq, coverage: cov || null };
}
function planPropose_(s, p) {
  const cls = planCls_(p.cls); if (!cls) throw new Error('اختر الفئة: A أو B أو C.');
  const doc = dbAll_('Doctors').find(d => String(d.id) === String(p.doctorId) && String(d.active) !== 'false');
  if (!doc) throw new Error('الطبيب غير موجود في السجل.');
  const lock = acquireLock_(20000);
  try {
    const row = planRows_().find(r => String(r.repId) === String(s.uid) && String(r.doctorId) === String(doc.id)), now = new Date().toISOString();
    if (row) {
      const pending = cls === row.cls ? '' : cls; // asking for the class it already has withdraws a pending change
      dbUpsert_('RepDoctors', 'id', Object.assign({}, row, { pendingCls: pending, requestedAt: pending ? now : row.requestedAt }));
    } else {
      dbAppend_('RepDoctors', { id: 'RD-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase(), repId: s.uid, doctorId: doc.id, doctorName: doc.name,
        cls: '', pendingCls: cls, requestedAt: now, approvedBy: '', approvedAt: '', active: true });
    }
    audit_(s, 'plan_propose', doc.id, cls);
  } finally { lock.releaseLock(); }
  return myPlan_(s);
}
function planWithdraw_(s, p) {
  const row = planRows_().find(r => r.id === p.id && String(r.repId) === String(s.uid));
  if (!row || !row.pendingCls) throw new Error('لا يوجد طلب لسحبه.');
  dbUpsert_('RepDoctors', 'id', Object.assign({}, row, { pendingCls: '', active: row.cls ? true : false }));
  audit_(s, 'plan_withdraw', row.doctorId);
  return myPlan_(s);
}

/* ---------- admin: approve / reject / set / remove / add; supervisor and admin: lists and coverage ---------- */
function planList_(s, p) {
  ensurePlanKpi_();
  const reps = {}; dbAll_('Reps').forEach(r => { reps[r.id] = r.name; });
  return { freq: planFreq_(), rows: planRows_().filter(r => !p.repId || String(r.repId) === String(p.repId))
    .map(r => ({ id: r.id, repId: r.repId, repName: reps[r.repId] || r.repId, doctorId: r.doctorId, name: r.doctorName, cls: r.cls, pendingCls: r.pendingCls || '', requestedAt: r.requestedAt })) };
}
function planAct_(s, p) {
  const op = p.op, lock = acquireLock_(20000), now = new Date().toISOString();
  try {
    if (op === 'add') {
      const cls = planCls_(p.cls); if (!cls) throw new Error('اختر الفئة: A أو B أو C.');
      if (!dbAll_('Reps').some(r => String(r.id) === String(p.repId))) throw new Error('المندوب غير موجود.');
      const doc = dbAll_('Doctors').find(d => String(d.id) === String(p.doctorId) && String(d.active) !== 'false');
      if (!doc) throw new Error('الطبيب غير موجود في السجل.');
      const row = planRows_().find(r => String(r.repId) === String(p.repId) && String(r.doctorId) === String(doc.id));
      const o = Object.assign({}, row || { id: 'RD-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase(), repId: p.repId, doctorId: doc.id, requestedAt: '' },
        { doctorName: doc.name, cls: cls, pendingCls: '', approvedBy: s.uid, approvedAt: now, active: true });
      if (row) dbUpsert_('RepDoctors', 'id', o); else dbAppend_('RepDoctors', o);
      audit_(s, 'plan_add', p.repId + ' ' + doc.id, cls);
      return 1;
    }
    const ids = (Array.isArray(p.ids) ? p.ids : [p.id]).map(String), all = planRows_(), rows = all.filter(r => ids.indexOf(String(r.id)) >= 0);
    if (!rows.length) throw new Error('السجل غير موجود.');
    const cls = planCls_(p.cls);
    if ((op === 'set') && !cls) throw new Error('اختر الفئة: A أو B أو C.');
    rows.forEach(r => {
      let o;
      if (op === 'approve') { const c = cls || r.pendingCls; if (!c) return; o = { cls: c, pendingCls: '', approvedBy: s.uid, approvedAt: now }; }
      else if (op === 'reject') { if (!r.pendingCls) return; o = { pendingCls: '', active: r.cls ? true : false }; }
      else if (op === 'set') o = { cls: cls, pendingCls: '', approvedBy: s.uid, approvedAt: now };
      else if (op === 'remove') o = { active: false, pendingCls: '' };
      else throw new Error('عملية غير معروفة');
      dbUpsert_('RepDoctors', 'id', Object.assign({}, r, o));
    });
    audit_(s, 'plan_' + op, rows.length === 1 ? rows[0].repId + ' ' + rows[0].doctorId : rows.length + ' rows', cls || '');
    return rows.length;
  } finally { lock.releaseLock(); }
}
function planCoverage_(s, p) {
  ensurePlanKpi_();
  const per = planPeriod_(p), ctx = planCtx_(), reps = dbAll_('Reps').filter(r => String(r.active) !== 'false');
  return { from: per.from, to: per.to, freq: ctx.freq,
    reps: planCoverageCore_(reps, planRows_(), planVisits_(per.from, per.to, PLAN_SENT), per.from, per.to, ctx) };
}
// Settings: visits per month for each class (0–31).
function planSaveFreq_(s, p) {
  const v = p.freq || {};
  PLAN_CLASSES.forEach(c => { const n = Number(v[c]); if (!Number.isInteger(n) || n < 0 || n > 31) throw new Error('عدد زيارات الفئة ' + c + ' يجب أن يكون بين 0 و31.'); });
  PLAN_CLASSES.forEach(c => dbUpsert_('Settings', 'key', { key: 'plan' + c, value: String(+v[c]) }));
  clearCache_(); audit_(s, 'plan_freq', 'A' + v.A + ' B' + v.B + ' C' + v.C);
  return planFreq_();
}

/* ---------- import from Excel: rep · doctor · class (approved at once) ---------- */
function planImportPlan_(rows) {
  const reps = dbAll_('Reps'), docs = dbAll_('Doctors').filter(d => String(d.active) !== 'false'), cur = planRows_();
  const repBy = {}, docBy = {};
  reps.forEach(r => { repBy[String(r.id).toUpperCase()] = r; const k = normName_(r.name); if (k && !repBy[k]) repBy[k] = r; });
  docs.forEach(d => { docBy[String(d.id).toUpperCase()] = d; const k = normName_(d.name); if (k && !docBy[k]) docBy[k] = d; });
  const cut = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 120);
  const add = [], dup = [], invalid = [], seen = {};
  (rows || []).slice(0, PLAN_IMPORT_MAX + 1).forEach((cells, i) => {
    const line = i + 1, c = Array.isArray(cells) ? cells : [];
    if (!c.some(x => cut(x))) return;
    if (i === 0 && /^(المندوب|مندوب|rep)/i.test(cut(c[0]))) return; // header row
    const rep = repBy[cut(c[0]).toUpperCase()] || repBy[normName_(c[0])], doc = docBy[cut(c[1]).toUpperCase()] || docBy[normName_(c[1])], cls = planCls_(c[2]);
    if (!rep) { invalid.push({ line: line, reason: 'المندوب غير موجود: ' + cut(c[0]) }); return; }
    if (!doc) { invalid.push({ line: line, reason: 'الطبيب غير موجود في السجل: ' + cut(c[1]) }); return; }
    if (!cls) { invalid.push({ line: line, reason: 'الفئة يجب أن تكون A أو B أو C' }); return; }
    const key = rep.id + '|' + doc.id;
    if (seen[key]) { dup.push({ line: line, name: rep.name + ' · ' + doc.name, existing: 'مكرر في السطر ' + seen[key] }); return; }
    seen[key] = line;
    const row = cur.find(r => String(r.repId) === String(rep.id) && String(r.doctorId) === String(doc.id));
    if (row && row.cls === cls && !row.pendingCls) { dup.push({ line: line, name: rep.name + ' · ' + doc.name, existing: 'الفئة ' + cls }); return; }
    add.push({ repId: rep.id, doctorId: doc.id, cls: cls, name: rep.name + ' · ' + doc.name, location: 'الفئة ' + cls + (row && row.cls ? ' (كانت ' + row.cls + ')' : '') });
  });
  if (add.length + dup.length + invalid.length > PLAN_IMPORT_MAX) throw new Error('أقصى عدد في المرة الواحدة ' + PLAN_IMPORT_MAX + ' سطر.');
  return { entity: 'Plans', add: add, dup: dup, invalid: invalid };
}
function planImport_(s, p) {
  ensureSheet_('RepDoctors');
  if (!p.commit) return planImportPlan_(p.rows);
  const lock = acquireLock_(30000);
  try {
    const plan = planImportPlan_(p.rows), now = new Date().toISOString(), cur = planRows_(), docs = {};
    dbAll_('Doctors').forEach(d => { docs[d.id] = d.name; });
    const fresh = [];
    plan.add.forEach(a => {
      const row = cur.find(r => String(r.repId) === String(a.repId) && String(r.doctorId) === String(a.doctorId));
      const o = Object.assign({}, row || { id: 'RD-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase(), repId: a.repId, doctorId: a.doctorId, requestedAt: '' },
        { doctorName: docs[a.doctorId], cls: a.cls, pendingCls: '', approvedBy: s.uid, approvedAt: now, active: true });
      if (row) dbUpsert_('RepDoctors', 'id', o); else fresh.push(T.RepDoctors.map(k => (o[k] === undefined ? '' : o[k])));
    });
    if (fresh.length) { const sh = sheet_('RepDoctors'); sh.getRange(sh.getLastRow() + 1, 1, fresh.length, T.RepDoctors.length).setValues(fresh); dropTableCache_('RepDoctors'); if (_RM) delete _RM.RepDoctors; }
    if (plan.add.length) audit_(s, 'plan_import', String(plan.add.length));
    return Object.assign(plan, { added: plan.add.length });
  } finally { lock.releaseLock(); }
}
