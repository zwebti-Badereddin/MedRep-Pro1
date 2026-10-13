// MedRep Pro — admin export of visits (one row per visit) for Excel. Read-only; allowed after the license ends too.

const EXPORT_MAX_DAYS = 366, EXPORT_MAX_ROWS = 20000;
const EXPORT_HEADER = ['رقم التقرير', 'التاريخ', 'المندوب', 'حالة التقرير', 'نوع الزيارة', 'م', 'الاسم', 'التخصص', 'مكان العمل / العنوان', 'أقرب منشأة',
  'القطاع', 'وقت الزيارة', 'المنتج المعرَّف به', 'المنتج المذكَّر به', 'العينات المجانية', 'النشاط داخل الصيدلية', 'الطلبية', 'التحقق من الموقع', 'المسافة (م)', 'ملاحظة اليوم'];

// Samples [{product, qty}] (or legacy s1/s2) as "Product ×2 · Other", merged by product.
function exportSamplesText_(v) {
  const list = Array.isArray(v.samples) ? v.samples : [v.s1, v.s2].filter(Boolean).map(p => ({ product: p, qty: 1 }));
  const sum = {}, order = [];
  list.forEach(x => { const p = String((x && x.product) || '').trim(); if (!p || p === '—') return;
    if (!(p in sum)) { sum[p] = 0; order.push(p); } sum[p] += Math.max(1, Math.min(99, Math.round(+x.qty) || 1)); });
  return order.map(p => p + (sum[p] > 1 ? ' ×' + sum[p] : '')).join(' · ');
}
// Pure: report rows (as stored) -> [header, ...visit rows].
function exportVisitRows_(reports, repNames) {
  const S = x => (x == null || x === '—' ? '' : String(x));
  const out = [EXPORT_HEADER.slice()];
  reports.forEach(r => {
    const base = [S(r.no), S(r.date), S(repNames[r.repId] || r.repId), S(r.status)];
    const json = t => { try { const a = JSON.parse(t || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
    const gps = v => { const g = v.gps || {}; return [g.status ? S(g.status) : 'لم يُتحقق بعد', isFinite(+g.dist) && g.dist !== '' && g.dist != null ? Math.round(+g.dist) : '']; };
    json(r.doctors).forEach((v, i) => out.push(base.concat(['طبيب', i + 1, S(v.name), S(v.specialty), S(v.place), '', S(v.sector), S(v.time), S(v.intro), S(v.remind),
      exportSamplesText_(v), '', ''], gps(v), [i === 0 ? S(r.notes) : ''])));
    json(r.pharmacies).forEach((v, i) => out.push(base.concat(['صيدلية', i + 1, S(v.name), '', S(v.loc), S(v.near), '', S(v.time), S(v.product), '',
      '', S(v.act), S(v.order)], gps(v), [i === 0 && !json(r.doctors).length ? S(r.notes) : ''])));
  });
  return out;
}
function exportVisits_(s, p) {
  const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  if (!ok(p.from) || !ok(p.to) || p.from > p.to) throw new Error('اختر فترة صحيحة (من … إلى …).');
  if ((Date.parse(p.to) - Date.parse(p.from)) / 864e5 > EXPORT_MAX_DAYS) throw new Error('أقصى فترة للتصدير سنة واحدة.');
  const reps = repNames_();
  const rows = dbAll_('Reports').filter(r => r.date >= p.from && r.date <= p.to && (!p.repId || r.repId === p.repId) && (!p.status || r.status === p.status))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.no).localeCompare(String(b.no))));
  const out = exportVisitRows_(rows, reps);
  if (out.length - 1 > EXPORT_MAX_ROWS) throw new Error('عدد الزيارات أكبر من ' + EXPORT_MAX_ROWS + '. قسّم الفترة إلى أجزاء أصغر.');
  audit_(s, 'export_visits', p.from + '..' + p.to, String(out.length - 1));
  return { rows: out, visits: out.length - 1, reports: rows.length };
}
