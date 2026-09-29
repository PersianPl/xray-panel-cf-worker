/**
 * دیال مقصد از داخل Worker — با همه‌ی مسیرهای فرار که در Workers ممکن است.
 *
 * ترتیب تلاش (قابل تنظیم per-client):
 *   1. مستقیم: connect(host:port) — روی اکثر مقصدها کار می‌کند
 *   2. proxyip: connect(proxyip:port) — لبه‌ی CF اتصال به IPهای خودش را می‌بندد،
 *      پس برای مقصدهای Cloudflare-محور (اکثر سایت‌ها) لازم است
 *   3. NAT64: مقصد IPv4 را داخل یک prefix شش‌گانه جا می‌دهد؛ CF مسیر IPv6 را باز می‌گذارد
 *   4. Trojan-relay: به یک سرور Trojan بیرونی وصل می‌شود و مقصد را داخل تونل می‌فرستد
 *
 * محدودیت‌های واقعی Workers که این ماژول رعایت می‌کند:
 *   • حداکثر ۶ اتصال خروجی همزمان در هر invocation → سقف موازی‌سازی ۳ است
 *   • حداکثر ۵۰ subrequest → resolve با DoH فقط یک‌بار و با کش isolate
 *   • connect() تنبل است: خطای اتصال تا اولین read/write ظاهر نمی‌شود، پس صحت اتصال
 *     را با opened تأیید می‌کنیم نه با نبودِ throw
 */
import { connect } from 'cloudflare:sockets';
import { ByteWriter, concat, readU16be, u16be } from '../lib/bytes';
import { buildTrojanRequest, TROJAN_ADDR } from './trojan';
import { socks5Handshake, type Socks5Upstream } from './socks5';
import { writeTarget } from './target';
import type { Target } from './types';

/** پورت پیش‌فرض proxyip وقتی در رشته ذکر نشده. */
const DEFAULT_PROXY_PORT = 443;
/** بیشترین زمان انتظار برای باز شدن یک اتصال قبل از رفتن به مسیر بعدی. */
const OPEN_TIMEOUT_MS = 2500;
/** سقف موازی‌سازی — نصفِ سقف ۶ اتصالی CF تا جای Trojan-relay هم بماند. */
const MAX_PARALLEL = 3;

export interface DialResult {
  socket: Socket;
  /** کدام مسیر جواب داد — برای نمایش در پنل و دیباگ. */
  via: string;
  /**
   * بایت‌هایی که *قبل از* دیتای کاربر باید روی سوکت نوشته شوند.
   * فقط در مسیر Trojan-relay پر است (هدر Trojan با مقصد واقعی).
   */
  preamble?: Uint8Array;
}

export class DialError extends Error {
  constructor(
    message: string,
    readonly attempts: Array<{ via: string; error: string }>,
  ) {
    super(message);
    this.name = 'DialError';
  }
}

/** یک مسیر دیال — نام + سازنده‌ی سوکت + بایت‌های مقدماتی (اگر تونل هدر بخواهد). */
interface Route {
  via: string;
  open(): Promise<Socket>;
  /** هدری که بعد از باز شدن سوکت و قبل از دیتای کاربر نوشته می‌شود (Trojan). */
  preamble?: Uint8Array;
}

/** cmd در Trojan: 1=TCP، 3=UDP (UDP-over-TCP با فریم‌بندی خودش). */
const TROJAN_CMD_TCP = 0x01;
const TROJAN_CMD_UDP = 0x03;

/** بایت‌های آدرس مقصد به فرم Trojan (port2BE | atype | addr، با نگاشت Trojan). */
function trojanTarget(target: Target): Uint8Array {
  const w = new ByteWriter();
  writeTarget(w, target.host, target.port, TROJAN_ADDR);
  return w.toBytes();
}

/**
 * یک ورودی proxyip. `port === null` یعنی «پورت مقصد را عبور بده» — رفتار
 * استاندارد proxyip، چون رله معمولاً همان پورتی را می‌زند که کلاینت خواسته.
 * اگر کاربر پورت را صریح نوشته باشد، همان اعمال می‌شود.
 */
export interface ProxyEntry {
  host: string;
  port: number | null;
}

