// Minimal in-memory Google Apps Script environment for running D:\MedRep-Pro1\Code.js under Node (local tests only).
'use strict';
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');

function makeSheet(name, rows, reads) {
  const data = rows.map(r => r.slice());
  let maxCols = 26;
  const width = () => data.reduce((m, r) => Math.max(m, r.length), 0);
  const cell = (r, c) => (data[r] && data[r][c] !== undefined ? data[r][c] : '');
  const range = (r0, c0, nr, nc) => ({
    getValues: () => { reads[name] = (reads[name] || 0) + 1; return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r0 - 1 + i, c0 - 1 + j))); },
    getDisplayValues() { return this.getValues().map(r => r.map(String)); },
    setValues: vals => vals.forEach((row, i) => row.forEach((v, j) => { const r = r0 - 1 + i; while (data.length <= r) data.push([]); data[r][c0 - 1 + j] = v; })),
    setValue: v => { const r = r0 - 1; while (data.length <= r) data.push([]); data[r][c0 - 1] = v; },
    setNumberFormat: () => {}
  });
  return {
    _name: name, _data: data,
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => width(),
    getMaxColumns: () => Math.max(maxCols, width()),
    insertColumnsAfter: (after, n) => { maxCols = Math.max(maxCols, width()) + n; },
    getMaxRows: () => Math.max(1000, data.length),
    getDataRange: () => range(1, 1, data.length, width()),
    getRange: (r, c, nr, nc) => range(r, c, nr || 1, nc || 1),
    appendRow: arr => { data.push(arr.slice()); },
    deleteRow: i => { data.splice(i - 1, 1); },
    setFrozenRows: () => {}
  };
}

// opts.legacyFacilitySchema: build Facilities / DoctorWorkplaces WITHOUT the V2 columns (the shape before migrateFacilityModelV2).
function makeEnv(seed, opts) {
  opts = opts || {};
  const sheets = {}, cache = new Map(), props = new Map([['SALT', 'test-salt']]), reads = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n, [], reads)),
    getSpreadsheetTimeZone: () => 'UTC', getId: () => 'ss', getName: () => 'test'
  };
  const fmt = (d, f) => {
    const p = n => String(n).padStart(2, '0'), y = d.getUTCFullYear(), m = p(d.getUTCMonth() + 1), dd = p(d.getUTCDate());
    if (f === 'yyyy-MM') return y + '-' + m;
    if (f === 'yyyy-MM-dd HH:mm') return y + '-' + m + '-' + dd + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
    return y + '-' + m + '-' + dd;
  };
  const ctx = {
    console: { log: () => {} },
    SpreadsheetApp: { getActive: () => ss, getActiveSpreadsheet: () => ss, getUi: () => { throw new Error('no ui in tests'); } },
    CacheService: { getScriptCache: () => ({
      get: k => (cache.has(k) ? cache.get(k) : null), put: (k, v) => { cache.set(k, String(v)); },
      remove: k => cache.delete(k), removeAll: ks => ks.forEach(k => cache.delete(k)),
      getAll: ks => { const o = {}; ks.forEach(k => { if (cache.has(k)) o[k] = cache.get(k); }); return o; },
      putAll: o => Object.keys(o).forEach(k => cache.set(k, String(o[k])))
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)) }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, f) => fmt(d, f),
      parseDate: (s) => new Date(s.replace(' ', 'T') + ':00Z'),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s).digest()],
      computeHmacSha256Signature: (s, k) => [...crypto.createHmac('sha256', k).update(s).digest()],
      base64Encode: b => Buffer.from(b).toString('base64'),
      base64EncodeWebSafe: b => Buffer.from(b).toString('base64url')
    },
    Session: { getActiveUser: () => ({ getEmail: () => 'o' }), getEffectiveUser: () => ({ getEmail: () => 'o' }), getScriptTimeZone: () => 'UTC' },
    MailApp: { sendEmail: () => {} },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://x' }), getProjectTriggers: () => [] },
    HtmlService: {}, ContentService: {}, Logger: { log: () => {} }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(process.env.CODE_JS || require('path').join(__dirname, '..', 'Code.js'), 'utf8'), ctx, { filename: 'Code.js' });
  const T = vm.runInContext('T', ctx), V2 = vm.runInContext('FACILITY_V2_COLUMNS', ctx);
  Object.keys(T).forEach(n => {
    if (seed[n] === null) return; // explicitly absent sheet
    const cols = opts.legacyFacilitySchema && V2[n] ? T[n].slice(0, T[n].length - V2[n].length) : T[n];
    const rows = (seed[n] || []).map(o => cols.map(c => (o[c] === undefined ? '' : o[c])));
    sheets[n] = makeSheet(n, [cols.slice()].concat(rows), reads);
  });
  const session = (uid, role) => { const t = 'tok-' + uid; cache.set('s_' + t, JSON.stringify({ uid, name: uid, role, iat: Date.now(), ts: Date.now() })); return t; };
  const call = (token, action, p) => {
    const r = ctx.api(token, action, JSON.parse(JSON.stringify(p || {})));
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const rows = n => vm.runInContext('dbAllRaw_', ctx)(n);
  const snapshot = () => JSON.stringify(Object.keys(sheets).sort().map(n => [n, sheets[n]._data]));
  const resetReads = () => Object.keys(reads).forEach(k => delete reads[k]);
  return { ctx, sheets, call, session, rows, reads, resetReads, snapshot, today: fmt(new Date(), 'yyyy-MM-dd'), clearCache: () => cache.clear() };
}
module.exports = { makeEnv };
