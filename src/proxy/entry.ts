/**
 * ورودی HTTP لایه‌ی پروکسی: از درخواست WebSocket تا نشست کامل.
 *
 * وظیفه‌ها:
 *   • تشخیص upgrade و پیدا کردن inbound از روی مسیر
 *   • پارس «مسیر داینامیک» (`/path/proxyip=1.2.3.4`) برای تست سریع بدون تغییر تنظیم
 *   • ساخت `ClientStore` روی ایندکسِ کش‌شده و اجرای `handleSession`
 *   • ثبت مصرف با `waitUntil` — بیرون از مسیر پاسخ
 *
 * نکته‌ی مهم Workers: پاسخ ۱۰۱ باید **فوراً** برگردد و نشست در پس‌زمینه ادامه
 * پیدا کند. اگر منتظر پایان نشست بمانیم، کلاینت هیچ‌وقت دست‌دادن را کامل
 * نمی‌بیند. پس `handleSession` با `waitUntil` اجرا می‌شود.
 */
import { settings, type Settings } from '../lib/settings';
import { record, flush } from '../lib/usage';
import { parseHostPort, parseProxyList, type DialOptions } from './dial';
import { handleSession, readEarlyData, type SessionResult } from './session';
import { D1ClientStore, clientIndex, inboundByPath, noteIp, type ClientIndex } from './store';
import { trojanKey } from './trojan';
import { XHttpStreamOneAdapter } from './xhttp';
import type { Env } from '../types';
import type { WsLike } from './pipe';

/** مسیرهای داینامیکی که در انتهای path پذیرفته می‌شوند. */
interface PathOverrides {
  /** مسیر پایه بعد از حذف بخش‌های داینامیک. */
  base: string;
  proxyip?: string;
  nat64?: string;
  trojan?: string;
}

/**
 * بخش‌های داینامیک را از مسیر جدا می‌کند: `/vl/proxyip=1.2.3.4:2087`.
 *
 * چرا انتهای مسیر و نه query: کلاینت‌های موبایل رشته‌ی query را در فیلد `path`
 * قبول می‌کنند ولی بعضی نسخه‌ها آن را دوباره encode می‌کنند؛ segment امن‌تر است.
 */
export function splitDynamicPath(path: string): PathOverrides {
  const parts = path.split('/');
  const out: PathOverrides = { base: path };
  const keep: string[] = [];
  for (const seg of parts) {
    const eq = seg.indexOf('=');
    if (eq > 0) {
      const k = seg.slice(0, eq).toLowerCase();
      const v = safeDecode(seg.slice(eq + 1));
      if (k === 'proxyip' || k === 'proxy') {
        out.proxyip = v;
        continue;
      }
      if (k === 'nat64') {
        out.nat64 = v;
        continue;
      }
      if (k === 'trojan') {
        out.trojan = v;
        continue;
      }
    }
    keep.push(seg);
  }
  out.base = keep.join('/') || '/';
  return out;
}

/**
 * `decodeURIComponent` که روی درصدِ ناقص پرتاب نمی‌کند.
 *
 * لازم است چون این تابع روی مسیرِ خامِ درخواست کار می‌کند: یک `GET /t/proxyip=%`
 * روی نقش node به هیچ try/catchای نمی‌رسد (در [index.ts](../index.ts) پیش از
 * بلوک خطا برگردانده می‌شود) و صفحه‌ی خطای کلادفلر را نشان می‌دهد — هم درخواست
 * می‌شکند، هم وجود چیزی غیرمعمول در این مسیر لو می‌رود.
 */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** آیا این درخواست یک upgrade به WebSocket است؟ */