/**
 * `host[:port]` را پارس می‌کند. پورت اختیاری است و اگر نباشد `null` برمی‌گردد
 * (تفکیک «ننوشته» از «صریحاً ۴۴۳ نوشته» برای proxyip اهمیت دارد).
 * IPv6 داخل براکت پشتیبانی می‌شود: `[2606:4700::1]:2053`؛ IPv6 خام بدون براکت
 * هم قبول است ولی طبعاً نمی‌تواند پورت داشته باشد.
 */
export function parseHostPort(s: string): ProxyEntry | null {
  const t = s.trim();
  if (!t) return null;

  if (t.startsWith('[')) {
    const close = t.indexOf(']');
    if (close < 1) return null;
    const host = t.slice(1, close);
    if (!host) return null;
    const rest = t.slice(close + 1);
    if (rest === '') return { host, port: null };
    if (!rest.startsWith(':')) return null;
    const port = toPort(rest.slice(1));
    return port === null ? null : { host, port };
  }

  const colons = (t.match(/:/g) ?? []).length;
  // صفر «:» → فقط host؛ بیش از یکی → IPv6 خام (پورت‌دار بودنش بی‌معنی است).
  if (colons !== 1) return { host: t, port: null };

  const idx = t.indexOf(':');
  const host = t.slice(0, idx);
  if (!host) return null;
  const port = toPort(t.slice(idx + 1));
  return port === null ? null : { host, port };
}

function toPort(s: string): number | null {
  if (!/^\d{1,5}$/.test(s)) return null;
  const v = Number(s);
  return v > 0 && v < 65536 ? v : null;
}

/** مثل `parseHostPort` ولی پورت پیش‌فرض را اعمال می‌کند (برای Trojan/DNS). */
export function parseTargetSpec(s: string, defaultPort = DEFAULT_PROXY_PORT): Target | null {
  const e = parseHostPort(s);
  return e === null ? null : { host: e.host, port: e.port ?? defaultPort };
}

/**
 * فهرست proxyip را از رشته‌ی چندخطی/کاماییِ تنظیمات می‌سازد.
 *
 * ترتیب مهم است: کامنت `#…` باید **قبل از** شکستن روی فاصله حذف شود، وگرنه
 * کلمه‌های داخل کامنت هرکدام یک میزبان جداگانه می‌شوند.
 */
