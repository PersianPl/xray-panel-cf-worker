/**
 * منبع کاربران روی D1، با کش در سطح isolate.
 *
 * چرا «همه را یک‌جا بخوان» و نه «به‌ازای هر اتصال یک SELECT»:
 *   • تطبیق authID در VMess ذاتاً به cmdKey **همه‌ی** کاربران نیاز دارد (authID
 *     یک AES-ECB از زمان است، قابل جست‌وجو در ایندکس نیست)، پس یک بار خواندن
 *     همه، از هر طرح دیگری ارزان‌تر است.
 *   • سقف ۵۰ کوئری در هر invocation و تأخیر D1 اجازه‌ی کوئری per-connection
 *     را نمی‌دهد؛ یک isolate می‌تواند صدها نشست را با همین یک بار خواندن سرو کند.
 *
 * بهای این طرح: تغییرات پنل تا `TTL_MS` در مسیر داده دیده نمی‌شود. برای
 * «غیرفعال کردن فوری» پنل باید `invalidateClients()` را صدا بزند (همان isolate)
 * و بقیه‌ی isolateها حداکثر یک TTL عقب می‌مانند.
 */
import { uuidToBytes } from '../lib/crypto';
import { hex } from '../lib/hexutil';
import { pendingOf } from '../lib/usage';
import { authIdKey, vmessCmdKey } from './vmess';
import { trojanKey } from './trojan';
import { parseProxyList, type DialOptions, type ProxyEntry } from './dial';
import { parseSocks5Upstream } from './socks5';
import type { ClientStore, MatchedClient } from './session';
import type { Settings } from '../lib/settings';
import type { Env, Protocol, Transport } from '../types';

/** عمر کش کاربران در isolate. کوتاه است تا تغییر پنل زود اثر کند. */
const TTL_MS = 10_000;
/** پنجره‌ی «IP فعال» برای limit_ip. */
export const IP_WINDOW_SEC = 300;
const GB = 1024 * 1024 * 1024;

/** ردیف خام join شده‌ی clients × inbounds. */
interface Row {
  id: number;
  inbound_id: number;
  name: string;
  auth: string;
  enable: number;
  total_gb: number;
  up: number;
  down: number;
  expiry_at: number;
  delayed_days: number;
  limit_ip: number;
  sub_token: string;
  proxyip: string;
  nat64_prefix: string;
  pref_node: string;
  first_seen: number;
  ib_id: number;
  ib_tag: string;
  ib_protocol: string;
  ib_transport: string;
  ib_path: string;
  ib_enable: number;
  ib_total_gb: number;
  ib_up: number;
  ib_down: number;
  ib_expiry_at: number;
}

/** یک کاربر با هرچه لایه‌ی داده برای تصمیم‌گیری لازم دارد. */
export interface ClientEntry {
  id: number;
  inboundId: number;
  name: string;
  auth: string;
  protocol: Protocol;
  transport: Transport;
  path: string;
  subToken: string;
  limitIp: number;
  delayedDays: number;
  firstSeen: number;
  proxyip: string;
  nat64Prefix: string;
  prefNode: string;
  /** ۱۶ بایت UUID (فقط vless/vmess). */
  uuid: Uint8Array | null;
  /** هگز SHA-224 رمز (فقط trojan). */
  trojanHash: string | null;
  /** دلیل رد، اگر کاربر واجد شرایط نیست. */
  reject: string | null;
}

/** یک inbound سبک، برای تطبیق مسیر و ساخت لینک ساب. */
export interface InboundLite {
  id: number;
  tag: string;
  protocol: Protocol;
  transport: Transport;
  path: string;
  enable: number;
}

interface Index {
  at: number;
  entries: ClientEntry[];
  byUuidHex: Map<string, ClientEntry>;
  byTrojan: Map<string, ClientEntry>;
  bySubToken: Map<string, ClientEntry>;
  byId: Map<number, ClientEntry>;
  inbounds: InboundLite[];
  /** IPهای فعال هر کاربر در پنجره‌ی اخیر (از D1، با تأخیر ≤ TTL). */
  recentIps: Map<number, Set<string>>;
  /** کاندیدهای VMess — یک‌بار محاسبه، چون KDF گران است. */
  vmess: Array<{ uuid: Uint8Array; cmdKey: Uint8Array; authIdKey: Uint8Array }>;
}

