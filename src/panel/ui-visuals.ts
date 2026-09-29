/** Decorative network illustration. Never represents live traffic or node health. */
export const IMMERSIVE_APP_CSS = `
.side{background:linear-gradient(175deg,var(--card),var(--bg));border-inline-end:1px solid var(--line);border-left:0;z-index:10}
.brand{padding-bottom:18px}.brand small{letter-spacing:.5px}.nav svg{transition:transform .25s var(--ease-out)}
.nav.on{color:var(--fg);background:linear-gradient(100deg,var(--accent-soft),var(--card));box-shadow:inset -3px 0 var(--accent),0 4px 18px #00000008}
.nav-label{font-size:.64rem;letter-spacing:1px;padding:16px 14px 8px;color:var(--muted)}
.side-note{border:1px solid var(--line);border-radius:14px;margin:22px 4px;padding:14px;background:linear-gradient(125deg,var(--accent-soft),transparent)}
.side-note b{font-size:.77rem}.side-note p{font-size:.68rem;line-height:1.9;color:var(--muted);margin:5px 0 0}
.top{border:0;padding:0;margin-bottom:26px}.top-caption{font-size:.65rem;letter-spacing:.7px}.top h2{font-size:1.25rem}
.top #clock{background:var(--card);border-color:var(--line);color:var(--muted);padding:8px 12px}
.hero{position:relative;isolation:isolate;min-height:296px;padding:32px 36px;background:linear-gradient(110deg,color-mix(in srgb,var(--accent-soft) 42%,var(--card)),var(--card));border:1px solid var(--line);border-radius:24px;box-shadow:0 12px 40px #0000000c}
.hero::before{content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(90deg,transparent 97%,var(--line) 100%),linear-gradient(0deg,transparent 97%,var(--line) 100%);background-size:44px 44px;opacity:.13;mask-image:linear-gradient(90deg,#000,transparent 85%)}
.hero::after{content:'';position:absolute;top:0;inset-inline:8%;height:1px;background:linear-gradient(90deg,transparent,#f05e6d80,transparent)}
.hero-copy{position:relative;z-index:1;flex:1;min-width:0}.hero h1{font-size:clamp(1.65rem,2.6vw,2.4rem);letter-spacing:-1.1px;line-height:1.55;margin:12px 0}
.hero h1 span{color:var(--accent)}.hero p{line-height:2;font-size:.83rem;max-width:450px}
.hero .eyebrow{display:inline-flex;align-items:center;gap:8px;letter-spacing:2px;font-size:.62rem}.hero .eyebrow::before{content:'';width:18px;height:1px;background:currentColor}
.hero-actions{gap:10px;margin-top:24px}.hero-art{flex:0 1 370px;min-width:0;position:relative;margin:-20px -10px;text-align:center}
.network-art{width:100%;max-height:290px;display:block}.art-caption{color:var(--muted);font-size:.59rem;letter-spacing:2px;opacity:.8;margin-top:-10px}
.orbit-spin{transform-origin:220px 170px;animation:orbit-turn 70s linear infinite}.orbit-flow{animation:orbit-stream 16s linear infinite}.orbit-core{animation:orbit-float 7s ease-in-out infinite}.orbit-stars{animation:orbit-breathe 5s ease-in-out infinite}
@keyframes orbit-turn{to{transform:rotate(360deg)}}@keyframes orbit-stream{to{stroke-dashoffset:-648}}@keyframes orbit-float{50%{transform:translateY(-6px)}}@keyframes orbit-breathe{50%{opacity:.3}}
.section-heading{display:flex;align-items:center;gap:12px;margin:28px 2px 16px}.section-heading h3{font-size:.87rem}.section-heading span{font-size:.67rem;color:var(--muted)}.section-heading::after{content:'';height:1px;background:var(--line);flex:1}
.stat{min-height:166px;border-radius:20px;background:radial-gradient(circle at 0% 0%,color-mix(in srgb,var(--accent) 10%,transparent),transparent 58%),linear-gradient(145deg,var(--card),var(--bg));transition:transform .25s var(--ease-out),border-color .25s,box-shadow .25s}
.stat::before{inset-block:20px;inset-inline-end:0;width:2px;border-radius:3px;opacity:.8}.stat .k svg{width:38px;height:38px;padding:10px}.stat .v{font-size:2.05rem;letter-spacing:-1px}.stat .x{font-size:.67rem}.stat .v.num{direction:ltr;text-align:right;unicode-bidi:isolate}
.card{border-radius:20px;background:linear-gradient(140deg,var(--card),color-mix(in srgb,var(--card) 95%,var(--accent)));box-shadow:0 5px 20px #00000005}.card>h3{margin-bottom:22px;gap:10px}.card>h3>svg{width:30px;height:30px;padding:6px;background:var(--accent-soft);border-radius:9px}
#d-chart{height:190px!important}.chart-card{position:relative}.chart-caption{display:flex;justify-content:space-between;margin-top:12px;color:var(--muted);font-size:.65rem}.spark .draw{stroke:#9a91ff;stroke-width:2;vector-effect:non-scaling-stroke}.spark .fill{fill:#8b80ff;opacity:.1}
.tools{padding:18px;border-radius:18px}.tbl-wrap{border-radius:18px}.tbl-wrap th{background:color-mix(in srgb,var(--soft) 65%,var(--card));padding-block:16px}.tbl-wrap tbody tr:hover{background:color-mix(in srgb,var(--accent-soft) 25%,var(--card))}
.badge{padding:4px 10px}.badge.ok{background:color-mix(in srgb,var(--ok) 8%,transparent)}.badge.bad{background:color-mix(in srgb,var(--bad) 8%,transparent)}.badge.acc{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.empty{background:radial-gradient(ellipse at center,var(--soft),transparent 80%);padding:40px 20px;color:var(--muted)}.empty svg{opacity:.65;color:var(--accent);width:44px;height:44px}
.sec.on{animation:scene-in .45s var(--ease-out)}.sec.on .stats .stat{animation:scene-in .6s var(--ease-out) both}.sec.on .stat:nth-child(2){animation-delay:.05s}.sec.on .stat:nth-child(3){animation-delay:.1s}.sec.on .stat:nth-child(4){animation-delay:.15s}
@keyframes scene-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.tabs{padding:8px;gap:6px;scrollbar-width:thin}.tab.on{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 24%,transparent)}
.mask{backdrop-filter:blur(9px);background:#050813aa}.modal{border-color:color-mix(in srgb,var(--accent) 25%,var(--line));animation:scene-in .3s var(--ease-out)}.modal>header{background:linear-gradient(100deg,var(--accent-soft),var(--card));border-radius:20px 20px 0 0}.fold>summary{padding:13px 15px}.fold[open]>summary{color:var(--accent)}
.toast{padding:14px 18px;border-radius:14px;background:var(--surface-glass);backdrop-filter:blur(12px)}
.skip-link{position:fixed;top:8px;inset-inline-start:16px;z-index:100;transform:translateY(-150%);padding:10px 16px;background:var(--card);border:1px solid var(--accent);border-radius:10px}.skip-link:focus{transform:none}
@media(hover:hover) and (prefers-reduced-motion:no-preference){.stat:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--accent) 45%,var(--line));box-shadow:0 12px 25px #00000018}}
@media(min-width:901px){.side{width:246px}.main{padding-top:28px}.burger{display:none}}
@media(max-width:1100px){.hero{padding:28px}.hero-art{flex-basis:270px}.hero h1{font-size:1.7rem}}
@media(max-width:900px){:root[dir=rtl] body.menu .side{transform:none}.side{z-index:70}.hero-art{flex-basis:240px}.hero{min-height:260px}.top{margin-bottom:20px}.top #clock{font-size:.65rem}}
@media(max-width:680px){.hero{padding:24px;display:block;min-height:0}.hero h1{font-size:1.8rem;max-width:310px}.hero p{font-size:.79rem}.hero-art{width:200px;margin:12px auto -10px;opacity:.85}.network-art{max-height:155px}.art-caption{display:none}.hero-actions .btn{font-size:.77rem;min-width:120px}.hero-actions{margin-top:18px}.stat{min-height:154px;padding:16px 13px}.stat .v{font-size:1.65rem}.stat .k{font-size:.67rem;gap:4px}.stat .k svg{width:28px;height:28px;padding:6px}.stat .x{font-size:.62rem}.section-heading span{display:none}.top #clock{background:none;text-align:right;padding:0}.tbl-wrap th{padding:0}.tbl-wrap tbody tr:hover{background:var(--card)}.modal{max-height:92dvh}.modal>header,.modal>footer{padding:14px 16px}.tools{padding:13px}.side-note{margin-top:14px}.chart-caption{font-size:.58rem}.card>h3{flex-wrap:wrap}#d-sum{font-size:.65rem}.two>*{min-width:0}}
:root[data-motion=off] *, :root[data-motion=off] *::before, :root[data-motion=off] *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

export const NETWORK_ART = `<svg class="network-art" viewBox="0 0 440 340" fill="none" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="orbit-color" x1="60" y1="30" x2="370" y2="300" gradientUnits="userSpaceOnUse"><stop stop-color="#77a9b5"/><stop offset=".5" stop-color="#dc5262"/><stop offset="1" stop-color="#ff9da8"/></linearGradient>
    <radialGradient id="orbit-glow"><stop stop-color="#dc5262" stop-opacity=".27"/><stop offset="1" stop-color="#dc5262" stop-opacity="0"/></radialGradient>
    <linearGradient id="core-color" x1="176" y1="115" x2="276" y2="235" gradientUnits="userSpaceOnUse"><stop stop-color="#4a2530"/><stop offset="1" stop-color="#1d0f14"/></linearGradient>
  </defs>
  <circle cx="220" cy="170" r="167" fill="url(#orbit-glow)"/>
  <g stroke="url(#orbit-color)">
    <ellipse cx="220" cy="170" rx="184" ry="69" transform="rotate(-28 220 170)" opacity=".25"/>
    <ellipse cx="220" cy="170" rx="184" ry="69" transform="rotate(28 220 170)" opacity=".25"/>
    <circle cx="220" cy="170" r="120" opacity=".16"/>
    <circle class="orbit-spin" cx="220" cy="170" r="146" stroke-dasharray="3 15" opacity=".4"/>
    <g class="orbit-flow" stroke-dasharray="14 310" stroke-width="2.5"><ellipse cx="220" cy="170" rx="184" ry="69" transform="rotate(-28 220 170)"/><ellipse cx="220" cy="170" rx="184" ry="69" transform="rotate(28 220 170)"/></g>
    <path d="M220 43v30m0 194v30M57 170h32m262 0h32" opacity=".4"/>
  </g>
  <g class="orbit-core">
    <path d="m220 104 57 33v66l-57 33-57-33v-66z" fill="url(#core-color)" stroke="url(#orbit-color)" stroke-width="1.5"/>
    <path d="m220 114 48 28v56l-48 28-48-28v-56z" stroke="#ff9da8" stroke-opacity=".2"/>
    <path d="m220 139-21 9v17c0 16 9 29 21 33 12-4 21-17 21-33v-17z" stroke="url(#orbit-color)" stroke-width="2"/>
    <path d="m210 168 7 7 14-16" stroke="#ffd7db" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <g fill="#2a1a20" stroke="url(#orbit-color)"><rect x="65" y="85" width="38" height="38" rx="12"/><rect x="332" y="215" width="38" height="38" rx="12"/><circle cx="342" cy="93" r="8"/><circle cx="106" cy="253" r="6"/></g>
  <g stroke="#d15866" stroke-width="1.5"><path d="M76 98h16m-16 6h16m-16 6h8M344 226h14v14h-14zM347 233h8"/></g>
  <g class="orbit-stars" fill="#ffb8bf"><circle cx="143" cy="65" r="2"/><circle cx="298" cy="271" r="2"/><circle cx="386" cy="157" r="2"/><circle cx="62" cy="222" r="2"/></g>
