// MedRep Pro — monthly report in English for the principal company: rep performance and product activity for one month.
// The client renders it (print → PDF, or CSV for Excel). Doctors appear only as counts, never by name.
// English names (company, reps, products) are optional: kept in Settings as companyNameEn / repsEn / productsEn (JSON id → name)
// so the table schemas do not change; a missing English name falls back to the Arabic one.

const REPORT_EN_MAX_NAME = 80;
function reportEnNames_() {
  const st = settings_(), parse = k => { try { const o = JSON.parse(st[k] || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } };
  return { company: String(st.companyNameEn || ''), reps: parse('repsEn'), products: parse('productsEn') };
}
// Admin: the names screen (current English names next to the Arabic ones).
function reportEnSetup_() {
  const n = reportEnNames_();
  return { companyName: settings_().companyName || '', companyNameEn: n.company,
    reps: dbAll_('Reps').filter(r => String(r.active) !== 'false').map(r => ({ id: r.id, name: r.name, en: n.reps[r.id] || '' })),
    products: dbAll_('Products').map(p => ({ id: p.id, name: p.name, en: n.products[p.id] || '', off: p.status === 'متوقف' })) };
}
function reportEnSaveNames_(s, p) {
  const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, REPORT_EN_MAX_NAME);
  const map = (o, ids) => { const out = {}; Object.keys(o || {}).forEach(k => { const v = clean(o[k]); if (v && ids[k]) out[k] = v; }); return out; };
  const repIds = {}, prodIds = {}; dbAll_('Reps').forEach(r => { repIds[r.id] = 1; }); dbAll_('Products').forEach(x => { prodIds[x.id] = 1; });
  dbUpsert_('Settings', 'key', { key: 'companyNameEn', value: clean(p.companyNameEn) });
  dbUpsert_('Settings', 'key', { key: 'repsEn', value: JSON.stringify(map(p.reps, repIds)) });
  dbUpsert_('Settings', 'key', { key: 'productsEn', value: JSON.stringify(map(p.products, prodIds)) });
  clearCache_(); audit_(s, 'report_en_names', '');
  return true;
}
function reportEn_(s, p) {
  const ym = /^\d{4}-\d{2}$/.test(String(p.ym || '')) ? p.ym : today_().slice(0, 7);
  if (ym > today_().slice(0, 7)) throw new Error('لا يمكن إصدار تقرير لشهر لم يبدأ بعد.');
  if (p.names) reportEnSaveNames_(s, p.names);
  const last = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5), 0)).getUTCDate(), from = ym + '-01', to = ym + '-' + ('0' + last).slice(-2);
  const names = reportEnNames_(), st = settings_();
  const sent = reportsLight_().filter(r => r.date >= from && r.date <= to && PLAN_SENT.indexOf(r.status) >= 0), cols = reportVisitColumns_(sent);
  const byRep = {}; sent.forEach(r => { const b = byRep[r.repId] || (byRep[r.repId] = { d: [], p: [] }); b.d.push.apply(b.d, cols[r.id].doctors); b.p.push.apply(b.p, cols[r.id].pharmacies); });
  const perf = {}; performance_(null, { from: from, to: to }).forEach(r => { perf[r.repId] = r; });
  const vis = {}; Object.keys(byRep).forEach(k => { vis[k] = byRep[k].d; });
  const reps = dbAll_('Reps').filter(r => String(r.active) !== 'false'), cov = {};
  planCoverageCore_(reps, planRows_(), vis, from, to, planCtx_()).forEach(c => { cov[c.repId] = c.pct; });
  const repRows = reps.map(rep => {
    const b = byRep[rep.id] || { d: [], p: [] }, pf = perf[rep.id] || {}, c = pf.compliance || { expected: 0, onTime: 0, pct: 0 };
    const uniq = {}; b.d.forEach(v => { const k = v.doctorId || normName_(v.name); if (k) uniq[k] = 1; });
    return { name: names.reps[rep.id] || rep.name, workDays: pf.off ? +(+pf.off.avail).toFixed(1) : 0, onTime: c.onTime, expected: c.expected, compliance: c.pct,
      doctorVisits: b.d.length, pharmacyVisits: b.p.length, uniqueDoctors: Object.keys(uniq).length, coverage: cov[rep.id] == null ? null : cov[rep.id], score: pf.score == null ? null : pf.score };
  });
  // Products: every product in the list, plus any product name found in the month's visits (renamed or removed later).
  const prodRows = {}, order = [];
  const row = name => { const k = String(name || '').trim(); if (!k || k === '—') return null; if (!prodRows[k]) { prodRows[k] = { name: k, detailing: 0, reminders: 0, samples: 0, pharmacyVisits: 0, orders: 0 }; order.push(k); } return prodRows[k]; };
  const enByName = {}; dbAll_('Products').forEach(x => { row(x.name); if (names.products[x.id]) enByName[String(x.name).trim()] = names.products[x.id]; });
  Object.keys(byRep).forEach(k => {
    byRep[k].d.forEach(v => {
      const a = row(v.intro); if (a) a.detailing++;
      const m = row(v.remind); if (m) m.reminders++;
      const list = Array.isArray(v.samples) ? v.samples : [v.s1, v.s2].filter(Boolean).map(x => ({ product: x, qty: 1 }));
      list.forEach(x => { const r = row(x && x.product); if (r) r.samples += Math.max(1, Math.min(99, Math.round(+x.qty) || 1)); });
    });
    byRep[k].p.forEach(v => { const r = row(v.product); if (r) { r.pharmacyVisits++; if (String(v.order || '').trim()) r.orders++; } });
  });
  // Products with no activity stay in the table (zeros): the principal sees its whole range.
  const products = order.map(k => Object.assign(prodRows[k], { name: enByName[k] || k }));
  const sum = (a, k) => a.reduce((n, r) => n + (+r[k] || 0), 0);
  audit_(s, 'report_en', ym);
  return { ym: ym, from: from, to: to, company: names.company || st.companyName || '', generatedAt: new Date().toISOString(),
    reps: repRows, products: products,
    totals: { doctorVisits: sum(repRows, 'doctorVisits'), pharmacyVisits: sum(repRows, 'pharmacyVisits'), reps: repRows.length,
      detailing: sum(products, 'detailing'), reminders: sum(products, 'reminders'), samples: sum(products, 'samples'), orders: sum(products, 'orders') } };
}
