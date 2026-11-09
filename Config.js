// MedRep Pro — sheet schema (T) and global constants. Setup: see Setup.js and RELEASE.md.
// Server files share one global scope; no file depends on another at load time (routes are built lazily in Main.js).

/**
 * MedRep Pro — Backend (Google Apps Script + Sheets)
 * Setup: bind to a Google Sheet -> run setup() once -> Deploy as Web App
 * (Execute as: Me, Access: Anyone). Optional: run setAdminPassword('...') once.
 * Layers: doGet/api() [transport] -> auth/role gate -> services -> sheets (db*).
 */
const T = {
  Settings: ['key', 'value'],
  Reps: ['id', 'name', 'codeHash', 'phone', 'active', 'email'],
  Admins: ['id', 'username', 'name', 'passwordHash', 'active', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
  // Supervisors: review only (reports, approve / return, visit locations). Created by an admin in the app.
  Supervisors: ['id', 'username', 'name', 'passwordHash', 'active', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
  Doctors: ['id', 'name', 'specialty', 'workplace', 'sector', 'lat', 'lng', 'radius', 'active', 'refState', 'refBy', 'addedBy', 'reviewed'],
  // Facility model V2: the last four DoctorWorkplaces columns and the last nine Facilities columns are appended by migrateFacilityModelV2.
  DoctorWorkplaces: ['id', 'doctorId', 'doctorName', 'workplace', 'sector', 'lat', 'lng', 'radius', 'active', 'refState', 'refBy', 'addedBy', 'reviewed',
    'facilityId', 'linkState', 'linkedBy', 'linkedAt'],
  Facilities: ['id', 'name', 'type', 'region', 'address', 'status', 'legacyEntity', 'legacyId', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy',
    'lat', 'lng', 'radius', 'geoState', 'geoSource', 'geoBy', 'geoAt', 'geoVersion', 'mergedInto'],
  FacilityLocations: ['id', 'facilityId', 'lat', 'lng', 'radius', 'source', 'state', 'proposedBy', 'proposedAt', 'approvedBy', 'approvedAt', 'version', 'active', 'note'],
  DoctorPlaces: ['id', 'doctorId', 'facilityId', 'workDays', 'notes', 'active', 'legacyWorkplaceId', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'],
  Pharmacies: ['id', 'name', 'location', 'nearFacility', 'lat', 'lng', 'radius', 'active', 'refState', 'refBy', 'addedBy', 'reviewed'],
  Products: ['id', 'name', 'category', 'status'],
  KPI: ['key', 'name', 'target', 'weight', 'active'],
  Reports: ['id', 'no', 'repId', 'date', 'status', 'notes', 'doctors', 'pharmacies', 'snapshot', 'createdAt', 'updatedAt', 'submittedAt', 'reviewNote', 'snapshot1', 'reopens'],
  Audit: ['ts', 'userId', 'role', 'action', 'ref', 'details'],
  Leaves: ['id', 'repId', 'from', 'to', 'type', 'note', 'createdAt', 'createdBy'],
  Holidays: ['id', 'date', 'name'],
  // TgLinks: Telegram chats linked to an account (Telegram.js). One account may have several chats; one chat, one account.
  // RepDoctors: each rep's visit-plan list (Plan.js). cls = approved class, pendingCls = class waiting for an admin.
  RepDoctors: ['id', 'repId', 'doctorId', 'doctorName', 'cls', 'pendingCls', 'requestedAt', 'approvedBy', 'approvedAt', 'active'],
  // SampleMoves: free-sample stock moves per rep (Stock.js): تسليم (+), إرجاع (−), جرد (signed difference).
  SampleMoves: ['id', 'repId', 'product', 'qty', 'type', 'note', 'date', 'createdAt', 'createdBy'],
  // ClientErrors: short error reports from the phones (Health.js): no report content, at most the last 5,000 rows.
  ClientErrors: ['ts', 'userId', 'role', 'kind', 'screen', 'msg', 'ver', 'ua'],
  // Sales / SalesAlias: distributor sales imported from Excel and the remembered name links (Sales.js).
  Sales: ['id', 'batch', 'date', 'region', 'customer', 'product', 'qty', 'price', 'total', 'pharmacyId', 'productId', 'importedAt', 'importedBy'],
  SalesAlias: ['kind', 'raw', 'targetId', 'createdAt', 'createdBy'],
  // DayPlans: daily visit plans set by a supervisor or an admin (DayPlan.js); status '' | 'failed' (done is read from the report).
  // PharmAck: «تم التوفير» on a pharmacy alert (Market.js): hides it until a newer observation (date) of the same pharmacy × product.
  PharmAck: ['key', 'pharmacy', 'product', 'date', 'by', 'byName', 'at'],
  DayPlans: ['id', 'repId', 'date', 'doctorId', 'doctorName', 'specialty', 'product', 'purpose', 'note', 'status', 'reason', 'active', 'createdAt', 'createdBy', 'updatedAt'],
  TgLinks: ['userId', 'role', 'name', 'chatId', 'linkedAt'],
  Monthly: ['id', 'ym', 'repId', 'repName', 'score', 'compliance', 'onTime', 'expected', 'visits', 'verified', 'gpsTotal', 'kpis', 'computedAt']
};
const PREFIX = { Reps: 'REP', Doctors: 'DOC', Pharmacies: 'PH', Products: 'PROD' };
const STATUS = ['مسودة', 'جاهز للمراجعة', 'مرسل', 'معتمد', 'معاد للمندوب']; // editable via Settings.statuses later
const SESSION_SEC = 6 * 3600;                 // cache TTL, renewed while the user is active (see session_)
const SESSION_TOUCH_MS = 15 * 60 * 1000;      // renew the session at most every 15 minutes
const SESSION_MAX_MS = 16 * 3600 * 1000;      // absolute lifetime of one login (a long field day)
const LOGIN_WINDOW_MS = 10 * 60 * 1000, REP_UNKNOWN_LIMIT = 30, ADMIN_USER_LIMIT = 5, TRUSTED_LIMIT = 10;
let _SALT, _ST = null, _SS = null, _RM = null, _SHEETS = {}; // per-execution memo
