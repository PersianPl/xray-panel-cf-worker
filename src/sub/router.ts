/**
 * مسیر اشتراک: `/<sub_path>/<token>[/<format>]`
 *
 * تشخیص فرمت به‌ترتیب:
 *   1. مسیر صریح (`/sub/<token>/singbox`) — همیشه برنده
 *   2. `?format=` در query
 *   3. تشخیص از User-Agent
 *   4. پیش‌فرض: v2ray بیس‌۶۴
 *
 * چرا UA: کلاینت‌ها هنگام به‌روزرسانی ساب هیچ راهی برای گفتن «چه فرمتی
 * می‌خواهم» ندارند جز UA. اگر مرورگر باشد، صفحه‌ی HTML با QR سرو می‌شود.
 *
 * هدر `subscription-userinfo` مصرف و انقضا را به خود کلاینت می‌دهد تا کاربر
 * بدون ورود به پنل ببیند چقدر مانده — همان کاری که x-ui می‌کند.
 */
import { b64encode } from '../lib/crypto';
import { settings as loadSettingsObj, type Settings } from '../lib/settings';
import { buildConfigs, humanBytes, parsePorts, type SubContext } from './build';
import { buildLink } from './links';
import { buildSingbox } from './singbox';
import { buildClash } from './clash';
import { buildXray } from './xray';
import { subPage } from './page';
import { mergeExternalSubs } from './external';
import { resolveProfileRules } from '../panel/routing';
import { warpRuntime } from '../lib/warp';
import { clientIndex, bySubToken, type ClientEntry } from '../proxy/store';
import type { Env, GenOpts, Protocol, Transport } from '../types';

export type SubFormat = 'v2ray' | 'singbox' | 'clash' | 'xray' | 'html';

/** فرمت را از UA حدس می‌زند. */
export function detectFormat(ua: string): SubFormat {
  const u = ua.toLowerCase();
  if (!u) return 'v2ray';
  if (/sing-?box|hiddify|karing|sfa|sfi|sfm|sft|puernya/.test(u)) return 'singbox';
  if (/clash|mihomo|stash|flclash|clashmeta/.test(u)) return 'clash';
  if (/v2rayng|v2rayn|streisand|nekobox|nekoray|husi|exclave/.test(u)) return 'xray';
  if (/mozilla|chrome|safari|edg\/|firefox|opr\//.test(u)) return 'html';
  // shadowrocket/v2box/happ و بقیه با فهرست بیس‌۶۴ کار می‌کنند.
  return 'v2ray';
}

function normalizeFormat(raw: string | null): SubFormat | null {
  switch ((raw ?? '').toLowerCase()) {
    case 'v2ray':
    case 'b64':
    case 'base64':
      return 'v2ray';
    case 'singbox':
    case 'sing-box':
    case 'sb':
      return 'singbox';
    case 'clash':
    case 'meta':
    case 'mihomo':
      return 'clash';
    case 'xray':
    case 'json':
      return 'xray';
    case 'html':
    case 'page':
      return 'html';
    default:
      return null;
  }
}

const GB = 1024 * 1024 * 1024;

// ── فهرست IP تمیزِ بیرونی (`clean_ips_url`) ──
// فچ در هر درخواستِ ساب گران است؛ کش isolate با TTL ده‌دقیقه‌ای کافی است
// (KV نمی‌خواهیم — سهمیه‌ی write پلن Free را می‌سوزاند).
const CLEAN_TTL_MS = 10 * 60 * 1000;
let cleanCache: { url: string; text: string; at: number } | null = null;

/** متنِ فهرست IP تمیز را از URL می‌خواند؛ خطا = best-effort (کش کهنه یا خالی). */
export async function fetchCleanIps(s: Settings): Promise<string> {
  const url = s.get('clean_ips_url').trim();
  if (!url) return '';
  const now = Date.now();
  if (cleanCache && cleanCache.url === url && now - cleanCache.at < CLEAN_TTL_MS) return cleanCache.text;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).slice(0, 65536);
    cleanCache = { url, text, at: now };
    return text;
  } catch {
    // با شکست فچ، کش کهنه (اگر هست) به‌عنوان پاسخ می‌ماند — ساب هرگز نمی‌شکند.
    return cleanCache && cleanCache.url === url ? cleanCache.text : '';
  }
}

