// Local tests for the installed web app transport: doPost (server) and _call (client, fetch vs google.script.run).
// Run: node tests/web-transport-tests.js
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const { makeEnv } = require('./gas-harness');

const SEED = () => ({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'theme', value: 'dark' }, { key: 'mapKey', value: 'SECRET_KEY_SHOULD_NEVER_LEAK_123' }, { key: 'reportEmail', value: 'boss@example.com' }],
  Reps: [{ id: 'REP-1', name: 'مندوب', active: true }]
});
// ContentService stub: records the text and mime type the web app would send.
const withContent = env => { env.ctx.ContentService = { MimeType: { JSON: 'application/json' }, createTextOutput: s => ({ body: s, mime: '', setMimeType(m) { this.mime = m; return this; } }) }; return env; };
const post = (env, body) => { const out = env.ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }); assert.strictEqual(out.mime, 'application/json'); return JSON.parse(out.body); };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('doPost runs the same api() with the token: a rep action returns {ok:true, data}', () => {
  const env = withContent(makeEnv(SEED())), tok = env.session('REP-1', 'rep');
  const r = post(env, { token: tok, action: 'myReports', p: {} });
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.data));
});
test('doPost: no token / wrong role / unknown action give the same errors as google.script.run', () => {
  const env = withContent(makeEnv(SEED())), tok = env.session('REP-1', 'rep');
  assert.match(post(env, { action: 'myReports', p: {} }).error, /انتهت الجلسة/);
  assert.match(post(env, { token: tok, action: 'audit', p: {} }).error, /غير مصرح/); // admin-only route
  assert.match(post(env, { token: tok, action: 'nope', p: {} }).error, /عملية غير معروفة/);
});
test('doPost: login with a wrong code is refused (rate limits unchanged, they live in login_)', () => {
  const env = withContent(makeEnv(SEED()));
  const r = post(env, { action: 'login', p: { code: '00000' } });
  assert.strictEqual(r.ok, false); assert.match(r.error, /بيانات الدخول غير صحيحة/);
});
test('doPost: malformed bodies are rejected without calling api()', () => {
  const env = withContent(makeEnv(SEED()));
  for (const b of ['', 'not json', '42', 'null']) assert.deepStrictEqual(post(env, b), { ok: false, error: 'طلب غير صالح' }, JSON.stringify(b));
  const r = post(env, { action: 'myReports', p: 'x' }); // non-object payload becomes {} (then the missing session is reported)
  assert.match(r.error, /انتهت الجلسة/);
});
test('doPost {cfg:true}: only theme and support line, never settings secrets', () => {
  const env = withContent(makeEnv(SEED()));
  const r = post(env, { cfg: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.data).sort(), ['support', 'theme']);
  assert.strictEqual(r.data.theme, 'dark');
  assert.ok(!/SECRET_KEY|boss@example/.test(JSON.stringify(r)));
});

// ---- client: the real _call / _callGas from App1.html ----
const app1 = fs.readFileSync(path.join(__dirname, '..', 'App1.html'), 'utf8');
const pick = n => { const i = app1.indexOf('function ' + n + '('); let d = 0, j = app1.indexOf('{', app1.indexOf(')', i)); for (let k = j; k < app1.length; k++) { if (app1[k] === '{') d++; else if (app1[k] === '}' && --d === 0) return app1.slice(i, k + 1); } };
function client(opts) {
  const calls = [], ctx = { JSON, Error, Promise, TOKEN: 'tok-1', window: { MEDREP_API: opts.api || '' } };
  ctx.fetch = (url, init) => { calls.push({ url, init }); return opts.fetch(url, init); };
  ctx.google = { script: { run: (function mk(s, f) { return { withSuccessHandler: x => mk(x, f), withFailureHandler: x => mk(s, x), api: (t, a, p) => { calls.push({ gas: [t, a, p] }); setTimeout(() => opts.gas ? opts.gas(s, f) : s({ ok: true, data: 'gas' }), 0); } }; })() } };
  ctx.setTimeout = setTimeout;
  vm.createContext(ctx); vm.runInContext('var TOKEN="tok-1";' + pick('_call') + pick('_callGas'), ctx);
  return { ctx, calls };
}
const res = (status, text) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) });
const API = 'https://script.google.com/macros/s/X/exec';

test('client without MEDREP_API uses google.script.run (Apps Script page unchanged)', async () => {
  const c = client({ fetch: () => { throw new Error('fetch must not be used'); } });
  assert.strictEqual(await c.ctx._call('bootstrap', { a: 1 }), 'gas');
  assert.deepStrictEqual(c.calls[0].gas, ['tok-1', 'bootstrap', { a: 1 }]);
});
test('client with MEDREP_API: POST text/plain JSON {token, action, p} to the web app URL, returns data', async () => {
  const c = client({ api: API, fetch: () => res(200, JSON.stringify({ ok: true, data: { x: 1 } })) });
  assert.deepStrictEqual(await c.ctx._call('saveReport', { id: 'R1' }), { x: 1 });
  const { url, init } = c.calls[0];
  assert.strictEqual(url, API); assert.strictEqual(init.method, 'POST');
  assert.match(init.headers['Content-Type'], /^text\/plain/);
  assert.deepStrictEqual(JSON.parse(init.body), { token: 'tok-1', action: 'saveReport', p: { id: 'R1' } });
});
test('client: a server error keeps its message and is NOT marked as a network failure', async () => {
  const c = client({ api: API, fetch: () => res(200, JSON.stringify({ ok: false, error: 'انتهت الجلسة. سجّل الدخول من جديد.' })) });
  await assert.rejects(c.ctx._call('bootstrap'), e => /انتهت الجلسة/.test(e.message) && !e.net);
});
test('client: offline, HTTP error and a non-JSON page (Google error page) are network failures (.net = true)', async () => {
  for (const f of [() => Promise.reject(new TypeError('Failed to fetch')), () => res(500, 'x'), () => res(200, '<html>Google error</html>')]) {
    const c = client({ api: API, fetch: f });
    await assert.rejects(c.ctx._call('saveReport'), e => e.net === true && /تعذر الاتصال بالخادم/.test(e.message));
  }
});
test('sign-in error text: no internet / server not answering / the server\'s own message', () => {
  const line = app1.match(/const loginErr=[^\n]*/)[0];
  const at = online => { const c = { navigator: { onLine: online } }; vm.createContext(c); vm.runInContext(line.replace('const loginErr=', 'this.loginErr='), c); return c.loginErr; };
  const net = Object.assign(new Error('x'), { net: true });
  assert.match(at(false)(net), /لا يوجد اتصال بالإنترنت/);
  assert.match(at(true)(net), /تعذر الاتصال بالخادم/);
  assert.strictEqual(at(false)(new Error('بيانات الدخول غير صحيحة')), 'بيانات الدخول غير صحيحة');
});
test('client code keeps the project rule: no // or /* inside client strings', () => {
  assert.ok(!/["'`][^"'`\n]*(\/\/|\/\*)[^"'`\n]*["'`]/.test(pick('_call')));
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) { try { await t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
