/**
 * UI پنل — یک صفحه‌ی کامل، بدون build و بدون وابستگی بیرونی.
 *
 * چرا بدون فریم‌ورک: سقف اسکریپت Worker روی Free سه مگابایت gzip است و همین
 * صفحه باید کنار کل لایه‌ی پروکسی جا شود. با DOM خام و چند تابع کمکی، کل UI
 * زیر ۵۰KB می‌ماند و هیچ درخواست بیرونی هم لازم نیست (هر CDN یک نقطه‌ی نشت و
 * یک نقطه‌ی خرابی روی اینترنت محدود است).
 *
 * چیدمان از x-ui گرفته شده: کارت‌های آمار بالا، جدول کاربران با اکشن آیکونی،
 * تب‌های تنظیمات، و مودال کلاینت بخش‌بندی‌شده. RTL-first با فونت سیستمی.
 */
import type { Settings } from '../lib/settings';
import { PANEL_POLISH_CSS, DASHBOARD_POLISH_CSS } from './ui-theme';
import { NETWORK_ART, IMMERSIVE_CSS, IMMERSIVE_APP_CSS } from './ui-visuals';

export interface PageInput {
  view: 'login' | 'app';
  s: Settings;
}

export function page(input: PageInput): string {
  const login = input.view === 'login';
  const theme = input.s.get('theme') === 'light' ? 'light' : 'dark';

  // چیزهایی که UI برای ساختن لینک لازم دارد. هیچ مقدار حساسی اینجا نیست —
  // تنظیمات واقعی از `GET api/settings` می‌آید که خودش کلیدهای حساس را ماسک می‌کند.
  const conf = JSON.stringify({
    subPath: input.s.get('sub_path'),
    user: input.s.get('admin_user'),
    pageSize: input.s.int('page_size', 25),
    calendar: input.s.get('calendar'),
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="fa" dir="rtl" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>PersianPl-Panel</title>
<style>${BASE_CSS}${login ? LOGIN_CSS : APP_CSS}${PANEL_POLISH_CSS}${login ? '' : DASHBOARD_POLISH_CSS}${IMMERSIVE_CSS}${login ? '' : IMMERSIVE_APP_CSS}</style>
</head>
<body>
${login ? LOGIN_BODY : APP_BODY}
<div id="toasts" class="toasts"></div>
<script>window.PP=${conf};${COMMON_SCRIPT}${login ? LOGIN_SCRIPT : APP_SCRIPT}</script>
</body>
</html>`;
}
/**
 * توکن‌های پایه — همان پالت صفحه‌ی اشتراک تا پنل و ساب یکدست باشند.
 * فونت سیستمی با Vazirmatn در ابتدای زنجیره: اگر کاربر نصبش داشته باشد
 * برداشته می‌شود، وگرنه هیچ درخواست بیرونی‌ای نمی‌رود.
 */
const BASE_CSS = `
:root{
  --bg:#0d1117;--card:#161b22;--soft:#1c232c;--line:#232a34;--fg:#e6edf3;--muted:#8b949e;
  --accent:#3b82f6;--accent-soft:#1d3a6e;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;
  --violet:#8b5cf6;--radius:14px;--shadow:0 6px 24px rgba(0,0,0,.35);
}
:root[data-theme=light]{
  --bg:#f6f8fa;--card:#fff;--soft:#f0f3f6;--line:#d8dee4;--fg:#1f2328;--muted:#656d76;
  --accent-soft:#dbeafe;--shadow:0 6px 24px rgba(31,35,40,.12);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;min-height:100%}
body{
  background:var(--bg);color:var(--fg);
  font-family:Vazirmatn,"Segoe UI",Tahoma,system-ui,sans-serif;
  font-size:14px;line-height:1.7;-webkit-font-smoothing:antialiased;
}
a{color:var(--accent);text-decoration:none}
h1,h2,h3{margin:0;font-weight:600}
input,select,textarea,button{font-family:inherit;font-size:inherit}
[hidden]{display:none!important}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;direction:ltr;text-align:left}
.muted{color:var(--muted)}
.num{font-variant-numeric:tabular-nums}
.row{display:flex;align-items:center;gap:8px}
.grow{flex:1;min-width:0}
.trunc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── فرم‌ها */
.field{display:block;margin-bottom:12px}
.field>span{display:block;font-size:.78rem;color:var(--muted);margin-bottom:5px}
.field>span b{color:var(--fg);font-weight:500}
.inp,select.inp,textarea.inp{
  width:100%;background:var(--bg);border:1px solid var(--line);color:var(--fg);
  border-radius:10px;padding:9px 11px;transition:border-color .15s,box-shadow .15s;
}
:root[data-theme=light] .inp{background:#fff}
.inp:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
textarea.inp{min-height:78px;resize:vertical;line-height:1.6}
select.inp{cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 49%,var(--muted) 50%),linear-gradient(-45deg,transparent 49%,var(--muted) 50%);background-position:left 12px center,left 17px center;background-size:5px 5px;background-repeat:no-repeat}
.hint{font-size:.72rem;color:var(--muted);margin-top:4px;line-height:1.5}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.three{display:grid;grid-template-columns:repeat(3,1fr);gap:0 12px}

/* سوییچ — نه چک‌باکس، چون در RTL و لمسی خیلی بهتر است */
.sw{display:flex;align-items:center;gap:9px;cursor:pointer;margin-bottom:12px;user-select:none}
.sw input{position:absolute;opacity:0;pointer-events:none}
.sw i{
  flex:none;width:38px;height:21px;border-radius:999px;background:var(--line);
  position:relative;transition:background .2s;
}
.sw i::after{
  content:'';position:absolute;top:3px;right:3px;width:15px;height:15px;border-radius:50%;
  background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.3);
}
.sw input:checked+i{background:var(--accent)}
.sw input:checked+i::after{transform:translateX(-17px)}
.sw input:focus-visible+i{box-shadow:0 0 0 3px var(--accent-soft)}
.sw span{font-size:.85rem}

/* ── دکمه‌ها */
.btn{
  background:var(--accent);color:#fff;border:0;border-radius:10px;padding:9px 16px;
  cursor:pointer;font-weight:500;font-size:.85rem;white-space:nowrap;
  transition:filter .15s,transform .08s;display:inline-flex;align-items:center;gap:6px;
}
.btn:hover{filter:brightness(1.12)}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.55;cursor:not-allowed;transform:none}
.btn.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.btn.ghost:hover{border-color:var(--accent);color:var(--accent);filter:none}
.btn.danger{background:var(--bad)}
.btn.ok{background:var(--ok)}
.btn.sm{padding:6px 12px;font-size:.78rem;border-radius:9px}
.btn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8}
.iconbtn{
  background:transparent;border:1px solid transparent;color:var(--muted);cursor:pointer;
  width:30px;height:30px;border-radius:8px;display:grid;place-items:center;padding:6px;
  transition:color .15s,background .15s;
}
.iconbtn:hover{background:var(--soft);color:var(--accent)}
.iconbtn.d:hover{color:var(--bad)}
.iconbtn svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}

/* ── نشان‌ها */
.badge{
  display:inline-flex;align-items:center;gap:4px;font-size:.7rem;padding:2px 8px;
  border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap;
}
.badge.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}
.badge.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
.badge.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.badge.acc{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent)}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.dot.pulse{animation:pulse 1.8s ease-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 currentColor;opacity:1}70%{box-shadow:0 0 0 6px transparent;opacity:.75}100%{box-shadow:0 0 0 0 transparent;opacity:1}}

/* ── توست */
.toasts{position:fixed;bottom:16px;left:16px;display:grid;gap:8px;z-index:90;max-width:min(360px,90vw)}
.toast{
  background:var(--card);border:1px solid var(--line);border-right:3px solid var(--accent);
  border-radius:10px;padding:10px 13px;box-shadow:var(--shadow);font-size:.82rem;
  animation:toastIn .25s cubic-bezier(.22,1,.36,1);
}
.toast.err{border-right-color:var(--bad)}
.toast.ok{border-right-color:var(--ok)}
.toast.out{animation:toastOut .2s ease-in forwards}
@keyframes toastIn{from{opacity:0;transform:translateY(10px) scale(.96)}to{opacity:1;transform:none}}
@keyframes toastOut{to{opacity:0;transform:translateX(-16px)}}

/* ── اسکلت بارگذاری */
.skel{background:linear-gradient(90deg,var(--soft) 25%,var(--line) 50%,var(--soft) 75%);
  background-size:200% 100%;animation:shimmer 1.3s linear infinite;border-radius:6px;color:transparent!important}
@keyframes shimmer{to{background-position:-200% 0}}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:9px}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
/* ── صفحه‌ی ورود */
const LOGIN_CSS = `
body{display:grid;place-items:center;min-height:100vh;padding:20px}
.box{
  width:min(370px,100%);background:var(--card);border:1px solid var(--line);
  border-radius:18px;padding:28px 24px;box-shadow:var(--shadow);
  animation:rise .45s cubic-bezier(.22,1,.36,1);
}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.box .logo{width:52px;height:52px;color:var(--accent);margin:0 auto 14px;display:block}
.box .logo path{fill:none;stroke:currentColor;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
/* قفل بسته می‌شود: هم امضای بصری است، هم نشان می‌دهد صفحه زنده است */
.box .logo .shackle{stroke-dasharray:34;stroke-dashoffset:34;animation:draw 1s .2s cubic-bezier(.22,1,.36,1) forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.box h1{text-align:center;font-size:1.1rem;margin-bottom:3px}
.box .tag{text-align:center;color:var(--muted);font-size:.78rem;margin:0 0 22px}
.box .btn{width:100%;justify-content:center;margin-top:6px;padding:11px}
.err{
  background:color-mix(in srgb,var(--bad) 12%,transparent);border:1px solid var(--bad);
  color:var(--bad);border-radius:10px;padding:8px 11px;font-size:.8rem;margin-bottom:12px;
  animation:shake .3s;
}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
.spin{width:15px;height:15px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
`;

const LOGIN_BODY = `<form class="box" id="f" autocomplete="on">
  <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
    <path class="shackle" d="M8 10V7a4 4 0 0 1 8 0v3"/>
    <path d="M5.5 10h13v10.5h-13z"/>
    <path d="M12 14.5v2.5"/>
  </svg>
  <h1>PersianPl-Panel</h1>
  <p class="tag">ورود مدیر</p>
  <div class="err" id="e" hidden></div>
  <label class="field"><span>نام کاربری</span>
    <input class="inp" id="u" name="username" autocomplete="username" required autofocus>
  </label>
  <label class="field"><span>رمز عبور</span>
    <input class="inp" id="p" name="password" type="password" autocomplete="current-password" required>
  </label>
  <label class="field" id="t" hidden><span>کد دومرحله‌ای (TOTP)</span>
    <input class="inp mono" id="c" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="------">
  </label>
  <button class="btn" id="s" type="submit">ورود</button>
</form>`;

const LOGIN_SCRIPT = `
(function(){
  var f=$('#f'),e=$('#e'),s=$('#s');
  f.addEventListener('submit',function(ev){
    ev.preventDefault();
    e.hidden=true;s.disabled=true;s.innerHTML='<i class="spin"></i>در حال ورود…';
    api('POST','login',{user:$('#u').value,pass:$('#p').value,code:$('#c').value}).then(function(){
      location.reload();
    }).catch(function(err){
      e.textContent=err.message||'ورود ناموفق';e.hidden=false;
      // اگر پنل ۲FA بخواهد، فیلد کد را نشان بده و فوکوس کن
      if((err.message||'').indexOf('دومرحله')>=0){$('#t').hidden=false;$('#c').focus();}
      // انیمیشن shake فقط با ری‌استارت المان دوباره اجرا می‌شود
      e.style.animation='none';void e.offsetWidth;e.style.animation='';
      s.disabled=false;s.textContent='ورود';
      $('#p').select();
    });
  });
})();
`;
/**
 * ── پنل اصلی
 *
 * چیدمان: نوار کنار ثابت (روی موبایل کشویی) + محتوای صفحه.
 * جدول کاربران روی موبایل به کارت تبدیل می‌شود (`data-h` برچسب هر سلول است)
 * چون جدول ۱۰ ستونی روی ۳۷۵px خوانا نیست.
 */
