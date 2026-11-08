// Local tests for the free-sample stock: issue / return / count by the admin, samples handed out read from visits (drafts
// included, from the first move on), going below zero allowed and reported, roles.
// Run: node tests/stock-tests.js
'use strict';
const assert = require('assert');
const { makeEnv } = require('./gas-harness');

const today = new Date().toISOString().slice(0, 10);
const visit = (samples) => JSON.stringify([{ name: 'د. علي', doctorId: 'DOC-1', samples: samples }]);
const SEED = (extra) => Object.assign({
  Settings: [{ key: 'timezone', value: 'UTC' }, { key: 'closeHour', value: '0' }, { key: 'workDays', value: '0,1,2,3,4,5,6' }],
  Reps: [{ id: 'REP-0001', name: 'سارة', active: true }, { id: 'REP-0002', name: 'البراء', active: true }],
  Admins: [{ id: 'ADM-1', username: 'boss', name: 'المدير', active: true }],
  Supervisors: [{ id: 'SUP-0001', username: 'salem', name: 'المشرف', active: true }],
  Products: [{ id: 'PROD-0001', name: 'منتج أ', status: 'نشط' }, { id: 'PROD-0002', name: 'منتج ب', status: 'نشط' }],
  Reports: []
}, extra || {});
const setup = (extra) => {
  const env = makeEnv(SEED(extra));
  return { env, rep: env.session('REP-0001', 'rep'), rep2: env.session('REP-0002', 'rep'), adm: env.session('ADM-1', 'admin'), sup: env.session('SUP-0001', 'supervisor') };
};
const expectError = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('expected error ' + re); };
const bal = (env, tok, rep, product) => env.call(tok, 'stockList', {}).balances.find(b => b.repId === rep && b.product === product);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('issue and return change the balance; every move is audited', () => {
  const { env, adm } = setup();
  assert.strictEqual(env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 50 }).balance, 50);
  assert.strictEqual(env.call(adm, 'stockMove', { op: 'ret', repId: 'REP-0001', product: 'منتج أ', qty: 5 }).balance, 45);
  const b = bal(env, adm, 'REP-0001', 'منتج أ');
  assert.deepStrictEqual([b.issued, b.returned, b.used, b.balance, b.repName], [50, 5, 0, 45, 'سارة']);
  assert.strictEqual(env.rows('Audit').filter(a => /^stock_/.test(a.action)).length, 2);
});
test('samples in visits are deducted: every report (drafts too), only from the first move, per product', () => {
  const { env, adm, rep } = setup({ Reports: [
    { id: 'R0', no: 'MR-0', repId: 'REP-0001', date: '2026-01-01', status: 'معتمد', doctors: visit([{ product: 'منتج أ', qty: 9 }]), pharmacies: '[]' },
    { id: 'R1', no: 'MR-1', repId: 'REP-0001', date: today, status: 'مسودة', doctors: visit([{ product: 'منتج أ', qty: 3 }, { product: 'منتج ب', qty: 2 }]), pharmacies: '[]' },
    { id: 'R2', no: 'MR-2', repId: 'REP-0002', date: today, status: 'مرسل', doctors: visit([{ product: 'منتج أ', qty: 4 }]), pharmacies: '[]' }] });
  env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 10, date: '2026-02-01' });
  const b = bal(env, adm, 'REP-0001', 'منتج أ');
  assert.deepStrictEqual([b.used, b.balance], [3, 7], 'the January visit (before the first move) does not count');
  assert.strictEqual(bal(env, adm, 'REP-0001', 'منتج ب'), undefined, 'a product never issued is not tracked');
  assert.strictEqual(bal(env, adm, 'REP-0002', 'منتج أ'), undefined);
  assert.strictEqual(JSON.stringify(env.call(rep, 'myStock', {})), JSON.stringify([{ product: 'منتج أ', balance: 7, issued: 10, used: 3 }]));
});
test('older visits with s1 / s2 count one each', () => {
  const { env, adm } = setup({ Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: today, status: 'مرسل', doctors: JSON.stringify([{ name: 'x', s1: 'منتج أ', s2: 'منتج أ' }]), pharmacies: '[]' }] });
  env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 5, date: '2026-01-01' });
  assert.strictEqual(bal(env, adm, 'REP-0001', 'منتج أ').balance, 3);
});
test('count (جرد) stores the difference so the balance equals the counted quantity', () => {
  const { env, adm } = setup({ Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: today, status: 'مرسل', doctors: visit([{ product: 'منتج أ', qty: 4 }]), pharmacies: '[]' }] });
  env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 20, date: '2026-01-01' });
  assert.strictEqual(env.call(adm, 'stockMove', { op: 'count', repId: 'REP-0001', product: 'منتج أ', qty: 13 }).balance, 13);
  const m = env.rows('SampleMoves').find(x => x.type === 'جرد');
  assert.strictEqual(+m.qty, -3); assert.match(m.note, /العدد الفعلي 13 \(كان في النظام 16\)/);
  assert.strictEqual(env.call(adm, 'stockMove', { op: 'count', repId: 'REP-0001', product: 'منتج أ', qty: 13 }).changed, 0, 'same count: nothing written');
  expectError(() => env.call(adm, 'stockMove', { op: 'count', repId: 'REP-0001', product: 'منتج ب', qty: 1 }), /سجّل «تسليم» أولًا/);
});
test('going below zero is allowed and shown; the Telegram summary lists it', () => {
  const { env, adm } = setup({ Reports: [{ id: 'R1', no: 'MR-1', repId: 'REP-0001', date: today, status: 'مسودة', doctors: visit([{ product: 'منتج أ', qty: 8 }]), pharmacies: '[]' }] });
  env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 5, date: '2026-01-01' });
  assert.strictEqual(bal(env, adm, 'REP-0001', 'منتج أ').balance, -3);
  assert.strictEqual(env.ctx.stockOverText_(), 'سارة (منتج أ -3)');
  assert.match(env.ctx.tgSummaryText_(today), /تجاوز رصيد العينات: سارة \(منتج أ -3\)/);
});
test('validation: product must exist, quantities are whole numbers, no future dates', () => {
  const { env, adm } = setup();
  expectError(() => env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'غير موجود', qty: 1 }), /المنتج غير موجود/);
  expectError(() => env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-9', product: 'منتج أ', qty: 1 }), /المندوب غير موجود/);
  expectError(() => env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 0 }), /كمية صحيحة/);
  expectError(() => env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 2.5 }), /كمية صحيحة/);
  expectError(() => env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 1, date: '2999-01-01' }), /تاريخ لاحق/);
  expectError(() => env.call(adm, 'stockMove', { op: 'steal', repId: 'REP-0001', product: 'منتج أ', qty: 1 }), /نوع الحركة/);
});
test('roles: only the admin records moves; the supervisor sees balances and history; a rep sees only own balance', () => {
  const { env, adm, sup, rep, rep2 } = setup();
  env.call(adm, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 5 });
  expectError(() => env.call(sup, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 5 }), /غير مصرح/);
  expectError(() => env.call(rep, 'stockMove', { op: 'issue', repId: 'REP-0001', product: 'منتج أ', qty: 5 }), /غير مصرح/);
  expectError(() => env.call(rep, 'stockList', {}), /غير مصرح/);
  assert.strictEqual(env.call(sup, 'stockList', {}).balances.length, 1);
  assert.strictEqual(env.call(sup, 'stockHistory', { repId: 'REP-0001' }).length, 1);
  assert.strictEqual(env.call(rep2, 'myStock', {}).length, 0);
});

let failed = 0;
tests.forEach(t => { try { t.fn(); console.log('PASS  ' + t.name); } catch (e) { failed++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      ')); } });
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
