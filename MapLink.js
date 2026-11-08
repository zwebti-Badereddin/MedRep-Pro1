// MedRep Pro — coordinates from a Google Maps link or text, for the admin's facility map. Search engines with open data
// (OpenStreetMap) miss many Libyan clinics and pharmacies; Google Maps has them, so the admin pastes its link or coordinates.
// Long links carry the coordinates; short links (maps.app.goo.gl) are followed here (the browser cannot: no CORS).
// Only Google Maps hosts are fetched, at most 4 redirects, nothing else is requested.

const MAPLINK_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|maps\.google\.[a-z.]+|(www\.)?google\.[a-z.]+)$/i;

// Pure: the first coordinate pair found in a link or text (the place pin !3d!4d first, then q= / ll= / center=, then @map centre,
// then plain "lat, lng"); Arabic-Indic digits are accepted. Returns {lat, lng} or null.
function mapCoordsFromText_(text) {
  const s = String(text || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/٫/g, '.').replace(/%2C/gi, ',');
  const num = '(-?\\d{1,3}\\.\\d+)';
  const pats = [new RegExp('!3d' + num + '!4d' + num), new RegExp('[?&](?:q|query|ll|destination|center|daddr)=(?:loc:)?' + num + ',\\s*' + num),
    new RegExp('@' + num + ',' + num), new RegExp('^\\s*' + num + '\\s*[,،\\s]\\s*' + num + '\\s*$')];
  for (let i = 0; i < pats.length; i++) {
    const m = pats[i].exec(s); if (!m) continue;
    const lat = +m[1], lng = +m[2];
    if (gpsPointValidServer_(lat, lng)) return { lat: lat, lng: lng };
  }
  return null;
}
function mapLinkHost_(url) { const m = /^https?:\/\/([^/?#]+)/i.exec(String(url || '').trim()); return m ? m[1] : ''; }
// Admin route: {text} = a pasted link or coordinates → {lat, lng}.
function resolveMapLink_(s, p) {
  const text = String(p.text || '').trim().slice(0, 2000); if (!text) throw new Error('الصق رابط Google Maps أو الإحداثيات.');
  const direct = mapCoordsFromText_(text); if (direct) return direct;
  let url = (/https?:\/\/\S+/i.exec(text) || [])[0];
  if (!url || !MAPLINK_HOSTS.test(mapLinkHost_(url))) throw new Error('لم أجد إحداثيات. الصق رابطًا من Google Maps، أو الإحداثيات بالشكل 32.88, 13.19.');
  for (let i = 0; i < 4; i++) {
    const res = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (MedRep Pro)' } });
    const code = res.getResponseCode(), h = res.getHeaders() || {}, loc = h.Location || h.location;
    if (code >= 300 && code < 400 && loc) {
      const next = /^https?:/i.test(loc) ? loc : 'https://' + mapLinkHost_(url) + loc;
      const hit = mapCoordsFromText_(decodeURIComponent(next)); if (hit) return hit;
      if (!MAPLINK_HOSTS.test(mapLinkHost_(next))) break;
      url = next; continue;
    }
    // A place page without coordinates in its address: its preview image and links usually carry them.
    const body = String(res.getContentText() || '').slice(0, 400000), hit = mapCoordsFromText_('?' + (/center=-?\d[^"&]*%2C-?\d[^"&]*/.exec(body) || [''])[0]) ||
      mapCoordsFromText_((/!3d-?\d+\.\d+!4d-?\d+\.\d+/.exec(body) || [''])[0]) || mapCoordsFromText_((/@-?\d+\.\d+,-?\d+\.\d+/.exec(body) || [''])[0]);
    if (hit) return hit;
    break;
  }
  throw new Error('الرابط لا يحمل الإحداثيات. في Google Maps اضغط مطولًا على مكان المنشأة، وانسخ الأرقام التي تظهر (مثل 32.88, 13.19) والصقها هنا.');
}
