// Local tests: coordinates from Google Maps links / pasted text (server), short links followed only on Google hosts, and the
// products import from Excel.
// Run: node tests/maplink-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }],
  Products: [{ id: 'PROD-0001', name: 'CardioPlus', category: 'قلب', status: 'نشط' }]
});
const setup = () => { const env = makeEnv(SEED()); return { env, adm: env.session('ADM-1', 'admin'), rep: env.session('REP-0001', 'rep') }; };
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const J = x => JSON.stringify(x);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('coordinates from every common Google Maps form and from pasted numbers', () => {
  const { env } = setup(), f = env.ctx.mapCoordsFromText_;
  const P = J({ lat: 32.8872, lng: 13.1913 });
  assert.strictEqual(J(f('https://www.google.com/maps/place/X/@32.80,13.10,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d32.8872!4d13.1913')), P, 'the place pin wins over the map centre');
  assert.strictEqual(J(f('https://maps.google.com/?q=32.8872,13.1913')), P);
  assert.strictEqual(J(f('https://www.google.com/maps/search/?api=1&query=32.8872%2C13.1913')), P);
  assert.strictEqual(J(f('https://www.google.com/maps/@32.8872,13.1913,15z')), P);
  assert.strictEqual(J(f(' 32.8872, 13.1913 ')), P);
  assert.strictEqual(J(f('٣٢٫٨٨٧٢، ١٣٫١٩١٣')), P, 'Arabic-Indic digits and comma');
  assert.strictEqual(f('مصحة الشفاء'), null);
  assert.strictEqual(f('95.1, 13.2'), null, 'invalid latitude');
});
test('short links are followed (redirect Location) on Google hosts only', () => {
  const { env, adm } = setup(), seen = [];
  env.ctx.UrlFetchApp = { fetch: (url) => { seen.push(url); return { getResponseCode: () => 302, getHeaders: () => ({ Location: 'https://www.google.com/maps/place/Clinic/data=!4m2!3m1!3d32.8872!4d13.1913' }), getContentText: () => '' }; } };
  assert.strictEqual(J(env.call(adm, 'resolveMapLink', { text: 'شوف الموقع https://maps.app.goo.gl/AbCdEf123' })), J({ lat: 32.8872, lng: 13.1913 }));
  assert.deepStrictEqual(seen, ['https://maps.app.goo.gl/AbCdEf123']);
  expectError(() => env.call(adm, 'resolveMapLink', { text: 'https://evil.example.com/x' }), /لم أجد إحداثيات/);
  assert.strictEqual(seen.length, 1, 'a non-Google host is never fetched');
});
test('a place page without coordinates in the address: read from its preview image; nothing found → a clear instruction', () => {
  const { env, adm } = setup();
  env.ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => '<meta content="https://maps.google.com/maps/api/staticmap?center=32.8872%2C13.1913&zoom=16">' }) };
  assert.strictEqual(J(env.call(adm, 'resolveMapLink', { text: 'https://maps.app.goo.gl/Zz' })), J({ lat: 32.8872, lng: 13.1913 }));
  env.ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => '<html>no coords</html>' }) };
  expectError(() => env.call(adm, 'resolveMapLink', { text: 'https://maps.app.goo.gl/Zz' }), /اضغط مطولًا/);
});
test('resolveMapLink is admin-only', () => {
  const { env, rep } = setup();
  expectError(() => env.call(rep, 'resolveMapLink', { text: '32.1, 13.1' }), /غير مصرح/);
});
test('products import: name + category, preview first, duplicates skipped, new ones active with PROD ids', () => {
  const { env, adm } = setup();
  const rows = [['اسم المنتج', 'التصنيف'], ['NeuroVit', 'أعصاب'], ['cardioplus', 'قلب'], ['GastroCare', ''], ['NeuroVit', 'x'], ['', ''], ['A', '']];
  const pre = env.call(adm, 'importMaster', { entity: 'Products', rows });
  assert.deepStrictEqual([pre.add.length, pre.dup.length, pre.invalid.length], [2, 2, 1]);
  assert.strictEqual(env.rows('Products').length, 1, 'preview writes nothing');
  const out = env.call(adm, 'importMaster', { entity: 'Products', rows, commit: true });
  assert.strictEqual(out.added, 2);
  assert.strictEqual(J(env.rows('Products').slice(1).map(p => [p.id, p.name, p.category, p.status])), J([['PROD-0002', 'NeuroVit', 'أعصاب', 'نشط'], ['PROD-0003', 'GastroCare', '', 'نشط']]));
  assert.ok(env.rows('Audit').some(a => a.action === 'import_products'));
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
