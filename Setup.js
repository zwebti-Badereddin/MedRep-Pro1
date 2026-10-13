// MedRep Pro — one-time setup and the read-only readiness check.

/* ---------- one-time setup + demo seed (Pharma Care is demo data only) ---------- */
function setup() {
  ownerOnly_();
  clearCache_();
  const sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('SALT')) sp.setProperty('SALT', Utilities.getUuid());
  const ss = SpreadsheetApp.getActive();
  const names = Object.keys(T);
  // Preflight every existing table before writing anything. Never overwrite a non-empty header row.
  const plan = names.map(n => {
    const sh = ss.getSheetByName(n);
    if (!sh || sh.getLastRow() === 0) return { name: n, sheet: sh, initialize: true, create: !sh };
    const expected = T[n], width = Math.max(sh.getLastColumn(), expected.length);
    const actual = sh.getRange(1, 1, 1, width).getValues()[0];
    if (width !== expected.length || expected.some((h, i) => actual[i] !== h)) {
      throw new Error('توقف الإعداد دون تعديل البيانات: عناوين جدول ' + n + ' لا تطابق المخطط الحالي. يلزم ترحيل مخطط منفصل بعد أخذ نسخة احتياطية.');
    }
    return { name: n, sheet: sh, initialize: false, create: false };
  });
  plan.forEach(item => {
    let sh = item.sheet;
    if (item.create) sh = ss.insertSheet(item.name);
    if (item.initialize) { sh.appendRow(T[item.name]); sh.setFrozenRows(1); }
  });
  ['Reports', 'Audit', 'Monthly', 'Leaves', 'Holidays', 'Facilities', 'FacilityLocations', 'DoctorPlaces'].forEach(n => ss.getSheetByName(n).getRange(1, 1, ss.getSheetByName(n).getMaxRows(), T[n].length).setNumberFormat('@')); // preserve JSON, IDs and ISO timestamps as text
  if (!dbAll_('Settings').length) {
    Object.entries({ companyName: 'فارما كير للدعاية الطبية', shortName: 'PC', brandColor: '#0b6b6f', reportTitle: 'تقرير الزيارات اليومية للمندوب الطبي', reportPrefix: 'MR', timezone: 'Africa/Tripoli', phone: '', address: '' })
      .forEach(([k, v]) => dbAppend_('Settings', { key: k, value: v }));
    [['د. أحمد سالم', 'باطنة', 'عيادة النور', 'خاص'], ['د. محمد علي', 'قلب', 'مصحة الشفاء', 'خاص']]
      .forEach(r => saveEntity_({ uid: 'SETUP', role: 'admin' }, { entity: 'Doctors', row: { name: r[0], specialty: r[1], workplace: r[2], sector: r[3], active: true } }));
    saveEntity_({ uid: 'SETUP', role: 'admin' }, { entity: 'Pharmacies', row: { name: 'صيدلية الشفاء', location: 'شارع بن عاشور', nearFacility: 'مصحة الشفاء', active: true } });
    ['CardioPlus', 'GastroCare', 'NeuroVit'].forEach(n => saveEntity_({ uid: 'SETUP', role: 'admin' }, { entity: 'Products', row: { name: n, category: 'عام', status: 'نشط' } }));
    [['visits', 'تحقيق هدف الزيارات', 100, 30], ['doctor_cov', 'تغطية الأطباء', 40, 20], ['pharmacy_cov', 'تغطية الصيدليات', 30, 15],
     ['product_activity', 'نشاط المنتجات', 5, 10], ['compliance', 'الالتزام بالتقارير', 22, 15], ['quality', 'جودة واكتمال التقرير', 100, 10]]
      .forEach(k => dbUpsert_('KPI', 'key', { key: k[0], name: k[1], target: k[2], weight: k[3], active: true }));
  }
  Object.entries({ reportEmail: '', closeHour: '10', workDays: '0,1,2,3,4', gpsRadius: '150', gpsRefAcc: '50' }).forEach(([k, v]) => { if (settings_()[k] === undefined) dbAppend_('Settings', { key: k, value: v }); });
  clearCache_();
  // No default admin password is created. Run configureAdminPassword() manually.
}

/**
 * MedRep Pro — فحص جاهزية نسخة الشركة قبل التسليم.
 * قراءة فقط: لا يعدل الجداول أو الإعدادات أو المهام المجدولة.
 * شغّلها يدويًا من حساب مالك المشروع المرتبط بجدول البيانات.
 */
