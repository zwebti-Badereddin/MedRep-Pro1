// MedRep Pro — prescription photo on a doctor visit («صورة: إدراج وصفة»).
// A prescription can show a patient's name: the photos live in ONE private Drive folder of the owner (never shared, no public link),
// are read back only through getRx (reviewers, or the rep who took it) and are moved to the trash after RX_RETENTION_DAYS.
// The visit keeps only {id, at}; the phone shrinks the photo (about 1600 px, JPEG) before upload.

const RX_FOLDER_NAME = 'MedRep Prescriptions', RX_FOLDER_KEY = 'RX_FOLDER_ID', RX_RETENTION_DAYS = 90;
const RX_MAX_B64 = 1500000; // ≈ 1.1 MB image; the phone sends ~200-400 KB
const rxIdOk_ = id => /^[A-Za-z0-9_-]{20,100}$/.test(String(id || ''));

function rxFolder_() {
  const sp = PropertiesService.getScriptProperties(), id = sp.getProperty(RX_FOLDER_KEY);
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const it = DriveApp.getFoldersByName(RX_FOLDER_NAME), f = it.hasNext() ? it.next() : DriveApp.createFolder(RX_FOLDER_NAME);
  sp.setProperty(RX_FOLDER_KEY, f.getId());
  return f;
}
// The file must sit in the prescriptions folder: an arbitrary Drive id sent by a client is never read.
function rxFile_(id) {
  if (!rxIdOk_(id)) throw new Error('صورة الوصفة غير موجودة.');
  let file; try { file = DriveApp.getFileById(id); } catch (e) { throw new Error('انتهت مدة الاحتفاظ بصورة الوصفة أو لم تعد موجودة.'); }
  if (file.isTrashed()) throw new Error('انتهت مدة الاحتفاظ بصورة الوصفة أو لم تعد موجودة.');
  const folderId = rxFolder_().getId(), parents = file.getParents();
  let inFolder = false; while (parents.hasNext()) { if (parents.next().getId() === folderId) { inFolder = true; break; } }
  if (!inFolder) throw new Error('صورة الوصفة غير موجودة.');
  return file;
}
// Rep: upload the (already shrunk) photo now; the visit then carries the returned id.
function uploadRx_(s, p) {
  const data = String(p.data || '').replace(/^data:image\/jpeg;base64,/, '');
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new Error('الصورة غير صالحة. التقطها مرة أخرى.');
  if (data.length > RX_MAX_B64) throw new Error('الصورة كبيرة جدًا. التقطها مرة أخرى.');
  const bytes = Utilities.base64Decode(data);
  if (!(bytes.length > 3 && (bytes[0] & 255) === 0xFF && (bytes[1] & 255) === 0xD8)) throw new Error('الصورة غير صالحة. التقطها مرة أخرى.'); // JPEG only
  const now = new Date(), name = 'RX-' + s.uid + '-' + now.toISOString().slice(0, 10) + '-' + Utilities.getUuid().slice(0, 8) + '.jpg';
  const file = rxFolder_().createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
  file.setDescription(String(s.uid)); // who took it: the only rep allowed to read it back
  audit_(s, 'upload_rx', file.getId(), String(Math.round(bytes.length / 1024)) + ' KB');
  return { id: file.getId(), at: now.toISOString() };
}
// Reviewers read any photo; a rep only the photos he took.
function getRx_(s, p) {
  const file = rxFile_(p.id);
  if (s.role === 'rep' && String(file.getDescription() || '') !== String(s.uid)) throw new Error('صورة الوصفة غير موجودة.');
  return { mime: 'image/jpeg', data: Utilities.base64Encode(file.getBlob().getBytes()) };
}
// A visit's rx from the client: kept only as {id, at} with a well-formed id; anything else is dropped.
function cleanRx_(rx) {
  if (!rx || typeof rx !== 'object' || !rxIdOk_(rx.id)) return null;
  const at = String(rx.at || '');
  return { id: String(rx.id), at: /^\d{4}-\d{2}-\d{2}T/.test(at) ? at.slice(0, 30) : '' };
}
// Daily (with the GPS retention job): photos older than RX_RETENTION_DAYS go to the Drive trash.
function reduceExpiredRx_() {
  const it = DriveApp.getFoldersByName(RX_FOLDER_NAME); if (!it.hasNext()) return 0;
  const sp = PropertiesService.getScriptProperties(), id = sp.getProperty(RX_FOLDER_KEY);
  const folder = id ? (function () { try { return DriveApp.getFolderById(id); } catch (e) { return it.next(); } })() : it.next();
  const cutoff = Date.now() - RX_RETENTION_DAYS * 864e5, files = folder.getFiles();
  let n = 0;
  while (files.hasNext()) { const f = files.next(); if (f.getDateCreated().getTime() < cutoff) { f.setTrashed(true); n++; } }
  if (n) audit_({ uid: 'SYSTEM', role: 'system' }, 'rx_retention', String(n), 'retentionDays=' + RX_RETENTION_DAYS);
  return n;
}