let index: Index | null = null;
let loading: Promise<Index> | null = null;

export function invalidateClients(): void {
  index = null;
}

/** IPهای دیده‌شده در همین isolate — مکمل داده‌ی D1 که تا یک TTL عقب است. */
const localIps = new Map<number, Map<string, number>>();

const SQL = `
SELECT c.id, c.inbound_id, c.name, c.auth, c.enable, c.total_gb, c.up, c.down,
       c.expiry_at, c.delayed_days, c.limit_ip, c.sub_token, c.proxyip, c.nat64_prefix,
       c.pref_node, c.first_seen,
       i.id AS ib_id, i.tag AS ib_tag, i.protocol AS ib_protocol, i.transport AS ib_transport,
       i.path AS ib_path, i.enable AS ib_enable, i.total_gb AS ib_total_gb,
       i.up AS ib_up, i.down AS ib_down, i.expiry_at AS ib_expiry_at
FROM clients c JOIN inbounds i ON i.id = c.inbound_id`;

/** ایندکس کاربران را برمی‌گرداند و اگر لازم بود از D1 می‌خواند. */
export async function clientIndex(env: Env, force = false): Promise<Index> {
  if (!force && index && Date.now() - index.at < TTL_MS) return index;
  // چند نشست همزمان نباید چند بار بخوانند.
  if (loading) return loading;
  loading = load(env).finally(() => {
    loading = null;
  });
  return loading;
}

async function load(env: Env): Promise<Index> {
  const now = Math.floor(Date.now() / 1000);
  const [rows, ips, ibs] = await Promise.all([
    env.DB.prepare(SQL).all<Row>(),
    env.DB.prepare('SELECT client_id, ip FROM client_ips WHERE last_seen > ?')
      .bind(now - IP_WINDOW_SEC)
      .all<{ client_id: number; ip: string }>(),
    env.DB.prepare('SELECT id, tag, protocol, transport, path, enable FROM inbounds').all<InboundLite>(),
  ]);

  const entries: ClientEntry[] = [];
  const byUuidHex = new Map<string, ClientEntry>();
  const byTrojan = new Map<string, ClientEntry>();
  const bySubToken = new Map<string, ClientEntry>();
  const byId = new Map<number, ClientEntry>();
  const vmess: Index['vmess'] = [];

  for (const r of rows.results ?? []) {
    const e = toEntry(r, now);
    entries.push(e);
    byId.set(e.id, e);
    if (e.subToken) bySubToken.set(e.subToken, e);

    if (e.uuid) {
      byUuidHex.set(hex(e.uuid), e);
      // فقط کاربران بی‌مانع در تطبیق authID می‌آیند تا KDF بی‌جهت خرج نشود؛
      // ولی رد شدن هم باید *بعد از* تطبیق پیام بدهد، پس اینجا فیلتر نمی‌کنیم.
      const cmdKey = vmessCmdKey(e.uuid);
      vmess.push({ uuid: e.uuid, cmdKey, authIdKey: authIdKey(cmdKey) });
    }
    if (e.trojanHash) byTrojan.set(e.trojanHash, e);
  }

  const recentIps = new Map<number, Set<string>>();
  for (const row of ips.results ?? []) {
    let s = recentIps.get(row.client_id);
    if (!s) {
      s = new Set();
      recentIps.set(row.client_id, s);
    }
    s.add(row.ip);
  }

  index = {
    at: Date.now(),
    entries,
    byUuidHex,
    byTrojan,
    bySubToken,
    byId,
    inbounds: ibs.results ?? [],
    recentIps,
    vmess,
  };
  return index;
}

