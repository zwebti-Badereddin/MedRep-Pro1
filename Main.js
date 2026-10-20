// MedRep Pro — web app entry points: doGet, include, api() and the route table (built on first use).

/* ---------- transport ---------- */
// Used by Index.html: <?!= include('Style'); ?> pulls in the other HTML files (keeps every file small).
function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

function doGet(e) {
  // Diagnostic: open <web-app-url>?ping=1 -> plain text 'OK' proves the deployment itself works.
  if (e && e.parameter && e.parameter.ping) return ContentService.createTextOutput('OK ' + new Date().toISOString());
  const page = HtmlService.createTemplateFromFile('Index');
  try { page.support = supportContact_(); } catch (err) { page.support = ''; } // shown on the login screen; never blocks the page
  try { const t = String(settings_().theme || ''); page.theme = t === 'light' || t === 'dark' ? t : ''; } catch (err) { page.theme = ''; } // '' = follow the device
  const out = page.evaluate()
    .setTitle('MedRep Pro').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  // Tab / home-screen shortcut icon: the company logo when it is an https image URL. Never blocks the page.
  try { const logo = String(settings_().logo || ''); if (/^https:\/\//i.test(logo)) out.setFaviconUrl(logo); } catch (err) {}
  return out;
}

// Single entry point called by google.script.run.api(token, action, payload)
// Temporary performance instrumentation: logs action, elapsed time and outcome only.
// Never log tokens, payloads, user identifiers, or error messages.
let _PH = null; // per-request phase timings (ms), added to the perf log
function phase_(name, t0) { if (_PH) _PH[name] = (_PH[name] || 0) + (Date.now() - t0); }
function api(token, action, p) {
  const startedAt = Date.now();
  _PH = {};
  let outcome = 'error';
  const measuredAction = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(String(action || '')) ? String(action) : 'unknown';
  p = p || {};
  try {
    if (action === 'login') {
      const result = ok(login_(p));
      outcome = 'ok';
      return result;
    }
    let tS = Date.now();
    const s = session_(token); phase_('session', tS);
    const route = routes_()[action];
    if (!route) throw new Error('عملية غير معروفة');
    if (route.role !== 'any' && route.role !== s.role) throw new Error('غير مصرح');
    licenseGuard_(action);
    const result = ok(route.fn(s, p));
    outcome = 'ok';
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    try {
      console.log('[MedRepPerf] ' + JSON.stringify({
        action: measuredAction,
        elapsedMs: Date.now() - startedAt,
        outcome: outcome,
        phases: Object.keys(_PH || {}).length ? _PH : undefined
      }));
    } catch (ignored) {}
    _PH = null;
  }
}
const ok = d => ({ ok: true, data: d });

// Built on first use (not at load time): it references functions from every server file, and Apps Script loads files in
// project order. Building it lazily makes the load order irrelevant.
let ROUTES_ = null;
function routes_() {
  return ROUTES_ || (ROUTES_ = {
  logout:        { role: 'any',   fn: (s) => { CacheService.getScriptCache().remove('s_' + s.token); audit_(s, 'logout', s.uid); return true; } },
  bootstrap:     { role: 'any',   fn: bootstrap_ },
  masterList:    { role: 'admin', fn: masterList_ },
  masterAct:     { role: 'admin', fn: masterAct_ },
  facilitiesList:{ role: 'admin', fn: facilitiesList_ },
  gpsReference:  { role: 'admin', fn: gpsReference_ },
  facilityAct:   { role: 'admin', fn: facilityAct_ },
  linkAct:       { role: 'admin', fn: linkAct_ },
  proposeFacility: { role: 'rep', fn: proposeFacility_ },
  requestDoctorLink: { role: 'rep', fn: requestDoctorLink_ },
  reopenReport:  { role: 'rep',   fn: reopenReport_ },
  prevInfo:      { role: 'rep',   fn: prevInfo_ },
  trend:         { role: 'admin', fn: trend_ },
  yearly:        { role: 'admin', fn: yearly_ },
  closeMonth:    { role: 'admin', fn: (s, p) => { ensureMonthly_(); const n = computeMonth_(p.ym, true).length; audit_(s, 'close_month', p.ym); return n; } },
  repsList:      { role: 'admin', fn: repsList_ },
  repSave:       { role: 'admin', fn: repSave_ },
  myReports:     { role: 'rep',   fn: myReports_ },
  myPerformance: { role: 'rep',   fn: myPerformance_ },
  kpiList:       { role: 'admin', fn: () => dbAll_('KPI') },
  setReminders:  { role: 'admin', fn: setReminders_ },
  leavesList:    { role: 'admin', fn: leavesList_ },
  leaveSave:     { role: 'admin', fn: leaveSave_ },
  leaveDelete:   { role: 'admin', fn: (s, p) => delRow_(s, 'Leaves', p.id, 'delete_leave') },
  holidaysList:  { role: 'admin', fn: () => { ensureSheet_('Holidays'); return dbAll_('Holidays').sort((a, b) => (a.date < b.date ? 1 : -1)); } },
  holidaySave:   { role: 'admin', fn: holidaySave_ },
  holidayDelete: { role: 'admin', fn: (s, p) => delRow_(s, 'Holidays', p.id, 'delete_holiday') },
  addDoctor:     { role: 'rep',   fn: (s, p) => addMaster_(s, 'Doctors', p) },
  addPharmacy:   { role: 'rep',   fn: (s, p) => addMaster_(s, 'Pharmacies', p) },
  addSpecialty:  { role: 'rep',   fn: (s, p) => addSpecialty_(s, p) },
  loginAudit:    { role: 'any',   fn: (s) => { audit_(s, 'login', s.uid); return true; } },
  saveReport:    { role: 'rep',   fn: saveReport_ },
  submitReport:  { role: 'rep',   fn: submitReport_ },
  myReport:      { role: 'rep',   fn: myReport_ },
  getReport:     { role: 'any',   fn: getReport_ },
  listReports:   { role: 'any',   fn: listReports_ },
  reviewReport:  { role: 'admin', fn: reviewReport_ },
  gpsReviewSummary:{ role: 'admin', fn: gpsReviewSummary_ },
  list:          { role: 'admin', fn: (s, p) => dbAll_(entity_(p.entity)) },
  // Generic save is for Products only: reps go through repSave_, doctors/pharmacies through masterAct_ (their validated paths).
  save:          { role: 'admin', fn: (s, p) => { if (p.entity !== 'Products') throw new Error('كيان غير مسموح'); return saveEntity_(s, p); } },
  saveKpi:       { role: 'admin', fn: saveKpi_ },
  saveSettings:  { role: 'admin', fn: saveSettings_ },
  saveLogo:      { role: 'admin', fn: saveCompanyLogo_ },
  performance:   { role: 'admin', fn: performance_ },
  dashboard:     { role: 'admin', fn: dashboard_ },
  setupStatus:   { role: 'admin', fn: setupStatus_ },
  exportVisits:  { role: 'admin', fn: exportVisits_ },
  importMaster:  { role: 'admin', fn: importMaster_ },
  audit:         { role: 'admin', fn: (s, p) => dbAll_('Audit').slice(-(p.limit || 200)).reverse() }
  });
}
