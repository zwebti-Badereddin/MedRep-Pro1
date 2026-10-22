// Local tests for the installed web app build (tools/build-web.js) and its service worker. Run: node tests/web-build-tests.js
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'medrep-web-'));
const r = spawnSync(process.execPath, [path.join(root, 'tools', 'build-web.js'), '--out', tmp], { cwd: root, encoding: 'utf8' });
const read = f => fs.readFileSync(path.join(tmp, f), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('build succeeds and writes the page, manifest, service worker, headers and icons', () => {
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  ['index.html', 'manifest.webmanifest', 'sw.js', '_headers', 'version.txt', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png']
    .forEach(f => assert.ok(fs.existsSync(path.join(tmp, f)), f));
});
test('page = Index.html with Style and App1-4 included, no template tag left, transport set to the configured URL', () => {
  const html = read('index.html'), cfg = JSON.parse(fs.readFileSync(path.join(root, 'web', 'config.json'), 'utf8'));
  ['App1', 'App2', 'App3', 'App4'].forEach(n => assert.ok(html.includes('window.__parts=window.__parts||[]).push("' + n + '")'), n));
  assert.ok(html.includes('<style id="polish">'), 'Style included');
  assert.ok(!/<\?(?:!?=|\s)/.test(html), 'no Apps Script template tag');
  assert.ok(html.includes('window.MEDREP_API=' + JSON.stringify(cfg.api)));
  assert.ok(html.includes('rel="manifest"') && html.includes('rel="apple-touch-icon"') && html.includes('name="theme-color"'));
  assert.ok(html.indexOf('navigator.serviceWorker.register("sw.js")') > html.lastIndexOf('push("App4")'), 'service worker registered after the app');
});
test('manifest: standalone, RTL Arabic, any + maskable icons', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.strictEqual(m.display, 'standalone'); assert.strictEqual(m.dir, 'rtl'); assert.strictEqual(m.lang, 'ar');
  assert.deepStrictEqual(m.icons.map(i => i.purpose).sort(), ['any', 'any', 'maskable']);
  m.icons.forEach(i => assert.ok(fs.existsSync(path.join(tmp, i.src)), i.src));
});
test('service worker version is filled in and changes when the page changes', () => {
  const sw = read('sw.js'), v = read('version.txt').trim();
  assert.ok(!sw.includes('__VERSION__') && sw.includes("'" + v + "'"));
  const r2 = spawnSync(process.execPath, [path.join(root, 'tools', 'build-web.js'), '--out', tmp + '-2', '--config', 'web/config.json'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r2.status, 0); assert.strictEqual(fs.readFileSync(path.join(tmp + '-2', 'version.txt'), 'utf8').trim(), v, 'same input -> same version');
  fs.rmSync(tmp + '-2', { recursive: true, force: true });
});

// Service worker routing, run against the real sw.js with stubbed browser APIs.
function swRoutes() {
  const handlers = {}, ctx = { self: { location: { origin: 'https://medrep.netlify.app', href: 'https://medrep.netlify.app/sw.js' }, addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {}, clients: { claim() {} } },
    URL, caches: { match: () => Promise.resolve(null), open: () => Promise.resolve({ put() {} }) }, fetch: () => Promise.resolve({}), setTimeout, Promise };
  ctx.self.location.toString = () => ctx.self.location.href;
  vm.createContext(ctx); vm.runInContext(read('sw.js').replace("'use strict';", ''), ctx);
  return (method, url, mode) => { let handled = false; handlers.fetch({ request: { method, url, mode: mode || 'no-cors' }, respondWith() { handled = true; } }); return handled; };
}
test('service worker never handles server calls, map tiles or place search; handles the page, shell and pinned libraries', () => {
  const h = swRoutes();
  assert.strictEqual(h('POST', 'https://script.google.com/macros/s/X/exec'), false, 'server POST');
  assert.strictEqual(h('GET', 'https://script.google.com/macros/s/X/exec'), false, 'server GET');
  assert.strictEqual(h('GET', 'https://a.tile.openstreetmap.org/1/2/3.png'), false, 'map tile');
  assert.strictEqual(h('GET', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/1/2/3'), false, 'satellite tile');
  assert.strictEqual(h('GET', 'https://nominatim.openstreetmap.org/search?q=x'), false, 'place search');
  assert.strictEqual(h('GET', 'https://medrep.netlify.app/', 'navigate'), true, 'page');
  assert.strictEqual(h('GET', 'https://medrep.netlify.app/icons/icon-192.png'), true, 'icon');
  assert.strictEqual(h('GET', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'), true, 'pinned Leaflet');
  assert.strictEqual(h('GET', 'https://unpkg.com/leaflet@latest/dist/leaflet.js'), false, 'unpinned library');
});
test('.claspignore keeps web/ out of Apps Script', () => {
  assert.ok(/^web\/\*\*$/m.test(fs.readFileSync(path.join(root, '.claspignore'), 'utf8')));
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
