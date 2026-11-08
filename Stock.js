// MedRep Pro — free-sample stock per rep. The admin records what each rep receives (تسليم), gives back (إرجاع) and the physical
// count (جرد); what the rep hands out is read from the samples already recorded in doctor visits (every report, drafts included:
// the sample left the rep's bag at the visit). Balance = issued − returned ± count corrections − handed out.
// Each rep × product starts on the date of its first move, so visits made before the stock was set up never count.
// Going below zero is allowed (the visit is always saved); it is shown in red to the admin and listed in the Telegram summary.

const STOCK_TYPES = { issue: 'تسليم', ret: 'إرجاع', count: 'جرد' }, STOCK_MAX = 100000;

function stockMoves_(repId) { ensureSheet_('SampleMoves'); return dbAll_('SampleMoves').filter(m => !repId || String(m.repId) === String(repId)); }
// Signed effect of one move on the balance.
const stockSign_ = m => (m.type === STOCK_TYPES.ret ? -1 : 1) * (+m.qty || 0);

// Samples handed out per rep × product since that pair's start date, from the visit columns of the reps' reports.
function stockUsed_(starts) {
  const reps = {}; Object.keys(starts).forEach(k => { const r = k.split('|')[0]; if (!reps[r] || starts[k] < reps[r]) reps[r] = starts[k]; });
  const rows = reportsLight_().filter(r => reps[r.repId] && r.date >= reps[r.repId]);
  const cols = reportVisitColumns_(rows), used = {};
  rows.forEach(r => (cols[r.id].doctors || []).forEach(v => {
    const list = Array.isArray(v.samples) ? v.samples : [v.s1, v.s2].filter(Boolean).map(p => ({ product: p, qty: 1 }));
    list.forEach(x => {
      const key = r.repId + '|' + String((x && x.product) || '').trim();
      if (starts[key] && r.date >= starts[key]) used[key] = (used[key] || 0) + Math.max(1, Math.min(99, Math.round(+x.qty) || 1));
    });
  }));
  return used;
}
function stockBalances_(repId) {
  const moves = stockMoves_(repId), pairs = {};
  moves.forEach(m => {
    const k = m.repId + '|' + String(m.product).trim(), p = pairs[k] || (pairs[k] = { repId: m.repId, product: String(m.product).trim(), start: m.date, issued: 0, returned: 0, adjusted: 0 });
    if (m.date < p.start) p.start = m.date;
    if (m.type === STOCK_TYPES.issue) p.issued += +m.qty || 0; else if (m.type === STOCK_TYPES.ret) p.returned += +m.qty || 0; else p.adjusted += +m.qty || 0;
  });
  const starts = {}; Object.keys(pairs).forEach(k => { starts[k] = pairs[k].start; });
  const used = Object.keys(pairs).length ? stockUsed_(starts) : {}, names = {};
  dbAll_('Reps').forEach(r => { names[r.id] = r.name; });
  return Object.keys(pairs).map(k => {
    const p = pairs[k], u = used[k] || 0;
    return Object.assign(p, { repName: names[p.repId] || p.repId, used: u, balance: p.issued - p.returned + p.adjusted - u });
  }).sort((a, b) => String(a.repName).localeCompare(String(b.repName), 'ar') || String(a.product).localeCompare(String(b.product), 'ar'));
}

/* ---------- routes ---------- */
function stockList_(s, p) {
  return { balances: stockBalances_(p.repId || ''), products: dbAll_('Products').filter(x => x.status !== 'متوقف').map(x => x.name) };
}
function stockHistory_(s, p) {
  if (!p.repId) throw new Error('اختر المندوب.');
  return stockMoves_(p.repId).sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1)).slice(0, 300);
}
function myStock_(s) { return stockBalances_(s.uid).map(b => ({ product: b.product, balance: b.balance, issued: b.issued, used: b.used })); }
// op: issue | ret (qty 1..100000) | count (the counted quantity, 0..100000: the move stores the difference from the current balance).
function stockMove_(s, p) {
  const type = STOCK_TYPES[p.op]; if (!type) throw new Error('نوع الحركة غير صالح.');
  ensureSheet_('SampleMoves');
  if (!dbAll_('Reps').some(r => String(r.id) === String(p.repId))) throw new Error('المندوب غير موجود.');
  const product = String(p.product || '').trim();
  if (!dbAll_('Products').some(x => String(x.name).trim() === product)) throw new Error('المنتج غير موجود في قائمة المنتجات.');
  const n = Number(p.qty);
  if (!Number.isInteger(n) || n < (p.op === 'count' ? 0 : 1) || n > STOCK_MAX) throw new Error(p.op === 'count' ? 'أدخل العدد الفعلي (0 أو أكثر).' : 'أدخل كمية صحيحة (1 أو أكثر).');
  const date = isDate_(p.date) ? p.date : today_();
  if (date > today_()) throw new Error('لا يمكن تسجيل حركة بتاريخ لاحق.');
  const lock = acquireLock_(20000);
  try {
    let qty = n, note = String(p.note || '').trim().slice(0, 200);
    if (p.op === 'count') {
      const cur = stockBalances_(p.repId).find(b => b.product === product);
      if (!cur) throw new Error('لا يوجد رصيد سابق لهذا المنتج عند المندوب. سجّل «تسليم» أولًا.');
      qty = n - cur.balance; if (!qty) return { changed: 0, balance: cur.balance };
      note = ('العدد الفعلي ' + n + ' (كان في النظام ' + cur.balance + ')' + (note ? ' · ' + note : '')).slice(0, 200);
    }
    const id = 'SM-' + Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
    dbAppend_('SampleMoves', { id: id, repId: p.repId, product: product, qty: qty, type: type, note: note, date: date, createdAt: new Date().toISOString(), createdBy: s.uid });
    audit_(s, 'stock_' + p.op, p.repId + ' ' + product, String(qty));
    const b = stockBalances_(p.repId).find(x => x.product === product);
    return { changed: 1, balance: b ? b.balance : 0 };
  } finally { lock.releaseLock(); }
}
// For the daily Telegram summary: "name (product −3)" for every rep × product below zero.
function stockOverText_() {
  try {
    const over = stockBalances_('').filter(b => b.balance < 0);
    return over.length ? over.map(b => b.repName + ' (' + b.product + ' ' + b.balance + ')').join('، ') : '';
  } catch (e) { return ''; }
}
