// Builds the installed web app (PWA) for Netlify from the SAME client files Apps Script serves.
//   node tools/build-web.js [--config web/config.json] [--out web/dist]
// Index.html is assembled like doGet does (Style + App1-4 included), the template values are filled at run time from the
// server ({cfg:true}), and window.MEDREP_API makes _call use fetch -> doPost instead of google.script.run.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..'), args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const cfgFile = path.join(root, opt('--config', 'web/config.json')), out = path.resolve(root, opt('--out', 'web/dist'));
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const fail = m => { console.error('✖ ' + m); process.exit(1); };
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(cfg.api || '')) fail('config api must be an Apps Script web app URL (…/exec).');
if (!/^#[0-9a-f]{6}$/i.test(cfg.color || '')) fail('config color must be #rrggbb.');
const icons = ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png'];
icons.forEach(f => { if (!fs.existsSync(path.join(root, 'web/icons', f))) fail('missing web/icons/' + f + ': run node tools/make-icons.js'); });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 1. The page, exactly as doGet assembles it.
let html = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
html = html.replace(/<\?!= include\('(\w+)'\); \?>/g, (m, n) => fs.readFileSync(path.join(root, n + '.html'), 'utf8'));
html = html.replace('<?= theme ?>', '').replace('<?= support ?>', '');
const tag = html.match(/<\?(?:!?=|\s)[^]*?\?>/); // template tags only (App1 itself mentions "<?" in a string)
if (tag) fail('Index.html has a template tag the web build does not know: ' + tag[0].slice(0, 80));

// 2. Head: install metadata + transport + pre-login settings remembered from the last start (theme, support line).
const head = `<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="${esc(cfg.color)}">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="${esc(cfg.shortName || cfg.name)}">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png"><link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
<script>window.MEDREP_API=${JSON.stringify(cfg.api)};
(function(){try{var c=JSON.parse(localStorage.getItem("mr_cfg")||"{}"),m=document.querySelector('meta[name="medrep-support"]');
if(c.theme==="light"||c.theme==="dark")document.documentElement.setAttribute("data-theme",c.theme);if(m&&c.support)m.setAttribute("content",c.support)}catch(e){}})();
window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__bip=e});</script>
`;
html = html.replace('</head>', head + '</head>');

// 3. After the app: refresh the pre-login settings for next time, register the service worker.
const tail = `<script>
(function(){fetch(window.MEDREP_API,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({cfg:true}),cache:"no-store"})
 .then(function(r){return r.ok?r.json():null}).then(function(r){if(!r||!r.ok||!r.data)return;try{localStorage.setItem("mr_cfg",JSON.stringify(r.data))}catch(e){}
  var m=document.querySelector('meta[name="medrep-support"]');if(m)m.setAttribute("content",r.data.support||"");
  if(typeof TOKEN!=="undefined"&&!TOKEN){if(typeof applyTheme==="function")applyTheme(r.data.theme);
   var box=document.querySelector(".login .box"),s=box&&box.querySelector(".supl"),t=r.data.support||"";
   if(box&&t){if(!s){s=document.createElement("div");s.className="supl";box.appendChild(s)}s.textContent=t}else if(s&&!t)s.remove()}}).catch(function(){});
 if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("sw.js").catch(function(){})});
})();
</script>
`;
html = html.replace(/<\/body>\s*<\/html>\s*$/, tail + '</body>\n</html>\n');
if (html.indexOf('navigator.serviceWorker.register') < 0) fail('could not append the service worker script (no closing </body></html>).');

// 4. Manifest.
const manifest = { name: cfg.name, short_name: cfg.shortName || cfg.name, lang: 'ar', dir: 'rtl', start_url: './', scope: './', display: 'standalone',
  orientation: 'portrait', background_color: '#f1f5f6', theme_color: cfg.color,
  icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] };

// 5. Write; the service worker version is a hash of everything it caches, so any change replaces the phone's copy.
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
icons.forEach(f => fs.copyFileSync(path.join(root, 'web/icons', f), path.join(out, 'icons', f)));
fs.copyFileSync(path.join(root, 'web/_headers'), path.join(out, '_headers'));
const h = crypto.createHash('sha256'); [html, JSON.stringify(manifest)].concat(icons.map(f => fs.readFileSync(path.join(out, 'icons', f)))).forEach(x => h.update(x));
const version = h.digest('hex').slice(0, 12);
fs.writeFileSync(path.join(out, 'sw.js'), fs.readFileSync(path.join(root, 'web/sw.js'), 'utf8').replace(/'__VERSION__'/g, "'" + version + "'"));
fs.writeFileSync(path.join(out, 'version.txt'), version + '\n');
console.log('✔ web app built in ' + path.relative(root, out) + ' (version ' + version + ', ' + Math.round(html.length / 1024) + ' KB page)');