export async function handleSubscription(req: Request, env: Env, s: Settings, seg: string[]): Promise<Response> {
  const token = seg[0] ?? '';
  if (!token) return new Response(null, { status: 404 });

  const url = new URL(req.url);
  const idx = await clientIndex(env);
  const entry = bySubToken(idx, token);
  // توکن ناشناس نباید با ۴۰۴ـی فرق کند که بگوید «مسیر ساب درست است».
  if (!entry) return new Response(null, { status: 404 });

  const format =
    normalizeFormat(seg[1] ?? null) ?? normalizeFormat(url.searchParams.get('format')) ?? detectFormat(req.headers.get('user-agent') ?? '');

  const built = await buildFor(env, s, entry, url);

  // ادغام ساب‌های بیرونی — فقط در فرمت‌های لینک‌محور (v2ray بیس‌۶۴ و صفحه‌ی HTML).
  // خروجی‌های ساختارمند (sing-box/Clash/Xray) لینک خام نمی‌گیرند.
  if (format === 'v2ray' || format === 'html') {
    try {
      const ext = await mergeExternalSubs(s);
      if (ext.length) built.links.push(...ext);
    } catch {
      // best-effort: خطای ساب بیرونی هرگز سابِ اصلی را نمی‌شکند.
    }
  }

  if (format === 'html') {
    return new Response(subPage({ entry, s, links: built.links, subUrl: built.subUrl, usage: built.usage }), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const headers = new Headers({
    'cache-control': 'no-store',
    'profile-update-interval': String(Math.max(1, s.int('sub_update_interval', 12))),
    'profile-title': `base64:${b64encode(built.title)}`,
    'subscription-userinfo': built.userinfo,
  });

  if (format === 'singbox') {
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(built.singbox, null, 2), { headers });
  }
  if (format === 'xray') {
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(built.xray, null, 2), { headers });
  }
  if (format === 'clash') {
    headers.set('content-type', 'text/yaml; charset=utf-8');
    return new Response(built.clash, { headers });
  }

  headers.set('content-type', 'text/plain; charset=utf-8');
  return new Response(b64encode(built.links.join('\n')), { headers });
}

interface Built {
  links: string[];
  singbox: unknown;
  clash: string;
  xray: unknown[];
  title: string;
  userinfo: string;
  subUrl: string;
  usage: { up: number; down: number; total: number; expiry: number };
}

export type { Built };

