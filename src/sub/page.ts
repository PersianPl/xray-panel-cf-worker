/**
 * صفحه‌ی اشتراک کاربر — چیزی که مشتری نهایی می‌بیند.
 *
 * فارسی RTL، دارک/لایت خودکار، گیج مصرف با `stroke-dashoffset`، QR ساب،
 * و دکمه‌ی مستقیم برای کلاینت‌های رایج. همه‌چیز inline است (بدون CDN) چون
 * هر درخواست بیرونی هم یک نقطه‌ی نشت است و هم روی اینترنت فیلترشده کند.
 */
import { qrSvg } from '../lib/qr';
import { humanBytes } from './build';
import type { Settings } from '../lib/settings';
import type { ClientEntry } from '../proxy/store';

export interface SubPageInput {
  entry: ClientEntry;
  s: Settings;
  links: string[];
  subUrl: string;
  usage: { up: number; down: number; total: number; expiry: number };
}

/** لینک‌های «افزودن به کلاینت» برای اپ‌های رایج. */
function deepLinks(subUrl: string, title: string): Array<{ name: string; href: string }> {
  const enc = encodeURIComponent(subUrl);
  const name = encodeURIComponent(title);
  return [
    { name: 'v2rayNG', href: `v2rayng://install-sub?url=${enc}&name=${name}` },
    { name: 'Streisand', href: `streisand://import/${subUrl}` },
    { name: 'Happ', href: `happ://add/${subUrl}` },
    { name: 'Shadowrocket', href: `sub://${btoa(subUrl)}` },
    { name: 'V2Box', href: `v2box://install-sub?url=${enc}&name=${name}` },
    { name: 'Hiddify', href: `hiddify://install-sub?url=${enc}&name=${name}` },
    { name: 'sing-box', href: `sing-box://import-remote-profile?url=${enc}#${name}` },
    { name: 'Clash Meta', href: `clash://install-config?url=${enc}` },
  ];
}

/** درصد مصرف (۰ تا ۱۰۰)؛ سقف نامحدود → ۰. */
function usedPercent(u: { up: number; down: number; total: number }): number {
  if (u.total <= 0) return 0;
  return Math.min(100, Math.round(((u.up + u.down) / u.total) * 100));
}