export function isWsUpgrade(req: Request): boolean {
  return (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
}

/**
 * `DialOptions` را با override مسیر داینامیک می‌سازد.
 * فقط وقتی اعمال می‌شود که تنظیم `dynamic_paths` روشن باشد — وگرنه هر کسی که
 * مسیر را بداند می‌تواند خروجی را به سرور خودش ببرد.
 */
function applyOverrides(base: DialOptions, ov: PathOverrides, s: Settings): DialOptions {
  if (!s.bool('dynamic_paths')) return base;
  const out: DialOptions = { ...base };

  if (ov.proxyip) {
    const list = parseProxyList(ov.proxyip);
    if (list.length) {
      out.proxyList = list;
      // override صریح یعنی «همین را بزن»؛ مسیر مستقیم باید کنار برود وگرنه
      // اکثر مقصدها مستقیم جواب می‌دهند و تست بی‌معنی می‌شود.
      out.order = ['proxyip', 'direct'];
    }
  }

  if (ov.nat64) {
    const pfx = ov.nat64
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (pfx.length) {
      out.nat64 = pfx;
      out.order = ['nat64', 'direct'];
    }
  }

  if (ov.trojan) {
    // قالب: `host:port:password`
    const i = ov.trojan.lastIndexOf(':');
    if (i > 0) {
      const hp = parseHostPort(ov.trojan.slice(0, i));
      const password = ov.trojan.slice(i + 1);
      if (hp && password) {
        out.trojan = { host: hp.host, port: hp.port ?? 443, passwordHashHex: trojanKey(password) };
        out.order = ['trojan'];
      }
    }
  }

  return out;
}

/** پاسخ ۱۰۱ با نشستی که در پس‌زمینه می‌چرخد. */
export interface ProxyOutcome {
  response: Response;
  /** اگر مسیر پروکسی نبود، `null` تا لایه‌ی بالاتر decoy را سرو کند. */
  matched: boolean;
}

/**
 * درخواست را اگر مسیر یک inbound باشد به نشست پروکسی تبدیل می‌کند.
 * `matched === false` یعنی این مسیر مال ما نیست و باید decoy سرو شود.
 */
export async function handleProxyRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<ProxyOutcome> {
  const url = new URL(req.url);
  const ov = splitDynamicPath(url.pathname);

  let idx: ClientIndex;
  try {
    idx = await clientIndex(env);
  } catch {
    // D1 در دسترس نیست: بهتر است مثل یک سایت معمولی رفتار کنیم تا اسکنر
    // نفهمد اینجا پنلی هست.
    return { response: new Response(null, { status: 502 }), matched: false };
  }

  const inbound = inboundByPath(idx, ov.base);
  if (!inbound || !inbound.enable) return { response: new Response(null, { status: 426 }), matched: false };

  const isWs = isWsUpgrade(req);
  const isHttpUpgrade = inbound.transport === 'httpupgrade' && (isWs || req.headers.get('upgrade')?.toLowerCase() === 'websocket');
  const isXHttp = inbound.transport === 'xhttp' && (req.method === 'POST' || req.method === 'GET');

  if (!isWs && !isHttpUpgrade && !isXHttp) {
    return { response: new Response(null, { status: 426 }), matched: false };
  }

  const s = await settings(env);
  const ip = req.headers.get('cf-connecting-ip') ?? '';
  const colo = (req.cf?.colo as string | undefined) ?? '';

  const store = new D1ClientStore(idx, {
    ip,
    inboundId: inbound.id,
    settings: s,
    enforceIpLimit: s.bool('ip_limit_enable'),
  });

  const early = readEarlyData(req.headers.get('sec-websocket-protocol') ?? url.searchParams.get('ed'));
  const timeoutMs = s.int('dial_timeout', 2500);
  const dialDefaults: DialOptions = applyOverrides({ timeoutMs }, ov, s);

  if (isWs || isHttpUpgrade) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const run = handleSession({
      ws: server as unknown as WsLike,
      store,
      dialDefaults,
      earlyData: early,
      ip,
      idleMs: s.int('idle_timeout', 100_000),
    });

    ctx.waitUntil(finishSession(env, run, { ip, colo, inboundId: inbound.id }));

    return {
      response: new Response(null, { status: 101, webSocket: client }),
      matched: true,
    };
  } else {
    // XHTTP stream-one
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const adapter = new XHttpStreamOneAdapter(req, transform);

    const run = handleSession({
      ws: adapter as unknown as WsLike,
      store,
      dialDefaults,
      earlyData: early,
      ip,
      idleMs: s.int('idle_timeout', 100_000),
    });

    ctx.waitUntil(finishSession(env, run, { ip, colo, inboundId: inbound.id }));

    // هدرهای استاندارد پاسخ XHTTP stream-one طبق مستندات Xray-core
    const headers = new Headers({
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });

    return {
      response: new Response(transform.readable, { status: 200, headers }),
      matched: true,
    };
  }
}

/** نتیجه‌ی نشست را در آمار می‌نویسد (خارج از مسیر پاسخ). */
async function finishSession(
  env: Env,
  run: Promise<SessionResult>,
  meta: { ip: string; colo: string; inboundId: number },
): Promise<void> {
  let res: SessionResult;
  try {
    res = await run;
  } catch {
    return;
  }
  const id = res.client?.clientId;
  if (id === undefined) return;

  noteIp(id, meta.ip);
  record(id, res.usage.up, res.usage.down, {
    ip: meta.ip,
    colo: meta.colo,
    inboundId: meta.inboundId,
    // اولین اتصال کاربرِ «شروع تعویقی» باید مبنای انقضا را ست کند. شرط
    // `first_seen = 0` در SQL باعث می‌شود این کار فقط یک‌بار اثر کند، پس
    // فرستادن پرچم در همه‌ی نشست‌ها بی‌خطر است.
    activate: true,
  });
  await flush(env);
}
