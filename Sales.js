// MedRep Pro — distributor sales against visits. The admin pastes the distributor's monthly Excel sheet (date, region, customer /
// pharmacy, product, [active ingredient], quantity, unit price, total). Customers and products are matched to our pharmacies and
// products by name; names that differ are linked once by the admin and remembered (SalesAlias). Each paste is a batch that can be
// removed whole; a row already imported is never added twice. The analysis compares sales with the visits of the same period:
// by product, by region, by pharmacy (buys but not visited / visited but not buying / both) and by rep.

const SALES_MAX_ROWS = 5000, SALES_SENT = ['مرسل', 'معتمد'];

/* ---------- parsing ---------- */
function salesNum_(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[٬,\s]|د\.?\s*ل|LYD/gi, '').replace('٫', '.');
  return s === '' ? NaN : Number(s);
}
function salesDate_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
  const s = String(v == null ? '' : v).trim().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  if (/^\d{5}$/.test(s)) return Utilities.formatDate(new Date(Date.UTC(1899, 11, 30) + +s * 864e5), 'UTC', 'yyyy-MM-dd'); // Excel serial day
  return '';
}
const salesKeyName_ = t => normName_(String(t || '').replace(/^\s*صيدلي(ة|ه)\s+/, ''));
// 8 columns (with the active ingredient) or 7 (without it).
function salesParse_(rows) {
  const out = [], invalid = [];
  (rows || []).slice(0, SALES_MAX_ROWS + 1).forEach((cells, i) => {
    const c = (Array.isArray(cells) ? cells : []).map(x => (x == null ? '' : x)), line = i + 1;
    if (!c.some(x => String(x).trim())) return;
    // Header row; a total row ("المجموع الكلي" in any column, or no date and no customer).
    if (/التاريخ|date/i.test(String(c[0])) || /المجموع|grand total|^total$/i.test(c.join(' ').trim()) || c.some(x => /المجموع/.test(String(x)))) return;
    if (!String(c[0]).trim() && !String(c[2]).trim()) return;
    const f = c.length >= 8 ? [0, 1, 2, 3, 5, 6, 7] : [0, 1, 2, 3, 4, 5, 6];
    const date = salesDate_(c[f[0]]), qty = salesNum_(c[f[4]]), price0 = salesNum_(c[f[5]]), total0 = salesNum_(c[f[6]]);
    const customer = String(c[f[2]]).replace(/\s+/g, ' ').trim().slice(0, 120), product = String(c[f[3]]).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!date) { invalid.push({ line: line, reason: 'تاريخ غير مفهوم: ' + String(c[f[0]]).slice(0, 20) }); return; }
    if (!customer || !product) { invalid.push({ line: line, reason: 'العميل أو الصنف فارغ' }); return; }
    if (!isFinite(qty) || qty <= 0) { invalid.push({ line: line, reason: 'الكمية غير صحيحة' }); return; }
    const total = isFinite(total0) ? total0 : (isFinite(price0) ? price0 * qty : 0), price = isFinite(price0) ? price0 : (qty ? total / qty : 0);
    out.push({ line: line, date: date, region: String(c[f[1]]).replace(/\s+/g, ' ').trim().slice(0, 60), customer: customer, product: product,
      qty: Math.round(qty * 100) / 100, price: Math.round(price * 100) / 100, total: Math.round(total * 100) / 100 });
  });
  if (out.length + invalid.length > SALES_MAX_ROWS) throw new Error('أقصى عدد في المرة الواحدة ' + SALES_MAX_ROWS + ' سطر.');
  return { rows: out, invalid: invalid };
}