</svg>`;

export const IMMERSIVE_CSS = `
:root{--ease-out:cubic-bezier(.22,1,.36,1);--surface-glass:color-mix(in srgb,var(--card) 88%,transparent)}
body{background:radial-gradient(ellipse at 4% 0%,#dc526212,transparent 42%),radial-gradient(ellipse at 90% 12%,#e35b680a,transparent 36%),var(--bg)}
::selection{background:var(--accent);color:#fff}
.btn,.iconbtn,.nav,.chip,.tab{transition:background .2s,border-color .2s,color .2s,box-shadow .2s,transform .2s var(--ease-out)}
.btn{min-height:44px;padding:10px 18px;letter-spacing:-.2px}
.btn:not(.ghost):not(.danger):not(.ok){background:linear-gradient(115deg,#dc5262,#a92437);box-shadow:0 4px 14px #dc526230,inset 0 1px #ffffff24}
.btn.ghost{background:color-mix(in srgb,var(--card) 60%,transparent)}
.btn:disabled{filter:none;box-shadow:none}
.iconbtn{width:40px;height:40px;padding:10px}
.inp{min-height:44px}
.inp:hover:not(:focus){border-color:color-mix(in srgb,var(--muted) 60%,var(--line))}
.inp::placeholder{color:var(--muted);opacity:.65}
.box{position:relative;width:min(430px,100%);padding:38px;border-radius:26px;border:1px solid var(--line);background:linear-gradient(145deg,var(--card),var(--bg));box-shadow:0 30px 100px #0003}
.box::before{content:'';position:absolute;top:-1px;inset-inline:20%;height:2px;background:linear-gradient(90deg,transparent,var(--accent),#ff9da8,transparent)}
.box .logo{width:66px;height:66px;padding:14px;border:1px solid var(--line);border-radius:20px;background:var(--accent-soft)}
.box h1{font-size:1.35rem;letter-spacing:.3px}
.box .tag{margin-bottom:30px}
.box .logo .shackle{stroke-dashoffset:0;animation:draw 1s var(--ease-out)}
@media(hover:hover) and (prefers-reduced-motion:no-preference){.btn:not(:disabled):hover{transform:translateY(-2px);box-shadow:0 7px 24px #c2394b2b}.nav:hover svg{transform:translateX(-2px)}.iconbtn:hover{transform:translateY(-2px)}}
`;