function pilotHealthCheck() {
  ownerOnly_();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('افتح المشروع المرتبط بجدول بيانات الشركة.');

  const checks = [];
  const add = (status, area, message, details) => {
    checks.push({
      status: status,
      area: area,
      message: message,
      details: details || ''
    });
  };

  const props = PropertiesService.getScriptProperties();
  const sheetMap = {};
  const config = {};

  // 1. التحقق من جميع الجداول وعناوين الأعمدة.
  Object.keys(T).forEach(name => {
    const sh = ss.getSheetByName(name);

    if (!sh) {
      add('FAIL', 'الجداول', 'الجدول غير موجود: ' + name);
      return;
    }

    sheetMap[name] = sh;
    const expected = T[name];
    const lastRow = sh.getLastRow();
    const width = Math.max(sh.getLastColumn(), expected.length);
    const header = lastRow
      ? sh.getRange(1, 1, 1, width).getDisplayValues()[0]
      : [];

    const valid = lastRow > 0 &&
      width === expected.length &&
      expected.every((h, i) => header[i] === h);

    add(
      valid ? 'PASS' : 'FAIL',
      'الجداول',
      valid
        ? 'سليم: ' + name
        : 'مخطط الجدول غير صحيح: ' + name,
      valid ? '' : 'راجع عناوين الأعمدة قبل التشغيل.'
    );
  });

  // 2. قراءة الإعدادات دون تعديلها.
  const settingsSheet = sheetMap.Settings;

  if (settingsSheet && settingsSheet.getLastRow() > 1) {
    settingsSheet.getRange(
      2, 1, settingsSheet.getLastRow() - 1, 2
    ).getDisplayValues().forEach(row => {
      if (row[0]) config[row[0]] = row[1];
    });
  }

  [
    ['companyName', 'اسم الشركة'],
    ['timezone', 'المنطقة الزمنية'],
    ['closeHour', 'ساعة الإقفال'],
    ['workDays', 'أيام العمل'],
    ['gpsRadius', 'نطاق GPS'],
    ['gpsRefAcc', 'دقة GPS المرجعية']
  ].forEach(([key, label]) => {
    const value = String(config[key] || '').trim();
    add(
      value ? 'PASS' : 'FAIL',
      'الإعدادات',
      value ? 'محدد: ' + label : 'إعداد ناقص: ' + label
    );
  });

  if (!String(config.reportEmail || '').trim()) {
    add(
      'WARN', 'البريد',
      'بريد استلام التقارير غير محدد.'
    );
  } else {
    add('PASS', 'البريد', 'بريد استلام التقارير محدد.');
  }

  if (config.companyName === 'فارما كير للدعاية الطبية') {
    add(
      'WARN', 'التهيئة',
      'اسم الشركة ما زال اسم البيانات التجريبية الافتراضي.'
    );
  }

  // 3. فحص كلمة مرور الإدارة ومفتاح التشفير.
  const saltExists = !!props.getProperty('SALT');
  add(
    saltExists ? 'PASS' : 'FAIL',
    'الأمان',
    saltExists
      ? 'مفتاح التشفير موجود.'
      : 'مفتاح SALT غير موجود؛ راجع تهيئة المشروع.'
  );

  let activeAdmins = 0;
  const adminSheet = sheetMap.Admins;

  if (adminSheet && adminSheet.getLastRow() > 1) {
    const rows = adminSheet.getDataRange().getValues();
    const ix = key => T.Admins.indexOf(key);

    activeAdmins = rows.slice(1).filter(row =>
      row[ix('username')] &&
      row[ix('passwordHash')] &&
      String(row[ix('active')]) !== 'false'
    ).length;
  }

  const passwordConfigured =
    !!props.getProperty('ADMIN_HASH') || activeAdmins > 0;

  add(
    passwordConfigured ? 'PASS' : 'FAIL',
    'الأمان',
    passwordConfigured
      ? 'يوجد إعداد لكلمة مرور الإدارة أو حساب مدير نشط.'
      : 'لم يتم العثور على كلمة مرور إدارة أو حساب مدير نشط.'
  );

  // 4. فحص وجود المندوبين النشطين.
  const repsSheet = sheetMap.Reps;

  if (repsSheet && repsSheet.getLastRow() > 1) {
    const rows = repsSheet.getDataRange().getValues();
    const ix = key => T.Reps.indexOf(key);
    const activeReps = rows.slice(1).filter(row =>
      row[ix('id')] && String(row[ix('active')]) !== 'false'
    ).length;

    add(
      activeReps > 0 ? 'PASS' : 'WARN',
      'المندوبون',
      'عدد المندوبين النشطين: ' + activeReps
    );
  } else {
    add('WARN', 'المندوبون', 'لا توجد سجلات مندوبين.');
  }

  // 5. فحص المهام المجدولة الظاهرة للحساب الحالي.
  let triggers = [];

  try {
    triggers = ScriptApp.getProjectTriggers();
    const count = handler =>
      triggers.filter(t => t.getHandlerFunction() === handler).length;

    [
      ['monthlyClose_', 'الإقفال الشهري'],
      ['gpsRetentionTriggerHandler', 'تنظيف بيانات GPS']
    ].forEach(([handler, label]) => {
      const n = count(handler);
      add(
        n === 1 ? 'PASS' : 'FAIL',
        'المهام المجدولة',
        label + ': ' + n + ' مهمة'
      );
    });

    const warmCount = count(WARM_HANDLER);
    add(warmCount === 1 ? 'PASS' : 'WARN', 'المهام المجدولة', 'تجهيز بيانات التطبيق: ' + warmCount + ' مهمة',
      warmCount === 1 ? '' : 'شغّل installCacheWarmTrigger من قائمة MedRep Pro لتسريع دخول المندوبين.');

    const backupCount = count('weeklyBackup_');

    if (backupCount === 1) {
      add(
        'WARN', 'النسخ الاحتياطي',
        'النسخ الاحتياطي الأسبوعي موجود؛ الكود الحالي لا يثبت نسخة يومية.'
      );
    } else {
      add(
        'FAIL', 'النسخ الاحتياطي',
        'عدد مهام النسخ الاحتياطي الأسبوعي: ' + backupCount
      );
    }

    if (String(config.remindEnabled) === 'true') {
      [
        ['sendReminders_', 'التذكير الصباحي'],
        ['sendFinalReminder_', 'التذكير النهائي'],
        ['sendEveningReminder_', 'التذكير المسائي']
      ].forEach(([handler, label]) => {
        const n = count(handler);
        add(
          n === 1 ? 'PASS' : 'FAIL',
          'التذكيرات',
          label + ': ' + n + ' مهمة'
        );
      });
    } else {
      add(
        'WARN', 'التذكيرات',
        'التذكيرات معطلة حسب الإعدادات الحالية.'
      );
    }
  } catch (err) {
    add(
      'FAIL', 'المهام المجدولة',
      'تعذر قراءة المهام.',
      String(err.message || err)
    );
  }

  // 6. فحص وجود آخر نسخة احتياطية في Drive.
  try {
    const folders = DriveApp.getFoldersByName('MedRep Backups');

    if (!folders.hasNext()) {
      add(
        'WARN', 'النسخ الاحتياطي',
        'مجلد MedRep Backups غير موجود.'
      );
    } else {
      const folder = folders.next();
      const files = folder.getFiles();
      let newest = null;
      let total = 0;

      while (files.hasNext()) {
        const file = files.next();
        total++;
        if (!newest || file.getDateCreated() > newest) {
          newest = file.getDateCreated();
        }
      }

      if (!newest) {
        add('WARN', 'النسخ الاحتياطي', 'المجلد لا يحتوي نسخًا.');
      } else {
        const ageHours =
          (Date.now() - newest.getTime()) / 3600000;

        add(
          ageHours <= 36 ? 'PASS' : 'WARN',
          'النسخ الاحتياطي',
          'عدد النسخ: ' + total +
            '؛ عمر أحدث نسخة بالساعات: ' +
            Math.round(ageHours * 10) / 10
        );
      }
    }
  } catch (err) {
    add(
      'WARN', 'النسخ الاحتياطي',
      'تعذر فحص ملفات Drive.',
      String(err.message || err)
    );
  }

  // 6ب. الترخيص: تاريخ الانتهاء في خصائص السكربت (اختياري).
  const lic = licenseState_(props.getProperty('LICENSE_UNTIL'), Utilities.formatDate(new Date(), config.timezone || Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    props.getProperty('LICENSE_WARN_DAYS'), props.getProperty('LICENSE_GRACE_DAYS'));
  add(lic.state === 'ok' ? 'PASS' : lic.state === 'expired' || lic.state === 'invalid' ? 'FAIL' : 'WARN', 'الترخيص',
    lic.state === 'none' ? 'لا يوجد تاريخ انتهاء (LICENSE_UNTIL غير محدد).'
      : lic.state === 'invalid' ? 'قيمة LICENSE_UNTIL غير صالحة: ' + lic.until + ' (الصيغة YYYY-MM-DD).'
      : 'ينتهي الترخيص في ' + lic.until + ' (متبقٍ ' + lic.days + ' يوم، والسماح حتى ' + lic.graceEnd + ').');

  // 7. إصدار النسخة: خاصية اختيارية لتوثيق إصدار كل شركة.
  const version = props.getProperty('APP_VERSION');

  add(
    version ? 'PASS' : 'WARN',
    'الإصدار',
    version
      ? 'إصدار النسخة: ' + version
      : 'لم يتم تسجيل APP_VERSION لهذه الشركة.'
  );

  // 8. ملخص واضح للنتيجة.
  const summary = {
    pass: checks.filter(x => x.status === 'PASS').length,
    warn: checks.filter(x => x.status === 'WARN').length,
    fail: checks.filter(x => x.status === 'FAIL').length
  };

  const result = {
    readOnly: true,
    company: config.companyName || 'غير محددة',
    checkedAt: new Date().toISOString(),
    spreadsheet: ss.getName(),
    spreadsheetTimeZone: ss.getSpreadsheetTimeZone(),
    scriptTimeZone: Session.getScriptTimeZone(),
    summary: summary,
    checks: checks
  };

  Logger.log(
    'MEDREP_PILOT_HEALTH_CHECK\n' +
    JSON.stringify(result, null, 2)
  );

  return result;
}
