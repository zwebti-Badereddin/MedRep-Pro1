<!doctype html>
<html lang="ar" dir="rtl" data-theme="">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>MedRep Pro</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
<?!= include('Style'); ?>
</head>
<body>
<script>
/* load guard: a separate block so it still runs when a main script has a syntax error or was truncated.
   For every part that did not start it re-compiles that script's text, so the exact failing source line can be shown. */
window.__ok=false;window.__errs=[];window.__need=["App1","App2","App3","App4"];
window.__lineNos=[];
window.addEventListener("error",function(e){window.__errs.push(e.message+" (line "+e.lineno+")");if(e.lineno)window.__lineNos.push(e.lineno)});
window.__diag=function(name){
 try{
  var el=[].slice.call(document.scripts).filter(function(s){return s.textContent.indexOf('push("'+name+'")')>=0})[0];
  if(!el)return name+": سكربت هذا الملف غير موجود في الصفحة (ملف ناقص أو لم يُحمَّل).";
  var src=el.textContent,lines=src.split("\n"),tail=lines.slice(-2).join(" ").replace(/\s+/g," ").slice(-80);
  try{new Function(src);return name+": الصياغة سليمة في هذه النسخة؛ تحقق من أن آخر ملف منشور هو المطلوب. (نهاية الملف: "+tail+")"}
  catch(e){
   var n=e.lineNumber?e.lineNumber-2:0,exact=!!n;
   if(!n){n=window.__lineNos.filter(function(x){return x>0&&x<=lines.length})[0]||0}
   var out=name+": "+e.message+" | السطر "+(n>0?n:"؟")+(n>0&&!exact?" (حسب إبلاغ المتصفح)":"")+" داخل ملف "+name+" ("+lines.length+" سطرًا في الملف)";
   if(n>0)for(var k=Math.max(1,n-1);k<=Math.min(lines.length,n+1);k++)out+="\n   "+k+": "+lines[k-1].replace(/\s+/g," ").slice(0,220);
   var chunks=[],cur=[];lines.forEach(function(l){if(/^(async )?function\s+\w+/.test(l)&&cur.length){chunks.push(cur);cur=[]}cur.push(l)});if(cur.length)chunks.push(cur);
   var bad=[];chunks.forEach(function(c){var s=c.join("\n");try{new Function(s)}catch(e3){bad.push({head:c[0].slice(0,70),msg:e3.message,text:s})}});
   if(bad.length){out+="\n\nالدوال التي تفشل عند تجميعها منفردة ("+bad.length+"):";bad.slice(0,2).forEach(function(x){out+="\n--- "+x.head+" — "+x.msg+"\n"+x.text.slice(0,1800)})}
   return out+"\n   (نهاية الملف: "+tail+")";
  }
 }catch(x){return name+": تعذّر التشخيص ("+x.message+")"}
};
window.addEventListener("load",function(){setTimeout(function(){var miss=window.__need.filter(function(n){return (window.__parts||[]).indexOf(n)<0});if(window.__ok&&!window.__errs.length&&!miss.length)return;
 var d=document.createElement("div");d.dir="rtl";d.style.cssText="margin:0;padding:14px;background:#fde3e1;color:#a3261d;font:14px/1.7 Tahoma,Arial,sans-serif";
 var diag=miss.map(window.__diag).join("\n\n");
 d.innerHTML=(miss.length?"تعذّر تشغيل الصفحة. الملفات الناقصة أو غير المكتملة: "+miss.join("، ")+". أعد لصقها كاملة (آخر سطر في كل ملف يجب أن يكون &lt;/script&gt;).":"حدث خطأ أثناء التشغيل:")+'<pre dir="ltr" style="white-space:pre-wrap;margin:6px 0 0;font-size:12px">'+(window.__errs.join("\n")||"no error message")+(diag?"\n\n"+diag.replace(/&/g,"&amp;").replace(/</g,"&lt;"):"")+"</pre>";
 document.body.insertBefore(d,document.body.firstChild)},500)});
</script>
<div id="busy"></div><div id="app"><div style="padding:60px 20px;text-align:center;color:#5d7274;font:16px Tahoma,Arial,sans-serif">جارٍ التحميل…</div></div>
<div id="pv"><div class="pvbar">
 <button class="btn" id="pvx">إغلاق</button>
 <button class="btn" id="pvp">طباعة / PDF</button>
 <button class="btn" id="pvs">مشاركة</button>
 <button class="btn pri" id="pvsend">إرسال التقرير</button><button class="btn pri" id="pvok" style="display:none">اعتماد</button><button class="btn" id="pv1" style="display:none">النسخة الأولى</button><button class="btn" id="pvret" style="display:none">إعادة للمندوب</button>
</div><div class="pvscroll"><div id="stage"></div></div></div>
<div class="ov" id="ov"><div class="modal" id="modal"></div></div>
<div class="toast" id="toast"></div>

<?!= include('App1'); ?>
<?!= include('App2'); ?>
<?!= include('App3'); ?>
<?!= include('App4'); ?>
</body>
</html>
