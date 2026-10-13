// MedRep Pro — handover helpers: the admin's "system setup" checklist and the vendor support contact.

const SETUP_DEMO_COMPANY = 'فارما كير للدعاية الطبية';
const SETUP_DEFAULT_TARGETS = { visits: 100, doctor_cov: 40, pharmacy_cov: 30, product_activity: 5 }; // as seeded by setup()

// Pure: t = { settings, products, kpi, reps, facilities } -> checklist. `go` tells the client which screen opens the item.
function setupChecklist_(t) {
  const S = x => String(x == null ? '' : x).trim(), st = t.settings || {};
  const company = S(st.companyName), email = S(st.reportEmail);
  const products = (t.products || []).filter(p => S(p.name) && S(p.status) !== 'متوقف').length;
  const kpiChanged = (t.kpi || []).some(k => k.key in SETUP_DEFAULT_TARGETS && +k.target !== SETUP_DEFAULT_TARGETS[k.key]);
  const reps = (t.reps || []).filter(r => S(r.id) && S(r.active) !== 'false').length;
  const live = (t.facilities || []).filter(f => f.legacyEntity !== 'Pharmacies' && !S(f.mergedInto) && S(f.status) !== 'معطل');
  const noGeo = live.filter(f => !facilityApproved_(f)).length;
  const items = [
    { key: 'company', go: 'co', label: 'اسم الشركة', done: !!company && company !== SETUP_DEMO_COMPANY, detail: company && company !== SETUP_DEMO_COMPANY ? company : 'ما زال الاسم التجريبي' },
    { key: 'email', go: 'co', label: 'بريد استلام التقارير', done: !!email, detail: email || 'غير محدد' },
    { key: 'products', go: 'prod', label: 'المنتجات', done: products > 0, detail: products + ' منتج' },
    { key: 'kpi', go: 'kpi', label: 'أهداف المؤشرات', done: kpiChanged, detail: kpiChanged ? 'محددة' : 'القيم الافتراضية' },
    { key: 'reps', go: 'Reps', label: 'المندوبون', done: reps > 0, detail: reps + ' مندوب نشط' },
    { key: 'facilities', go: 'Facilities', label: 'المنشآت بموقع معتمد', done: live.length > 0 && noGeo === 0,
      detail: !live.length ? 'لا توجد منشآت' : noGeo ? noGeo + ' منشأة بلا موقع معتمد' : live.length + ' منشأة' }
  ];
  return { complete: items.every(i => i.done), items: items };
}
function setupStatus_() {
  return readScope_(() => setupChecklist_({ settings: settings_(), products: dbAll_('Products'), kpi: dbAll_('KPI'), reps: dbAll_('Reps'), facilities: dbAll_('Facilities') }));
}

// Vendor support line (Script Property SUPPORT_CONTACT, e.g. "الدعم الفني: 0912345678"). Shown on the login screen and in license notices.
function supportContact_() { return String(licenseProps_().support || '').trim().slice(0, 120); }
