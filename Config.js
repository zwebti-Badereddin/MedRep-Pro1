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
  Monthly: ['id', 'ym', 'repId', 'repName', 'score', 'compliance', 'onTime', 'expected', 'visits', 'verified', 'gpsTotal', 'kpis', 'computedAt']
};
const PREFIX = { Reps: 'REP', Doctors: 'DOC', Pharmacies: 'PH', Products: 'PROD' };
const STATUS = ['مسودة', 'جاهز للمراجعة', 'مرسل', 'معتمد', 'معاد للمندوب']; // editable via Settings.statuses later
const SESSION_SEC = 6 * 3600;                 // cache TTL, renewed while the user is active (see session_)
const SESSION_TOUCH_MS = 15 * 60 * 1000;      // renew the session at most every 15 minutes
const SESSION_MAX_MS = 16 * 3600 * 1000;      // absolute lifetime of one login (a long field day)
const LOGIN_WINDOW_MS = 10 * 60 * 1000, REP_UNKNOWN_LIMIT = 30, ADMIN_USER_LIMIT = 5, TRUSTED_LIMIT = 10;
let _SALT, _ST = null, _SS = null, _RM = null, _SHEETS = {}; // per-execution memo