export function parseProxyList(raw: string): ProxyEntry[] {
  return raw
    .split(/[\r\n]/)
    .map((line) => line.split('#')[0]!)
    .flatMap((line) => line.split(/[,\s]+/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseHostPort(s))
    .filter((t): t is ProxyEntry => t !== null);
}

/**
 * انتخاب round-robin از لیست proxyip. شمارنده در سطح isolate است، پس
 * توزیع بین isolateها یکنواخت نیست ولی داخل هر isolate چرخشی است — کافی است
 * چون هدف پخش بار روی چند IP است، نه توازن دقیق.
 */
let rrCounter = 0;
export function pickProxies(list: ProxyEntry[], count: number): ProxyEntry[] {
  if (list.length === 0) return [];
  const out: ProxyEntry[] = [];
  const n = Math.min(count, list.length);
  const start = rrCounter++ % list.length;
  for (let i = 0; i < n; i++) out.push(list[(start + i) % list.length]!);
  return out;
}

/** آیا رشته یک IPv4 خام است (بدون DNS)؟ */
export function isIPv4(host: string): boolean {
  const p = host.split('.');
  if (p.length !== 4) return false;
  return p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}

export function isIPv6(host: string): boolean {
  return host.includes(':');
}

/**
 * IPv4 را داخل prefix شش‌گانه‌ی NAT64 می‌گذارد.
 * `2602:fc59:b0:64::` + `1.2.3.4` → `[2602:fc59:b0:64::102:304]`
 * (دو گروه آخر، چهار بایت IPv4 به‌صورت هگز).
 */
export function nat64Address(prefix: string, ipv4: string): string | null {
  if (!isIPv4(ipv4)) return null;
  const p = ipv4.split('.').map(Number);
  const hi = ((p[0]! << 8) | p[1]!).toString(16);
  const lo = ((p[2]! << 8) | p[3]!).toString(16);
  let base = prefix.trim().replace(/^\[|\]$/g, '');
  if (!base.endsWith('::')) base = base.endsWith(':') ? `${base}:` : `${base}::`;
  return `${base}${hi}:${lo}`;
}

/** تنظیماتی که لایه‌ی بالاتر (نشست WS) برای دیال می‌دهد. */
export interface DialOptions {
  /** لیست proxyip سراسری یا اختصاصی کلاینت. */
  proxyList?: ProxyEntry[];
  /** prefixهای NAT64. */
  nat64?: string[];
  /** ترتیب مسیرها؛ پیش‌فرض: direct → proxyip → nat64 → socks5 → trojan. */
  order?: Array<'direct' | 'proxyip' | 'nat64' | 'socks5' | 'trojan'>;
  /** Trojan-relay بیرونی. */
  trojan?: { host: string; port: number; passwordHashHex: string };
  /**
   * بالادست SOCKS5 (زنجیره). «دامنه‌ها» محدودکننده‌ی مقصدهاست؛ خالی یعنی
   * همه‌ی مقصدها از این مسیر می‌روند و مسیر direct حذف می‌شود (بدون نشت).
   */
  socks5?: { upstream: Socks5Upstream; domains?: string[] };
  /** مقصد UDP است (فقط روی cmd هدر Trojan اثر دارد). */
  udp?: boolean;
  /** موازی‌سازی مسیرهای هم‌رده (سقف MAX_PARALLEL). */
  parallel?: number;
  timeoutMs?: number;
  /** مقصدهایی که باید مستقیم نروند (مثلاً دامنه‌های CF) — مسیر direct حذف می‌شود. */
  forceProxy?: boolean;
}

/** آیا میزبان مقصد با الگوی دامنه‌ی SOCKS5 (تطبیق پسوند کامل) می‌خورد؟ */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const d = pattern.trim().toLowerCase();
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/** مسیرهای ممکن برای یک مقصد را به‌ترتیب اولویت می‌سازد. */
export function buildRoutes(target: Target, opts: DialOptions): Route[] {
  const timeout = opts.timeoutMs ?? OPEN_TIMEOUT_MS;
  const order = opts.order ?? ['direct', 'proxyip', 'nat64', 'socks5', 'trojan'];
  const routes: Route[] = [];

  // SOCKS5 فعال است یا نه: سراسری (بدون دامنه) = همه‌ی مقصدها؛ وگرنه فقط
  // مقصدهایی که با فهرست دامنه‌ها (پسوند کامل) می‌خورند. برای مقصدِ انتخاب‌شده
  // مسیر direct حذف می‌شود تا ترافیک «دست‌نخورده» بیرون نزند.
  const s5 = opts.socks5;
  const s5All = !!s5 && !(s5.domains?.length);
  const s5Match = !!s5 && (s5All || s5.domains!.some((d) => hostMatches(target.host, d)));

  for (const kind of order) {
    if (kind === 'direct') {
      if (opts.forceProxy || s5Match) continue;
      routes.push({
        via: 'direct',
        open: () => openSocket(target.host, target.port, false, timeout),
      });
      continue;
    }

    if (kind === 'proxyip') {
      const picks = pickProxies(opts.proxyList ?? [], MAX_PARALLEL);
      for (const p of picks) {
        // پورت ننوشته → پورت مقصد عبور داده می‌شود (رفتار استاندارد proxyip).
        const port = p.port ?? target.port;
        routes.push({
          via: `proxyip:${p.host}:${port}`,
          open: () => openSocket(p.host, port, false, timeout),
        });
      }
      continue;
    }

    if (kind === 'nat64') {
      // NAT64 فقط برای مقصد IPv4 معنی دارد؛ دامنه باید اول resolve شود که
      // یک subrequest اضافه می‌خواهد — پس این مسیر را فقط روی IP خام می‌گذاریم.
      if (!isIPv4(target.host)) continue;
      for (const prefix of opts.nat64 ?? []) {
        const addr = nat64Address(prefix, target.host);
        if (!addr) continue;
        routes.push({
          via: `nat64:${prefix}`,
          open: () => openSocket(addr, target.port, false, timeout),
        });
      }
      continue;
    }

    if (kind === 'socks5' && s5 && s5Match) {
      // UDP-over-SOCKS5 (ASSOCIATE) در Workers ممکن نیست؛ UDP از Trojan می‌رود.
      if (opts.udp) continue;
      const u = s5.upstream;
      routes.push({
        via: `socks5:${u.host}:${u.port}`,
        open: async () => {
          const sock = await openSocket(u.host, u.port, false, timeout);
          try {
            // دست‌دادن باید همین‌جا کامل شود؛ سوکتِ تأییدشده به رله می‌رود.
            await socks5Handshake(sock, target, u, timeout);
            return sock;
          } catch (e) {
            void sock.close().catch(() => {});
            throw e;
          }
        },
      });
      continue;
    }

    if (kind === 'trojan' && opts.trojan) {
      const t = opts.trojan;
      // هدر Trojan همین‌جا ساخته می‌شود تا بعد از باز شدن سوکت، لایه‌ی نشست فقط
      // آن را بنویسد؛ مقصد *واقعی* داخل تونل می‌رود نه در دست‌دادن TLS.
      const cmd = opts.udp ? TROJAN_CMD_UDP : TROJAN_CMD_TCP;
      const preamble = buildTrojanRequest(t.passwordHashHex, trojanTarget(target), cmd);
      routes.push({
        via: `trojan:${t.host}:${t.port}`,
        // TLS لازم است چون سرور Trojan روی TLS گوش می‌دهد.
        open: () => openSocket(t.host, t.port, true, timeout),
        preamble,
      });
    }
  }

  return routes;
}

/**
 * مسیرها را گروه‌گروه (به اندازه‌ی parallel) امتحان می‌کند و اولین سوکت باز را
 * برمی‌گرداند؛ بقیه‌ی سوکت‌های همان گروه بسته می‌شوند تا سهمیه‌ی اتصال آزاد شود.
 *
 * نکته: `preamble` را خودِ dial نمی‌نویسد. لایه‌ی نشست آن را به اولین بسته‌ی
 * کاربر می‌چسباند (`concat(preamble, rest)`) تا یک رکورد TLS جداگانه‌ی کوچک
 * تولید نشود — الگویی که انگشت‌نگاری‌اش ساده است.
 */
export async function dial(target: Target, opts: DialOptions = {}): Promise<DialResult> {
  const routes = buildRoutes(target, opts);
  if (routes.length === 0) throw new DialError('هیچ مسیری برای دیال تنظیم نشده', []);

  const width = Math.max(1, Math.min(opts.parallel ?? 1, MAX_PARALLEL));
  const attempts: Array<{ via: string; error: string }> = [];

  for (let i = 0; i < routes.length; i += width) {
    const group = routes.slice(i, i + width);
    const settled = await Promise.allSettled(group.map((r) => r.open()));

    let winner: DialResult | null = null;
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]!;
      const route = group[j]!;
      if (s.status === 'rejected') {
        attempts.push({ via: route.via, error: String((s.reason as Error)?.message ?? s.reason) });
        continue;
      }
      if (winner === null) {
        winner = route.preamble
          ? { socket: s.value, via: route.via, preamble: route.preamble }
          : { socket: s.value, via: route.via };
      } else {
        void s.value.close().catch(() => {});
      }
    }
    if (winner) return winner;
  }

  throw new DialError(`دیال ${target.host}:${target.port} در همه‌ی مسیرها شکست خورد`, attempts);
}