const APP_CSS = `
body{display:grid;grid-template-columns:214px 1fr;min-height:100vh}
.side{
  background:var(--card);border-left:1px solid var(--line);padding:16px 12px;
  display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh;
}
.brand{display:flex;align-items:center;gap:9px;padding:4px 8px 16px}
.brand svg{width:30px;height:30px;color:var(--accent);fill:none;stroke:currentColor;stroke-width:1.6;stroke-linejoin:round}
.brand b{font-size:.95rem}
.brand small{display:block;color:var(--muted);font-size:.66rem;font-weight:400;line-height:1.2}
.nav{
  display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:10px;
  color:var(--muted);cursor:pointer;border:0;background:transparent;width:100%;
  text-align:right;font-size:.85rem;transition:background .15s,color .15s;
}
.nav:hover{background:var(--soft);color:var(--fg)}
.nav.on{background:var(--accent-soft);color:var(--accent);font-weight:500}
.nav svg{width:17px;height:17px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.nav .n{margin-inline-start:auto;font-size:.7rem;background:var(--soft);border-radius:999px;padding:0 6px}
.nav.on .n{background:var(--card)}
.side .sep{height:1px;background:var(--line);margin:8px 4px}
.side .foot{margin-top:auto;font-size:.68rem;color:var(--muted);padding:8px;text-align:center;line-height:1.5}

.main{padding:18px 22px 60px;min-width:0}
.top{display:flex;align-items:center;gap:10px;margin-bottom:18px;flex-wrap:wrap}
.top h2{font-size:1.05rem}
.top .sp{flex:1}
.burger{display:none}
.sec{display:none}
.sec.on{display:block;animation:fade .25s ease-out}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:14px}
.card>h3{font-size:.9rem;margin-bottom:12px;display:flex;align-items:center;gap:7px}
.card>h3 .sp{flex:1}

/* ── کارت‌های آمار */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:14px}
.stat{
  background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:14px 16px;position:relative;overflow:hidden;
}
.stat::before{content:'';position:absolute;inset-block:0;inset-inline-end:0;width:3px;background:var(--accent)}
.stat.g::before{background:var(--ok)}
.stat.w::before{background:var(--warn)}
.stat.v::before{background:var(--violet)}
.stat .k{font-size:.74rem;color:var(--muted);display:flex;align-items:center;gap:6px}
.stat .k svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.7}
.stat .v{font-size:1.5rem;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums}
.stat .x{font-size:.72rem;color:var(--muted)}
.spark{width:100%;height:34px;display:block;margin-top:4px;overflow:visible}
.spark path{fill:none;stroke:var(--accent);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.spark .fill{fill:var(--accent);opacity:.13;stroke:none}
/* خط با کشیدن ظاهر می‌شود؛ طولش در JS ست می‌شود چون به داده وابسته است */
.spark path.draw{transition:stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1)}

/* ── نوار پیشرفت (مصرف کاربر) */
.bar{height:5px;border-radius:999px;background:var(--line);overflow:hidden;min-width:56px}
.bar i{display:block;height:100%;border-radius:999px;background:var(--ok);width:0;transition:width .8s cubic-bezier(.22,1,.36,1)}
.bar i.w{background:var(--warn)}
.bar i.b{background:var(--bad)}

/* ── جدول */
.tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.tools .inp{width:auto}
.search{position:relative;flex:1;min-width:170px}
.search .inp{padding-inline-start:32px}
.search svg{position:absolute;inset-inline-start:10px;top:50%;transform:translateY(-50%);width:14px;height:14px;color:var(--muted);fill:none;stroke:currentColor;stroke-width:1.8}
.tbl-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--card)}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th,td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
th{background:var(--soft);font-weight:500;font-size:.75rem;color:var(--muted);position:sticky;top:0;z-index:1}
th.s{cursor:pointer;user-select:none}
th.s:hover{color:var(--accent)}
th.s::after{content:'';display:inline-block;margin-inline-start:4px;opacity:.4;font-size:.7em}
th.s.asc::after{content:'▲';opacity:1;color:var(--accent)}
th.s.desc::after{content:'▼';opacity:1;color:var(--accent)}
tbody tr{transition:background .12s}
tbody tr:hover{background:var(--soft)}
tbody tr:last-child td{border-bottom:0}
td.acts{display:flex;gap:1px;justify-content:flex-start}
.empty{text-align:center;padding:34px 16px;color:var(--muted);font-size:.85rem}
.empty svg{width:40px;height:40px;opacity:.35;display:block;margin:0 auto 10px;fill:none;stroke:currentColor;stroke-width:1.3}
.pager{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;flex-wrap:wrap}
.pager .btn{padding:6px 12px}

/* ── مودال */
.mask{
  position:fixed;inset:0;background:rgba(1,4,9,.7);backdrop-filter:blur(3px);
  display:grid;place-items:center;padding:16px;z-index:80;animation:fade .18s;
}
.modal{
  background:var(--card);border:1px solid var(--line);border-radius:16px;
  width:min(660px,100%);max-height:88vh;display:flex;flex-direction:column;
  box-shadow:var(--shadow);animation:pop .24s cubic-bezier(.22,1,.36,1);
}
.modal.wide{width:min(880px,100%)}
@keyframes pop{from{opacity:0;transform:scale(.96) translateY(10px)}to{opacity:1;transform:none}}
.modal>header{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line)}
.modal>header h3{font-size:.95rem;flex:1}
.modal>.body{padding:16px 18px;overflow-y:auto}
.modal>footer{display:flex;gap:8px;justify-content:flex-start;padding:13px 18px;border-top:1px solid var(--line);background:var(--soft);border-radius:0 0 16px 16px}
.modal>footer .sp{flex:1}

/* بخش‌های تاشو در مودال — فیلدهای زیاد را قابل هضم می‌کند */
.fold{border:1px solid var(--line);border-radius:11px;margin-bottom:10px;overflow:hidden}
.fold>summary{
  padding:10px 13px;cursor:pointer;font-size:.85rem;font-weight:500;background:var(--soft);
  display:flex;align-items:center;gap:8px;list-style:none;
}
.fold>summary::-webkit-details-marker{display:none}
.fold>summary::before{content:'';width:5px;height:5px;border-inline-end:1.6px solid var(--muted);border-block-end:1.6px solid var(--muted);transform:rotate(-45deg);transition:transform .2s;flex:none;margin-inline-start:2px}
.fold[open]>summary::before{transform:rotate(45deg)}
.fold>summary svg{width:15px;height:15px;color:var(--accent);fill:none;stroke:currentColor;stroke-width:1.7}
.fold>div{padding:14px 13px 4px}

/* ── تب‌های تنظیمات */
.tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--line);margin-bottom:16px;padding-bottom:1px}
.tab{
  background:transparent;border:0;border-bottom:2px solid transparent;color:var(--muted);
  padding:9px 13px;cursor:pointer;font-size:.83rem;white-space:nowrap;transition:color .15s,border-color .15s;
}
.tab:hover{color:var(--fg)}
.tab.on{color:var(--accent);border-bottom-color:var(--accent);font-weight:500}
.pane{display:none}
.pane.on{display:block;animation:fade .2s}

/* ── QR و لینک‌ها در مودال کاربر */
.qrbox{display:grid;grid-template-columns:154px 1fr;gap:16px;align-items:start}
.qrbox .qr{background:#fff;padding:9px;border-radius:11px;line-height:0}
.qrbox .qr svg{width:136px;height:136px;display:block}
.links{display:grid;gap:7px;max-height:230px;overflow-y:auto}
.links .l{display:grid;grid-template-columns:1fr auto;gap:7px;align-items:center;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:7px 9px}
:root[data-theme=light] .links .l{background:var(--soft)}
.links .l .inp{padding:5px 8px;font-size:.68rem;background:transparent;border:0}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{
  border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:.73rem;
  color:var(--muted);cursor:pointer;background:transparent;transition:all .15s;
}
.chip:hover,.chip.on{color:var(--accent);border-color:var(--accent)}

/* ── واکنشی */
@media(max-width:900px){
  body{grid-template-columns:1fr}
  .side{
    position:fixed;inset-block:0;inset-inline-end:0;width:230px;z-index:70;
    transform:translateX(100%);transition:transform .25s cubic-bezier(.22,1,.36,1);box-shadow:var(--shadow);
  }
  :root[dir=rtl] .side{transform:translateX(100%)}
  body.menu .side{transform:none}
  body.menu::after{content:'';position:fixed;inset:0;background:rgba(1,4,9,.55);z-index:60}
  .burger{display:grid}
  .main{padding:14px 14px 60px}
}
@media(max-width:680px){
  .tbl-wrap{border:0;background:transparent;overflow:visible}
  table,tbody,tr,td{display:block;width:100%}
  thead{display:none}
  tbody tr{
    background:var(--card);border:1px solid var(--line);border-radius:12px;
    padding:10px 12px;margin-bottom:9px;
  }
  tbody tr:hover{background:var(--card)}
  td{
    border:0;padding:4px 0;display:flex;justify-content:space-between;gap:10px;
    align-items:center;white-space:normal;
  }
  td::before{content:attr(data-h);color:var(--muted);font-size:.72rem;flex:none}
  td.acts{justify-content:flex-end;padding-top:8px;margin-top:6px;border-top:1px solid var(--line)}
  td.acts::before{content:''}
  td.pick{position:absolute;opacity:0;pointer-events:none}
  .qrbox{grid-template-columns:1fr;justify-items:center}
  .two,.three{grid-template-columns:1fr}
  .modal>footer{flex-wrap:wrap}
}
`;
/** آیکون‌های خطی ۲۴×۲۴ — یک‌بار تعریف، همه‌جا استفاده. */
const I: Record<string, string> = {
  shield: '<path d="M12 2 4 6v6c0 5 3.4 8.9 8 10 4.6-1.1 8-5 8-10V6l-8-4Z"/>',
  grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.5a3 3 0 0 1 0 5.6M18 20c0-2.2-.7-3.9-2-5"/>',
  inbox: '<path d="M3 12h5l1.5 3h5L16 12h5"/><path d="M3 12 5.5 5h13L21 12v6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  log: '<path d="M5 3h14v18H5z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  out: '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v3M14 20h6"/>',
  edit: '<path d="M4 20h4L20 8l-4-4L4 16Z"/><path d="M14.5 5.5 18.5 9.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  power: '<path d="M12 3v9"/><path d="M7.5 6.5a7 7 0 1 0 9 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  down: '<path d="M12 4v12M6.5 10.5 12 16l5.5-5.5M4 20h16"/>',
  up: '<path d="M12 20V8M6.5 13.5 12 8l5.5 5.5M4 4h16"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 17v-5M12 17V8M16 17v-8M20 17v-4"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11 20 2M17 5l2.5 2.5M15 7l2.5 2.5"/>',
  bolt: '<path d="M13 3 5 14h5l-1 7 8-11h-5Z"/>',
  ghost: '<path d="M5 20V10a7 7 0 0 1 14 0v10l-2.3-2-2.4 2-2.3-2-2.3 2L7.3 18Z"/><path d="M9.5 10h.01M14.5 10h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"/>',
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H14a4 4 0 0 0 0-8H9"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  db: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
};

