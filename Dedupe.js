// MedRep Pro — protection against duplicate doctors and pharmacies.
// nameKey_ is a stronger comparison key than normName_ (kept unchanged: stored sales links depend on it): no titles in any form
// (الدكتور، دكتور، د/، Dr, صيدلية), no punctuation, «ال» dropped from words, «عبد الله / عبدالله» and «أبو بكر / ابوبكر» joined.
// Same key = the same record (the existing one is used). A similar name (one or two letters apart, an extra middle name, another
// word order) is offered to the rep as «هل تقصد؟» before a new record is created; the admin gets a list of likely duplicates to merge.

function nameKey_(t, sheet) {
  let s = normName_(t).replace(/[.\-_/\\,،:;()\[\]"'«»]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:ال)?(?:دكتوره|دكتور|طبيبه|طبيب|د|dr|doctor)\s+/, '');
  if (sheet === 'Pharmacies') s = s.replace(/^(?:ال)?(?:صيدليه|pharmacy)\s+/, '');
  s = s.replace(/(^|\s)عبد\s+/g, '$1عبد').replace(/(^|\s)ابو\s+/g, '$1ابو');
  return s.split(' ').filter(Boolean).map(w => (w.length > 3 ? w.replace(/^ال/, '') : w)).join(' ');
}
function nameLev_(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Two keys that probably name the same person or pharmacy (but are not equal).
function nameSimilar_(a, b) {
  if (!a || !b || a === b) return false;
  const ta = a.split(' '), tb = b.split(' '), [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (s.length >= 2 && s.every(w => l.indexOf(w) >= 0)) return true; // an extra middle name, or another order
  const d = nameLev_(a.replace(/ /g, ''), b.replace(/ /g, ''));
  return d <= (Math.max(a.length, b.length) >= 12 ? 2 : 1);
}
function similarMasters_(rows, name, sheet) {
  const k = nameKey_(name, sheet);
  return rows.filter(r => String(r.active) !== 'false' && nameSimilar_(k, nameKey_(r.name, sheet))).slice(0, 3)
    .map(r => ({ id: r.id, name: r.name, specialty: r.specialty || '', location: r.location || '' }));
}
// Admin: groups of active records whose names are equal by key or similar. Only names sharing a word are compared.
function duplicateCandidates_(s, p) {
  const sheet = p.entity === 'Pharmacies' ? 'Pharmacies' : 'Doctors';
  const rows = dbAll_(sheet).filter(r => String(r.active) !== 'false'), keys = rows.map(r => nameKey_(r.name, sheet)), byWord = {};
  keys.forEach((k, i) => k.split(' ').forEach(w => { if (w.length > 1) (byWord[w] = byWord[w] || []).push(i); }));
  const pairs = {}, out = [];
  keys.forEach((k, i) => {
    const seen = {};
    k.split(' ').forEach(w => (byWord[w] || []).forEach(j => {
      if (j <= i || seen[j]) return; seen[j] = 1;
      if (keys[j] === k || nameSimilar_(k, keys[j])) pairs[i + '|' + j] = 1;
    }));
  });
  // Single-word names share no second word: compare them by spelling only.
  const single = keys.map((k, i) => (k.indexOf(' ') < 0 ? i : -1)).filter(i => i >= 0);
  single.forEach((i, x) => single.slice(x + 1).forEach(j => { if (keys[i] === keys[j] || nameSimilar_(keys[i], keys[j])) pairs[i + '|' + j] = 1; }));
  Object.keys(pairs).forEach(k => { const [i, j] = k.split('|').map(Number);
    out.push({ a: { id: rows[i].id, name: rows[i].name, specialty: rows[i].specialty || '', location: rows[i].location || '' },
      b: { id: rows[j].id, name: rows[j].name, specialty: rows[j].specialty || '', location: rows[j].location || '' }, same: keys[i] === keys[j] }); });
  return out.sort((x, y) => (y.same ? 1 : 0) - (x.same ? 1 : 0) || String(x.a.name).localeCompare(String(y.a.name), 'ar')).slice(0, 200);
}
