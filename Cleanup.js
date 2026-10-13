// MedRep Pro — test-data cleanup before the pilot (read-only preview + approved execution).

/*
 * Two steps, both owner-only and run from the Apps Script editor:
 *  1. previewTestDataCleanup()  READ-ONLY. Logs every row that would be deleted and an approval code.
 *  2. cleanupTestData()         Deletes exactly that plan, and only when the Script Property
 *     TEST_CLEANUP_APPROVED equals the approval code of the CURRENT data (any change since the preview = a new code).
 * What is removed:
 *  - every row of Reports, Monthly and Leaves (no real report exists before the pilot), and REPORT_SEQ restarts at 1;
 *  - the demo rows of setup() (two doctors, one pharmacy, three products), matched by exact name;
 *  - extra ids listed in the Script Property TEST_CLEANUP_EXTRA, e.g. {"Doctors":["DOC-0007"],"Facilities":["FAC-0003"],"Reps":["REP-0001"]};
 *  - what hangs on a removed doctor or facility: its DoctorWorkplaces links, DoctorPlaces rows and FacilityLocations history,
 *    and a facility whose ONLY links were removed (unless listed in TEST_CLEANUP_EXTRA.keep.Facilities).
 * Never touched: Settings, KPI, Admins, Holidays, Audit (the cleanup adds one entry), sheet headers.
 */
const CLEANUP_WIPE = ['Reports', 'Monthly', 'Leaves'];
const CLEANUP_DEMO = { Doctors: ['د. أحمد سالم', 'د. محمد علي'], Pharmacies: ['صيدلية الشفاء'], Products: ['CardioPlus', 'GastroCare', 'NeuroVit'] };
const CLEANUP_EXTRA_SHEETS = ['Doctors', 'Pharmacies', 'Products', 'Facilities', 'DoctorWorkplaces', 'Reps'];
const CLEANUP_ORDER = ['Reports', 'Monthly', 'Leaves', 'FacilityLocations', 'DoctorPlaces', 'DoctorWorkplaces', 'Facilities', 'Doctors', 'Pharmacies', 'Products', 'Reps'];