/** آیکون درون یک `<svg>` سبک. */
function ic(name: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${I[name] ?? ''}</svg>`;
}

const NAVS: Array<[string, string, string]> = [
  ['dash', 'grid', 'داشبورد'],
  ['clients', 'users', 'کاربران'],
  ['inbounds', 'inbox', 'inboundها'],
  ['nodes', 'server', 'نودها'],
  ['settings', 'gear', 'تنظیمات'],
  ['audit', 'log', 'رویدادها'],
];
/** کارت آمار با اسپارک‌لاین اختیاری. */
function stat(id: string, icon: string, label: string, sub = '', tone = ''): string {
  return `<div class="stat${tone ? ' ' + tone : ''}">
      <div class="k">${ic(icon)}${label}</div>
      <div class="v num" id="s-${id}"><span class="skel">0000</span></div>
      <div class="x" id="x-${id}">${sub}</div>
    </div>`;
}

const SEC_DASH = `<section class="sec on" id="sec-dash">
    <div class="hero">
      <div class="hero-copy">
        <span class="eyebrow" lang="en">PERSIANPL / CONTROL CENTER</span>
        <h1>شبکهٔ تو.<br><span>همه‌چیز، در کنترل تو.</span></h1>
        <p>کاربران، اتصال‌ها و ترافیک را یک‌جا مدیریت کن؛ با دیدی روشن به آنچه در شبکه‌ات می‌گذرد.</p>
        <div class="hero-actions">
          <button class="btn" data-jump="clients" type="button">${ic('users')}مدیریت کاربران</button>
          <button class="btn ghost" data-jump="inbounds" type="button">${ic('plus')}مدیریت اینباندها</button>
        </div>
      </div>
      <div class="hero-art">${NETWORK_ART}<div class="art-caption" lang="en">CONNECT · MANAGE · EXPLORE</div></div>
    </div>
    <div class="section-heading"><h3>شبکه در یک نگاه</h3><span>آمار واقعی پنل · به‌روزرسانی هر ۳۰ ثانیه</span></div>
    <div class="stats">
      ${stat('total', 'users', 'کل کاربران', 'فعال: —')}
      ${stat('online', 'bolt', 'آنلاین (۵ دقیقه)', 'IPهای یکتا: —', 'g')}
      ${stat('traffic', 'chart', 'ترافیک کل', '↑ — · ↓ —', 'v')}
      ${stat('quota', 'db', 'سهمیه‌ی امروز CF', 'از ۱۰۰٬۰۰۰', 'w')}
    </div>

    <div class="card">
      <h3>${ic('chart')}ترافیک ۳۰ روز اخیر<span class="sp"></span><span class="muted" id="d-sum"></span></h3>
      <svg class="spark" id="d-chart" viewBox="0 0 600 120" preserveAspectRatio="none" style="height:120px">
        <path class="fill"/><path class="draw"/>
      </svg>
    </div>

    <div class="two" style="gap:14px">
      <div class="card">
        <h3>${ic('up')}پرمصرف‌های امروز</h3>
        <div id="d-top"><p class="empty muted">—</p></div>
      </div>
      <div class="card">
        <h3>${ic('clock')}انقضاهای نزدیک</h3>
        <div id="d-exp"><p class="empty muted">—</p></div>
      </div>
    </div>

    <div class="card">
      <h3>${ic('inbox')}inboundها</h3>
      <div class="tbl-wrap"><table><thead><tr>
        <th>تگ</th><th>پروتکل</th><th>کاربران</th><th>آپلود</th><th>دانلود</th>
      </tr></thead><tbody id="d-inb"></tbody></table></div>
    </div>

    <div class="card">
      <h3>${ic('server')}نودها</h3>
      <div class="tbl-wrap"><table><thead><tr>
        <th>نام</th><th>منطقه</th><th>وضعیت</th><th>آخرین دیده‌شدن</th><th>ریکوئست امروز</th>
      </tr></thead><tbody id="d-nodes"></tbody></table></div>
    </div>
  </section>`;
const SEC_CLIENTS = `<section class="sec" id="sec-clients">
    <div class="tools">
      <div class="search">${ic('search')}<input class="inp" id="q" placeholder="جست‌وجو در نام، توضیح، UUID یا توکن ساب…"></div>
      <select class="inp" id="f-inb"><option value="">همه‌ی inboundها</option></select>
      <select class="inp" id="f-st">
        <option value="all">همه</option>
        <option value="active">فعال</option>
        <option value="disabled">غیرفعال</option>
        <option value="expired">منقضی</option>
        <option value="depleted">حجم تمام</option>
        <option value="online">آنلاین</option>
      </select>
      <span class="sp" style="flex:1"></span>
      <button class="btn ghost sm" id="c-bulk" type="button">${ic('users')}ساخت گروهی</button>
      <button class="btn" id="c-new" type="button">${ic('plus')}کاربر جدید</button>
    </div>

    <div class="tools" id="c-selbar" hidden>
      <span class="badge acc"><span id="c-selN">0</span> انتخاب‌شده</span>
      <button class="btn ghost sm" data-bulk="reset" type="button">${ic('refresh')}ریست مصرف</button>
      <button class="btn ghost sm" data-bulk="renew" type="button">${ic('clock')}تمدید</button>
      <button class="btn ghost sm" data-bulk="on" type="button">${ic('power')}فعال</button>
      <button class="btn ghost sm" data-bulk="off" type="button">${ic('power')}غیرفعال</button>
      <button class="btn danger sm" data-bulk="del" type="button">${ic('trash')}حذف</button>
    </div>

    <div class="tbl-wrap"><table>
      <thead><tr>
        <th style="width:34px"><input type="checkbox" id="c-all" aria-label="انتخاب همه"></th>
        <th class="s" data-sort="name">نام</th>
        <th>inbound</th>
        <th class="s" data-sort="total">مصرف</th>
        <th class="s" data-sort="expiry_at">انقضا</th>
        <th class="s" data-sort="limit_ip">IP</th>
        <th class="s" data-sort="last_online">آخرین اتصال</th>
        <th>وضعیت</th>
        <th style="width:130px"></th>
      </tr></thead>
      <tbody id="c-body"></tbody>
    </table></div>

    <div class="pager">
      <div class="row">
        <button class="btn ghost sm" id="c-prev" type="button">قبلی</button>
        <span class="muted" id="c-info">—</span>
        <button class="btn ghost sm" id="c-next" type="button">بعدی</button>
      </div>
      <select class="inp" id="c-size" style="width:auto">
        <option>10</option><option selected>25</option><option>50</option><option>100</option>
      </select>
    </div>
  </section>`;

const SEC_INBOUNDS = `<section class="sec" id="sec-inbounds">
    <div class="tools">
      <span class="muted">هر inbound یک مسیر یکتای WS دارد؛ همه‌ی پورت‌های TLS کلادفلر روی همان مسیر کار می‌کنند.</span>
      <span class="sp" style="flex:1"></span>
      <button class="btn" id="i-new" type="button">${ic('plus')}inbound جدید</button>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr>
        <th>تگ</th><th>پروتکل</th><th>transport</th><th>مسیر</th><th>پورت‌ها</th>
        <th>کاربران</th><th>ترافیک</th><th>وضعیت</th><th style="width:100px"></th>
      </tr></thead>
      <tbody id="i-body"></tbody>
    </table></div>
  </section>`;

const SEC_NODES = `<section class="sec" id="sec-nodes">
    <div class="card">
      <h3>${ic('server')}معماری چندنودی</h3>
      <p class="muted" style="margin:0;font-size:.82rem">
        هر نود یک Worker در یک اکانت دیگر کلادفلر است که همین کد را با
        <code class="mono">ROLE=node</code> اجرا می‌کند. نود کانفیگ را هر چند دقیقه از پنل
        <b>pull</b> می‌کند و آمار مصرف را <b>push</b> می‌کند؛ هیچ دیتابیسی سمت نود نیست.
        نتیجه: هر اکانت جدید ۱۰۰٬۰۰۰ ریکوئست روزانه‌ی مستقل اضافه می‌کند.
      </p>
    </div>
    <div class="tools">
      <span class="sp" style="flex:1"></span>
      <button class="btn" id="n-new" type="button">${ic('plus')}افزودن نود</button>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr>
        <th>نام</th><th>دامنه</th><th>منطقه</th><th>وزن</th><th>ترافیک امروز</th>
        <th>وضعیت</th><th>آخرین دیده‌شدن</th><th style="width:130px"></th>
      </tr></thead>
      <tbody id="n-body"></tbody>
    </table></div>
  </section>`;

const SEC_AUDIT = `<section class="sec" id="sec-audit">
    <div class="tbl-wrap"><table>
      <thead><tr><th>زمان</th><th>نوع</th><th>کاربر</th><th>IP</th><th>جزئیات</th></tr></thead>
      <tbody id="a-body"></tbody>
    </table></div>
  </section>`;
/**
 * ── سازنده‌های فیلد تنظیمات
 *
 * هر فیلد `data-k` دارد؛ JS با همان یک صفت هم پر می‌کند هم جمع می‌کند، پس
 * افزودن یک کلید جدید فقط یک خط HTML است و هیچ کد جاوااسکریپتی لازم ندارد.
 */
function sInp(k: string, label: string, hint = '', type = 'text'): string {
  return `<label class="field"><span>${label}</span>
      <input class="inp" type="${type}" data-k="${k}">${hint ? `<em class="hint">${hint}</em>` : ''}</label>`;
}
function sTxt(k: string, label: string, hint = ''): string {
  return `<label class="field"><span>${label}</span>
      <textarea class="inp" data-k="${k}" spellcheck="false"></textarea>${hint ? `<em class="hint">${hint}</em>` : ''}</label>`;
}
function sSw(k: string, label: string, hint = ''): string {
  return `<label class="sw"><input type="checkbox" data-k="${k}" data-b="1"><i></i><span>${label}${hint ? ` <em class="hint" style="display:inline">— ${hint}</em>` : ''}</span></label>`;
}
function sSel(k: string, label: string, opts: Array<[string, string]>, hint = ''): string {
  return `<label class="field"><span>${label}</span>
      <select class="inp" data-k="${k}">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>${hint ? `<em class="hint">${hint}</em>` : ''}</label>`;
}

const TABS: Array<[string, string]> = [
  ['gen', 'عمومی'],
  ['sec', 'امنیت و استتار'],
  ['sub', 'اشتراک'],
  ['net', 'شبکه و خروجی'],
  ['route', 'مسیریابی'],
  ['dns', 'DNS'],
  ['node', 'نودها'],
  ['tg', 'تلگرام'],
  ['ops', 'عملیاتی'],
];

const SEC_SETTINGS = `<section class="sec" id="sec-settings">
    <div class="tabs">${TABS.map(([id, t], i) => `<button class="tab${i === 0 ? ' on' : ''}" data-tab="${id}" type="button">${t}</button>`).join('')}</div>

    <div class="pane on" id="p-gen">
      <div class="card"><h3>${ic('grid')}پنل</h3>
        <div class="two">
          ${sInp('admin_user', 'نام کاربری مدیر')}
          ${sInp('session_max_age', 'عمر نشست (ثانیه)', '۸۶۴۰۰ = یک روز', 'number')}
          ${sInp('page_size', 'تعداد ردیف در هر صفحه', '', 'number')}
          ${sSel('theme', 'تم پیش‌فرض', [['dark', 'تیره'], ['light', 'روشن']])}
          ${sSel('calendar', 'تقویم', [['jalali', 'شمسی'], ['gregorian', 'میلادی']])}
          ${sSel('lang', 'زبان', [['fa', 'فارسی'], ['en', 'English']])}
        </div>
      </div>
      <div class="card"><h3>${ic('key')}تغییر رمز</h3>
        <div class="two">
          <label class="field"><span>رمز فعلی</span><input class="inp" type="password" id="pw-old" autocomplete="current-password"></label>
          <label class="field"><span>رمز جدید</span><input class="inp" type="password" id="pw-new" autocomplete="new-password"></label>
        </div>
        <button class="btn" id="pw-go" type="button">${ic('key')}تغییر رمز</button>
        <p class="hint">با تغییر رمز همه‌ی نشست‌های باز (شامل همین مرورگر) بسته می‌شوند.</p>
      </div>
      <div class="card"><h3>${ic('ghost')}مسیر پنل</h3>
        <div class="row">
          <input class="inp mono grow" id="pp-new" placeholder="مسیر جدید بدون /">
          <button class="btn ghost" id="pp-go" type="button">تغییر</button>
        </div>
        <p class="hint">آدرس فعلی: <code class="mono" id="pp-cur"></code> — بعد از تغییر، به آدرس جدید هدایت می‌شوید. مسیر قبلی مثل هر مسیر ناشناسی سایت استتار را نشان می‌دهد.</p>
      </div>
    </div>

    <div class="pane" id="p-sec">
      <div class="card"><h3>${ic('ghost')}سایت استتار</h3>
        ${sSel('decoy_mode', 'رفتار مسیرهای ناشناس', [['proxy', 'پروکسی یک سایت واقعی'], ['redirect', 'ریدایرکت'], ['1101', 'خطای ۱۱۰۱ کلادفلر'], ['404', '۴۰۴ خالی']], 'حالت «پروکسی» بهترین استتار است: بازدیدکننده یک سایت کامل می‌بیند.')}
        ${sInp('decoy_target', 'آدرس هدف', 'مثلاً https://www.docker.com')}
      </div>
      <div class="card"><h3>${ic('shield')}دسترسی</h3>
        ${sSw('ip_limit_enable', 'اعمال محدودیت IP همزمان', 'شمارش در بازه‌ی ۵ دقیقه')}
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button class="btn ghost" id="tfa-setup" type="button">${ic('key')}راه‌اندازی ۲FA</button>
          <button class="btn ghost" id="tfa-disable" type="button">${ic('refresh')}خاموش‌کردن ۲FA</button>
        </div>
        <div id="tfa-out" hidden>
          <div id="tfa-qr" style="background:#fff;padding:10px;border-radius:10px;width:fit-content;margin:8px 0"></div>
          <p class="hint mono" id="tfa-secret" style="word-break:break-all"></p>
          <div class="two">
            <label class="field"><span>کد ۶ رقمی اپ (برای تأیید و فعال‌سازی)</span><input class="inp mono" id="tfa-code" inputmode="numeric" maxlength="6"></label>
          </div>
          <button class="btn" id="tfa-enable" type="button">تأیید و فعال‌سازی</button>
        </div>
        ${sSw('kill_switch', 'Kill Switch — قطع کل سرویس', 'همه‌ی اتصال‌ها رد می‌شوند؛ پنل باز می‌ماند.')}
        <p class="hint">ورود دومرحله‌ای: با «راه‌اندازی» QR را با اپ Authenticator اسکن کن، کد ۶ رقمی را بزن و فعال کن — بعد از آن ورود بدون کد ممکن نیست.</p>
      </div>
    </div>

    <div class="pane" id="p-sub">
      <div class="card"><h3>${ic('qr')}اشتراک</h3>
        <div class="two">
          ${sInp('sub_path', 'مسیر اشتراک', 'آدرس نهایی: /<مسیر>/<توکن>')}
          ${sInp('sub_title', 'عنوان پروفایل')}
          ${sInp('sub_update_interval', 'فاصله‌ی به‌روزرسانی (ساعت)', '', 'number')}
          ${sInp('max_configs', 'حداکثر کانفیگ در هر ساب', 'آدرس × پورت زود بزرگ می‌شود', 'number')}
        </div>
        ${sSw('sub_show_info', 'نمایش کارت مصرف در صفحه‌ی اشتراک')}
        <div class="two">
          ${sInp('remark_template', 'قالب نام کانفیگ', 'متغیرها: {WORKER} {NODE} {PORT} {NAME} {DATE} {USAGE} {EXPIRY} {PROTO} {IDX}')}
          ${sInp('remark_separator', 'جداکننده')}
        </div>
        ${sTxt('fake_configs', 'کانفیگ‌های جعلی', 'یک لینک در هر خط؛ در انتهای فهرست اضافه می‌شوند.')}
        ${sTxt('external_subs', 'ساب‌های بیرونی', 'یک URL در هر خط؛ خروجی‌شان با ساب شما ادغام می‌شود.')}
      </div>
    </div>

    <div class="pane" id="p-net">
      <div class="card"><h3>${ic('globe')}خروجی</h3>
        ${sSel('proxyip_mode', 'روش عبور از محدودیت CF', [['proxyip', 'ProxyIP'], ['nat64', 'NAT64 / DNS64']], 'کلادفلر اتصال مستقیم به IPهای خودش را می‌بندد؛ هر دو روش همان مشکل را دور می‌زنند.')}
        ${sTxt('proxyip', 'ProxyIP', 'یک مورد در هر خط: <code class="mono">host[:port]</code> — به‌ترتیب امتحان می‌شوند.')}
        ${sTxt('nat64_prefixes', 'پیشوندهای NAT64', 'یک پیشوند IPv6 در هر خط.')}
        <div class="three">
          ${sInp('dial_parallel', 'دیال موازی', '۱ = ترتیبی. سقف ۳ (نصف ۶ اتصال همزمان CF)', 'number')}
          ${sInp('dial_timeout', 'مهلت هر دیال (ms)', '', 'number')}
          ${sInp('idle_timeout', 'مهلت بی‌فعالیتی (ms)', '', 'number')}
        </div>
      </div>
      <div class="card"><h3>${ic('route')}SOCKS5 بالادست</h3>
        ${sInp('socks5', 'آدرس SOCKS5', 'user:pass@host:port')}
        ${sSw('socks5_global', 'استفاده برای همه‌ی مقصدها')}
        ${sTxt('socks5_domains', 'فقط برای این دامنه‌ها', 'یک دامنه در هر خط (وقتی «همه‌ی مقصدها» خاموش است).')}
      </div>
      <div class="card"><h3>${ic('bolt')}IPهای تمیز و CDN</h3>
        ${sSw('dynamic_paths', 'مسیرهای داینامیک', 'مثل <code class="mono">/vl/proxyip=1.2.3.4:443</code> — تست سریع بدون تغییر تنظیمات.')}
        ${sTxt('clean_ips', 'IPهای تمیز', 'یک مورد در هر خط: <code class="mono">IP[:PORT]#نام</code>')}
        ${sInp('clean_ips_url', 'آدرس فهرست IP تمیز', 'هر بار ساخت ساب خوانده می‌شود.')}
        ${sTxt('custom_cdn', 'CDN اختصاصی', '<code class="mono">address|host|sni|label</code> در هر خط.')}
      </div>
    </div>

    <div class="pane" id="p-route">
      <div class="card"><h3>${ic('route')}قواعد سمت کلاینت</h3>
        <p class="hint" style="margin-top:0">این قواعد داخل کانفیگ sing-box/Clash/Xray نوشته می‌شوند و روی دستگاه کاربر اجرا می‌شوند — نه روی Worker.</p>
        ${sSw('bypass_iran', 'عبور مستقیم سایت‌های ایران')}
        ${sSw('bypass_lan', 'عبور مستقیم شبکه‌ی محلی')}
        ${sSw('block_ads', 'مسدودسازی تبلیغات')}
        ${sSw('block_porn', 'مسدودسازی محتوای بزرگسال')}
        ${sSw('block_quic', 'مسدودسازی QUIC', 'روی Worker فقط TCP ممکن است؛ بستن QUIC از افت کیفیت جلوگیری می‌کند.')}
        <div class="three">
          ${sTxt('custom_rules_direct', 'مستقیم')}
          ${sTxt('custom_rules_proxy', 'از پروکسی')}
          ${sTxt('custom_rules_block', 'مسدود')}
        </div>
      </div>
      <div class="card"><h3>${ic('users')}پروفایل‌های مسیریابی</h3>
        <p class="hint" style="margin-top:0">برای هر کاربر می‌توانی پروفایل جدا گذاشت — در مودال کاربر، فیلد «پروفایل مسیریابی (ID)» را با شماره‌ی پروفایل پر کن. قواعد پروفایل روی قواعد عمومی بالا اورلی می‌شوند و فقط برای همان کاربر در ساب می‌روند.</p>
        <div id="rp-list" class="hint"></div>
        <details>
          <summary>پروفایل جدید</summary>
          <label class="lbl">نام<input class="inp" id="rp-name" placeholder="مثلاً کاربران VIP"></label>
          <label class="lbl">قواعد مستقیم (یک مورد در هر خط؛ <code class="mono">ip:1.2.3.0/24</code> برای IP)<textarea class="inp mono" id="rp-direct" rows="2"></textarea></label>
          <div class="two">
            <label class="lbl">مسدود<textarea class="inp mono" id="rp-block" rows="2"></textarea></label>
            <label class="lbl">اجباری از پروکسی<textarea class="inp mono" id="rp-proxy" rows="2"></textarea></label>
          </div>
          <button class="btn ghost" id="rp-add" type="button">${ic('up')}افزودن پروفایل</button>
        </details>
      </div>
    </div>

    <div class="pane" id="p-dns">
      <div class="card"><h3>${ic('globe')}DNS</h3>
        <div class="two">
          ${sInp('dns_remote', 'DNS راه دور (DoH)')}
          ${sInp('dns_local', 'DNS محلی')}
          ${sInp('dns_underlying_doh', 'DoH پایه')}
          ${sInp('dns_relay', 'رله‌ی DNS سمت Worker', 'پرسش UDP روی TCP فرستاده می‌شود چون Worker UDP خام ندارد.')}
        </div>
        ${sSw('doh_enable', 'سرویس DoH روی همین Worker', 'مسیر <code class="mono">/dns-query</code>')}
        ${sSw('fakedns', 'FakeDNS')}
        ${sSw('ipv6', 'IPv6')}
      </div>
    </div>

    <div class="pane" id="p-node">
      <div class="card"><h3>${ic('server')}نودها</h3>
        ${sInp('node_pull_interval', 'فاصله‌ی pull کانفیگ (ثانیه)', 'کمتر از ۶۰ توصیه نمی‌شود.', 'number')}
        <label class="field"><span>کلید مشترک نودها</span><input class="inp mono" data-k="node_secret" placeholder="••••••••"></label>
        <p class="hint">توکن هر نود از این کلید مشتق می‌شود و جایی ذخیره نمی‌شود. <b>عوض کردنش همه‌ی نودها را قطع می‌کند</b> و باید توکن‌ها را دوباره در نودها بگذارید.</p>
      </div>
    </div>

    <div class="pane" id="p-tg">
      <div class="card"><h3>${ic('bolt')}ربات تلگرام</h3>
        <div class="two">
          ${sInp('tg_bot_token', 'توکن ربات', 'از @BotFather')}
          ${sInp('tg_chat_id', 'chat_id مدیر', 'اختیاری — با اتصال ربات خودکار پر می‌شود')}
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <button class="btn ghost" id="tg-connect" type="button">${ic('bolt')}اتصال ربات</button>
          <button class="btn ghost" id="tg-unbind" type="button">${ic('refresh')}لغو اتصال</button>
        </div>
        <pre class="mono hint" id="tg-out" style="white-space:pre-wrap"></pre>
        <p class="hint">«اتصال ربات» وب‌هوک را روی همین Worker ثبت می‌کند و یک <b>کلید API یک‌بارمصرف</b> می‌دهد؛ آن را در تلگرام به ربات بفرستید: <code class="mono">/start pplk_…</code> — از آن پس مدیریت کامل (آمار، روشن/خاموش، ریست حجم، تمدید، افزودن/حذف کاربر، Kill Switch) از داخل تلگرام ممکن است.</p>
        ${sSw('tg_notify_expiry', 'هشدار نزدیک‌شدن انقضا')}
        ${sSw('tg_notify_traffic', 'هشدار اتمام حجم')}
        ${sSw('tg_notify_login', 'اطلاع ورود به پنل')}
      </div>
    </div>

    <div class="pane" id="p-ops">
      <div class="card"><h3>${ic('db')}کلادفلر</h3>
        <div class="two">
          ${sInp('cf_api_token', 'توکن API', 'دسترسی Account Analytics: Read — برای نمایش سهمیه‌ی مصرف‌شده.')}
          ${sInp('cf_account_id', 'شناسه‌ی اکانت')}
        </div>
      </div>
      <div class="card"><h3>${ic('db')}پشتیبان‌گیری</h3>
        <p class="hint" style="margin-top:0">پشتیبان کامل: تنظیمات، کاربران، نودها، پروفایل‌های مسیریابی و کلیدهای API — <b>شامل رمزها و توکن‌هاست</b>، پس ایمن نگهش دار. بازگردانی داده‌های فعلی را جایگزین می‌کند؛ تاریخچه‌ی آمار و نشست‌ها سر جایشان می‌مانند.</p>
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <a class="btn ghost" id="bk-dl" href="#" download>${ic('down')}دانلود پشتیبان</a>
          <label class="btn ghost" style="cursor:pointer">${ic('up')}بازگردانی از فایل<input type="file" id="bk-file" accept="application/json,.json" hidden></label>
        </div>
        <pre class="mono hint" id="bk-out" style="white-space:pre-wrap"></pre>
      </div>
      <div class="card"><h3>${ic('clock')}نگه‌داری</h3>
        <p class="hint" style="margin-top:0">کران هر روز خودکار اجرا می‌شود: تمدید خودکار، ریست دوره‌ای ترافیک، سلامت نودها و پاک‌سازی داده‌های قدیمی.</p>
        <button class="btn ghost" id="cron-go" type="button">${ic('refresh')}اجرای دستی کران</button>
        <pre class="mono hint" id="cron-out" style="white-space:pre-wrap"></pre>
      </div>
      <div class="card"><h3>${ic('globe')}WARP (خروجی وایرگارد)</h3>
        <p class="hint" style="margin-top:0">هویت وایرگارد از کلادفلر ثبت می‌شود؛ بعد می‌توانی دامنه‌های خاص را به خروجی WARP بفرستی یا کل ساب را از روی WARP عبور دهی (دابل‌هاپ).</p>
        <div class="two">
          <label class="lbl">حالت<input class="inp" id="warp-mode" placeholder="direct یا chain"></label>
          <label class="lbl">فعال<input class="inp" id="warp-enabled" placeholder="1 = روشن"></label>
        </div>
        <label class="lbl">دامنه‌های WARP (یک در هر خط)<textarea class="inp" id="warp-sites" rows="3" placeholder="openai.com&#10;chatgpt.com"></textarea></label>
        <div class="row" style="gap:8px">
          <button class="btn ghost" id="warp-reg" type="button">${ic('refresh')}ثبت هویت WARP</button>
          <button class="btn ghost" id="warp-conf" type="button">${ic('down')}دانلود warp.conf</button>
        </div>
        <pre class="mono hint" id="warp-out" style="white-space:pre-wrap"></pre>
      </div>
      <div class="card"><h3>${ic('up')}ایمپورت از x-ui</h3>
        <p class="hint" style="margin-top:0">خروجی JSON پنل 3x-ui (آبجکتِ شامل <b>inbounds</b>) را اینجا بچسبان. کلاینت‌ها با توکن ساب تازه وارد می‌شوند و مصرف از صفر شروع می‌شود. Reality و grpc پرش می‌شوند و دلیلش اعلام می‌شود.</p>
        <label class="lbl">JSON خروجی x-ui<textarea class="inp mono" id="xui-json" rows="5" placeholder='{"inbounds":[…]} or [ … ]'></textarea></label>
        <button class="btn ghost" id="xui-go" type="button">${ic('up')}ایمپورت</button>
        <pre class="mono hint" id="xui-out" style="white-space:pre-wrap"></pre>
      </div>
    </div>

    <div class="row" style="position:sticky;bottom:0;background:var(--bg);padding:12px 0;gap:8px">
      <button class="btn" id="set-save" type="button">${ic('down')}ذخیره‌ی تنظیمات</button>
      <button class="btn ghost" id="set-reload" type="button">${ic('refresh')}بازخوانی</button>
      <span class="muted hint" id="set-note"></span>
    </div>
  </section>`;
/* __SECTIONS__ */

const APP_BODY = `<a class="skip-link" href="#main-content">رفتن به محتوای اصلی</a><aside class="side" id="side" aria-label="منوی اصلی">
  <div class="brand">
    <svg viewBox="0 0 24 24" aria-hidden="true">${I.shield}</svg>
    <div><b><span class="dot"></span>PersianPl</b><small>EDGE CONTROL CENTER</small></div>
  </div>
  <div class="nav-label">فضای مدیریت</div>
  ${NAVS.map(([id, icon, label], i) => `<button class="nav${i === 0 ? ' on' : ''}" data-go="${id}" type="button">${ic(icon)}<span>${label}</span><span class="n" id="n-${id}" hidden></span></button>`).join('\n  ')}
  <div class="sep"></div>
  <button class="nav" id="theme" type="button">${ic('sun')}<span>تغییر تم (تیره/روشن/ماه)</span></button>
  <button class="nav" id="motion" type="button" aria-pressed="false">${ic('eye')}<span>توقف جلوه‌های حرکتی</span></button>
  <button class="nav" id="logout" type="button">${ic('out')}<span>خروج</span></button>
  <div class="side-note"><b>یک پنل، تمام اتصال‌ها</b><p>مدیریت کاربران و اشتراک‌ها، بدون جابه‌جایی بین ابزارها.</p></div>
  <div class="foot">v1.0 · <span id="ver-ip" class="mono"></span></div>
</aside>

<main class="main" id="main-content" tabindex="-1">
  <div class="top">
    <button class="iconbtn burger" id="burger" type="button" aria-label="منو">
      <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    <h2 id="title">داشبورد</h2>
    <span class="sp"></span>
    <span class="badge acc" id="clock">${'—'}</span>
    <button class="btn ghost sm" id="reload" type="button">${ic('refresh')}به‌روزرسانی</button>
  </div>

  ${SEC_DASH}
  ${SEC_CLIENTS}
  ${SEC_INBOUNDS}
  ${SEC_NODES}
  ${SEC_SETTINGS}
  ${SEC_AUDIT}
</main>`;
/**
 * ── اسکریپت مشترک (ورود و پنل)
 *
 * بدون template literal نوشته شده چون خودش داخل یک template literal تایپ‌اسکریپت
 * می‌نشیند و `${…}` تفسیر می‌شد. همه‌جا الحاق رشته با `+`.
 */
const COMMON_SCRIPT = `
var PP=window.PP||{};
// مسیر پنل تصادفی است؛ ریشه را از اولین سگمنت آدرس برمی‌داریم تا API درست بسازیم.
var BASE='/'+(location.pathname.split('/').filter(Boolean)[0]||'');
function $(s,r){return (r||document).querySelector(s)}
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))}
function el(tag,cls,html){var n=document.createElement(tag);if(cls)n.className=cls;if(html!=null)n.innerHTML=html;return n}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fa(n){return (Number(n)||0).toLocaleString('fa-IR')}