function jalali(ts: number): string {
  if (!ts) return 'بدون انقضا';
  return new Date(ts * 1000).toLocaleDateString('fa-IR-u-ca-persian', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function daysLeft(ts: number): string {
  if (!ts) return '∞';
  const d = Math.ceil((ts * 1000 - Date.now()) / 86400000);
  return d > 0 ? String(d) : '۰';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** محیط دایره‌ی گیج — شعاع ۵۴ در viewBox 120. */
const GAUGE_R = 54;
const GAUGE_C = 2 * Math.PI * GAUGE_R;

export function subPage(input: SubPageInput): string {
  const { entry, s, links, subUrl, usage } = input;
  const pct = usedPercent(usage);
  const used = usage.up + usage.down;
  const title = s.get('sub_title') || 'PersianPl';
  const showInfo = s.bool('sub_show_info');
  const offset = GAUGE_C * (1 - pct / 100);
  // بالای ۹۰٪ قرمز، بالای ۷۰٪ کهربایی — رنگ باید قبل از خواندن عدد پیام بدهد.
  const gaugeColor = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--warn)' : 'var(--ok)';

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — ${esc(entry.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="head">
    <div class="brand">
      <svg viewBox="0 0 24 24" class="logo" aria-hidden="true"><path d="M12 2 4 6v6c0 5 3.4 8.9 8 10 4.6-1.1 8-5 8-10V6l-8-4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div>
        <h1>${esc(title)}</h1>
        <p class="sub">${esc(entry.name)}</p>
      </div>
    </div>
    <button class="icon-btn" id="theme" type="button" aria-label="تغییر تم">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
    </button>
  </header>
${showInfo ? statsCard(usage, pct, used, offset, gaugeColor) : ''}
${qrCard(subUrl)}
${appsCard(subUrl, title)}
${configsCard(links)}
  <footer class="foot">به‌روزرسانی هر ${s.int('sub_update_interval', 12)} ساعت · ${esc(title)}</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/** کارت آمار: گیج SVG + سه عدد شمارشی. */
function statsCard(
  usage: SubPageInput['usage'],
  pct: number,
  used: number,
  offset: number,
  color: string,
): string {
  return `  <section class="card stats">
    <div class="gauge">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="${GAUGE_R}" class="track"/>
        <circle cx="60" cy="60" r="${GAUGE_R}" class="bar" style="stroke:${color};stroke-dasharray:${GAUGE_C.toFixed(2)};stroke-dashoffset:${GAUGE_C.toFixed(2)}" data-offset="${offset.toFixed(2)}"/>
      </svg>
      <div class="gauge-mid">
        <b class="count" data-to="${pct}">0</b><span>٪</span>
        <em>${usage.total > 0 ? 'مصرف‌شده' : 'نامحدود'}</em>
      </div>
    </div>
    <ul class="numbers">
      <li><span>مصرف</span><b>${humanBytes(used)}</b></li>
      <li><span>سقف</span><b>${usage.total > 0 ? humanBytes(usage.total) : '∞'}</b></li>
      <li><span>باقیمانده</span><b>${usage.total > 0 ? humanBytes(Math.max(0, usage.total - used)) : '∞'}</b></li>
      <li><span>آپلود</span><b>${humanBytes(usage.up)}</b></li>
      <li><span>دانلود</span><b>${humanBytes(usage.down)}</b></li>
      <li><span>روز مانده</span><b>${daysLeft(usage.expiry)}</b></li>
    </ul>
    <p class="expiry">انقضا: ${jalali(usage.expiry)}</p>
  </section>
`;
}

function qrCard(subUrl: string): string {
  // QR اینجا سرور-ساید تولید می‌شود؛ هیچ درخواستی به سرویس بیرونی نمی‌رود.
  const svg = qrSvg(subUrl, { ecc: 'M', margin: 2 });
  return `  <section class="card qr-card">
    <div class="qr">${svg}</div>
    <div class="qr-side">
      <label for="url">لینک اشتراک</label>
      <div class="copy-row">
        <input id="url" value="${esc(subUrl)}" readonly spellcheck="false">
        <button class="btn" data-copy="#url" type="button">کپی</button>
      </div>
      <div class="fmt">
        <a class="chip" href="${esc(subUrl)}">v2ray</a>
        <a class="chip" href="${esc(subUrl)}/singbox">sing-box</a>
        <a class="chip" href="${esc(subUrl)}/clash">Clash</a>
        <a class="chip" href="${esc(subUrl)}/xray">Xray JSON</a>
      </div>
    </div>
  </section>
`;
}

function appsCard(subUrl: string, title: string): string {
  const items = deepLinks(subUrl, title)
    .map((a) => `<a class="app" href="${esc(a.href)}">${esc(a.name)}</a>`)
    .join('');
  return `  <section class="card">
    <h2>افزودن به برنامه</h2>
    <div class="apps">${items}</div>
  </section>
`;
}

function configsCard(links: string[]): string {
  const rows = links
    .map((l, i) => {
      const remark = decodeURIComponent((l.split('#')[1] ?? `کانفیگ ${i + 1}`).replace(/\+/g, ' '));
      return `<li>
        <div class="c-name">${esc(remark)}</div>
        <input class="c-val" value="${esc(l)}" readonly spellcheck="false">
        <button class="btn sm" data-copy-prev type="button">کپی</button>
      </li>`;
    })
    .join('');
  return `  <section class="card">
    <h2>کانفیگ‌ها <span class="muted">(${links.length})</span></h2>
    <ol class="configs">${rows}</ol>
  </section>
`;
}

/**
 * استایل — فونت سیستمی به‌جای Vazirmatn از CDN.
 * دلیل: بارگیری فونت از یک دامنه‌ی بیرونی هم یک درخواست قابل‌ردگیری اضافه
 * می‌کند و هم روی اینترنت محدود کند است. اگر کاربر Vazirmatn را نصب داشته
 * باشد، `font-family` اول همان را برمی‌دارد.
 */
const STYLE = `
:root{
  --bg:#0d1117;--card:#161b22;--line:#232a34;--fg:#e6edf3;--muted:#8b949e;
  --accent:#3b82f6;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;--radius:16px;
}
:root[data-theme=light]{
  --bg:#f6f8fa;--card:#fff;--line:#d8dee4;--fg:#1f2328;--muted:#656d76;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg);color:var(--fg);
  font-family:Vazirmatn,"Segoe UI",Tahoma,system-ui,sans-serif;
  font-size:15px;line-height:1.7;
  -webkit-font-smoothing:antialiased;
  transition:background .25s,color .25s;
}
.wrap{max-width:760px;margin:0 auto;padding:16px 16px 48px}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0 20px}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:38px;height:38px;color:var(--accent)}
h1{font-size:1.15rem;margin:0;font-weight:600}
h2{font-size:.95rem;margin:0 0 12px;font-weight:600}
.sub{margin:0;color:var(--muted);font-size:.85rem}
.muted{color:var(--muted);font-weight:400}
.card{
  background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:18px;margin-bottom:14px;
}
.icon-btn{
  background:var(--card);border:1px solid var(--line);color:var(--muted);
  width:38px;height:38px;border-radius:50%;cursor:pointer;padding:8px;
  display:grid;place-items:center;transition:color .2s,border-color .2s;
}
.icon-btn:hover{color:var(--accent);border-color:var(--accent)}
.icon-btn svg{width:100%;height:100%;fill:none}

/* ── آمار */
.stats{display:grid;grid-template-columns:150px 1fr;gap:18px;align-items:center}
.gauge{position:relative;width:150px;height:150px}
.gauge svg{width:100%;height:100%;transform:rotate(-90deg)}
.gauge .track{fill:none;stroke:var(--line);stroke-width:9}
.gauge .bar{fill:none;stroke-width:9;stroke-linecap:round;transition:stroke-dashoffset 1.1s cubic-bezier(.22,1,.36,1)}
.gauge-mid{position:absolute;inset:0;display:grid;place-content:center;text-align:center;line-height:1.25}
.gauge-mid b{font-size:1.9rem;font-weight:700}
.gauge-mid span{font-size:1rem;color:var(--muted)}
.gauge-mid em{display:block;font-style:normal;font-size:.72rem;color:var(--muted)}
.numbers{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.numbers li{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 10px;text-align:center}
.numbers span{display:block;font-size:.7rem;color:var(--muted)}
.numbers b{font-size:.95rem;font-variant-numeric:tabular-nums}
.expiry{grid-column:1/-1;margin:4px 0 0;color:var(--muted);font-size:.82rem;text-align:center}

/* ── QR */
.qr-card{display:grid;grid-template-columns:170px 1fr;gap:18px;align-items:center}
.qr{background:#fff;padding:10px;border-radius:12px;line-height:0}
.qr svg{width:150px;height:150px;display:block}
.qr-side label{display:block;font-size:.78rem;color:var(--muted);margin-bottom:6px}
.copy-row{display:flex;gap:8px}
input{
  flex:1;min-width:0;background:var(--bg);border:1px solid var(--line);color:var(--fg);
  border-radius:10px;padding:9px 11px;font-family:ui-monospace,SFMono-Regular,monospace;
  font-size:.78rem;direction:ltr;text-align:left;
}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
.btn{
  background:var(--accent);color:#fff;border:0;border-radius:10px;padding:9px 16px;
  cursor:pointer;font-family:inherit;font-size:.82rem;font-weight:500;
  transition:filter .15s,transform .1s;white-space:nowrap;
}
.btn:hover{filter:brightness(1.12)}
.btn:active{transform:scale(.97)}
.btn.sm{padding:6px 12px;font-size:.75rem}
.btn.done{background:var(--ok)}
.fmt{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}
.chip{
  color:var(--muted);border:1px solid var(--line);border-radius:999px;
  padding:4px 11px;font-size:.75rem;text-decoration:none;transition:all .18s;
}
.chip:hover{color:var(--accent);border-color:var(--accent)}

/* ── اپ‌ها */
.apps{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:9px}
.app{
  display:block;text-align:center;text-decoration:none;color:var(--fg);
  background:var(--bg);border:1px solid var(--line);border-radius:11px;
  padding:11px 8px;font-size:.82rem;transition:all .18s;
}
.app:hover{border-color:var(--accent);color:var(--accent);transform:translateY(-1px)}

/* ── کانفیگ‌ها */
.configs{list-style:none;margin:0;padding:0;display:grid;gap:9px}
.configs li{
  display:grid;grid-template-columns:1fr auto;gap:8px 10px;align-items:center;
  background:var(--bg);border:1px solid var(--line);border-radius:11px;padding:10px 12px;
}
.c-name{grid-column:1/-1;font-size:.8rem;color:var(--muted);word-break:break-word}
.c-val{font-size:.7rem}
.foot{text-align:center;color:var(--muted);font-size:.75rem;margin-top:22px}

@media(max-width:560px){
  .stats,.qr-card{grid-template-columns:1fr;justify-items:center}
  .numbers{grid-template-columns:repeat(2,1fr);width:100%}
  .qr-side{width:100%}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

/**
 * اسکریپت صفحه — تم، کپی، انیمیشن گیج و شمارش.
 *
 * انیمیشن‌ها در `requestAnimationFrame` بعدی شروع می‌شوند، نه در همان تیک:
 * مرورگر باید اول مقدار اولیه‌ی `stroke-dashoffset` را ثبت کند وگرنه ترنزیشن
 * هیچ‌وقت اجرا نمی‌شود و گیج یک‌دفعه ظاهر می‌شود.
 */
const SCRIPT = `
(function(){
  var root=document.documentElement;
  var saved=null;
  try{saved=localStorage.getItem('pp-theme')}catch(e){}
  if(saved)root.setAttribute('data-theme',saved);
  else if(window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches)root.setAttribute('data-theme','light');

  var tb=document.getElementById('theme');
  if(tb)tb.addEventListener('click',function(){
    var next=root.getAttribute('data-theme')==='light'?'dark':'light';
    root.setAttribute('data-theme',next);
    try{localStorage.setItem('pp-theme',next)}catch(e){}
  });

  function flash(btn){
    var old=btn.textContent;
    btn.textContent='کپی شد';
    btn.classList.add('done');
    setTimeout(function(){btn.textContent=old;btn.classList.remove('done')},1400);
  }
  function copy(text,btn){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){flash(btn)},function(){fallback(text,btn)});
    }else fallback(text,btn);
  }
  function fallback(text,btn){
    var t=document.createElement('textarea');
    t.value=text;t.style.position='fixed';t.style.opacity='0';
    document.body.appendChild(t);t.select();
    try{document.execCommand('copy');flash(btn)}catch(e){}
    document.body.removeChild(t);
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('button'):null;
    if(!b)return;
    var sel=b.getAttribute('data-copy');
    if(sel){var el=document.querySelector(sel);if(el)copy(el.value,b);return}
    if(b.hasAttribute('data-copy-prev')){
      var inp=b.parentNode.querySelector('input');
      if(inp)copy(inp.value,b);
    }
  });

  requestAnimationFrame(function(){
    var bar=document.querySelector('.gauge .bar');
    if(bar)bar.style.strokeDashoffset=bar.getAttribute('data-offset');

    document.querySelectorAll('.count').forEach(function(el){
      var to=parseFloat(el.getAttribute('data-to'))||0;
      if(to<=0){el.textContent='0';return}
      var t0=performance.now(),dur=1100;
      function step(now){
        var p=Math.min(1,(now-t0)/dur);
        // easeOutCubic — هم‌آهنگ با ترنزیشن گیج
        el.textContent=Math.round(to*(1-Math.pow(1-p,3))).toLocaleString('fa-IR');
        if(p<1)requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  });
})();
`;