function toEntry(r: Row, now: number): ClientEntry {
  const protocol = r.ib_protocol as Protocol;
  const isUuid = protocol === 'vless' || protocol === 'vmess';
  return {
    id: r.id,
    inboundId: r.inbound_id,
    name: r.name,
    auth: r.auth,
    protocol,
    transport: r.ib_transport as Transport,
    path: r.ib_path,
    subToken: r.sub_token,
    limitIp: r.limit_ip,
    delayedDays: r.delayed_days,
    firstSeen: r.first_seen,
    proxyip: r.proxyip,
    nat64Prefix: r.nat64_prefix,
    prefNode: r.pref_node,
    uuid: isUuid && /^[0-9a-f-]{32,36}$/i.test(r.auth) ? uuidToBytes(r.auth) : null,
    trojanHash: protocol === 'trojan' ? trojanKey(r.auth) : null,
    reject: rejectReason(r, now),
  };
}

/**
 * آیا این کاربر اجازه‌ی اتصال دارد؟ `null` یعنی بله.
 *
 * ترتیب پیام‌ها از «کلی» به «شخصی» است تا در پنل قابل فهم باشد. بایت‌های
 * ثبت‌شده‌ی همین isolate که هنوز در D1 نیستند هم حساب می‌شوند، وگرنه یک کاربر
 * می‌توانست در فاصله‌ی دو flush از سقفش رد شود.
 */
function rejectReason(r: Row, now: number): string | null {
  if (!r.ib_enable) return `inbound «${r.ib_tag}» غیرفعال است`;
  if (r.ib_expiry_at > 0 && now >= r.ib_expiry_at) return `inbound «${r.ib_tag}» منقضی شده`;
  if (r.ib_total_gb > 0 && r.ib_up + r.ib_down >= r.ib_total_gb * GB) return `ترافیک inbound «${r.ib_tag}» تمام شده`;

  if (!r.enable) return 'کاربر غیرفعال است';
  if (r.expiry_at > 0 && now >= r.expiry_at) return 'اشتراک منقضی شده';
  if (r.total_gb > 0) {
    const used = r.up + r.down + pendingOf(r.id);
    if (used >= r.total_gb * GB) return 'ترافیک تمام شده';
  }
  return null;
}

// ───────────────────────────── ClientStore روی D1 ─────────────────────────────

export interface StoreContext {
  /** IP کلاینت (`CF-Connecting-IP`) برای limit_ip. */
  ip?: string;
  /** فقط این inbound مجاز است (مسیر WS مشخصش کرده). */
  inboundId?: number;
  /** تنظیمات سراسری، برای ساخت DialOptions هر کاربر. */
  settings: Settings;
  /** آیا limit_ip اعمال شود (تنظیم `ip_limit_enable`). */
  enforceIpLimit: boolean;
}

/**
 * `ClientStore` واقعی: روی ایندکسِ کش‌شده کار می‌کند، پس هیچ کوئری‌ای در مسیر
 * داغ نمی‌زند (به‌جز اولین اتصالِ هر isolate).
 */
export class D1ClientStore implements ClientStore {
  constructor(
    private readonly idx: Index,
    private readonly ctx: StoreContext,
  ) {}

  async byUuid(uuid: Uint8Array): Promise<MatchedClient | null> {
    return this.wrap(this.idx.byUuidHex.get(hex(uuid)));
  }

  async byTrojanKey(hashHex: string): Promise<MatchedClient | null> {
    return this.wrap(this.idx.byTrojan.get(hashHex));
  }

  async vmessCandidates(): Promise<Array<{ uuid: Uint8Array; cmdKey: Uint8Array; authIdKey: Uint8Array }>> {
    return this.idx.vmess;
  }

  /** ورودی خام را به `MatchedClient` تبدیل و سقف‌های وابسته به اتصال را می‌سنجد. */
  private wrap(e: ClientEntry | undefined): MatchedClient | null {
    if (!e) return null;
    // مسیر WS پروتکل و inbound را تعیین کرده؛ کاربرِ inbound دیگری نباید از این
    // مسیر بیاید وگرنه سقف‌های inbound دور زده می‌شود.
    if (this.ctx.inboundId !== undefined && e.inboundId !== this.ctx.inboundId) return null;

    const reject = e.reject ?? this.ipReject(e);
    return {
      clientId: e.id,
      inboundId: e.inboundId,
      name: e.name,
      dial: dialOptionsFor(e, this.ctx.settings),
      ...(reject ? { reject } : {}),
    };
  }