function api(m,p,b){
  var o={method:m,credentials:'same-origin',headers:{'x-requested-with':'PersianPl'}};
  if(b!==undefined){o.headers['content-type']='application/json';o.body=JSON.stringify(b)}
  return fetch(BASE+'/api/'+p,o).then(function(r){
    // ۴۰۱ یعنی نشست رفته؛ بارگذاری مجدد صفحه‌ی ورود را می‌آورد.
    if(r.status===401&&p!=='login'){location.reload();throw new Error('نشست منقضی شد')}
    return r.text().then(function(t){
      var j;try{j=JSON.parse(t)}catch(e){throw new Error('پاسخ نامعتبر سرور')}
      if(!r.ok||j.ok===false)throw new Error(j.error||'خطای '+r.status);
      return j;
    });
  });
}

function toast(msg,kind){
  var box=$('#toasts');if(!box)return;
  var t=el('div','toast'+(kind?' '+kind:''),esc(msg));
  box.appendChild(t);
  setTimeout(function(){t.className+=' out';setTimeout(function(){t.remove()},220)},kind==='err'?4200:2600);
}

function bytes(n){
  n=Number(n)||0;
  if(n<1024)return fa(n)+' B';
  var u=['KB','MB','GB','TB','PB'],i=-1;
  do{n/=1024;i++}while(n>=1024&&i<u.length-1);
  return n.toLocaleString('fa-IR',{maximumFractionDigits:n<10?2:1})+' '+u[i];
}
function fdate(ts){
  if(!ts)return 'بدون انقضا';
  var loc=PP.calendar==='gregorian'?'fa-IR-u-ca-gregory':'fa-IR-u-ca-persian';
  try{return new Date(ts*1000).toLocaleDateString(loc,{year:'numeric',month:'2-digit',day:'2-digit'})}
  catch(e){return new Date(ts*1000).toISOString().slice(0,10)}
}
function fago(ts){
  if(!ts)return 'هرگز';
  var d=Math.floor(Date.now()/1000)-ts;
  if(d<0)d=0;
  if(d<60)return 'همین حالا';
  if(d<3600)return fa(Math.floor(d/60))+' دقیقه پیش';
  if(d<86400)return fa(Math.floor(d/3600))+' ساعت پیش';
  if(d<86400*30)return fa(Math.floor(d/86400))+' روز پیش';
  return fdate(ts);
}
function days(ts){
  if(!ts)return '∞';
  var d=Math.ceil((ts*1000-Date.now())/86400000);
  return d>0?fa(d):'۰';
}

function copy(text,btn){
  function done(){if(btn){var o=btn.getAttribute('data-l')||btn.textContent;btn.setAttribute('data-l',o);btn.textContent='کپی شد';setTimeout(function(){btn.textContent=o},1300)}else toast('کپی شد','ok')}
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done,function(){legacy(text,done)});
  }else legacy(text,done);
}
function legacy(text,done){
  var t=el('textarea');t.value=text;t.style.position='fixed';t.style.opacity='0';
  document.body.appendChild(t);t.select();
  try{document.execCommand('copy');done()}catch(e){toast('کپی نشد','err')}
  t.remove();
}

var THEME_KEY='pp-panel-theme';
(function(){
  try{var s=localStorage.getItem(THEME_KEY);if(s)document.documentElement.setAttribute('data-theme',s)}catch(e){}
})();
function toggleTheme(){
  // چرخه‌ی سه‌تمه: تیره (پیش‌فرض) → روشن → ماه سیاه → تیره
  var r=document.documentElement;
  var cur=r.getAttribute('data-theme')||'dark';
  var n=cur==='light'?'moon':cur==='moon'?'dark':'light';
  r.setAttribute('data-theme',n);
  try{localStorage.setItem(THEME_KEY,n)}catch(e){}
}
`;
/**
 * ── اسکریپت پنل
 *
 * یک SPA کوچک: هر بخش یک `<section class="sec">` است و `go()` بین‌شان جابه‌جا
 * می‌کند. داده‌ها با اولین ورود به هر بخش لود می‌شوند (نه همه در بوت) تا هم
 * سریع بالا بیاید و هم ریکوئست الکی به D1 نخورد.
 */
const APP_SCRIPT = `
// آیکون‌ها همان مجموعه‌ی سرور است تا در دکمه‌های ساخته‌شده با JS هم در دسترس
// باشند. \`<\` اسکیپ می‌شود چون رشته داخل \`<script>\` می‌نشیند.
var ICONS=${JSON.stringify(I).replace(/</g, '\\u003c')};
var VIEW='dash',INB=[],RP=[],CACHE={},SEL={};
var TITLES={dash:'داشبورد',clients:'کاربران',inbounds:'inboundها',nodes:'نودها',settings:'تنظیمات',audit:'رویدادها'};

function go(v){
  VIEW=v;
  $$('.nav[data-go]').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-go')===v)});
  $$('.sec').forEach(function(s){s.classList.toggle('on',s.id==='sec-'+v)});
  $('#title').textContent=TITLES[v]||v;
  document.body.classList.remove('menu');
  try{location.hash=v}catch(e){}
  load(v);
}

function load(v,force){
  if(CACHE[v]&&!force)return;
  CACHE[v]=1;
  if(v==='dash')loadDash();
  else if(v==='clients')loadClients();
  else if(v==='inbounds')loadInbounds();
  else if(v==='nodes')loadNodes();
  else if(v==='settings')loadSettings();
  else if(v==='audit')loadAudit();
}

function boot(){
  $$('[data-jump]').forEach(function(b){b.onclick=function(){go(b.getAttribute('data-jump'))}});
  var motion=$('#motion');
  function syncMotion(){
    var off=document.documentElement.getAttribute('data-motion')==='off';
    motion.setAttribute('aria-pressed',String(off));
    $('span',motion).textContent=off?'فعال‌کردن جلوه‌های حرکتی':'توقف جلوه‌های حرکتی';
  }
  try{if(localStorage.getItem('pp-panel-motion')==='off')document.documentElement.setAttribute('data-motion','off')}catch(e){}
  syncMotion();
  motion.onclick=function(){
    var next=document.documentElement.getAttribute('data-motion')==='off'?'on':'off';
    document.documentElement.setAttribute('data-motion',next);
    try{localStorage.setItem('pp-panel-motion',next)}catch(e){}
    syncMotion();
  };
  $$('.nav[data-go]').forEach(function(b){b.onclick=function(){go(b.getAttribute('data-go'))}});
  $('#theme').onclick=toggleTheme;
  $('#burger').onclick=function(){document.body.classList.toggle('menu')};
  $('#reload').onclick=function(){load(VIEW,true);toast('به‌روزرسانی شد')};
  $('#logout').onclick=function(){
    api('POST','logout',{}).then(function(){location.reload()}).catch(function(e){toast(e.message,'err')});
  };
  document.addEventListener('click',function(e){
    if(document.body.classList.contains('menu')&&!e.target.closest('.side')&&!e.target.closest('#burger'))
      document.body.classList.remove('menu');
  });
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){var m=$('.mask');if(m)m.remove();else document.body.classList.remove('menu')}
    // «/» کادر جست‌وجو را فوکوس می‌کند مثل هر پنل دیگری
    if(e.key==='/'&&VIEW==='clients'&&document.activeElement.tagName!=='INPUT'){e.preventDefault();$('#q').focus()}
  });
  tickClock();setInterval(tickClock,30000);
  bindClients();bindInbounds();bindNodes();bindSettings();
  var h=(location.hash||'').replace('#','');
  go(TITLES[h]?h:'dash');
  // داشبورد هر ۳۰ ثانیه تازه می‌شود؛ بقیه‌ی بخش‌ها دستی.
  setInterval(function(){if(VIEW==='dash')loadDash()},30000);
}

