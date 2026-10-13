// MedRep Pro — KPI, compliance, monthly history and the admin dashboard.

/* ---------- KPI: Target -> Actual -> Achievement% -> Weight -> Weighted Score ---------- */
// Actuals are computed from submitted/approved reports in [from,to]; targets & weights come from the KPI sheet.
function performance_(s, p) {
  const from = p.from, to = p.to, cfg = dbAll_('KPI').filter(k => String(k.active) !== 'false');
  const comp = compliance_(from, to);
  // Targets for visits/coverage shrink with the rep's available working days (holidays, leaves, half-day permissions).
  const wdays = String(settings_().workDays || '0,1,2,3,4').split(',').map(Number), off = offData_(), allDays = workDays_(from, to, wdays);
  const SCALED = ['visits', 'doctor_cov', 'pharmacy_cov'];
  const availOf = id => allDays.reduce((a, d) => a + (1 - offWeight_(off, id, d)), 0);
  const reports = reportsFull_(reportsLight_().filter(r => r.date >= from && r.date <= to && ['مرسل', 'معتمد'].indexOf(r.status) >= 0)).map(parseReport_);
  const totalW = cfg.reduce((a, k) => a + (+k.weight || 0), 0) || 1;
  return dbAll_('Reps').filter(r => String(r.active) !== 'false').map(rep => {
    const rs = reports.filter(r => r.repId === rep.id), docs = [].concat.apply([], rs.map(r => r.doctors)), phs = [].concat.apply([], rs.map(r => r.pharmacies));
    const uniq = a => a.filter((v, i) => a.indexOf(v) === i).length;
    const complete = rs.length ? rs.reduce((a, r) => a + (r.notes ? 1 : 0.8) * (r.doctors.concat(r.pharmacies).filter(v => v.name).length / Math.max(1, r.doctors.length + r.pharmacies.length)), 0) / rs.length : 0;
    const actuals = { visits: docs.length + phs.length, doctor_cov: uniq(docs.map(v => v.name)), pharmacy_cov: uniq(phs.map(v => v.name)),
      product_activity: uniq(docs.map(v => v.intro).concat(phs.map(v => v.product)).filter(Boolean)), compliance: rs.length, quality: Math.round(complete * 100) };
    const rows = cfg.map(k => {
      const cc = comp[rep.id], frac = allDays.length ? availOf(rep.id) / allDays.length : 1, target = k.key === 'compliance' ? cc.expected : (SCALED.indexOf(k.key) >= 0 ? Math.round((+k.target || 0) * frac) : (+k.target || 0)), actual = k.key === 'compliance' ? cc.onTime : (actuals[k.key] || 0), ach = target ? Math.min(100, Math.round(actual / target * 100)) : (SCALED.indexOf(k.key) >= 0 && frac === 0 ? 100 : 0);
      return { key: k.key, name: k.name, target, actual, achievement: ach, weight: +k.weight, weighted: +(ach * k.weight / totalW).toFixed(1) };
    });
    return { repId: rep.id, name: rep.name, compliance: comp[rep.id], off: { total: allDays.length, avail: availOf(rep.id) }, gps: { total: docs.length + phs.length, ver: docs.concat(phs).filter(v => v.gps && v.gps.status === 'تم التحقق').length, out: docs.concat(phs).filter(v => v.gps && v.gps.status === 'خارج النطاق').length, pending: docs.concat(phs).filter(v => !v.gps || ['تم التحقق', 'خارج النطاق'].indexOf(v.gps.status) < 0).length }, score: Math.round(rows.reduce((a, r) => a + r.weighted, 0)), kpis: rows };
  }).sort((a, b) => b.score - a.score).map((r, i) => Object.assign(r, { rank: i + 1 }));
}