// Pure planner: t = { rows: {sheet: [row objects]}, extra: parsed TEST_CLEANUP_EXTRA, reportSeq }.
function testDataCleanupPlan_(t) {
  const S = x => String(x == null ? '' : x).trim(), rows = n => (t.rows && t.rows[n]) || [];
  const extra = t.extra || {}, keepFac = new Set(((extra.keep || {}).Facilities || []).map(S));
  const del = {}, why = {}, blockers = [], warnings = [];
  const mark = (n, r, reason) => { const id = S(r.id); if (!id || (del[n] = del[n] || new Set()).has(id)) return; del[n].add(id); (why[n] = why[n] || {})[id] = reason; };
  const has = (n, id) => !!del[n] && del[n].has(S(id));

  CLEANUP_WIPE.forEach(n => rows(n).forEach(r => mark(n, r, 'سجل تجربة')));
  // Demo names match like duplicate detection does (normName_: "د." prefix, hamza, spacing), ignoring invisible direction marks.
  const N = x => normName_(String(x == null ? '' : x).replace(/[​-‏‪-‮⁦-⁩﻿]/g, ''));
  Object.keys(CLEANUP_DEMO).forEach(n => CLEANUP_DEMO[n].forEach(name => {
    const hit = rows(n).filter(r => N(r.name) === N(name));
    hit.forEach(r => mark(n, r, 'بيانات setup التجريبية'));
    if (!hit.length) warnings.push({ type: 'demoNotFound', sheet: n, name: name, note: 'إن كان موجودًا باسم مختلف فأضف رقمه في TEST_CLEANUP_EXTRA.' });
  }));
  CLEANUP_EXTRA_SHEETS.forEach(n => (extra[n] || []).map(S).forEach(id => {
    const r = rows(n).find(x => S(x.id) === id);
    if (r) mark(n, r, 'مضاف في TEST_CLEANUP_EXTRA'); else warnings.push({ type: 'extraIdNotFound', sheet: n, id: id });
  }));
  // Cascade: links of removed doctors; facilities whose every link is gone; history rows of removed doctors and facilities.
  rows('DoctorWorkplaces').forEach(w => { if (has('Doctors', w.doctorId)) mark('DoctorWorkplaces', w, 'ارتباط طبيب محذوف'); });
  const linkFac = {}; rows('DoctorWorkplaces').forEach(w => { const f = S(w.facilityId); if (f) (linkFac[f] = linkFac[f] || []).push(w); });
  rows('Facilities').forEach(f => {
    const links = linkFac[S(f.id)] || [];
    if (links.length && links.every(w => has('DoctorWorkplaces', w.id)) && !keepFac.has(S(f.id))) mark('Facilities', f, 'لا يرتبط بها إلا روابط محذوفة');
  });
  // Legacy per-entity facility rows (pharmacy GPS references still live there) follow their removed pharmacy or doctor link.
  rows('Facilities').forEach(f => { if (has(f.legacyEntity === 'Pharmacies' ? 'Pharmacies' : f.legacyEntity === 'DoctorWorkplaces' ? 'DoctorWorkplaces' : '-', f.legacyId)
    && !keepFac.has(S(f.id)) && !(linkFac[S(f.id)] || []).some(w => !has('DoctorWorkplaces', w.id))) mark('Facilities', f, 'مرجع موقع قديم لعنصر محذوف'); });
  rows('DoctorWorkplaces').forEach(w => { if (!has('DoctorWorkplaces', w.id) && has('Facilities', w.facilityId)) blockers.push({ type: 'facilityStillLinked', facilityId: S(w.facilityId), workplaceId: S(w.id), doctorId: S(w.doctorId) }); });
  rows('Facilities').forEach(f => { if (!has('Facilities', f.id) && has('Facilities', f.mergedInto)) blockers.push({ type: 'mergedIntoRemovedFacility', facilityId: S(f.id), mergedInto: S(f.mergedInto) }); });
  rows('FacilityLocations').forEach(l => { if (has('Facilities', l.facilityId)) mark('FacilityLocations', l, 'سجل موقع منشأة محذوفة'); });
  rows('DoctorPlaces').forEach(p => { if (has('Doctors', p.doctorId) || has('Facilities', p.facilityId)) mark('DoctorPlaces', p, 'سجل قديم لطبيب أو منشأة محذوفة'); });
  rows('Products').forEach(p => { if (has('Products', p.id)) warnings.push({ type: 'productRemoved', name: S(p.name) }); });
  if (!rows('Products').some(p => !has('Products', p.id))) warnings.push({ type: 'noProductLeft', note: 'أضف منتجات الشركة الحقيقية قبل بدء التجربة.' });

  const sheets = {}, counts = {};
  CLEANUP_ORDER.forEach(n => {
    if (!del[n] || !del[n].size) return;
    counts[n] = del[n].size;
    sheets[n] = rows(n).filter(r => has(n, r.id)).map(r => {
      const o = { id: S(r.id), why: why[n][S(r.id)] };
      ['no', 'date', 'repId', 'name', 'doctorName', 'workplace', 'ym', 'facilityId'].forEach(k => { if (S(r[k])) o[k] = S(r[k]); });
      return o;
    });
  });
  const resetSeq = +t.reportSeq > 0;
  const keyList = CLEANUP_ORDER.filter(n => sheets[n]).map(n => n + ':' + sheets[n].map(x => x.id).sort().join(',')).join('|') + '|seq:' + (resetSeq ? S(t.reportSeq) : '0');
  return { ready: !blockers.length, empty: !Object.keys(counts).length && !resetSeq, counts: counts, resetReportSeq: resetSeq,
    sheets: sheets, blockers: blockers, warnings: warnings, keyList: keyList };
}

function testDataCleanupRead_() {
  const out = {};
  CLEANUP_ORDER.forEach(n => { const r = readByHeader_(n); out[n] = r.rows; });
  let extra = {}; const raw = PropertiesService.getScriptProperties().getProperty('TEST_CLEANUP_EXTRA');
  if (raw) { try { extra = JSON.parse(raw); } catch (e) { throw new Error('قيمة TEST_CLEANUP_EXTRA ليست JSON صالحًا: ' + raw.slice(0, 200)); } }
  return { rows: out, extra: extra, reportSeq: PropertiesService.getScriptProperties().getProperty('REPORT_SEQ') };
}
function testDataCleanupCode_(plan) {
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, plan.keyList);
  return 'CLEAN-' + b.slice(0, 5).map(x => ('0' + ((x + 256) % 256).toString(16)).slice(-2)).join('').toUpperCase();
}