function tickClock(){
  var d=new Date(),loc=PP.calendar==='gregorian'?'fa-IR-u-ca-gregory':'fa-IR-u-ca-persian';
  var s='';
  try{s=d.toLocaleDateString(loc,{weekday:'long',day:'numeric',month:'long'})}catch(e){s=d.toISOString().slice(0,10)}
  $('#clock').textContent=s+' · '+d.toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'});
}
/* ── داشبورد ─────────────────────────────────────────── */
function loadDash(){
  api('GET','stats').then(function(d){
    var c=d.clients,t=d.traffic;
    setStat('total',fa(c.total),'فعال: '+fa(c.active)+' · غیرفعال: '+fa(c.disabled)+' · منقضی: '+fa(c.expired)+' · حجم تمام: '+fa(c.depleted));
    setStat('online',fa(c.online),'از '+fa(c.total)+' کاربر');
    setStat('traffic',bytes(t.total),'↑ '+bytes(t.up)+' · ↓ '+bytes(t.down));
    if(d.cf&&d.cf.requests!=null){
      var pc=Math.round(d.cf.requests/d.cf.limit*100);
      setStat('quota',fa(d.cf.requests),pc+'٪ از '+fa(d.cf.limit)+' — '+(d.nodes.length?fa(d.nodes.length)+' نود فعال یعنی '+fa((d.nodes.length+1)*d.cf.limit)+' سقف کل':'برای سقف بیشتر نود اضافه کنید'));
    }else{
      setStat('quota','—','توکن API کلادفلر را در تنظیمات › عملیاتی وارد کنید');
    }
    $('#n-clients').hidden=false;$('#n-clients').textContent=fa(c.total);
    if(d.nodes.length){$('#n-nodes').hidden=false;$('#n-nodes').textContent=fa(d.nodes.length)}
    if(d.inbounds.length){$('#n-inbounds').hidden=false;$('#n-inbounds').textContent=fa(d.inbounds.length)}
    spark(d.daily);
    listMini('#d-top',d.top,function(r){
      return '<span class="trunc">'+esc(r.name)+'</span><b class="num">'+bytes(Number(r.up)+Number(r.down))+'</b>';
    },'امروز مصرفی ثبت نشده');
    listMini('#d-exp',d.expiring,function(r){
      var dl=days(r.expiry_at);
      return '<span class="trunc">'+esc(r.name)+'</span><span class="badge '+(dl==='۰'?'bad':'warn')+'">'+dl+' روز</span>';
    },'انقضای نزدیکی وجود ندارد');
    rows('#d-inb',d.inbounds,function(r){
      return '<td data-h="تگ">'+esc(r.tag)+'</td><td data-h="پروتکل"><span class="badge acc">'+esc(r.protocol)+'</span></td>'+
        '<td data-h="کاربران" class="num">'+fa(r.clients)+'</td><td data-h="آپلود" class="num">'+bytes(r.up)+'</td>'+
        '<td data-h="دانلود" class="num">'+bytes(r.down)+'</td>';
    },'هنوز inboundی نساخته‌اید');
    rows('#d-nodes',d.nodes,function(r){
      return '<td data-h="نام">'+esc(r.name)+'</td><td data-h="منطقه">'+(esc(r.region)||'—')+'</td>'+
        '<td data-h="وضعیت">'+health(r.health)+'</td><td data-h="آخرین">'+fago(r.last_seen)+'</td>'+
        '<td data-h="ریکوئست" class="num">'+fa(r.req_today)+'</td>';
    },'نودی اضافه نشده — پنل خودش نود اول است');
  }).catch(function(e){toast(e.message,'err')});
}

function setStat(id,v,x){
  var a=$('#s-'+id),b=$('#x-'+id);
  if(a){a.textContent=v;a.classList.remove('skel')}
  if(b&&x!=null)b.innerHTML=x;
}

function listMini(sel,arr,fmt,empty){
  var box=$(sel);if(!box)return;
  if(!arr||!arr.length){box.innerHTML='<p class="empty">'+empty+'</p>';return}
  box.innerHTML='<div class="links">'+arr.map(function(r){
    return '<div class="l" style="grid-template-columns:1fr auto">'+fmt(r)+'</div>';
  }).join('')+'</div>';
}

function health(h){
  var m={ok:['ok','سالم'],stale:['warn','کند'],down:['bad','قطع'],unknown:['','نامعلوم']};
  var v=m[h]||m.unknown;
  return '<span class="badge '+v[0]+'"><i class="dot'+(h==='ok'?' pulse':'')+'"></i>'+v[1]+'</span>';
}

/**
 * اسپارک‌لاین ترافیک روزانه.
 * طول مسیر با getTotalLength گرفته می‌شود و در rAF بعدی آفست صفر می‌شود؛
 * بدون آن فاصله، مرورگر مقدار اولیه را ثبت نمی‌کند و انیمیشن اجرا نمی‌شود.
 */
function spark(daily){
  var svg=$('#d-chart'),W=600,H=120,P=6;
  if(!svg)return;
  var line=svg.querySelector('.draw'),area=svg.querySelector('.fill');
  if(!daily||daily.length<2){line.setAttribute('d','');area.setAttribute('d','');$('#d-sum').textContent='داده‌ی کافی برای نمودار نیست';return}
  var vals=daily.map(function(r){return Number(r.up)+Number(r.down)});
  var max=Math.max.apply(null,vals)||1,n=vals.length;
  var sum=vals.reduce(function(a,b){return a+b},0);
  $('#d-sum').textContent='جمع: '+bytes(sum)+' · اوج: '+bytes(max);
  var pts=vals.map(function(v,i){
    return [P+i*(W-2*P)/(n-1), H-P-(v/max)*(H-2*P)];
  });
  var d=pts.map(function(p,i){return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)}).join(' ');
  line.setAttribute('d',d);
  area.setAttribute('d',d+' L'+pts[n-1][0].toFixed(1)+' '+(H-P)+' L'+pts[0][0].toFixed(1)+' '+(H-P)+' Z');
  var len=line.getTotalLength();
  line.style.strokeDasharray=len;line.style.strokeDashoffset=len;
  requestAnimationFrame(function(){requestAnimationFrame(function(){line.style.strokeDashoffset='0'})});
}

function rows(sel,arr,fmt,empty,cols){
  var body=$(sel);if(!body)return;
  if(!arr||!arr.length){
    body.innerHTML='<tr><td colspan="'+(cols||9)+'"><p class="empty">'+ic_empty()+empty+'</p></td></tr>';
    return;
  }
  body.innerHTML=arr.map(function(r,i){return '<tr data-i="'+i+'">'+fmt(r,i)+'</tr>'}).join('');
}
function ic_empty(){
  return '<svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>';
}
/* ── کاربران ─────────────────────────────────────────── */
var CQ={page:1,pageSize:25,search:'',inbound:0,status:'all',sort:'id',dir:'desc'};
var CROWS=[],CTOTAL=0,CTIMER=0;

function bindClients(){
  $('#q').oninput=function(){
    // ۳۰۰ms مکث: تایپ سریع نباید هر حرف یک کوئری به D1 بزند.
    clearTimeout(CTIMER);
    CTIMER=setTimeout(function(){CQ.search=$('#q').value.trim();CQ.page=1;loadClients()},300);
  };
  $('#f-inb').onchange=function(){CQ.inbound=Number(this.value)||0;CQ.page=1;loadClients()};
  $('#f-st').onchange=function(){CQ.status=this.value;CQ.page=1;loadClients()};
  $('#c-size').onchange=function(){CQ.pageSize=Number(this.value)||25;CQ.page=1;loadClients()};
  $('#c-prev').onclick=function(){if(CQ.page>1){CQ.page--;loadClients()}};
  $('#c-next').onclick=function(){if(CQ.page*CQ.pageSize<CTOTAL){CQ.page++;loadClients()}};
  $('#c-new').onclick=function(){clientModal(null)};
  $('#c-bulk').onclick=bulkModal;
  $('#c-all').onchange=function(){
    var on=this.checked;
    CROWS.forEach(function(r){if(on)SEL[r.id]=1;else delete SEL[r.id]});
    $$('#c-body input[data-id]').forEach(function(b){b.checked=on});
    selbar();
  };
  $$('th.s').forEach(function(th){
    th.onclick=function(){
      var k=th.getAttribute('data-sort');
      CQ.dir=(CQ.sort===k&&CQ.dir==='desc')?'asc':'desc';
      CQ.sort=k;loadClients();
    };
  });
  $$('[data-bulk]').forEach(function(b){b.onclick=function(){bulkAction(b.getAttribute('data-bulk'))}});
  $('#c-body').addEventListener('click',onClientClick);
  $('#c-body').addEventListener('change',function(e){
    var cb=e.target.closest('input[data-id]');
    if(!cb)return;
    var id=Number(cb.getAttribute('data-id'));
    if(cb.checked)SEL[id]=1;else delete SEL[id];
    selbar();
  });
}

function selbar(){
  var n=Object.keys(SEL).length;
  $('#c-selbar').hidden=n===0;
  $('#c-selN').textContent=fa(n);
}

function loadClients(){
  if(!INB.length){
    // فیلتر inbound باید قبل از اولین رندر پر باشد وگرنه انتخاب کاربر می‌پرد.
    api('GET','inbounds').then(function(d){INB=d.inbounds;fillInbounds();rpRefresh();fetchClients()}).catch(fetchClients);
  }else fetchClients();
}
/** فهرست پروفایل‌ها برای dropdown مودال کاربر — فقط یک بار. */
function rpRefresh(){
  if(RP.length)return;
  api('GET','routing').then(function(d){RP=d.profiles}).catch(function(){});
}

function fillInbounds(){
  var sel=$('#f-inb');
  sel.innerHTML='<option value="">همه‌ی inboundها</option>'+INB.map(function(i){
    return '<option value="'+i.id+'">'+esc(i.tag)+' ('+esc(i.protocol)+')</option>';
  }).join('');
  sel.value=CQ.inbound||'';
}

function fetchClients(){
  var qs='page='+CQ.page+'&pageSize='+CQ.pageSize+'&status='+CQ.status+'&sort='+CQ.sort+'&dir='+CQ.dir;
  if(CQ.search)qs+='&search='+encodeURIComponent(CQ.search);
  if(CQ.inbound)qs+='&inbound='+CQ.inbound;
  $('#c-body').innerHTML='<tr><td colspan="9"><span class="skel">در حال بارگذاری…</span></td></tr>';
  api('GET','clients?'+qs).then(function(d){
    CROWS=d.rows;CTOTAL=d.total;
    render();
    var from=CTOTAL?(CQ.page-1)*CQ.pageSize+1:0;
    var to=Math.min(CTOTAL,CQ.page*CQ.pageSize);
    $('#c-info').textContent=fa(from)+'–'+fa(to)+' از '+fa(CTOTAL);
    $('#c-prev').disabled=CQ.page<=1;
    $('#c-next').disabled=CQ.page*CQ.pageSize>=CTOTAL;
    $$('th.s').forEach(function(th){
      var on=th.getAttribute('data-sort')===CQ.sort;
      th.classList.toggle('asc',on&&CQ.dir==='asc');
      th.classList.toggle('desc',on&&CQ.dir==='desc');
    });
  }).catch(function(e){
    $('#c-body').innerHTML='<tr><td colspan="9"><p class="empty">'+esc(e.message)+'</p></td></tr>';
  });
}

var GB=1073741824;

function render(){
  rows('#c-body',CROWS,function(r){
    var used=Number(r.up)+Number(r.down);
    var cap=Number(r.total_gb)*GB;
    var pct=cap>0?Math.min(100,Math.round(used/cap*100)):0;
    var tone=pct>=90?'b':pct>=70?'w':'';
    var on=Number(r.last_online)>Math.floor(Date.now()/1000)-300;
    return '<td class="pick"><input type="checkbox" data-id="'+r.id+'"'+(SEL[r.id]?' checked':'')+' aria-label="انتخاب"></td>'+
      '<td data-h="نام"><div class="row"><span class="dot" style="color:'+(on?'var(--ok)':'var(--line)')+'"></span>'+
        '<span class="trunc" title="'+esc(r.comment||'')+'">'+esc(r.name)+'</span></div></td>'+
      '<td data-h="inbound"><span class="badge">'+esc(r.inbound_tag)+'</span></td>'+
      '<td data-h="مصرف"><div class="row"><div class="bar grow"><i class="'+tone+'" style="width:'+pct+'%"></i></div>'+
        '<span class="muted num" style="font-size:.72rem">'+bytes(used)+(cap>0?' / '+bytes(cap):' / ∞')+'</span></div></td>'+
      '<td data-h="انقضا" class="num">'+(Number(r.expiry_at)?fdate(r.expiry_at)+' <span class="muted">('+days(r.expiry_at)+')</span>':'∞')+'</td>'+
      '<td data-h="IP" class="num">'+(Number(r.limit_ip)?fa(r.online_ips)+'/'+fa(r.limit_ip):fa(r.online_ips)+'/∞')+'</td>'+
      '<td data-h="آخرین اتصال">'+fago(r.last_online)+'</td>'+
      '<td data-h="وضعیت">'+status(r,used,cap)+'</td>'+
      '<td class="acts">'+
        btn('qr','qr','لینک و QR',r.id)+btn('edit','edit','ویرایش',r.id)+
        btn('reset','refresh','ریست مصرف',r.id)+
        btn('toggle','power',Number(r.enable)?'غیرفعال کردن':'فعال کردن',r.id)+
        btn('del','trash','حذف',r.id,'d')+
      '</td>';
  },'کاربری با این فیلتر پیدا نشد');
  $('#c-all').checked=CROWS.length>0&&CROWS.every(function(r){return SEL[r.id]});
}

function btn(act,icon,title,id,cls){
  return '<button class="iconbtn'+(cls?' '+cls:'')+'" data-a="'+act+'" data-id="'+id+'" title="'+title+'" aria-label="'+title+'">'+
    '<svg viewBox="0 0 24 24">'+ICONS[icon]+'</svg></button>';
}

function status(r,used,cap){
  if(!Number(r.enable))return '<span class="badge bad">غیرفعال</span>';
  if(Number(r.expiry_at)&&Number(r.expiry_at)<=Math.floor(Date.now()/1000))return '<span class="badge bad">منقضی</span>';
  if(cap>0&&used>=cap)return '<span class="badge bad">حجم تمام</span>';
  if(Number(r.delayed_days)&&!Number(r.first_seen))return '<span class="badge warn">شروع نشده</span>';
  if(cap>0&&used/cap>=0.9)return '<span class="badge warn">نزدیک اتمام</span>';
  return '<span class="badge ok">فعال</span>';
}