/**
 * سوکت را باز می‌کند و منتظر تأیید `opened` می‌ماند.
 * بدون این انتظار، `connect()` هیچ‌وقت throw نمی‌کند و خطای اتصال تا اولین
 * read/write پنهان می‌ماند — یعنی مسیر بعدی هرگز امتحان نمی‌شد.
 */
async function openSocket(hostname: string, port: number, tls: boolean, timeoutMs: number): Promise<Socket> {
  const sock = tls
    ? connect({ hostname, port }, { secureTransport: 'on', allowHalfOpen: false })
    : connect({ hostname, port });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sock.opened,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout بعد از ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return sock;
  } catch (e) {
    // سوکت نیمه‌باز را رها نمی‌کنیم تا سهمیه‌ی ۶ اتصالی آزاد شود.
    void sock.close().catch(() => {});
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─────────────────────────── DNS: UDP → TCP ───────────────────────────

/** سرور DNS پیش‌فرض برای رله؛ روی TCP گوش می‌دهد و لبه‌ی CF اجازه‌اش می‌دهد. */
export const DEFAULT_DNS = { host: '8.8.4.4', port: 53 };
/** سقف اندازه‌ی یک پیام DNS روی TCP — RFC 1035 دو بایت طول می‌دهد. */
const MAX_DNS_MSG = 65535;

/**
 * رله‌ی DNS: کلاینت‌های VLESS/VMess/Trojan پرسش DNS را روی **UDP** می‌فرستند،
 * ولی Workers سوکت UDP ندارد. راه‌حل استانداردِ همه‌ی پنل‌های Worker این است که
 * همان پیام DNS را روی **TCP** (RFC 1035 §4.2.2) بفرستیم: `len(2BE) | message`.
 *
 * چند پرسش روی یک سوکت پشت سر هم می‌رود (pipelining ترتیبی) تا از سهمیه‌ی
 * ۶ اتصال همزمان صرفه‌جویی شود؛ سوکت با اولین پرسش لِیزی باز می‌شود.
 */
export class DnsRelay {
  private sock: Socket | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  /** پرسش‌ها ترتیبی می‌شوند تا پاسخ‌ها با هم قاطی نشوند. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly server: { host: string; port: number } = DEFAULT_DNS,
    private readonly timeoutMs: number = OPEN_TIMEOUT_MS,
  ) {}

  /** یک پرسش DNS (بدنه‌ی خام UDP) را می‌فرستد و پاسخ خام را برمی‌گرداند. */
  query(message: Uint8Array): Promise<Uint8Array> {
    const run = this.queue.then(
      () => this.doQuery(message),
      () => this.doQuery(message),
    );
    // صف را نگه می‌داریم ولی خطای این پرسش، پرسش بعدی را نمی‌شکند.
    this.queue = run.catch(() => {});
    return run;
  }

  private async doQuery(message: Uint8Array): Promise<Uint8Array> {
    if (message.length === 0 || message.length > MAX_DNS_MSG) {
      throw new Error(`اندازه‌ی پیام DNS نامعتبر: ${message.length}`);
    }
    await this.ensureOpen();
    const [hi, lo] = u16be(message.length);
    const frame = new Uint8Array(2 + message.length);
    frame[0] = hi;
    frame[1] = lo;
    frame.set(message, 2);

    try {
      await this.writer!.write(frame);
      return await this.readMessage();
    } catch (e) {
      // سوکت خراب را دور می‌ریزیم تا پرسش بعدی از نو وصل شود.
      this.reset();
      throw e;
    }
  }

  private async ensureOpen(): Promise<void> {
    if (this.sock) return;
    const sock = await openSocket(this.server.host, this.server.port, false, this.timeoutMs);
    this.sock = sock;
    this.reader = sock.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.writer = sock.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    this.buf = new Uint8Array(0);
  }

  /** تا کامل شدن یک پیام `len|body` می‌خواند (پاسخ می‌تواند چندتکه بیاید). */
  private async readMessage(): Promise<Uint8Array> {
    for (;;) {
      if (this.buf.length >= 2) {
        const need = readU16be(this.buf, 0);
        if (this.buf.length >= 2 + need) {
          const msg = this.buf.slice(2, 2 + need);
          this.buf = this.buf.subarray(2 + need);
          return msg;
        }
      }
      const { value, done } = await this.reader!.read();
      if (done) throw new Error('اتصال DNS قبل از کامل شدن پاسخ بسته شد');
      if (value && value.length) this.buf = this.buf.length === 0 ? value : concat(this.buf, value);
    }
  }

  private reset(): void {
    const s = this.sock;
    this.sock = null;
    this.reader = null;
    this.writer = null;
    this.buf = new Uint8Array(0);
    if (s) void s.close().catch(() => {});
  }

  close(): void {
    this.reset();
  }
}
