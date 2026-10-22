// App icons for the installed web app, drawn from the SAME doctor figure as the admin header (DOC_FIG in App1.html).
//   node tools/make-icons.js [--config web/config.json]
// Writes web/icons/: icon.svg, icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png (180), favicon-32.png.
// PNGs are rendered by headless Microsoft Edge (Windows) or Chrome (CHROME env var); rerun when the brand color changes.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const root = path.join(__dirname, '..'), args = process.argv.slice(2), ci = args.indexOf('--config');
const cfg = JSON.parse(fs.readFileSync(path.join(root, ci >= 0 ? args[ci + 1] : 'web/config.json'), 'utf8'));
const out = path.join(root, 'web', 'icons');

const app1 = fs.readFileSync(path.join(root, 'App1.html'), 'utf8');
const m = app1.match(/const DOC_FIG=('[\s\S]*?');\r?\n/);
if (!m) throw new Error('DOC_FIG not found in App1.html');
const fig = vm_eval(m[1]); // the exact header figure markup
function vm_eval(src) { return require('vm').runInNewContext(src); }
const inner = fig.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
if (!/^#[0-9a-f]{6}$/i.test(cfg.color)) throw new Error('config color must be #rrggbb');

// Same composition as the header badge: brand gradient, translucent round badge, figure bottom-aligned and clipped by it.
// The badge stays inside the maskable safe zone (radius 40% of the icon), so launchers that crop to a circle keep it whole.
function iconSvg(pad) {
  const S = 512, R = pad ? 176 : 196, cx = 256, cy = 256, fs_ = R * 2 * 42 / 46, fx = cx - fs_ / 2, fy = cy + R - fs_;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${cfg.color}"/><stop offset="1" stop-color="${shade(cfg.color, 0.78)}"/></linearGradient>
<radialGradient id="badge" cx="50%" cy="35%" r="65%"><stop offset="0" stop-color="#fff" stop-opacity=".30"/><stop offset="1" stop-color="#fff" stop-opacity=".10"/></radialGradient>
<clipPath id="c"><circle cx="${cx}" cy="${cy}" r="${R}"/></clipPath></defs>
<rect width="${S}" height="${S}" fill="url(#bg)"/>
<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#badge)"/><circle cx="${cx}" cy="${cy}" r="${R - 2}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="4"/>
<g clip-path="url(#c)"><svg x="${fx}" y="${fy}" width="${fs_}" height="${fs_}" viewBox="0 0 48 48">${inner}</svg></g></svg>`;
}
function shade(hex, k) { const n = parseInt(hex.slice(1), 16), c = s => Math.round(((n >> s) & 255) * k); return '#' + [16, 8, 0].map(s => c(s).toString(16).padStart(2, '0')).join(''); }

const browser = process.env.CHROME || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
if (!browser) throw new Error('No Edge/Chrome found: set CHROME to a Chromium browser path.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.svg'), iconSvg(false));
  const PORT = 9350 + Math.floor(Math.random() * 40), prof = fs.mkdtempSync(path.join(os.tmpdir(), 'medrep-icons-'));
  const b = spawn(browser, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let tgt; for (let i = 0; i < 60 && !tgt; i++) { await sleep(250); try { tgt = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json(); } catch (e) {} }
    if (!tgt) throw new Error('browser did not start');
    const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = {}; ws.onmessage = e => { const x = JSON.parse(e.data); if (x.id && pend[x.id]) { pend[x.id](x); delete pend[x.id]; } };
    const cdp = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const render = async (svg, size, file) => {
      await cdp('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
      const html = '<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:transparent}::-webkit-scrollbar{display:none}svg{display:block}</style></head><body>' + svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`) + '</body></html>';
      await cdp('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') }); await sleep(400);
      const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
      fs.writeFileSync(path.join(out, file), Buffer.from(r.result.data, 'base64'));
    };
    await cdp('Page.enable');
    await render(iconSvg(false), 512, 'icon-512.png');
    await render(iconSvg(false), 192, 'icon-192.png');
    await render(iconSvg(true), 512, 'maskable-512.png');
    await render(iconSvg(false), 180, 'apple-touch-icon.png');
    await render(iconSvg(false), 32, 'favicon-32.png');
    ws.close();
    console.log('icons written to ' + path.relative(root, out));
  } finally { b.kill(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {} }
})().catch(e => { console.error(e.message); process.exit(1); });
