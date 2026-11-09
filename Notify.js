// MedRep Pro — in-app notifications (the bell): a new daily plan, a returned report… One row per user and event.
// The app polls myNotifs every minute while open; a cached version number answers «nothing new» without reading the sheet.
// A closed app is reached by Telegram (sent alongside by the callers); real phone push needs the future server.

const NF_TYPES = { plan: 'خطة زيارات', report: 'تقرير', info: 'تنبيه' };
const NF_KEEP = 30, NF_VER_SEC = 21600;

function nfRows_() { ensureSheet_('Notifs'); return dbAll_('Notifs'); }
function nfBump_(userId) { try { CacheService.getScriptCache().put('nfv_' + userId, String(Date.now()), NF_VER_SEC); } catch (e) {} }
// Never throws: a notification must not break the action that sends it.
function notifPush_(userId, type, text, ref) {
  try {
    ensureSheet_('Notifs');
    dbAppend_('Notifs', { id: 'NF-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase(), userId: String(userId), type: NF_TYPES[type] ? type : 'info',
      text: String(text || '').slice(0, 500), ref: ref ? JSON.stringify(ref).slice(0, 300) : '', at: new Date().toISOString(), read: false });
    nfBump_(userId);
    return true;
  } catch (e) { return false; }
}
// p.since = the version the app already has: { same: true } when nothing changed (no sheet read).
function myNotifs_(s, p) {
  let ver = null; try { ver = CacheService.getScriptCache().get('nfv_' + s.uid); } catch (e) {}
  if (p && p.since && ver && +ver <= +p.since) return { same: true, ver: +ver };
  const mine = nfRows_().filter(r => String(r.userId) === String(s.uid)).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, NF_KEEP);
  if (!ver) { ver = String(Date.now()); try { CacheService.getScriptCache().put('nfv_' + s.uid, ver, NF_VER_SEC); } catch (e) {} }
  return { ver: +ver, unread: mine.filter(r => String(r.read) !== 'true').length,
    items: mine.map(r => { let ref = null; try { ref = r.ref ? JSON.parse(r.ref) : null; } catch (e) {} return { id: r.id, type: r.type, text: r.text, ref: ref, at: r.at, read: String(r.read) === 'true' }; }) };
}
function notifsRead_(s, p) {
  const lock = acquireLock_(20000);
  try { nfRows_().filter(r => String(r.userId) === String(s.uid) && String(r.read) !== 'true').forEach(r => dbUpsert_('Notifs', 'id', { id: r.id, read: true })); }
  finally { lock.releaseLock(); }
  nfBump_(s.uid);
  return myNotifs_(s, {});
}