  private ipReject(e: ClientEntry): string | null {
    if (!this.ctx.enforceIpLimit || e.limitIp <= 0) return null;
    const ip = this.ctx.ip;
    const seen = activeIps(this.idx, e.id);
    if (ip && seen.has(ip)) return null; // IP تکراری سهمیه‌ی تازه نمی‌خواهد
    if (seen.size < e.limitIp) return null;
    return `سقف ${e.limitIp} IP همزمان پر است`;
  }
}

/** IPهای فعالِ یک کاربر: دادهٔ D1 (تا یک TTL عقب) + دیده‌شده‌های همین isolate. */
function activeIps(idx: Index, clientId: number): Set<string> {
  const out = new Set(idx.recentIps.get(clientId) ?? []);
  const local = localIps.get(clientId);
  if (local) {
    const cutoff = Math.floor(Date.now() / 1000) - IP_WINDOW_SEC;
    for (const [ip, at] of local) {
      if (at > cutoff) out.add(ip);
      else local.delete(ip);
    }
  }
  return out;
}

/** یک IP را در حافظه‌ی isolate ثبت می‌کند تا limit_ip بین دو flush هم درست بماند. */
export function noteIp(clientId: number, ip: string | undefined): void {
  if (!ip) return;
  let m = localIps.get(clientId);
  if (!m) {
    m = new Map();
    localIps.set(clientId, m);
  }
  m.set(ip, Math.floor(Date.now() / 1000));
}

/**
 * `DialOptions` مؤثر یک کاربر: تنظیم سراسری + override اختصاصی.
 *
 * فیلدهای خالیِ کاربر نباید تنظیم سراسری را پاک کنند، پس هرکدام جدا بررسی
 * می‌شود (spread ساده مقدار خالی را هم می‌نویسد).
 */
export function dialOptionsFor(e: ClientEntry, s: Settings): DialOptions {
  const proxyRaw = e.proxyip.trim() || s.get('proxyip');
  const proxyList: ProxyEntry[] = parseProxyList(proxyRaw);

  const nat64Raw = e.nat64Prefix.trim() || s.get('nat64_prefixes');
  const nat64 = nat64Raw
    .split(/[\r\n,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const mode = s.get('proxyip_mode');
  const order: DialOptions['order'] =
    mode === 'nat64' ? ['direct', 'nat64', 'proxyip', 'socks5', 'trojan'] : ['direct', 'proxyip', 'nat64', 'socks5', 'trojan'];

  // زنجیره‌ی SOCKS5: اگر آدرس تنظیم شده باشد، در DialOptions می‌رود. فهرست
  // دامنه‌ها خالی = همه‌ی مقصدها از بالادست می‌روند (رفتار GO2SOCKS5).
  const socksRaw = s.get('socks5').trim();
  const socks5 = socksRaw ? parseSocks5Upstream(socksRaw) : null;
  const socks5Domains = s.lines('socks5_domains').map((x) => x.toLowerCase()).filter(Boolean);

  const parallel = s.int('dial_parallel', 1);
  return {
    proxyList,
    nat64,
    order,
    ...(parallel > 1 ? { parallel } : {}),
    ...(socks5 ? { socks5: { upstream: socks5, domains: socks5Domains } } : {}),
  };
}

/** یک inbound را با مسیر WS پیدا می‌کند (مسیر باید یکتا باشد). */
export function inboundByPath(idx: Index, path: string): InboundLite | null {
  for (const ib of idx.inbounds) {
    if (ib.path && ib.path === path) return ib;
  }
  return null;
}

/** کاربر را با توکن ساب پیدا می‌کند (برای صفحه‌ی اشتراک). */
export function bySubToken(idx: Index, token: string): ClientEntry | null {
  return idx.bySubToken.get(token) ?? null;
}

export function byClientId(idx: Index, id: number): ClientEntry | null {
  return idx.byId.get(id) ?? null;
}

export type { Index as ClientIndex };