/* ---------- admin dashboard: one cached call; reads only the two visit columns of the period's reports ---------- */
const DASH_GPS = ['تم التحقق', 'خارج النطاق', 'غير حاسم', 'مرجع غير مؤكد', 'غير متاح'];
function reportVisitColumns_(rows) {
  const out = {}; if (!rows.length) return out;
  const sh = sheet_('Reports'), cd = T.Reports.indexOf('doctors') + 1, cp = T.Reports.indexOf('pharmacies') + 1; // adjacent columns
  const lo = Math.min.apply(null, rows.map(r => r.rowNo)), hi = Math.max.apply(null, rows.map(r => r.rowNo));
  const block = sh.getRange(lo, cd, hi - lo + 1, cp - cd + 1).getValues();
  const parse = x => { try { const a = JSON.parse(x || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  rows.forEach(r => { const v = block[r.rowNo - lo]; out[r.id] = { doctors: parse(v[0]), pharmacies: parse(v[cp - cd]) }; });
  return out;
}
function dashboard_(s, p) {
  const td = today_(), from = isDate_(p.from) ? p.from : td.slice(0, 8) + '01', to = isDate_(p.to) ? p.to : td;
  if (to < from) throw new Error('تاريخ البداية بعد تاريخ النهاية.');
  const DAY = 864e5, ms = d => Date.parse(d + 'T12:00:00Z'), fmt = t => Utilities.formatDate(new Date(t), 'UTC', 'yyyy-MM-dd');
  const days = Math.round((ms(to) - ms(from)) / DAY) + 1;
  if (days > 366) throw new Error('اختر فترة لا تزيد على سنة.');
  const key = 'dash_' + from + '_' + to, hit = cacheGetLarge_(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  // The previous period has the same length and ends the day before `from`: the cards compare against it.
  const pFrom = fmt(ms(from) - days * DAY), pTo = fmt(ms(from) - DAY);
  const sent = r => r.status === 'مرسل' || r.status === 'معتمد', light = reportsLight_();
  const cur = light.filter(r => sent(r) && r.date >= from && r.date <= to), prev = light.filter(r => sent(r) && r.date >= pFrom && r.date <= pTo);
  const visits = reportVisitColumns_(cur.concat(prev)), sum = (rows, k) => rows.reduce((n, r) => n + visits[r.id][k].length, 0);
  const change = (a, b) => (b ? Math.round((a - b) / b * 100) : null);
  const reps = {}; dbAll_('Reps').forEach(r => { reps[r.id] = r; });
  // Daily movement and GPS verdicts of the period.
  const daily = {}; for (let t = ms(from); t <= ms(to); t += DAY) daily[fmt(t)] = { d: 0, p: 0 };
  const gps = {}; DASH_GPS.forEach(k => { gps[k] = 0; });
  cur.forEach(r => {
    const v = visits[r.id]; if (daily[r.date]) { daily[r.date].d += v.doctors.length; daily[r.date].p += v.pharmacies.length; }
    v.doctors.concat(v.pharmacies).forEach(x => { const st = x && x.gps && x.gps.status; gps[DASH_GPS.indexOf(st) >= 0 ? st : 'غير متاح']++; });
  });
  // Most visited facilities: a visit counts for its facility (merges followed); older visits via their workplace row or place text.
  const facilities = readScope_(() => {
    const fx = { facilities: sheet_('Facilities') ? dbAll_('Facilities') : [], workplaces: dbAll_('DoctorWorkplaces') }, agg = {};
    cur.forEach(r => visits[r.id].doctors.forEach(v => {
      let f = v.facilityId ? facilityById_(v.facilityId, fx.facilities) : null;
      if (!f && v.workplaceId) { const w = fx.workplaces.find(x => String(x.id) === String(v.workplaceId)); f = w ? facilityById_(w.facilityId, fx.facilities) : null; }
      const k = f ? 'f:' + f.id : 'n:' + normName_(v.place || ''); if (k === 'n:') return;
      const a = agg[k] = agg[k] || { id: f ? f.id : '', name: f ? f.name : String(v.place || ''), visits: 0, doctors: {} };
      a.visits++; a.doctors[v.doctorId || normName_(v.name)] = 1;
    }));
    return Object.keys(agg).map(k => ({ id: agg[k].id, name: agg[k].name, visits: agg[k].visits, doctors: Object.keys(agg[k].doctors).length }))
      .sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name)).slice(0, 10);
  });
  // Reporting compliance (on-time submissions / expected working days) of active reps, current vs previous period.
  const active = Object.keys(reps).filter(id => String(reps[id].active) !== 'false');
  const comp = compliance_(from, to), compPrev = compliance_(pFrom, pTo);
  const rate = c => { const e = active.reduce((n, id) => n + ((c[id] || {}).expected || 0), 0), o = active.reduce((n, id) => n + ((c[id] || {}).onTime || 0), 0); return e ? Math.round(o / e * 100) : null; };
  const compliance = active.map(id => Object.assign({ repId: id, name: reps[id].name }, comp[id] || { expected: 0, onTime: 0, late: 0, missing: 0, pct: 0 }))
    .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  // Latest reports (any status but draft), newest activity first.
  const latestRows = light.filter(r => r.status !== 'مسودة').sort((a, b) => String(b.submittedAt || b.updatedAt) < String(a.submittedAt || a.updatedAt) ? -1 : 1).slice(0, 8), vc = visitCounts_(latestRows);
  const docs = sum(cur, 'doctors'), phs = sum(cur, 'pharmacies'), docsPrev = sum(prev, 'doctors'), phsPrev = sum(prev, 'pharmacies');
  const compNow = rate(comp), compBefore = rate(compPrev);
  const out = {
    from: from, to: to, prevFrom: pFrom, prevTo: pTo, reports: cur.length,
    cards: {
      doctorVisits: { value: docs, change: change(docs, docsPrev) },
      pharmacyVisits: { value: phs, change: change(phs, phsPrev) },
      compliance: { value: compNow, change: compNow == null || compBefore == null ? null : compNow - compBefore },
      topFacility: facilities[0] ? { name: facilities[0].name, value: facilities[0].visits } : null
    },
    daily: Object.keys(daily).map(d => ({ date: d, doctors: daily[d].d, pharmacies: daily[d].p })),
    gps: DASH_GPS.map(k => ({ status: k, count: gps[k] })), facilities: facilities, compliance: compliance,
    latest: latestRows.map(r => ({ id: r.id, no: r.no, date: r.date, status: r.status, repName: (reps[r.repId] || {}).name || '', visits: vc[r.id] || 0 }))
  };
  cachePutLarge_(key, JSON.stringify(out), 300);
  return out;
}

/* ---------- compliance: on-time = submitted before (day+1) at closeHour, on workDays (0=Sun) ---------- */
function compliance_(from, to) {
  const st = settings_(), tz = st.timezone || Session.getScriptTimeZone(), close = ('0' + closeHour_(st)).slice(-2);
  const wd = String(st.workDays || '0,1,2,3,4').split(',').map(Number), DAY = 864e5, f = d => Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  const yesterday = f(new Date(new Date(today_() + 'T12:00:00Z').getTime() - DAY)), end = to < yesterday ? to : yesterday, days = [];
  for (let d = new Date(from + 'T12:00:00Z'); f(d) <= end; d = new Date(d.getTime() + DAY)) if (wd.indexOf(d.getUTCDay()) >= 0) days.push(f(d));
  const reports = reportsLight_().filter(x => ['مرسل', 'معتمد'].indexOf(x.status) >= 0), out = {}, off = offData_();
  dbAll_('Reps').forEach(rep => {
    let onTime = 0, late = 0;
    const rd = days.filter(d => offWeight_(off, rep.id, d) < 1); // holidays and full-day leaves are not required days
    rd.forEach(day => {
      const r = reports.find(x => x.repId === rep.id && x.date === day); if (!r) return;
      const dl = Utilities.parseDate(f(new Date(new Date(day + 'T12:00:00Z').getTime() + DAY)) + ' ' + close + ':00', tz, 'yyyy-MM-dd HH:mm').getTime();
      if (new Date(r.submittedAt).getTime() <= dl) onTime++; else late++;
    });
    out[rep.id] = { expected: rd.length, onTime: onTime, late: late, missing: rd.length - onTime - late, pct: rd.length ? Math.round(onTime / rd.length * 100) : 0, exempt: days.length - rd.length };
  });
  return out;
}

/* ---------- monthly history: frozen monthly scores per rep (survive KPI target changes) ---------- */
function ensureMonthly_() {
  const ss = SpreadsheetApp.getActive(); let sh = ss.getSheetByName('Monthly');
  if (!sh) { sh = ss.insertSheet('Monthly'); sh.appendRow(T.Monthly); sh.setFrozenRows(1); sh.getRange(1, 1, sh.getMaxRows(), T.Monthly.length).setNumberFormat('@'); }
}
function computeMonth_(ym, save) {
  const a = ym.split('-'), last = new Date(Date.UTC(+a[0], +a[1], 0)).getUTCDate(), now = new Date().toISOString();
  return performance_(null, { from: ym + '-01', to: ym + '-' + ('0' + last).slice(-2) }).map(r => {
    const row = { id: ym + '|' + r.repId, ym: ym, repId: r.repId, repName: r.name, score: r.score, compliance: r.compliance.pct, onTime: r.compliance.onTime,
      expected: r.compliance.expected, visits: r.gps.total, verified: r.gps.ver, gpsTotal: r.gps.total, kpis: JSON.stringify(r.kpis), computedAt: now };
    if (save) dbUpsert_('Monthly', 'id', row);
    return row;
  });
}
const slimM_ = r => ({ repId: r.repId, score: +r.score, compliance: +r.compliance, visits: +r.visits, verified: +r.verified });
// 12 months of one year. Closed months are read from 'Monthly' (computed once, then frozen); the current month is live.
function trend_(s, p) {
  ensureMonthly_();
  const y = +p.year, curYm = today_().slice(0, 7), reps = dbAll_('Reps').filter(r => String(r.active) !== 'false');
  const first = reportsLight_().reduce((a, r) => (!a || r.date < a ? r.date : a), ''), firstYm = first ? first.slice(0, 7) : curYm;
  const stored = {}; dbAll_('Monthly').forEach(r => { (stored[r.ym] = stored[r.ym] || []).push(r); });
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const ym = y + '-' + ('0' + m).slice(-2);
    if (ym > curYm || ym < firstYm) { months.push({ ym: ym, rows: null }); continue; }
    let rows = ym === curYm ? computeMonth_(ym, false) : (stored[ym] || []);
    if (!rows.length) rows = computeMonth_(ym, true);
    months.push({ ym: ym, rows: rows.map(slimM_) });
  }
  return { year: y, months: months, reps: reps.map(r => ({ id: r.id, name: r.name })) };
}
// Average monthly score per rep per year (months with no visits are ignored).
function yearly_(s, p) {
  const ys = (p.years || []).slice(0, 4).map(Number), sum = {};
  ys.forEach(y => trend_(s, { year: y }).months.forEach(m => (m.rows || []).forEach(r => {
    if (r.visits > 0) { const o = (sum[r.repId] = sum[r.repId] || {}); (o[y] = o[y] || []).push(r.score); }
  })));
  const avg = {}; Object.keys(sum).forEach(id => { avg[id] = {}; Object.keys(sum[id]).forEach(y => { const a = sum[id][y]; avg[id][y] = Math.round(a.reduce((x, z) => x + z, 0) / a.length); }); });
  return { years: ys, avg: avg };
}
// Run once from the editor: closes the previous month automatically on the 2nd of every month.
function installMonthlyTrigger() {
  ownerOnly_();
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'monthlyClose_') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('monthlyClose_').timeBased().onMonthDay(2).atHour(3).create();
}
function monthlyClose_() {
  ensureMonthly_();
  computeMonth_(Utilities.formatDate(new Date(new Date(today_() + 'T12:00:00Z').getTime() - 3 * 864e5), 'UTC', 'yyyy-MM'), true);
}
function myPerformance_(s, p) {
  ensureMonthly_();
  const cur = today_().slice(0, 7), ym = /^\d{4}-\d{2}$/.test(p.ym || '') ? p.ym : cur;
  let row = ym < cur ? dbAll_('Monthly').find(r => r.id === ym + '|' + s.uid) : null;
  if (!row) row = computeMonth_(ym, false).find(r => r.repId === s.uid);
  if (!row) throw new Error('لا توجد بيانات لهذا الشهر');
  return { ym: ym, score: +row.score, compliance: +row.compliance, onTime: +row.onTime, expected: +row.expected, visits: +row.visits, kpis: JSON.parse(row.kpis || '[]') };
}