// Owner-only, READ-ONLY. Run from the Apps Script editor; the plan and its approval code go to the execution log only.
function previewTestDataCleanup() {
  ownerOnly_();
  const plan = testDataCleanupPlan_(testDataCleanupRead_()), code = plan.empty ? '' : testDataCleanupCode_(plan);
  const out = { readOnly: true, ready: plan.ready, empty: plan.empty, approvalCode: code, counts: plan.counts, resetReportSeq: plan.resetReportSeq,
    blockers: plan.blockers, warnings: plan.warnings, rows: plan.sheets,
    next: plan.empty ? 'لا توجد بيانات تجربة للحذف.' : !plan.ready ? 'عالج الموانع أولًا ثم أعد المعاينة.'
      : 'بعد المراجعة والموافقة: أضف خاصية السكربت TEST_CLEANUP_APPROVED بالقيمة ' + code + ' ثم شغّل cleanupTestData.' };
  Logger.log('MEDREP_TEST_CLEANUP_PREVIEW\n' + JSON.stringify(out, null, 2));
  return out;
}

// Deletes data rows whose id is in ids (all data rows when ids is null), bottom-up, in contiguous runs.
function cleanupDeleteRows_(n, ids) {
  const sh = sheet_(n), last = sh ? sh.getLastRow() : 0; if (last < 2) return 0;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim()), ci = head.indexOf('id');
  if (ci < 0) throw new Error('لا يوجد عمود id في ' + n);
  const col = sh.getRange(2, ci + 1, last - 1, 1).getValues(), hit = [];
  col.forEach((r, i) => { if (ids === null || ids.has(String(r[0]).trim())) hit.push(i + 2); });
  if (!hit.length) return 0;
  if (sh.getMaxRows() - hit.length < 2) sh.insertRowsAfter(sh.getMaxRows(), 1); // Sheets refuses to delete every non-frozen row
  for (let j = hit.length - 1; j >= 0;) {
    let k = j; while (k > 0 && hit[k - 1] === hit[k] - 1) k--;
    if (j === k) sh.deleteRow(hit[k]); else sh.deleteRows(hit[k], j - k + 1);
    j = k - 1;
  }
  dropTableCache_(n); if (_RM) delete _RM[n];
  return hit.length;
}

function cleanupTestData() {
  ownerOnly_();
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const sp = PropertiesService.getScriptProperties(), approved = String(sp.getProperty('TEST_CLEANUP_APPROVED') || '').trim();
    const plan = testDataCleanupPlan_(testDataCleanupRead_());
    if (plan.empty) throw new Error('لا توجد بيانات تجربة للحذف. لم يُحذف شيء.');
    if (!plan.ready) throw new Error('توقف التنظيف دون أي حذف. الموانع: ' + JSON.stringify(plan.blockers).slice(0, 1500));
    const code = testDataCleanupCode_(plan);
    if (!approved) throw new Error('توقف التنظيف دون أي حذف: شغّل previewTestDataCleanup أولًا، ثم أضف خاصية السكربت TEST_CLEANUP_APPROVED برمز الموافقة.');
    if (approved !== code) throw new Error('توقف التنظيف دون أي حذف: البيانات تغيّرت منذ المعاينة (الرمز الحالي ' + code + '). أعد المعاينة وراجعها ثم حدّث TEST_CLEANUP_APPROVED.');
    weeklyBackup_(); // a full copy of the spreadsheet in "MedRep Backups" before the first delete
    const deleted = {};
    CLEANUP_ORDER.forEach(n => {
      if (!plan.sheets[n]) return;
      deleted[n] = cleanupDeleteRows_(n, CLEANUP_WIPE.indexOf(n) >= 0 ? null : new Set(plan.sheets[n].map(x => x.id)));
    });
    if (plan.resetReportSeq) sp.setProperty('REPORT_SEQ', '0');
    sp.deleteProperty('TEST_CLEANUP_APPROVED');
    _SHEETS = {}; clearCache_(); dropOffCache_();
    const after = testDataCleanupPlan_(testDataCleanupRead_());
    const out = { approvalCode: code, deleted: deleted, reportSeqReset: plan.resetReportSeq, backup: 'MedRep Backups', after: { empty: after.empty, counts: after.counts } };
    audit_({ uid: 'TEST_CLEANUP', role: 'system' }, 'cleanup_test_data', code, JSON.stringify(out));
    Logger.log('MEDREP_TEST_CLEANUP_DONE\n' + JSON.stringify(out, null, 2));
    return out;
  } finally { lock.releaseLock(); }
}