function onClientClick(e){
  var b=e.target.closest('button[data-a]');
  if(!b)return;
  var id=Number(b.getAttribute('data-id')),a=b.getAttribute('data-a');
  var row=CROWS.filter(function(r){return r.id===id})[0];
  if(a==='qr')return subModal(id,row);
  if(a==='edit')return clientModal(id);
  if(a==='reset')return act('POST','clients/reset',{ids:[id]},'مصرف ریست شد');
  if(a==='toggle')return api('PUT','clients/'+id,{enable:!Number(row.enable)}).then(function(){
    toast(Number(row.enable)?'غیرفعال شد':'فعال شد','ok');fetchClients();
  }).catch(function(er){toast(er.message,'err')});
  if(a==='del'){
    if(!confirm('کاربر «'+row.name+'» حذف شود؟ این کار برگشت‌پذیر نیست.'))return;
    return act('DELETE','clients/'+id,undefined,'حذف شد');
  }
}

function act(m,p,b,msg){
  return api(m,p,b).then(function(){toast(msg,'ok');SEL={};selbar();fetchClients();CACHE.dash=0})
    .catch(function(e){toast(e.message,'err')});
}

function bulkAction(kind){
  var ids=Object.keys(SEL).map(Number);
  if(!ids.length)return;
  if(kind==='reset')return act('POST','clients/reset',{ids:ids},'مصرف '+fa(ids.length)+' کاربر ریست شد');
  if(kind==='del'){
    if(!confirm(fa(ids.length)+' کاربر حذف شود؟'))return;
    return act('DELETE','clients/bulk',{ids:ids},fa(ids.length)+' کاربر حذف شد');
  }
  if(kind==='renew'){
    var d=prompt('چند روز تمدید شود؟','30');
    if(!d)return;
    return act('POST','clients/renew',{ids:ids,days:Number(d)||30},'تمدید شد');
  }
  // فعال/غیرفعال گروهی: API دسته‌ای ندارد، پس تک‌تک اما موازی.
  var on=kind==='on';
  Promise.all(ids.map(function(id){return api('PUT','clients/'+id,{enable:on})}))
    .then(function(){toast((on?'فعال':'غیرفعال')+' شد: '+fa(ids.length)+' کاربر','ok');SEL={};selbar();fetchClients()})
    .catch(function(e){toast(e.message,'err')});
}
/* ── مودال ───────────────────────────────────────────── */
/**
 * یک مودال ساده. «foot» رشته‌ی HTML دکمه‌ها است و «onFoot» با کلیدِ
 * data-x هر دکمه صدا زده می‌شود؛ برگرداندن true مودال را باز نگه می‌دارد.
 */
function modal(opts){
  var m=el('div','mask');
  m.innerHTML='<div class="modal'+(opts.wide?' wide':'')+'" role="dialog" aria-modal="true">'+
    '<header><h3>'+esc(opts.title)+'</h3><span class="sp" style="flex:1"></span>'+
    '<button class="iconbtn" data-x="close" aria-label="بستن"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>'+
    '<div class="body">'+opts.body+'</div>'+
    (opts.foot?'<footer>'+opts.foot+'</footer>':'')+'</div>';
  document.body.appendChild(m);
  function close(){m.remove()}
  m.addEventListener('click',function(e){
    if(e.target===m)return close();
    var b=e.target.closest('[data-x]');
    if(!b)return;
    var k=b.getAttribute('data-x');
    if(k==='close')return close();
    if(opts.onFoot&&opts.onFoot(k,m,close)===true)return;
    if(k!=='save'&&k!=='ok')close();
  });
  if(opts.after)opts.after(m,close);
  var first=m.querySelector('.body input,.body select,.body textarea');
  if(first)first.focus();
  return {node:m,close:close};
}

/** مقادیر همه‌ی فیلدهای data-f را در یک آبجکت جمع می‌کند. */
function collect(root){
  var out={};
  $$('[data-f]',root).forEach(function(n){
    var k=n.getAttribute('data-f');
    if(n.type==='checkbox')out[k]=n.checked;
    else if(n.getAttribute('data-n')!=null)out[k]=n.value===''?0:Number(n.value);
    else out[k]=n.value;
  });
  return out;
}
function fill(root,data){
  $$('[data-f]',root).forEach(function(n){
    var k=n.getAttribute('data-f');
    if(!(k in data)||data[k]==null)return;
    if(n.type==='checkbox')n.checked=!!Number(data[k])||data[k]===true;
    else n.value=data[k];
  });
}

function f(k,label,hint,type,n){
  return '<label class="field"><span>'+label+'</span><input class="inp'+(type==='mono'?' mono':'')+'" '+
    'type="'+(type==='mono'?'text':(type||'text'))+'" data-f="'+k+'"'+(n?' data-n="1"':'')+'>'+
    (hint?'<em class="hint">'+hint+'</em>':'')+'</label>';
}
function fnum(k,label,hint){return f(k,label,hint,'number',1)}
function fsw(k,label,hint){
  return '<label class="sw"><input type="checkbox" data-f="'+k+'"><i></i><span>'+label+
    (hint?' <em class="hint" style="display:inline">— '+hint+'</em>':'')+'</span></label>';
}
function fsel(k,label,opts,hint){
  return '<label class="field"><span>'+label+'</span><select class="inp" data-f="'+k+'">'+
    opts.map(function(o){return '<option value="'+o[0]+'">'+o[1]+'</option>'}).join('')+'</select>'+
    (hint?'<em class="hint">'+hint+'</em>':'')+'</label>';
}
function fold(title,icon,body,open){
  return '<details class="fold"'+(open?' open':'')+'><summary><svg viewBox="0 0 24 24">'+ICONS[icon]+'</svg>'+title+
    '</summary><div>'+body+'</div></details>';
}
/* ── مودال کاربر ─────────────────────────────────────── */
/**
 * فرم ساخت/ویرایش کاربر. فیلدها در چند بخش تاشو گروه شده‌اند: بخش «اصلی» باز
 * است و بقیه بسته، چون کاربر معمولی فقط نام و حجم و انقضا را می‌خواهد و بقیه
 * تنظیمات پیشرفته است.
 */
function clientModal(id){
  var isNew=!id;
  var body=
    fold('اصلی','users',
      '<div class="two">'+
      f('name','نام کاربر','یکتا در هر inbound — معادل email در x-ui')+
      fsel('inbound_id','inbound',INB.map(function(i){return [String(i.id),i.tag+' ('+i.protocol+')']}))+
      '</div>'+
      f('comment','توضیح','برای خودتان؛ در جست‌وجو هم پیدا می‌شود')+
      f('auth','UUID / رمز','خالی بگذارید تا خودکار ساخته شود','mono')+
      fsw('enable','فعال'),true)+
    fold('حجم و زمان','clock',
      '<div class="two">'+
      fnum('total_gb','سقف حجم (GB)','۰ = نامحدود')+
      fnum('expiry_days',isNew?'اعتبار (روز)':'تمدید از امروز (روز)','۰ = بدون انقضا')+
      '</div><div class="two">'+
      fnum('delayed_days','شروع تعویقی (روز)','انقضا از اولین اتصال حساب می‌شود، نه از الان')+
      fnum('renew_days','تمدید خودکار (روز)','۰ = بدون تمدید')+
      '</div>'+
      fnum('limit_ip','سقف IP همزمان','۰ = نامحدود · شمارش در بازه‌ی ۵ دقیقه'))+
    fold('شبکه','globe',
      f('pref_node','نود ترجیحی','نام نود؛ خالی = همه‌ی نودها در ساب بیایند')+
      '<div class="two">'+
      f('proxyip','ProxyIP اختصاصی','خالی = تنظیم عمومی','mono')+
      f('nat64_prefix','پیشوند NAT64 اختصاصی','','mono')+
      '</div>'+
      fsel('routing_id','پروفایل مسیریابی',[['','قواعد عمومی (بدون پروفایل)']].concat(RP.map(function(p){return [String(p.id),'#'+p.id+' — '+p.name]})),'در تب «مسیریابی» در تنظیمات ساخته می‌شود'),
      '</div>')+
    fold('ساب‌ساز','qr',
      '<div class="two">'+
      fsel('gen_fp','fingerprint',[['','پیش‌فرض'],['chrome','chrome'],['firefox','firefox'],['safari','safari'],['ios','ios'],['android','android'],['edge','edge'],['random','random'],['randomized','randomized']])+
      fsel('gen_alpn','ALPN',[['','پیش‌فرض'],['h2,http/1.1','h2, http/1.1'],['h2','h2'],['http/1.1','http/1.1']])+
      '</div>'+
      fsw('gen_frag','Fragment','بسته‌های TLS تکه‌تکه فرستاده می‌شوند — فقط در Xray JSON و v2rayNG')+
      '<div class="three">'+
      f('gen_frag_len','طول تکه','مثل 100-200')+
      f('gen_frag_int','فاصله (ms)','مثل 10-20')+
      fsel('gen_frag_pkt','بسته‌ها',[['tlshello','tlshello'],['1-1','1-1'],['1-3','1-3']])+
      '</div>'+
      fsw('gen_mux','Mux')+fsw('gen_insecure','allowInsecure','فقط برای تست — گواهی TLS بررسی نمی‌شود'))+
    fold('تلگرام','bolt',f('tg_chat_id','chat_id کاربر','برای ارسال هشدار انقضا و اتمام حجم به خودش'));

  var m=modal({
    title:isNew?'کاربر جدید':'ویرایش کاربر',
    body:body,
    foot:'<button class="btn" data-x="save">'+ic2('down')+'ذخیره</button>'+
      '<button class="btn ghost" data-x="close">انصراف</button><span class="sp"></span>'+
      (isNew?'':'<button class="btn ghost" data-x="rotate">'+ic2('key')+'تولید UUID جدید</button>'),
    onFoot:function(k,root,close){
      if(k==='rotate'){
        if(!confirm('شناسه‌ی احراز عوض شود؟ کاربر باید ساب را به‌روز کند.'))return true;
        api('POST','clients/'+id+'/rotate-auth',{}).then(function(d){
          $('[data-f=auth]',root).value=d.auth;toast('شناسه‌ی جدید ساخته شد','ok');
        }).catch(function(e){toast(e.message,'err')});
        return true;
      }
      if(k!=='save')return;
      var v=collect(root),p=payload(v);
      var req=isNew?api('POST','clients',p):api('PUT','clients/'+id,p);
      req.then(function(){toast(isNew?'کاربر ساخته شد':'ذخیره شد','ok');close();fetchClients();CACHE.dash=0})
        .catch(function(e){toast(e.message,'err')});
      return true;
    },
    after:function(root){
      if(isNew){
        fill(root,{enable:1,total_gb:0,expiry_days:30,limit_ip:0,inbound_id:CQ.inbound||(INB[0]&&INB[0].id)});
        return;
      }
      api('GET','clients/'+id).then(function(d){
        var c=d.client,g={};
        try{g=JSON.parse(c.gen_opts||'{}')}catch(e){}
        fill(root,{
          name:c.name,comment:c.comment,auth:c.auth,enable:c.enable,inbound_id:c.inbound_id,
          total_gb:c.total_gb,expiry_days:0,delayed_days:c.delayed_days,renew_days:c.renew_days,
          limit_ip:c.limit_ip,pref_node:c.pref_node,proxyip:c.proxyip,nat64_prefix:c.nat64_prefix,
          tg_chat_id:c.tg_chat_id,routing_id:c.routing_id?String(c.routing_id):'',
          gen_fp:g.fingerprint||'',gen_alpn:(g.alpn||[]).join(','),
          gen_frag:g.fragment?1:0,
          gen_frag_len:(g.fragment&&g.fragment.length)||'',
          gen_frag_int:(g.fragment&&g.fragment.interval)||'',
          gen_frag_pkt:(g.fragment&&g.fragment.packets)||'tlshello',
          gen_mux:(g.mux&&g.mux.enabled)?1:0,gen_insecure:g.allowInsecure?1:0
        });
        // در ویرایش، «تمدید از امروز» باید صفر بماند تا ذخیره‌ی ساده انقضا را نبرد.
        var ex=$('[data-f=expiry_days]',root);
        ex.value='0';
        ex.parentNode.querySelector('.hint').textContent=
          'انقضای فعلی: '+(Number(c.expiry_at)?fdate(c.expiry_at):'بدون انقضا')+' — عدد بگذارید تا از امروز تمدید شود';
      }).catch(function(e){toast(e.message,'err')});
    }
  });
  return m;
}

/** فرم را به بدنه‌ی API تبدیل می‌کند (gen_* در یک آبجکت جمع می‌شود). */
function payload(v){
  var g={};
  if(v.gen_fp)g.fingerprint=v.gen_fp;
  if(v.gen_alpn)g.alpn=v.gen_alpn.split(',');
  if(v.gen_insecure)g.allowInsecure=true;
  if(v.gen_mux)g.mux={enabled:true,concurrency:8};
  if(v.gen_frag)g.fragment={length:v.gen_frag_len||'100-200',interval:v.gen_frag_int||'10-20',packets:v.gen_frag_pkt||'tlshello'};
  var p={
    name:v.name,comment:v.comment,enable:v.enable,inbound_id:Number(v.inbound_id)||0,
    total_gb:v.total_gb,delayed_days:v.delayed_days,renew_days:v.renew_days,limit_ip:v.limit_ip,
    pref_node:v.pref_node,proxyip:v.proxyip,nat64_prefix:v.nat64_prefix,tg_chat_id:v.tg_chat_id,
    gen_opts:g
  };
  // پروفایل مسیریابی: خالی یعنی «حذف تخصیص» (NULL در دیتابیس).
  p.routing_id=v.routing_id?Number(v.routing_id):null;
  if(v.auth)p.auth=v.auth;
  if(Number(v.expiry_days)>0)p.expiry_days=Number(v.expiry_days);
  return p;
}

function ic2(name){return '<svg viewBox="0 0 24 24">'+ICONS[name]+'</svg>'}
/* ── مودال لینک و QR ─────────────────────────────────── */
/**
 * QR سمت سرور ساخته می‌شود (api/clients/&lt;id&gt;/sub) — عمداً هیچ سرویس بیرونی
 * صدا زده نمی‌شود، چون چیزی که در QR می‌رود همان لینک اشتراک کاربر است.
 */
