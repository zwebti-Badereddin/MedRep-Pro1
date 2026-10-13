// Local tests for the admin sheets that replaced the browser prompt()/confirm() dialogs. Run: node tests/admin-ui-tests.js
'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..'), read = f => fs.readFileSync(path.join(root, f), 'utf8');
const app1 = read('App1.html'), app2 = read('App2.html');
const fn = (src, name) => { const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\r?\\n\\}')); assert.ok(m, 'function ' + name); return m[0]; };
const escLine = app1.split('\n').find(l => l.includes(',esc=t=>'));
const api = (() => {
  const src = ['const ' + escLine.slice(escLine.indexOf('esc=t=>')).replace(/;\s*$/, '') + ';', app2.match(/const FAC_TYPES=[^\n]*/)[0],
    fn(app1, 'approveDialogHtml'), fn(app2, 'facilityFormHtml'), fn(app2, 'similarFacilitiesHtml')].join('\n');
  const c = vm.createContext({}); vm.runInContext(src + '\n;this.api={approveDialogHtml,facilityFormHtml,similarFacilitiesHtml}', c); return c.api;
})();
const tests = [];
const test = (name, f) => tests.push({ name, fn: f });

test('no browser prompt()/confirm() is left in any client file', () => {
  ['App1.html', 'App2.html', 'App3.html', 'App4.html'].forEach(f => assert.ok(!/\b(prompt|confirm)\(/.test(read(f)), f));
});
test('approval sheet: lists location exceptions with distance, asks a reason; lists new links with a confirmation box', () => {
  const h = api.approveDialogHtml([{ kind: 'طبيب', name: 'د. <b>أحمد</b>', place: 'مصحة الشفاء', status: 'خارج النطاق', distance: 250 }, { kind: 'صيدلية', name: 'صيدلية', status: 'غير حاسم', distance: null }],
    [{ name: 'د. سالم', place: 'عيادة النور' }]);
  ['زيارات لم يثبت تطابق موقعها (2)', 'خارج النطاق · 250 م', 'غير حاسم', 'id="ap_note"', 'ارتباطات أطباء جديدة بمنشآت (1)', 'عيادة النور', 'id="ap_links"', 'اعتماد استثنائي']
    .forEach(t => assert.ok(h.includes(t), 'missing ' + t));
  assert.ok(!h.includes('<b>أحمد</b>') && h.includes('&lt;b&gt;'));
  assert.ok(!/undefined|NaN/.test(h));
});
test('approval sheet with links only: no reason field, plain "اعتماد التقرير"', () => {
  const h = api.approveDialogHtml([], [{ name: 'x', place: 'y' }]);
  assert.ok(!h.includes('ap_note') && h.includes('ap_links') && h.includes('>اعتماد التقرير<'));
});
test('facility form: add (empty, "إضافة المنشأة") and edit (escaped name, a custom type kept and selected)', () => {
  const add = api.facilityFormHtml(null);
  assert.ok(add.includes('إضافة منشأة') && add.includes('إضافة المنشأة') && add.includes('حدّد موقع المنشأة من الخريطة'));
  const ed = api.facilityFormHtml({ id: 'F1', name: 'مصحة "الشفاء"', type: 'مختبر' });
  assert.ok(ed.includes('value="مصحة &quot;الشفاء&quot;"') && /<option selected>مختبر<\/option>/.test(ed) && ed.includes('حفظ التعديل'));
  assert.ok(ed.includes('لا يغيّر إحداثيات المنشأة'));
});
test('similar facilities are listed inside the form with their distance', () => {
  const h = api.similarFacilitiesHtml([{ name: 'مصحة الشفاء', distance: 40 }, { name: 'الشفاء', distance: null }]);
  assert.ok(h.includes('مصحة الشفاء') && h.includes('40 م') && h.includes('الشفاء'));
});

let pass = 0, fail = 0;
tests.forEach(t => { try { t.fn(); pass++; console.log('PASS  ' + t.name); } catch (e) { fail++; console.log('FAIL  ' + t.name + '\n      ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n      ')); } });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
