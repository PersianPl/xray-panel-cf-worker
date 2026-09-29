/**
 * بالادست SOCKS5 (فقط CONNECT) برای دیال زنجیره‌ای.
 *
 * چرا این‌جا و نه در dial.ts: دست‌دادنِ SOCKS5 **رفت‌وبرگشتی** است (greeting →
 * روش auth → درخواست CONNECT → پاسخ)، برخلاف Trojan که هدرش یک‌طرفه است و
 * می‌تواند «preamble» باشد. پس دست‌دادن باید در خودِ `open()` مسیر تمام شود و
 * فقط سوکتِ تأییدشده به لایه‌ی رله داده شود.
 *
 * UDP این‌جا معنا ندارد: Workers سوکت UDP ندارد و UDP ASSOCIATE هم به آن
 * نیاز دارد؛ مقصدهای UDP از مسیرهای دیگر (Trojan cmd=3) می‌روند.
 */
import { concat, utf8 } from '../lib/bytes';

/** یک بالادست SOCKS5. `user` خالی = بدون احراز هویت. */
export interface Socks5Upstream {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * `user:pass@host:port` را پارس می‌کند (فرم `host:port` و `host` هم قبول است).
 *
 * چرا `lastIndexOf('@')`: رمز می‌تواند خودش «@» داشته باشد؛ فقط آخرین «@»
 * جداکننده‌ی اعتبار از میزبان است. پورت پیش‌فرض ۱۰۸۰ است.
 */
export function parseSocks5Upstream(raw: string): Socks5Upstream | null {
  let t = raw.trim();
  if (!t) return null;

  let user = '';
  let pass = '';
  const at = t.lastIndexOf('@');
  if (at >= 0) {
    const creds = t.slice(0, at);
    t = t.slice(at + 1);
    const c = creds.indexOf(':');
    if (c >= 0) {
      user = creds.slice(0, c);
      pass = creds.slice(c + 1);
    } else {
      user = creds;
    }
  }

  let host = t;
  let port = 1080;
  if (t.startsWith('[')) {
    const close = t.indexOf(']');
    if (close < 1) return null;
    host = t.slice(1, close);
    const rest = t.slice(close + 1);
    if (rest.startsWith(':')) {
      const p = Number(rest.slice(1));
      if (!Number.isInteger(p) || p <= 0 || p >= 65536) return null;
      port = p;
    } else if (rest) {
      return null;
    }
  } else {
    // مثل parseHostPort: دقیقاً یک «:» یعنی host:port؛ بیشتر یعنی IPv6 خام.
    const colons = (t.match(/:/g) ?? []).length;
    if (colons === 1) {
      const i = t.indexOf(':');
      const p = Number(t.slice(i + 1));
      if (!Number.isInteger(p) || p <= 0 || p >= 65536) return null;
      host = t.slice(0, i);
      port = p;
    }
  }

  if (!host) return null;
  return { host, port, user, pass };
}

const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYPE_IPV4 = 0x01;
const ATYPE_DOMAIN = 0x03;

function isV4(host: string): boolean {
  const p = host.split('.');
  if (p.length !== 4) return false;
  return p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}

/** تا `need` بایت از خواننده می‌خواند (پاسخ می‌تواند تکه‌تکه بیاید). */
async function readN(reader: ReadableStreamDefaultReader<Uint8Array>, need: number, buf: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
  for (;;) {
    if (buf.length >= need) return buf.subarray(0, need);
    const { value, done } = await reader.read();
    if (done) throw new Error('اتصال SOCKS5 قبل از پایان پاسخ بسته شد');
    if (value && value.length) buf = buf.length === 0 ? value : concat(buf, value);
  }
}

/** خطای دست‌دادن را با مهلت زمانی محدود می‌کند تا مسیر بعدی امتحان شود. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout دست‌دادن SOCKS5 بعد از ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * کل دست‌دادن SOCKS5 را روی سوکتِ باز انجام می‌دهد و در موفقیت برمی‌گردد.
 * قفل‌های reader/writer آزاد می‌شوند تا لایه‌ی رله خودش صاحب جریان‌ها شود.
 */
export async function socks5Handshake(
  sock: Socket,
  target: { host: string; port: number },
  upstream: Socks5Upstream,
  timeoutMs: number,
): Promise<void> {
  const run = (async () => {
    const reader = sock.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const writer = sock.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    try {
      const needAuth = upstream.user.length > 0;
      // greeting: نسخه + تعداد متد + فهرست متدها (0=no-auth، 2=user/pass)
      await writer.write(needAuth ? new Uint8Array([SOCKS_VERSION, 2, 0, 2]) : new Uint8Array([SOCKS_VERSION, 1, 0]));
      const method = await readN(reader, 2);
      if (method[0] !== SOCKS_VERSION) throw new Error(`پاسخ greeting نامعتبر: ${method[0]}`);
      if (method[1] === 0x02) {
        if (!needAuth) throw new Error('سرور SOCKS5 احراز هویت خواست');
        const u = utf8(upstream.user);
        const p = utf8(upstream.pass);
        const req = new Uint8Array(3 + u.length + p.length);
        req[0] = 0x01;
        req[1] = u.length;
        req.set(u, 2);
        req[2 + u.length] = p.length;
        req.set(p, 3 + u.length);
        await writer.write(req);
        const st = await readN(reader, 2);
        if (st[0] !== 0x01 || st[1] !== 0) throw new Error('احراز هویت SOCKS5 رد شد');
      } else if (method[1] !== 0x00) {
        throw new Error(`متد SOCKS5 پشتیبانی نمی‌شود: ${method[1]}`);
      }

      await writer.write(connectRequestBytes(target.host, target.port));
      // head: ver | rep | rsv | atype | (برای دامنه: طول آدرس)
      const head = await readN(reader, 5);
      const atype = head[3]!;
      let total: number;
      if (atype === ATYPE_IPV4) total = 4 + 4 + 2;
      else if (atype === ATYPE_DOMAIN) total = 4 + 1 + head[4]! + 2;
      else if (atype === 0x04) total = 4 + 16 + 2;
      else total = 5; // atype ناشناخته — فقط rep بررسی می‌شود
      if (total > 5) await readN(reader, total - 5, head);
      if (head[1] !== 0) throw new Error(`CONNECT SOCKS5 رد شد: کد ${head[1]}`);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* قفل گرفته نشده بود */
      }
      try {
        writer.releaseLock();
      } catch {
        /* قفل گرفته نشده بود */
      }
    }
  })();
  return withTimeout(run, timeoutMs);
}

/** درخواست CONNECT: ver | cmd | rsv | atype | addr | port(2BE). */
export function connectRequestBytes(host: string, port: number): Uint8Array {
  const portHi = (port >> 8) & 0xff;
  const portLo = port & 0xff;
  if (isV4(host)) {
    const parts = host.split('.').map(Number);
    return new Uint8Array([SOCKS_VERSION, CMD_CONNECT, 0, ATYPE_IPV4, parts[0]!, parts[1]!, parts[2]!, parts[3]!, portHi, portLo]);
  }
  // IPv6 literal و دامنه هر دو به‌صورت ATYPE_DOMAIN می‌روند — بالادست‌ها
  // رشته‌ی شش‌گانه را خودشان resolve می‌کنند و این ساده‌تر و سازگارتر است.
  const addr = utf8(host);
  const out = new Uint8Array(7 + addr.length);
  out[0] = SOCKS_VERSION;
  out[1] = CMD_CONNECT;
  out[3] = ATYPE_DOMAIN;
  out[4] = addr.length;
  out.set(addr, 5);
  out[out.length - 2] = portHi;
  out[out.length - 1] = portLo;
  return out;
}

