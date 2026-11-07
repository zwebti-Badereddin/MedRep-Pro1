// Local tests for prescription photos (uploadRx / getRx / visit rx / 90-day retention). Run: node tests/prescription-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '10' }, { key: 'workplacePolicy', value: 'soft' }],
  Reps: [{ id: 'REP-0001', name: 'مندوب أول', active: true }, { id: 'REP-0002', name: 'مندوب ثانٍ', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Supervisors: [{ id: 'SUP-0001', username: 'salem', name: 'المشرف', active: true }],
  Pharmacies: [{ id: 'PH-0001', name: 'صيدلية', active: true }],
  Products: [{ id: 'PROD-0001', name: 'Med' }]
});
// In-memory Drive: folders by name, files with parents, description, creation date, trash.
function fakeDrive(env) {
  let n = 0; const folders = [], files = [], mkId = p => (p + '_' + (++n) + '_abcdefghijklmnopqrstuv').slice(0, 30);
  const iter = a => { let i = 0; return { hasNext: () => i < a.length, next: () => a[i++] }; };
  const mkFolder = name => { const f = { id: mkId('fold'), name, trashed: false, getId: () => f.id, isTrashed: () => f.trashed,
    createFile: blob => { const x = { id: mkId('file'), bytes: blob.bytes, desc: '', created: new Date(), trashed: false, parent: f,
      getId: () => x.id, setDescription: d => { x.desc = d; }, getDescription: () => x.desc, isTrashed: () => x.trashed, setTrashed: t => { x.trashed = t; },
      getParents: () => iter([x.parent]), getDateCreated: () => x.created, getBlob: () => ({ getBytes: () => x.bytes }) }; files.push(x); return x; },
    getFiles: () => iter(files.filter(x => x.parent === f && !x.trashed)) }; folders.push(f); return f; };
  env.ctx.DriveApp = {
    getFoldersByName: name => iter(folders.filter(f => f.name === name && !f.trashed)), createFolder: mkFolder,
    getFolderById: id => { const f = folders.find(x => x.id === id); if (!f) throw new Error('no folder'); return f; },
    getFileById: id => { const x = files.find(f => f.id === id); if (!x) throw new Error('no file'); return x; }
  };
  const U = env.ctx.Utilities;
  U.base64Decode = s => Array.from(Buffer.from(s, 'base64')).map(b => (b > 127 ? b - 256 : b)); // Apps Script bytes are signed
  U.base64Encode = b => Buffer.from(b.map(x => x & 255)).toString('base64');
  U.newBlob = (bytes, mime, name) => ({ bytes, mime, name });
  return { folders, files, mkFolder };
}
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5]).toString('base64'), PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2]).toString('base64');
const setup = () => {
  const env = makeEnv(SEED()), drive = fakeDrive(env);
  return { env, drive, rep1: env.session('REP-0001', 'rep'), rep2: env.session('REP-0002', 'rep'), adm: env.session('ADM-1', 'admin'), sup: env.session('SUP-0001', 'supervisor') };
};
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('rep uploads a JPEG: stored in the private "MedRep Prescriptions" folder, tagged with the rep, id + time returned', () => {
  const { env, drive, rep1 } = setup();
  const out = env.call(rep1, 'uploadRx', { data: 'data:image/jpeg;base64,' + JPEG });
  assert.ok(out.id && out.at);
  assert.strictEqual(drive.folders[0].name, 'MedRep Prescriptions');
  assert.deepStrictEqual([drive.files.length, drive.files[0].desc, drive.files[0].parent === drive.folders[0]], [1, 'REP-0001', true]);
  assert.ok(env.rows('Audit').some(a => a.action === 'upload_rx'));
  env.call(rep1, 'uploadRx', { data: JPEG });
  assert.strictEqual(drive.folders.length, 1, 'the folder is reused');
});
test('only JPEG within the size limit is accepted; only reps upload', () => {
  const { env, adm, sup, rep1 } = setup();
  expectError(() => env.call(rep1, 'uploadRx', { data: PNG }), /غير صالحة/);
  expectError(() => env.call(rep1, 'uploadRx', { data: 'not base64 !!' }), /غير صالحة/);
  expectError(() => env.call(rep1, 'uploadRx', { data: 'A'.repeat(1500004) }), /كبيرة جدًا/);
  expectError(() => env.call(adm, 'uploadRx', { data: JPEG }), /غير مصرح/);
  expectError(() => env.call(sup, 'uploadRx', { data: JPEG }), /غير مصرح/);
});
test('reading back: admin and supervisor any photo, a rep only his own; files outside the folder are never read', () => {
  const { env, drive, rep1, rep2, adm, sup } = setup();
  const { id } = env.call(rep1, 'uploadRx', { data: JPEG });
  assert.strictEqual(env.call(adm, 'getRx', { id }).data, JPEG);
  assert.strictEqual(env.call(sup, 'getRx', { id }).data, JPEG);
  assert.strictEqual(env.call(rep1, 'getRx', { id }).data, JPEG);
  expectError(() => env.call(rep2, 'getRx', { id }), /غير موجودة/);
  const other = drive.mkFolder('Private').createFile({ bytes: [1, 2, 3] });
  expectError(() => env.call(adm, 'getRx', { id: other.id }), /غير موجودة/);
  expectError(() => env.call(adm, 'getRx', { id: '../x' }), /غير موجودة/);
});
test('a visit keeps only {id, at} of a well-formed rx; anything else is dropped', () => {
  const { env, rep1 } = setup(), ph = o => Object.assign({ name: 'صيدلية', pharmacyId: 'PH-0001' }, o);
  const { id, at } = env.call(rep1, 'uploadRx', { data: JPEG });
  env.call(rep1, 'saveReport', { date: env.today, pharmacies: [ph({ rx: { id, at, url: 'https://evil', extra: 1 } }), ph({ rx: { id: 'bad id!' } }), ph({ rx: 'x' })] });
  const saved = JSON.parse(env.rows('Reports')[0].pharmacies);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved[0].rx)), { id, at });
  assert.ok(!('rx' in saved[1]) && !('rx' in saved[2]));
});
test('retention: photos older than 90 days go to the trash, then read back as expired', () => {
  const { env, drive, rep1, adm } = setup();
  const old = env.call(rep1, 'uploadRx', { data: JPEG }), fresh = env.call(rep1, 'uploadRx', { data: JPEG });
  drive.files[0].created = new Date(Date.now() - 91 * 864e5);
  assert.strictEqual(env.ctx.reduceExpiredRx_(), 1);
  expectError(() => env.call(adm, 'getRx', { id: old.id }), /انتهت مدة الاحتفاظ/);
  assert.strictEqual(env.call(adm, 'getRx', { id: fresh.id }).data, JPEG);
});
test('uploading stops when the license has expired (reading stays)', () => {
  const { env, rep1, adm } = setup();
  const { id } = env.call(rep1, 'uploadRx', { data: JPEG });
  env.props.set('LICENSE_UNTIL', '2020-01-01'); env.clearCache();
  expectError(() => env.call(env.session('REP-0001', 'rep'), 'uploadRx', { data: JPEG }), /انتهى ترخيص/);
  assert.strictEqual(env.call(env.session('ADM-1', 'admin'), 'getRx', { id }).data, JPEG);
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
