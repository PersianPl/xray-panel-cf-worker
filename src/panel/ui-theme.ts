/** Visual layer with no external fonts, scripts or assets. */
export const PANEL_POLISH_CSS = `
/* پالت PersianPl: لاکی سرمه‌ای سه‌تمه (شب گرافیتی / روز روشن / ماه سیاه) */
:root{--bg:#12161b;--card:#1a2027;--soft:#202832;--line:#2b3540;--fg:#e7ebef;--muted:#98a4b0;--accent:#dc5262;--accent-soft:#3c2228;--violet:#e35b68;--radius:18px;--shadow:0 14px 40px #0003;color-scheme:dark}
:root[data-theme=light]{--bg:#f5f7fa;--card:#fff;--soft:#eef1f4;--line:#dce2e8;--fg:#20252b;--muted:#74808d;--accent:#ba2437;--accent-soft:#fae8ea;--violet:#d15866;--shadow:0 12px 35px #20252b10;color-scheme:light}
:root[data-theme=moon]{--bg:#080a0e;--card:#10141b;--soft:#161d27;--line:#222d3a;--fg:#e8edf5;--muted:#8290a2;--accent:#f05e6d;--accent-soft:#32151b;--violet:#ff9da8;--shadow:0 14px 40px #0004;color-scheme:dark}
body{background:radial-gradient(ellipse at 10% 0%,color-mix(in srgb,var(--accent) 10%,transparent),transparent 50%),var(--bg)}
button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:4px}
.btn{min-height:40px;border-radius:11px;font-weight:600}
.btn:not(.ghost):not(.danger):not(.ok){background:linear-gradient(125deg,#dc5262,#a92437);color:#fff;box-shadow:0 4px 14px #dc526230}
.iconbtn{width:36px;height:36px}
.inp,select.inp,textarea.inp{padding:11px 13px;border-radius:11px}
select.inp{padding-inline-end:32px}
.field>span{font-size:.82rem;margin-bottom:7px}
.box{border-top:3px solid var(--accent);box-shadow:var(--shadow)}
.toasts{bottom:24px;left:24px}
`;

export const DASHBOARD_POLISH_CSS = `
body{grid-template-columns:246px minmax(0,1fr)}
.side{padding:26px 16px 18px;background:linear-gradient(180deg,var(--card),var(--bg));gap:7px;overflow-y:auto}
.brand{padding:0 8px 26px;gap:12px}
.brand>svg{width:44px;height:44px;padding:9px;background:var(--accent-soft);border-radius:14px}
.brand .dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}
.brand b{font-size:1.2rem;letter-spacing:.4px;display:flex;align-items:center;gap:8px}
.brand small{font-size:.72rem;margin-top:6px}
.nav{padding:12px 14px;min-height:46px;border:1px solid transparent}
.nav.on{border-color:color-mix(in srgb,var(--accent) 30%,transparent);background:linear-gradient(100deg,var(--accent-soft),var(--card));box-shadow:inset -3px 0 var(--accent)}
.nav svg{width:20px;height:20px}
.nav-label{color:var(--muted);font-size:.68rem;padding:10px 14px;letter-spacing:1px}
.side .foot{border-top:1px solid var(--line);margin-top:auto;padding-top:18px}
.main{padding:28px clamp(18px,3vw,48px) 60px;width:100%;max-width:1680px;margin-inline:auto}
.top{gap:12px;margin-bottom:26px;padding-bottom:20px;border-bottom:1px solid var(--line)}
.top h2{font-size:1.35rem;font-weight:700}
.top-caption{font-size:.72rem;color:var(--muted);margin-bottom:3px}
.hero{display:flex;align-items:center;justify-content:space-between;gap:24px;overflow:hidden;padding:28px 30px;margin-bottom:24px;border:1px solid var(--line);border-radius:22px;background:radial-gradient(ellipse at 0% 0%,color-mix(in srgb,var(--violet) 19%,transparent),transparent 65%),linear-gradient(115deg,var(--card),var(--accent-soft))}
.hero h1{font-size:clamp(1.35rem,2.3vw,1.9rem);font-weight:750;margin:9px 0}
.hero p{margin:0;color:var(--muted);max-width:550px;font-size:.86rem}
.eyebrow{font-size:.68rem;color:var(--accent);letter-spacing:2px;display:block}
.hero-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.hero-mark{width:110px;height:110px;flex:none;border:1px solid var(--line);border-radius:28px;display:grid;place-items:center;background:var(--card);transform:rotate(-8deg)}
.hero-mark svg{width:62px;height:62px;fill:none;stroke:var(--accent);stroke-width:1.2}
.stats{gap:16px;margin-bottom:24px;grid-template-columns:repeat(4,minmax(0,1fr))}
.stat{padding:22px;box-shadow:0 6px 20px #0000000a;min-height:154px}
.stat .k{font-size:.78rem;justify-content:space-between;flex-direction:row-reverse}
.stat .k svg{width:34px;height:34px;padding:8px;border-radius:10px;color:var(--accent);background:var(--accent-soft)}
.stat.g .k svg{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.stat.v .k svg{color:var(--violet);background:color-mix(in srgb,var(--violet) 12%,transparent)}
.stat.w .k svg{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent)}
.stat .v{font-size:1.95rem;font-weight:700;margin:9px 0 6px;overflow-wrap:anywhere}
.stat .x{font-size:.7rem;line-height:1.8}
.card{padding:22px;margin-bottom:20px;box-shadow:0 6px 20px #00000008}
.card>h3{font-size:.94rem;margin-bottom:20px}
.card>h3>svg{width:21px;height:21px;flex:none;fill:none;stroke:var(--accent);stroke-width:1.7}
#d-chart{height:180px!important;background:repeating-linear-gradient(to top,transparent 0,transparent 44px,var(--line) 45px,transparent 46px);border-bottom:1px solid var(--line)}
.tools{padding:14px;background:var(--card);border:1px solid var(--line);border-radius:16px;gap:10px;margin-bottom:18px}
.tools .search .inp{width:100%;padding-inline-start:36px}
th,td{padding:14px 16px}
th{font-size:.76rem}
.tabs{background:var(--card);padding:7px;border:1px solid var(--line);border-radius:14px;gap:5px}
.tab{border:0;border-radius:9px;padding:10px 16px}
.tab.on{background:var(--accent-soft);color:var(--accent)}
.empty{padding:44px 20px;border:1px dashed var(--line);border-radius:14px;background:color-mix(in srgb,var(--soft) 35%,transparent)}
.modal{border-radius:20px;box-shadow:0 24px 100px #0006}
.modal>header,.modal>footer{padding:18px 22px}
.modal>.body{padding:22px}
#xui-out,#tg-out{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:1150px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:900px){body{grid-template-columns:minmax(0,1fr)}.side{inset-inline-start:0;inset-inline-end:auto;width:246px}.main{padding:18px 16px 40px}.top{gap:8px}.hero{padding:24px}.top-caption{display:none}}
@media(max-width:680px){.hero-mark{display:none}.hero{padding:22px}.hero-actions{width:100%}.hero-actions .btn{flex:1;justify-content:center}.stats{gap:10px}.stat{padding:15px;min-height:144px}.stat .v{font-size:1.5rem}.stat .k{font-size:.7rem}.card{padding:16px}.top #clock{order:5;width:100%;border:0;padding:0}.tools{padding:12px}.tools .search{flex-basis:100%}.tools .inp{max-width:100%}.modal>.body{padding:16px}td{padding:6px 0}.hero h1{font-size:1.4rem}}
`;