/* ---------- matching ---------- */
function salesAliases_() {
  ensureSheet_('SalesAlias');
  const m = { ph: {}, prod: {} };
  dbAll_('SalesAlias').forEach(a => { if (m[a.kind]) m[a.kind][String(a.raw)] = String(a.targetId || ''); });
  return m;
}
function salesMatcher_() {
  const al = salesAliases_(), phs = dbAll_('Pharmacies'), prods = dbAll_('Products'), phBy = {}, prBy = {};
  phs.forEach(p => { const k = salesKeyName_(p.name); if (!k) return; (phBy[k] = phBy[k] || []).push(p); });
  prods.forEach(p => { const k = normName_(p.name); if (k) (prBy[k] = prBy[k] || []).push(p); });
  return {
    ph: raw => { const k = salesKeyName_(raw); if (k in al.ph) return al.ph[k]; const hit = phBy[k] || []; return hit.length === 1 ? String(hit[0].id) : ''; },
    prod: raw => {
      const k = normName_(raw); if (k in al.prod) return al.prod[k];
      let hit = prBy[k] || [];
      if (!hit.length) hit = prods.filter(p => { const n = normName_(p.name); return n && (n.indexOf(k + ' ') === 0 || k.indexOf(n + ' ') === 0); });
      return hit.length === 1 ? String(hit[0].id) : '';
    },
    phs: phs, prods: prods
  };
}
const salesDupKey_ = r => [r.date, salesKeyName_(r.customer), normName_(r.product), +r.qty, +r.total].join('|');