/** همه‌ی فرمت‌ها یک‌جا ساخته می‌شوند؛ ساخت‌شان ارزان است و کد را ساده می‌کند. */
export async function buildFor(env: Env, s: Settings, entry: ClientEntry, url: URL): Promise<Built> {
  const row = await env.DB.prepare(
    `SELECT c.up, c.down, c.total_gb, c.expiry_at, c.gen_opts, c.name, c.routing_id,
            i.ports, i.max_early_data, i.vmess_security, i.ss_method, i.host, i.sni, i.path, i.protocol, i.transport
       FROM clients c JOIN inbounds i ON i.id = c.inbound_id WHERE c.id = ?`,
  )
    .bind(entry.id)
    .first<{
      up: number;
      down: number;
      total_gb: number;
      expiry_at: number;
      gen_opts: string;
      name: string;
      routing_id: number | null;
      ports: string;
      max_early_data: number;
      vmess_security: string;
      ss_method: string;
      host: string;
      sni: string;
      path: string;
      protocol: string;
      transport: string;
    }>();

  const nodes = await env.DB.prepare('SELECT name, host, ports, region FROM nodes WHERE enable = 1 ORDER BY weight DESC')
    .all<{ name: string; host: string; ports: string; region: string }>();

  // مصرف *امروز* برای تگ {DAILY} در نام کانفیگ (کوئری ارزان روی ایندکس روز).
  const today = new Date().toISOString().slice(0, 10);
  const dailyRow = await env.DB.prepare(
    'SELECT SUM(up + down) AS b FROM client_usage_daily WHERE client_id = ? AND day = ?',
  )
    .bind(entry.id, today)
    .first<{ b: number | null }>();

  const globalOpts = s.json<GenOpts>('default_gen_opts', {});
  const userOpts = row ? safeJson<GenOpts>(row.gen_opts) : {};
  const opts: GenOpts = { ...globalOpts, ...userOpts };

  const ctx: SubContext = {
    selfHost: url.hostname,
    nodes: nodes.results ?? [],
    settings: s,
    prefNode: entry.prefNode,
    cleanIpsExtra: await fetchCleanIps(s),
  };

  const usage = {
    up: row?.up ?? 0,
    down: row?.down ?? 0,
    total: Math.round((row?.total_gb ?? 0) * GB),
    expiry: row?.expiry_at ?? 0,
  };

  const items = buildConfigs({
    ctx,
    protocol: (row?.protocol ?? entry.protocol) as Protocol,
    transport: (row?.transport ?? entry.transport) as Transport,
    auth: entry.auth,
    path: row?.path ?? entry.path,
    host: row?.host ?? '',
    sni: row?.sni ?? '',
    maxEarlyData: row?.max_early_data ?? 0,
    ...(row?.vmess_security ? { vmessSecurity: row.vmess_security } : {}),
    ...(row?.ss_method ? { ssMethod: row.ss_method } : {}),
    opts,
    inboundPorts: parsePorts(row?.ports ?? '[443]'),
    remarkVars: {
      WORKER: s.get('sub_title') || url.hostname,
      NAME: entry.name,
      DATE: new Date().toISOString().slice(0, 10),
      USAGE: humanBytes(usage.up + usage.down),
      DAILY: humanBytes(dailyRow?.b ?? 0),
      EXPIRY: usage.expiry ? new Date(usage.expiry * 1000).toISOString().slice(0, 10) : '∞',
    },
    max: Math.max(1, s.int('max_configs', 60)),
  });

  const links = items.map((it) => buildLink(it.spec));
  // کانفیگ‌های جعلی برای پرکردن فهرست (هم استتار، هم راهنمای کاربر).
  for (const fake of s.lines('fake_configs')) links.push(fake);

  const flags = {
    bypassIran: s.bool('bypass_iran'),
    blockAds: s.bool('block_ads'),
    blockPorn: s.bool('block_porn'),
    blockQuic: s.bool('block_quic'),
    ipv6: s.bool('ipv6'),
    fakedns: s.bool('fakedns'),
    remoteDns: s.get('dns_remote'),
    localDns: s.get('dns_local'),
    underlyingDoh: s.get('dns_underlying_doh'),
    direct: s.lines('custom_rules_direct'),
    block: s.lines('custom_rules_block'),
    proxy: s.lines('custom_rules_proxy'),
    warp: warpRuntime(s),
  };

  // پروفایل مسیریابی اختصاصی کلاینت — روی flags اورلی می‌شود.
  if (row?.routing_id) {
    const p = await resolveProfileRules(env, row.routing_id);
    if (p) {
      if (typeof p.bypass_iran === 'boolean') flags.bypassIran = p.bypass_iran;
      if (typeof p.block_ads === 'boolean') flags.blockAds = p.block_ads;
      if (typeof p.block_porn === 'boolean') flags.blockPorn = p.block_porn;
      if (typeof p.block_quic === 'boolean') flags.blockQuic = p.block_quic;
      if (typeof p.ipv6 === 'boolean') flags.ipv6 = p.ipv6;
      if (typeof p.fakedns === 'boolean') flags.fakedns = p.fakedns;
      if (p.dns_remote) flags.remoteDns = p.dns_remote;
      if (p.dns_local) flags.localDns = p.dns_local;
      if (p.direct) flags.direct = [...flags.direct, ...p.direct.split(/[\r\n]+/)].filter(Boolean);
      if (p.block) flags.block = [...flags.block, ...p.block.split(/[\r\n]+/)].filter(Boolean);
      if (p.proxy) flags.proxy = [...flags.proxy, ...p.proxy.split(/[\r\n]+/)].filter(Boolean);
    }
  }

  const subUrl = `${url.origin}/${s.get('sub_path')}/${entry.subToken}`;

  return {
    links,
    singbox: buildSingbox({ items, opts, flags }),
    clash: buildClash({ items, opts, flags, subUrl, interval: s.int('sub_update_interval', 12) }),
    xray: buildXray({ items, opts, flags }),
    title: `${s.get('sub_title')} — ${entry.name}`,
    userinfo: `upload=${usage.up}; download=${usage.down}; total=${usage.total}; expire=${usage.expiry}`,
    subUrl,
    usage,
  };
}

function safeJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

export { loadSettingsObj };