function subModal(id,row){
  modal({
    title:'اشتراک: '+(row?row.name:''),
    wide:true,
    body:'<div class="qrbox">'+
      '<div class="qr" id="sm-qr"><span class="skel" style="display:block;width:136px;height:136px"></span></div>'+
      '<div>'+
        '<label class="field"><span>لینک اشتراک</span>'+
          '<div class="row"><input class="inp mono grow" id="sm-url" readonly spellcheck="false">'+
          '<button class="btn sm" id="sm-copy" type="button">کپی</button></div>'+
        '</label>'+
        '<div class="chips" id="sm-fmt"></div>'+
        '<p class="hint">هر فرمت را می‌توانید مستقیم به کاربر بدهید؛ کلاینت‌ها با User-Agent خودشان هم فرمت درست را می‌گیرند.</p>'+
      '</div>'+
    '</div>'+
    '<h3 style="font-size:.85rem;margin:16px 0 8px">کانفیگ‌ها <span class="muted" id="sm-n"></span></h3>'+
    '<div class="links" id="sm-links"><span class="skel">در حال ساخت…</span></div>',
    foot:'<button class="btn ghost" data-x="close">بستن</button><span class="sp"></span>'+
      '<button class="btn ghost" data-x="rotate">'+ic2('refresh')+'توکن ساب جدید</button>'+
      '<button class="btn ghost" data-x="clearips">'+ic2('eye')+'پاک‌کردن IPها</button>',
    onFoot:function(k,root,close){
      if(k==='rotate'){
        if(!confirm('توکن ساب عوض شود؟ لینک قبلی از کار می‌افتد.'))return true;
        api('POST','clients/'+id+'/rotate-sub',{}).then(function(){toast('توکن جدید ساخته شد','ok');close();subModal(id,row)})
          .catch(function(e){toast(e.message,'err')});
        return true;
      }
      if(k==='clearips'){
        api('POST','clients/'+id+'/clear-ips',{}).then(function(){toast('IPها پاک شد','ok');fetchClients()})
          .catch(function(e){toast(e.message,'err')});
        return true;
      }
    },
    after:function(root){
      api('GET','clients/'+id+'/sub').then(function(d){
        $('#sm-qr',root).innerHTML=d.qr;
        $('#sm-url',root).value=d.sub_url;
        $('#sm-copy',root).onclick=function(){copy(d.sub_url,this)};
        $('#sm-fmt',root).innerHTML=[['','v2ray'],['singbox','sing-box'],['clash','Clash Meta'],['xray','Xray JSON'],['html','صفحه‌ی کاربر']]
          .map(function(x){return '<a class="chip" target="_blank" rel="noopener" href="'+esc(d.sub_url+(x[0]?'/'+x[0]:''))+'">'+x[1]+'</a>'}).join('');
        $('#sm-n',root).textContent='('+fa(d.links.length)+')';
        $('#sm-links',root).innerHTML=d.links.map(function(l){
          var tag=l.split('#')[1]||'';
          try{tag=decodeURIComponent(tag.replace(/\\+/g,' '))}catch(e){}
          return '<div class="l"><div><div class="hint" style="margin:0">'+esc(tag)+'</div>'+
            '<input class="inp mono" value="'+esc(l)+'" readonly spellcheck="false"></div>'+
            '<button class="btn ghost sm" data-cp="1" type="button">کپی</button></div>';
        }).join('');
        $('#sm-links',root).onclick=function(e){
          var b=e.target.closest('[data-cp]');
          if(b)copy(b.parentNode.querySelector('input').value,b);
        };
      }).catch(function(e){
        $('#sm-links',root).innerHTML='<p class="empty">'+esc(e.message)+'</p>';
      });
    }
  });
}

/* ── ساخت گروهی ──────────────────────────────────────── */
function bulkModal(){
  modal({
    title:'ساخت گروهی کاربر',
    body:
      '<div class="two">'+
      fsel('inbound_id','inbound',INB.map(function(i){return [String(i.id),i.tag+' ('+i.protocol+')']}))+
      fnum('count','تعداد','حداکثر ۱۰۰ در هر بار')+
      '</div>'+
      fsel('naming','الگوی نام‌گذاری',[
        ['random','تصادفی — k7m2p9qr'],
        ['prefix','پیشوند + تصادفی — vip-k7m2p9'],
        ['number','فقط شماره — ۱، ۲، ۳'],
        ['postfix','تصادفی + پسوند — k7m2p9-vip'],
        ['prefix-number','پیشوند + شماره — vip-1، vip-2']
      ])+
      '<div class="two">'+
      f('base','پیشوند / پسوند','برای الگوهای پیشوندی و پسوندی')+
      fnum('start','شماره‌ی شروع','')+
      '</div>'+
      '<div class="two">'+
      fnum('total_gb','سقف حجم هر کاربر (GB)','۰ = نامحدود')+
      fnum('expiry_days','اعتبار (روز)','۰ = بدون انقضا')+
      '</div>'+
      '<div class="two">'+
      fnum('limit_ip','سقف IP همزمان','')+
      fnum('delayed_days','شروع تعویقی (روز)','')+
      '</div>',
    foot:'<button class="btn" data-x="save">'+ic2('users')+'ساخت</button><button class="btn ghost" data-x="close">انصراف</button>',
    onFoot:function(k,root,close){
      if(k!=='save')return;
      var v=collect(root);
      api('POST','clients/bulk',{
        inbound_id:Number(v.inbound_id)||0,count:v.count,naming:v.naming,base:v.base,start:v.start,
        total_gb:v.total_gb,limit_ip:v.limit_ip,delayed_days:v.delayed_days,
        expiry_days:Number(v.expiry_days)||0
      }).then(function(d){
        toast(fa(d.created)+' کاربر ساخته شد','ok');close();fetchClients();CACHE.dash=0;
      }).catch(function(e){toast(e.message,'err')});
      return true;
    },
    after:function(root){
      fill(root,{count:10,naming:'prefix-number',base:'user',start:1,total_gb:30,expiry_days:30,limit_ip:2,delayed_days:0,
        inbound_id:CQ.inbound||(INB[0]&&INB[0].id)});
    }
  });
}
/* ── inboundها ───────────────────────────────────────── */
function bindInbounds(){
  $('#i-new').onclick=function(){inboundModal(null)};
  $('#i-body').addEventListener('click',function(e){
    var b=e.target.closest('button[data-a]');
    if(!b)return;
    var id=Number(b.getAttribute('data-id')),a=b.getAttribute('data-a');
    var row=INB.filter(function(r){return r.id===id})[0];
    if(a==='edit')return inboundModal(id);
    if(a==='toggle')return api('PUT','inbounds/'+id,{id:id,enable:!Number(row.enable),
      tag:row.tag,remark:row.remark,protocol:row.protocol,transport:row.transport,path:row.path,
      host:row.host,sni:row.sni,ports:JSON.parse(row.ports||'[]'),max_early_data:row.max_early_data,
      ss_method:row.ss_method,vmess_security:row.vmess_security,total_gb:row.total_gb,
      traffic_reset:row.traffic_reset,expiry_at:row.expiry_at,extra:row.extra
    }).then(function(){toast('تغییر کرد','ok');loadInbounds()}).catch(function(er){toast(er.message,'err')});
    if(a==='del'){
      if(!confirm('inbound «'+row.tag+'» و همه‌ی '+fa(row.clients_count)+' کاربرش حذف شوند؟'))return;
      api('DELETE','inbounds/'+id).then(function(){toast('حذف شد','ok');loadInbounds();CACHE.clients=0})
        .catch(function(er){toast(er.message,'err')});
    }
  });
}

function loadInbounds(){
  api('GET','inbounds').then(function(d){
    INB=d.inbounds;fillInbounds();
    rows('#i-body',INB,function(r){
      var ports=[];try{ports=JSON.parse(r.ports||'[]')}catch(e){}
      return '<td data-h="تگ"><b>'+esc(r.tag)+'</b>'+(r.remark?'<div class="hint" style="margin:0">'+esc(r.remark)+'</div>':'')+'</td>'+
        '<td data-h="پروتکل"><span class="badge acc">'+esc(r.protocol)+'</span></td>'+
        '<td data-h="transport"><span class="badge">'+esc(r.transport)+'</span></td>'+
        '<td data-h="مسیر"><code class="mono">'+esc(r.path)+'</code></td>'+
        '<td data-h="پورت‌ها" class="num">'+(ports.length?fa(ports.length)+' پورت':'—')+'</td>'+
        '<td data-h="کاربران" class="num">'+fa(r.clients_count)+'</td>'+
        '<td data-h="ترافیک" class="num">'+bytes(Number(r.up)+Number(r.down))+'</td>'+
        '<td data-h="وضعیت">'+(Number(r.enable)?'<span class="badge ok">فعال</span>':'<span class="badge bad">غیرفعال</span>')+'</td>'+
        '<td class="acts">'+btn('edit','edit','ویرایش',r.id)+btn('toggle','power','فعال/غیرفعال',r.id)+
        btn('del','trash','حذف',r.id,'d')+'</td>';
    },'هیچ inboundی نیست — یکی بسازید تا کاربر اضافه شود');
  }).catch(function(e){toast(e.message,'err')});
}

/**
 * فرم inbound. گزینه‌های transport محدود است چون روی Worker فقط چیزهایی که
 * روی WebSocket/HTTP سوار می‌شوند ممکن‌اند — REALITY، mKCP، Hysteria و TUIC
 * به UDP خام یا کنترل کامل TLS نیاز دارند که Worker نمی‌دهد.
 */
function inboundModal(id){
  var isNew=!id;
  var row=isNew?null:INB.filter(function(r){return r.id===id})[0];
  var body=
    fold('اصلی','inbox',
      '<div class="two">'+
      f('tag','تگ','یکتا؛ خالی = خودکار')+
      f('remark','توضیح','')+
      '</div><div class="two">'+
      fsel('protocol','پروتکل',[['vless','VLESS'],['vmess','VMess'],['trojan','Trojan'],['shadowsocks','Shadowsocks']])+
      fsel('transport','transport',[['ws','WebSocket + TLS'],['httpupgrade','HTTPUpgrade'],['xhttp','XHTTP (stream-one)']],
        'REALITY/XTLS، mKCP، Hysteria2 و TUIC روی Worker ممکن نیستند (UDP خام و کنترل TLS لازم دارند).')+
      '</div>'+
      f('path','مسیر','باید یکتا باشد؛ خالی = تصادفی. همین مسیر است که اتصال را به این inbound وصل می‌کند.','mono')+
      fsw('enable','فعال'),true)+
    fold('پورت و میزبان','globe',
      f('ports','پورت‌های TLS','با کاما جدا کنید. خالی = همه‌ی پورت‌های TLS کلادفلر: 443, 2053, 2083, 2087, 2096, 8443','mono')+
      '<div class="two">'+
      f('host','Host header','خالی = دامنه‌ی خود Worker')+
      f('sni','SNI','خالی = همان Host')+
      '</div>'+
      fnum('max_early_data','max early data','۰ = خاموش. ۲۵۶۰ مقدار امن است؛ اولین بسته در هدر WS می‌رود و یک RTT صرفه‌جویی می‌شود.'))+
    fold('پروتکل','key',
      fsel('vmess_security','رمزنگاری VMess',[['auto','auto'],['none','none'],['aes-128-gcm','aes-128-gcm'],['chacha20-poly1305','chacha20-poly1305'],['zero','zero']],
        'sing-box مقدار auto را نمی‌فهمد و به aes-128-gcm برمی‌گردد.')+
      fsel('ss_method','روش Shadowsocks',[['aes-128-gcm','aes-128-gcm'],['aes-256-gcm','aes-256-gcm'],['chacha20-ietf-poly1305','chacha20-ietf-poly1305'],['none','none']]))+
    fold('محدودیت','clock',
      '<div class="two">'+
      fnum('total_gb','سقف حجم کل inbound (GB)','۰ = نامحدود')+
      fsel('traffic_reset','ریست دوره‌ای',[['never','هرگز'],['daily','روزانه'],['weekly','هفتگی'],['monthly','ماهانه']])+
      '</div>');

  modal({
    title:isNew?'inbound جدید':'ویرایش inbound',
    body:body,
    foot:'<button class="btn" data-x="save">'+ic2('down')+'ذخیره</button><button class="btn ghost" data-x="close">انصراف</button>',
    onFoot:function(k,root,close){
      if(k!=='save')return;
      var v=collect(root);
      var p={
        tag:v.tag,remark:v.remark,enable:v.enable,protocol:v.protocol,transport:v.transport,
        path:v.path,host:v.host,sni:v.sni,ports:v.ports,max_early_data:v.max_early_data,
        ss_method:v.ss_method,vmess_security:v.vmess_security,total_gb:v.total_gb,traffic_reset:v.traffic_reset
      };
      var req=isNew?api('POST','inbounds',p):api('PUT','inbounds/'+id,p);
      req.then(function(d){
        toast(isNew?'inbound ساخته شد — مسیر: '+d.path:'ذخیره شد','ok');
        close();loadInbounds();
      }).catch(function(e){toast(e.message,'err')});
      return true;
    },
    after:function(root){
      if(isNew){fill(root,{enable:1,protocol:'vless',transport:'ws',max_early_data:2560,total_gb:0,traffic_reset:'never',vmess_security:'auto',ss_method:'aes-128-gcm'});return}
      var ports='';try{ports=JSON.parse(row.ports||'[]').join(', ')}catch(e){}
      fill(root,{tag:row.tag,remark:row.remark,enable:row.enable,protocol:row.protocol,transport:row.transport,
        path:row.path,host:row.host,sni:row.sni,ports:ports,max_early_data:row.max_early_data,
        ss_method:row.ss_method,vmess_security:row.vmess_security,total_gb:row.total_gb,traffic_reset:row.traffic_reset});
    }
  });
}
/* ── نودها ───────────────────────────────────────────── */
var NODES=[];

function bindNodes(){
  $('#n-new').onclick=function(){nodeModal(null)};
  $('#n-body').addEventListener('click',function(e){
    var b=e.target.closest('button[data-a]');
    if(!b)return;
    var id=Number(b.getAttribute('data-id')),a=b.getAttribute('data-a');
    var row=NODES.filter(function(r){return r.id===id})[0];
    if(a==='edit')return nodeModal(id);
    if(a==='qr')return nodeSetup(row.name);
    if(a==='del'){
      if(!confirm('نود «'+row.name+'» حذف شود؟ توکنش از کار می‌افتد.'))return;
      api('DELETE','nodes/'+id).then(function(){toast('حذف شد','ok');loadNodes()})
        .catch(function(er){toast(er.message,'err')});
    }
  });
}

function loadNodes(){
  api('GET','nodes').then(function(d){
    NODES=d.nodes;
    rows('#n-body',NODES,function(r){
      return '<td data-h="نام"><b>'+esc(r.name)+'</b></td>'+
        '<td data-h="دامنه"><code class="mono">'+esc(r.host)+'</code></td>'+
        '<td data-h="منطقه">'+(esc(r.region)||'—')+'</td>'+
        '<td data-h="وزن" class="num">'+fa(r.weight)+'</td>'+
        '<td data-h="ترافیک امروز" class="num">'+bytes(r.today_bytes)+'</td>'+
        '<td data-h="وضعیت">'+(Number(r.enable)?health(r.health):'<span class="badge">خاموش</span>')+'</td>'+
        '<td data-h="آخرین دیده‌شدن">'+fago(r.last_seen)+'</td>'+
        '<td class="acts">'+btn('qr','key','راهنمای نصب و توکن',r.id)+btn('edit','edit','ویرایش',r.id)+
        btn('del','trash','حذف',r.id,'d')+'</td>';
    },'نودی اضافه نشده — پنل خودش نود اول است');
  }).catch(function(e){toast(e.message,'err')});
}