/* ---------- import ---------- */
function salesImport_(s, p) {
  ensureSheet_('Sales');
  const lock = p.commit ? acquireLock_(30000) : null;
  try {
    if (p.commit && p.map) salesSaveAliases_(s, p.map);
    const parsed = salesParse_(p.rows), M = salesMatcher_(), seen = {};
    dbAll_('Sales').forEach(r => { seen[salesDupKey_(r)] = 1; });
    const add = [], unPh = {}, unPr = {};
    let dup = 0;
    parsed.rows.forEach(r => {
      const k = salesDupKey_(r); if (seen[k]) { dup++; return; } seen[k] = 1;
      r.pharmacyId = M.ph(r.customer); r.productId = M.prod(r.product);
      if (!r.pharmacyId) { const u = unPh[r.customer] || (unPh[r.customer] = { raw: r.customer, region: r.region, rows: 0, qty: 0 }); u.rows++; u.qty += r.qty; }
      if (!r.productId) { const u = unPr[r.product] || (unPr[r.product] = { raw: r.product, rows: 0, qty: 0 }); u.rows++; u.qty += r.qty; }
      add.push(r);
    });
    const dates = add.map(r => r.date).sort(), sum = k => Math.round(add.reduce((n, r) => n + r[k], 0) * 100) / 100;
    const res = { add: add.length, dup: dup, invalid: parsed.invalid, qty: sum('qty'), value: sum('total'), from: dates[0] || '', to: dates[dates.length - 1] || '',
      matchedPh: add.filter(r => r.pharmacyId).length, matchedProd: add.filter(r => r.productId).length,
      unmatched: { ph: Object.keys(unPh).map(k => unPh[k]), prod: Object.keys(unPr).map(k => unPr[k]) } };
    if (!p.commit) return Object.assign(res, {
      pharmacies: M.phs.filter(x => String(x.active) !== 'false').map(x => ({ id: x.id, name: x.name, loc: x.location || '' })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar')),
      products: M.prods.map(x => ({ id: x.id, name: x.name })) });
    if (!add.length) return Object.assign(res, { added: 0 });
    const now = new Date().toISOString(), batch = 'SB-' + now.slice(0, 10).replace(/-/g, '') + '-' + now.slice(11, 19).replace(/:/g, '');
    const values = add.map((r, i) => {
      const o = Object.assign({}, r, { id: batch + '-' + (i + 1), batch: batch, importedAt: now, importedBy: s.uid });
      return T.Sales.map(c => (o[c] === undefined ? '' : o[c]));
    });
    const sh = sheet_('Sales'); sh.getRange(sh.getLastRow() + 1, 1, values.length, T.Sales.length).setValues(values);
    dropTableCache_('Sales'); if (_RM) delete _RM.Sales;
    audit_(s, 'sales_import', batch, add.length + ' rows · ' + res.qty + ' units');
    return Object.assign(res, { added: add.length, batch: batch });
  } finally { if (lock) lock.releaseLock(); }
}
// map = {ph: {rawName: pharmacyId | ''}, prod: {rawName: productId | ''}}; '' clears a link. Ids must exist.
function salesSaveAliases_(s, map) {
  ensureSheet_('SalesAlias');
  const ok = { ph: {}, prod: {} }; dbAll_('Pharmacies').forEach(x => { ok.ph[x.id] = 1; }); dbAll_('Products').forEach(x => { ok.prod[x.id] = 1; });
  const now = new Date().toISOString(), cur = dbAll_('SalesAlias');
  ['ph', 'prod'].forEach(kind => Object.keys((map && map[kind]) || {}).forEach(raw => {
    const id = String(map[kind][raw] || ''); if (id && !ok[kind][id]) return;
    const key = kind === 'ph' ? salesKeyName_(raw) : normName_(raw); if (!key) return;
    const row = { kind: kind, raw: key, targetId: id, createdAt: now, createdBy: s.uid };
    const at = cur.findIndex(a => a.kind === kind && String(a.raw) === key);
    if (at >= 0) { const sh = sheet_('SalesAlias'); sh.getRange(at + 2, 1, 1, T.SalesAlias.length).setValues([T.SalesAlias.map(c => row[c])]); cur[at] = row; }
    else { dbAppend_('SalesAlias', row); cur.push(row); }
  }));
  dropTableCache_('SalesAlias'); if (_RM) delete _RM.SalesAlias;
}
function salesBatches_() {
  ensureSheet_('Sales');
  const by = {};
  dbAll_('Sales').forEach(r => {
    const b = by[r.batch] || (by[r.batch] = { batch: r.batch, importedAt: r.importedAt, rows: 0, qty: 0, value: 0, from: r.date, to: r.date });
    b.rows++; b.qty += +r.qty || 0; b.value += +r.total || 0; if (r.date < b.from) b.from = r.date; if (r.date > b.to) b.to = r.date;
  });
  return Object.keys(by).map(k => Object.assign(by[k], { value: Math.round(by[k].value * 100) / 100 })).sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
}
function salesDeleteBatch_(s, p) {
  const batch = String(p.batch || ''); if (!/^SB-\d{8}-\d{6}$/.test(batch)) throw new Error('الدفعة غير صالحة.');
  const lock = acquireLock_(30000);
  try {
    // A batch's rows were appended together: delete them run by run from the bottom (row numbers above stay valid).
    const sh = sheet_('Sales'), all = sh.getDataRange().getValues(), bi = T.Sales.indexOf('batch');
    let removed = 0;
    for (let i = all.length - 1; i >= 1;) {
      if (String(all[i][bi]) !== batch) { i--; continue; }
      let j = i; while (j - 1 >= 1 && String(all[j - 1][bi]) === batch) j--;
      sh.deleteRows(j + 1, i - j + 1); removed += i - j + 1; i = j - 1;
    }
    if (!removed) throw new Error('الدفعة غير موجودة.');
    dropTableCache_('Sales'); if (_RM) delete _RM.Sales;
    audit_(s, 'sales_delete_batch', batch, String(removed));
    return removed;
  } finally { lock.releaseLock(); }
}

/* ---------- analysis: sales against visits for a period ---------- */
function salesAnalysis_(s, p) {
  ensureSheet_('Sales');
  const per = planPeriod_(p), sales = dbAll_('Sales').filter(r => r.date >= per.from && r.date <= per.to);
  const prodName = {}; dbAll_('Products').forEach(x => { prodName[x.id] = x.name; });
  const phName = {}; dbAll_('Pharmacies').forEach(x => { phName[x.id] = x.name; });
  const visits = marketVisits_(per.from, per.to), r2 = n => Math.round(n * 100) / 100;
  // visits per pharmacy and per rep; product promotion counts
  const phVis = {}, repPh = {}, promo = {};
  const bump = (name, k) => { const n = String(name || '').trim(); if (!n || n === '—') return; (promo[n] = promo[n] || { doctor: 0, pharmacy: 0 })[k]++; };
  visits.forEach(x => {
    x.docs.forEach(v => { bump(v.intro, 'doctor'); if (v.remind !== v.intro) bump(v.remind, 'doctor'); });
    x.phs.forEach(v => {
      bump(v.product, 'pharmacy');
      const id = v.pharmacyId ? String(v.pharmacyId) : ''; if (!id) return;
      const b = phVis[id] || (phVis[id] = { visits: 0, reps: {} }); b.visits++; b.reps[x.rep] = 1;
      (repPh[x.rep] = repPh[x.rep] || {})[id] = 1;
    });
  });
  // sales per product, region, pharmacy
  const byProd = {}, byRegion = {}, byPh = {};
  sales.forEach(r => {
    const pn = r.productId && prodName[r.productId] ? prodName[r.productId] : r.product;
    const a = byProd[pn] || (byProd[pn] = { product: pn, qty: 0, value: 0, linked: !!(r.productId && prodName[r.productId]) }); a.qty += +r.qty; a.value += +r.total;
    const reg = r.region || 'غير محددة', g = byRegion[reg] || (byRegion[reg] = { region: reg, qty: 0, value: 0, ph: {} }); g.qty += +r.qty; g.value += +r.total;
    const key = r.pharmacyId && phName[r.pharmacyId] ? String(r.pharmacyId) : 'raw:' + salesKeyName_(r.customer);
    g.ph[key] = 1;
    const h = byPh[key] || (byPh[key] = { key: key, name: key.indexOf('raw:') === 0 ? r.customer : phName[r.pharmacyId], region: r.region, qty: 0, value: 0, linked: key.indexOf('raw:') !== 0 });
    h.qty += +r.qty; h.value += +r.total;
  });
  const products = Object.keys(Object.assign({}, byProd, promo)).map(n => {
    const a = byProd[n] || { qty: 0, value: 0 }, m = promo[n] || { doctor: 0, pharmacy: 0 };
    return { product: n, qty: r2(a.qty), value: r2(a.value), doctorPromo: m.doctor, pharmacyVisits: m.pharmacy };
  }).sort((a, b) => b.value - a.value || (b.doctorPromo + b.pharmacyVisits) - (a.doctorPromo + a.pharmacyVisits));
  const regions = Object.keys(byRegion).map(k => {
    const g = byRegion[k], ids = Object.keys(g.ph), visited = ids.filter(id => phVis[id]);
    return { region: k, qty: r2(g.qty), value: r2(g.value), pharmacies: ids.length, visitedPharmacies: visited.length, visits: visited.reduce((n, id) => n + phVis[id].visits, 0) };
  }).sort((a, b) => b.value - a.value);
  const buyNoVisit = [], both = [];
  Object.keys(byPh).forEach(k => { const h = byPh[k], v = phVis[k]; const row = { name: h.name, region: h.region, qty: r2(h.qty), value: r2(h.value), linked: h.linked };
    if (v) both.push(Object.assign(row, { visits: v.visits, reps: Object.keys(v.reps).join('، ') })); else buyNoVisit.push(row); });
  const visitNoBuy = Object.keys(phVis).filter(id => !byPh[id]).map(id => ({ name: phName[id] || id, visits: phVis[id].visits, reps: Object.keys(phVis[id].reps).join('، ') }));
  const reps = Object.keys(repPh).map(rep => {
    const ids = Object.keys(repPh[rep]), buying = ids.filter(id => byPh[id]);
    return { rep: rep, visitedPharmacies: ids.length, buying: buying.length, qty: r2(buying.reduce((n, id) => n + byPh[id].qty, 0)), value: r2(buying.reduce((n, id) => n + byPh[id].value, 0)) };
  }).sort((a, b) => b.value - a.value);
  const sum = k => r2(sales.reduce((n, r) => n + (+r[k] || 0), 0));
  return { from: per.from, to: per.to, totals: { rows: sales.length, qty: sum('qty'), value: sum('total'), unlinked: sales.filter(r => !(r.pharmacyId && phName[r.pharmacyId])).length },
    products: products, regions: regions,
    pharmacies: { buyNoVisit: buyNoVisit.sort((a, b) => b.value - a.value), visitNoBuy: visitNoBuy.sort((a, b) => b.visits - a.visits), both: both.sort((a, b) => b.value - a.value) },
    reps: reps, batches: salesBatches_() };
}
// For the English report: units and value per product name in a month.
function salesByProduct_(from, to) {
  const sh = sheet_('Sales'); if (!sh || sh.getLastRow() < 2) return {};
  const prodName = {}; dbAll_('Products').forEach(x => { prodName[x.id] = x.name; });
  const out = {};
  dbAll_('Sales').filter(r => r.date >= from && r.date <= to).forEach(r => {
    const n = r.productId && prodName[r.productId] ? prodName[r.productId] : r.product, a = out[n] || (out[n] = { qty: 0, value: 0 });
    a.qty += +r.qty; a.value += +r.total;
  });
  return out;
}