function nodeModal(id){
  var isNew=!id;
  var row=isNew?null:NODES.filter(function(r){return r.id===id})[0];
  modal({
    title:isNew?'افزودن نود':'ویرایش نود',
    body:
      '<div class="two">'+
      f('name','نام نود','فقط حروف انگلیسی، عدد، نقطه، خط تیره — در نام کانفیگ هم می‌آید')+
      f('host','دامنه‌ی نود','دامنه‌ای که در address کانفیگ می‌نشیند، مثل node1.example.com')+
      '</div>'+
      '<div class="two">'+
      f('region','منطقه','برای نمایش، مثل Germany')+
      fnum('weight','وزن','نود با وزن بیشتر بالاتر در ساب می‌آید')+
      '</div>'+
      f('ports','پورت‌های TLS','با کاما؛ خالی = همه‌ی پورت‌های TLS کلادفلر','mono')+
      f('proxyip','ProxyIP اختصاصی نود','خالی = تنظیم عمومی','mono')+
      fsw('enable','فعال'),
    foot:'<button class="btn" data-x="save">'+ic2('down')+'ذخیره</button><button class="btn ghost" data-x="close">انصراف</button>',
    onFoot:function(k,root,close){
      if(k!=='save')return;
      var v=collect(root);
      var p={name:v.name,host:v.host,region:v.region,weight:v.weight,ports:v.ports,proxyip:v.proxyip,enable:v.enable};
      var req=isNew?api('POST','nodes',p):api('PUT','nodes/'+id,p);
      req.then(function(d){
        close();loadNodes();
        // در ساخت، بلافاصله راهنمای نصب با توکن باز می‌شود؛ توکن جای دیگری
        // نمایش داده نمی‌شود مگر دوباره درخواست شود.
        if(isNew)nodeSetup(d.name,d.token);else toast('ذخیره شد','ok');
      }).catch(function(e){toast(e.message,'err')});
      return true;
    },
    after:function(root){
      if(isNew){fill(root,{enable:1,weight:100});return}
      var ports='';try{ports=JSON.parse(row.ports||'[]').join(', ')}catch(e){}
      fill(root,{name:row.name,host:row.host,region:row.region,weight:row.weight,ports:ports,proxyip:row.proxyip,enable:row.enable});
    }
  });
}

/** راهنمای نصب نود + توکن. توکن از سرور گرفته می‌شود اگر پاس داده نشده باشد. */
function nodeSetup(name,token){
  var panel=location.origin;
  function view(tk){
    return '<p class="hint" style="margin-top:0">این کد را در یک اکانت <b>دیگر</b> کلادفلر دیپلوی کنید. نود دیتابیس ندارد؛ '+
      'کانفیگ را از پنل می‌گیرد و آمار را برمی‌گرداند.</p>'+
      '<label class="field"><span>۱) همین ریپو را روی اکانت دیگر دیپلوی کنید</span>'+
      '<input class="inp mono" readonly value="npx wrangler deploy"></label>'+
      '<label class="field"><span>۲) متغیرهای محیطی نود</span>'+
      '<textarea class="inp mono" readonly rows="4" id="ns-env">ROLE = "node"\\nPANEL_URL = "'+panel+'"\\nNODE_NAME = "'+name+'"</textarea>'+
      '<em class="hint">در <code class="mono">wrangler.toml</code> بخش <code class="mono">[vars]</code></em></label>'+
      '<label class="field"><span>۳) توکن نود (Secret)</span>'+
      '<div class="row"><input class="inp mono grow" readonly id="ns-tk" value="'+esc(tk||'')+'">'+
      '<button class="btn sm" id="ns-cp" type="button">کپی</button></div>'+
      '<em class="hint">با دستور <code class="mono">npx wrangler secret put NODE_TOKEN</code> ست کنید. این توکن از کلید مشترک مشتق شده و در دیتابیس ذخیره نشده.</em></label>'+
      '<label class="field"><span>۴) کران نود</span>'+
      '<input class="inp mono" readonly value="crons = [&quot;*/5 * * * *&quot;]">'+
      '<em class="hint">نود هر ۵ دقیقه کانفیگ را pull و آمار را push می‌کند.</em></label>';
  }
  modal({
    title:'نصب نود: '+name,
    wide:true,
    body:view(token),
    foot:'<button class="btn ghost" data-x="close">بستن</button>',
    after:function(root){
      function wire(){
        var i=$('#ns-tk',root);
        $('#ns-cp',root).onclick=function(){copy(i.value,this)};
      }
      if(token){wire();return}
      api('POST','nodes/token',{name:name}).then(function(d){
        $('#ns-tk',root).value=d.token;wire();
      }).catch(function(e){toast(e.message,'err')});
      wire();
    }
  });
}
/* ── تنظیمات ─────────────────────────────────────────── */
var SETS={};

function bindSettings(){
  $$('.tab').forEach(function(t){
    t.onclick=function(){
      $$('.tab').forEach(function(x){x.classList.toggle('on',x===t)});
      var id=t.getAttribute('data-tab');
      $$('.pane').forEach(function(p){p.classList.toggle('on',p.id==='p-'+id)});
    };
  });
  $('#set-save').onclick=saveSettings;
  $('#set-reload').onclick=function(){loadSettings();toast('بازخوانی شد')};
  // WARP
  var wr=$('#warp-reg');if(wr)wr.onclick=function(){
    wr.disabled=true;
    api('POST','warp/register').then(function(d){
      $('#warp-out').textContent='ثبت شد ✓ endpoint: '+d.endpoint;
      toast('هویت WARP ثبت شد');
    }).catch(function(e){$('#warp-out').textContent=e.message;toast(e.message,'err')})
      .finally(function(){wr.disabled=false});
  };
  var wc=$('#warp-conf');if(wc)wc.onclick=function(){window.open(BASE+'/api/warp/conf','_blank')};
  // ایمپورت x-ui
  var xg=$('#xui-go');if(xg)xg.onclick=function(){
    var t=$('#xui-json').value.trim();
    if(!t)return toast('JSON خالی است','err');
    var j;try{j=JSON.parse(t)}catch(e){return toast('JSON نامعتبر: '+e.message,'err')}
    xg.disabled=true;
    api('POST','import-xui',j).then(function(d){
      var msg='ایمپورت شد: '+d.inbounds+' اینباند، '+d.clients+' کلاینت'+(d.skipped?', '+d.skipped+' پرش':'');
      $('#xui-out').textContent=msg+(d.warnings&&d.warnings.length?('\\n'+d.warnings.join('\\n')):'');
      toast(msg);
    }).catch(function(e){$('#xui-out').textContent=e.message;toast(e.message,'err')})
      .finally(function(){xg.disabled=false});
  };
  // پروفایل‌های مسیریابی
  function rpLoad(){
    var box=$('#rp-list');if(!box)return;
    api('GET','routing').then(function(d){
      RP=d.profiles;
      if(!d.profiles.length){box.textContent='هنوز پروفایلی نیست — کاربران از قواعد عمومی بالا پیروی می‌کنند.';return}
      box.innerHTML=d.profiles.map(function(p){
        return '<div>• <b>#'+p.id+'</b> '+esc(p.name)+' — '+(p.clients||0)+' کاربر'+(p.is_default?' · پیش‌فرض':'')+
          ' <button class="btn sm ghost" data-rp-del="'+p.id+'" type="button">حذف</button></div>';
      }).join('');
      $$('[data-rp-del]',box).forEach(function(b){
        b.onclick=function(){
          if(!confirm('حذف پروفایل؟ کاربرانش به قواعد عمومی برمی‌گردند.'))return;
          api('DELETE','routing/'+b.getAttribute('data-rp-del')).then(function(){toast('پروفایل حذف شد');rpLoad()}).catch(function(e){toast(e.message,'err')});
        };
      });
    }).catch(function(e){box.textContent=e.message});
  }
  rpLoad();
  var ra=$('#rp-add');
  if(ra)ra.onclick=function(){
    var name=$('#rp-name').value.trim();
    if(!name)return toast('نام پروفایل الزامی است','err');
    api('POST','routing',{name:name,rules:{
      direct:$('#rp-direct').value,block:$('#rp-block').value,proxy:$('#rp-proxy').value
    }}).then(function(){
      toast('پروفایل ساخته شد — ID آن را در مودال کاربر بگذار');
      $('#rp-name').value='';$('#rp-direct').value='';$('#rp-block').value='';$('#rp-proxy').value='';
      rpLoad();
    }).catch(function(e){toast(e.message,'err')});
  };
  $('#pw-go').onclick=function(){
    var o=$('#pw-old').value,n=$('#pw-new').value;
    if(n.length<8)return toast('رمز جدید باید حداقل ۸ کاراکتر باشد','err');
    api('POST','password',{old:o,new:n}).then(function(){
      toast('رمز عوض شد — باید دوباره وارد شوید','ok');
      setTimeout(function(){location.reload()},1500);
    }).catch(function(e){toast(e.message,'err')});
  };
  $('#pp-go').onclick=function(){
    var p=$('#pp-new').value.trim();
    if(!p)return;
    if(!confirm('مسیر پنل به «'+p+'» عوض شود؟ آدرس فعلی دیگر کار نمی‌کند.'))return;
    api('POST','panel-path',{path:p}).then(function(d){
      toast('مسیر عوض شد — انتقال…','ok');
      setTimeout(function(){location.href='/'+d.path},1200);
    }).catch(function(e){toast(e.message,'err')});
  };
  $('#cron-go').onclick=function(){
    var out=$('#cron-out');out.textContent='در حال اجرا…';
    api('POST','cron',{}).then(function(d){
      out.textContent=JSON.stringify(d.report,null,2);toast('کران اجرا شد','ok');
    }).catch(function(e){out.textContent='';toast(e.message,'err')});
  };
  $('#tg-connect').onclick=function(){
    var out=$('#tg-out');out.textContent='در حال اتصال…';
    api('POST','telegram/connect',{}).then(function(d){
      out.textContent='✅ ربات @'+d.username+' وصل شد.\\n\\nکلید API یک‌بارمصرف (همین حالا کپی کن):\\n'+d.api_key+'\\n\\nدر تلگرام بفرست:\\n/start '+d.api_key;
      toast('وب‌هوک ثبت شد','ok');
    }).catch(function(e){out.textContent='';toast(e.message,'err')});
  };
  $('#tg-unbind').onclick=function(){
    if(!confirm('اتصال ربات لغو شود؟ اعلان‌ها و مدیریت تلگرامی قطع می‌شود.'))return;
    api('POST','telegram/unbind',{}).then(function(){
      $('#tg-out').textContent='اتصال لغو شد.';toast('لغو شد','ok');
    }).catch(function(e){toast(e.message,'err')});
  };
  $('#tfa-setup').onclick=function(){
    api('POST','twofa/setup',{}).then(function(d){
      $('#tfa-out').hidden=false;
      $('#tfa-qr').innerHTML=d.qr;
      $('#tfa-secret').textContent='کلید (برای ورود دستی): '+d.secret;
      toast('QR ساخته شد — با اپ Authenticator اسکن کن','ok');
    }).catch(function(e){toast(e.message,'err')});
  };
  $('#tfa-enable').onclick=function(){
    api('POST','twofa/enable',{code:$('#tfa-code').value.trim()}).then(function(){
      $('#tfa-out').hidden=true;
      toast('۲FA فعال شد — از ورود بعدی کد می‌خواهد','ok');
    }).catch(function(e){toast(e.message,'err')});
  };
  $('#tfa-disable').onclick=function(){
    var c=prompt('برای خاموش‌کردن ۲FA، کد ۶ رقمی فعلی را وارد کن:');
    if(!c)return;
    api('POST','twofa/disable',{code:c.trim()}).then(function(){
      toast('۲FA خاموش شد','ok');
    }).catch(function(e){toast(e.message,'err')});
  };
  $('#bk-dl').href=BASE+'/api/backup';
  $('#bk-file').onchange=function(){
    var f=this.files[0];this.value='';if(!f)return;
    var rd=new FileReader();
    rd.onload=function(){
      if(!confirm('بازگردانی، همه‌ی داده‌های فعلی (کاربران/نودها/تنظیمات) را با فایل پشتیبان جایگزین می‌کند. مطمئنی؟'))return;
      var d;try{d=JSON.parse(rd.result)}catch(err){return toast('فایل JSON نامعتبر است','err')}
      var out=$('#bk-out');out.textContent='در حال بازگردانی…';
      api('POST','backup/restore',d).then(function(r){
        out.textContent='✅ بازگردانی شد — '+JSON.stringify(r.restored);
        toast('بازگردانی کامل شد','ok');
        CACHE.dash=0;CACHE.clients=0;loadSettings();
      }).catch(function(e){out.textContent='';toast(e.message,'err')});
    };
    rd.readAsText(f);
  };
}

function loadSettings(){
  api('GET','settings').then(function(d){
    SETS=d.settings;
    $$('[data-k]').forEach(function(n){
      var k=n.getAttribute('data-k'),v=SETS[k];
      if(v==null)return;
      if(n.getAttribute('data-b'))n.checked=v==='1'||v==='true';
      // مقدارهای ماسک‌شده را نباید در فیلد بگذاریم، وگرنه ذخیره‌ی بعدی
      // «••••••••» را به‌عنوان مقدار واقعی می‌نویسد.
      else if(v==='••••••••'){n.value='';n.placeholder='••••••••  (تغییر نمی‌کند اگر خالی بماند)'}
      else n.value=v;
    });
    $('#pp-cur').textContent='/'+(SETS.panel_path||'');
    $('#set-note').textContent='';
  }).catch(function(e){toast(e.message,'err')});
}

function saveSettings(){
  var body={};
  $$('[data-k]').forEach(function(n){
    var k=n.getAttribute('data-k');
    if(n.getAttribute('data-b'))body[k]=n.checked?'1':'0';
    else{
      var v=n.value;
      // فیلد ماسک‌شده‌ی خالی یعنی «دست نزن».
      if(v===''&&SETS[k]==='••••••••')return;
      body[k]=v;
    }
  });
  delete body.panel_path;
  // WARP از API اختصاصی خودش ذخیره می‌شود، نه در PUT عمومی تنظیمات.
  var wm=$('#warp-mode'),we=$('#warp-enabled'),ws=$('#warp-sites');
  if(we){
    var wb={};
    if(wm)wb.warp_mode=(wm.value||'direct').trim();
    if(ws)wb.warp_sites=ws.value;
    if(!we.value.trim()||we.value.trim()==='0')wb.warp_enabled='0';else wb.warp_enabled='1';
    api('PUT','settings',wb).catch(function(e){toast('WARP: '+e.message,'err')});
  }
  $('#set-save').disabled=true;
  api('PUT','settings',body).then(function(){
    toast('تنظیمات ذخیره شد','ok');
    $('#set-note').textContent='آخرین ذخیره: '+new Date().toLocaleTimeString('fa-IR');
    loadSettings();CACHE.dash=0;CACHE.clients=0;
  }).catch(function(e){toast(e.message,'err')}).then(function(){$('#set-save').disabled=false});
}

/* ── رویدادها ────────────────────────────────────────── */
function loadAudit(){
  api('GET','audit').then(function(d){
    var kinds={login:['ok','ورود'],login_fail:['bad','ورود ناموفق'],settings:['acc','تنظیمات'],
      client:['','کاربر'],node:['warn','نود'],cron:['','کران']};
    rows('#a-body',d.rows,function(r){
      var k=kinds[r.kind]||['',r.kind];
      return '<td data-h="زمان">'+fdate(r.at)+' '+new Date(r.at*1000).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'})+'</td>'+
        '<td data-h="نوع"><span class="badge '+k[0]+'">'+esc(k[1])+'</span></td>'+
        '<td data-h="کاربر">'+(esc(r.actor)||'—')+'</td>'+
        '<td data-h="IP"><code class="mono">'+(esc(r.ip)||'—')+'</code></td>'+
        '<td data-h="جزئیات" class="trunc">'+(esc(r.detail)||'—')+'</td>';
    },'رویدادی ثبت نشده',5);
  }).catch(function(e){toast(e.message,'err')});
}

api('GET','whoami').then(function(d){$('#ver-ip').textContent=d.user}).catch(function(){});
boot();
/* __APP__ */
`;
/* __TAIL__ */
