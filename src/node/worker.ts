/**
 * نقش node — یک Worker بی‌حالت روی اکانت کلادفلر دیگر.
 *
 * چرا: هر اکانت رایگان ۱۰۰k ریکوئست در روز دارد. با ۳-۵ نود، سهمیه‌ی عملی
 * چند برابر می‌شود بدون آنکه کاربر لازم باشد چیزی عوض کند (همه‌ی نودها در
 * یک ساب می‌آیند).
 *
 * نود **هیچ D1ای ندارد**. کانفیگ را از پنل pull می‌کند و در حافظه‌ی isolate
 * نگه می‌دارد؛ آمار را هم در حافظه جمع می‌کند و دوره‌ای push می‌کند. اگر
 * isolate از بین برود، حداکثر یک بازه آمار از دست می‌رود — بهای پذیرفته‌شده در
 * برابر نداشتن دیتابیس روی نود.
 *
 * توکن نود در `NODE_TOKEN` است و همان کلید HMAC است (`nodeKey` در پنل).
 */
import { hmacSign, sha256Hex, uuidToBytes } from '../lib/crypto';
import { hex } from '../lib/hexutil';
import { authIdKey, vmessCmdKey } from '../proxy/vmess';
import { trojanKey } from '../proxy/trojan';
import { parseProxyList } from '../proxy/dial';
import { handleSession, readEarlyData, type ClientStore, type MatchedClient } from '../proxy/session';
import { splitDynamicPath } from '../proxy/entry';
import { XHttpStreamOneAdapter } from '../proxy/xhttp';
import type { DialOptions } from '../proxy/dial';
import type { WsLike } from '../proxy/pipe';
import type { Env, Protocol } from '../types';

/** کانفیگی که پنل می‌دهد (زیرمجموعه‌ای که نود لازم دارد). */
interface NodeConfig {
  version: number;
  at: number;
  node: string;
  inbounds: Array<{
    id: number;
    tag: string;
    protocol: string;
    transport: string;
    path: string;
    enable: number;
    max_early_data: number;
  }>;
  clients: Array<{
    id: number;
    inbound_id: number;
    name: string;
    auth: string;
    enable: number;
    total_gb: number;
    up: number;
    down: number;
    expiry_at: number;
    limit_ip: number;
    proxyip: string;
    nat64_prefix: string;
  }>;
  net: {
    proxyip: string;
    proxyip_mode: string;
    nat64_prefixes: string;
    dial_parallel: number;
    dial_timeout: number;
    idle_timeout: number;
    ip_limit_enable: boolean;
    kill_switch: boolean;
    pull_interval: number;
  };
}

interface Compiled {
  cfg: NodeConfig;
  at: number;
  etag: string;
  byUuidHex: Map<string, MatchedClient>;
  byTrojan: Map<string, MatchedClient>;
  vmess: Array<{ uuid: Uint8Array; cmdKey: Uint8Array; authIdKey: Uint8Array }>;
  paths: Map<string, number>;
  earlyData: Map<number, number>;
  transportOf: Map<number, string>;
}

let compiled: Compiled | null = null;
let pulling: Promise<Compiled | null> | null = null;

/** آمار انباشته‌ی این isolate تا push بعدی. */
const stats = new Map<number, { up: number; down: number; last: number; ips: Set<string> }>();
let reqToday = 0;

const GB = 1024 * 1024 * 1024;

/** کانفیگ را از پنل می‌گیرد و ایندکس تطبیق را می‌سازد. */
async function pull(env: Env, force = false): Promise<Compiled | null> {
  const interval = (compiled?.cfg.net.pull_interval ?? 300) * 1000;
  if (!force && compiled && Date.now() - compiled.at < interval) return compiled;
  if (pulling) return pulling;
  pulling = doPull(env).finally(() => {
    pulling = null;
  });
  return pulling;
}

async function doPull(env: Env): Promise<Compiled | null> {
  const base = (env.PANEL_URL ?? '').replace(/\/+$/, '');
  const token = env.NODE_TOKEN ?? '';
  const name = env.NODE_NAME ?? '';
  if (!base || !token || !name) return compiled;

  try {
    const path = '/api/node/config';
    const res = await fetch(base + path, {
      headers: {
        ...(await signHeaders(token, name, 'GET', path, '')),
        ...(compiled ? { 'if-none-match': compiled.etag } : {}),
      },
    });

    if (res.status === 304 && compiled) {
      // بدنه عوض نشده؛ فقط مهر زمان کش را جلو می‌بریم.
      compiled = { ...compiled, at: Date.now() };
      return compiled;
    }
    if (!res.ok) return compiled;

    const cfg = (await res.json()) as NodeConfig;
    compiled = compile(cfg, res.headers.get('etag') ?? '');
    return compiled;
  } catch {
    // شکست شبکه: با کانفیگ قبلی ادامه می‌دهیم تا سرویس قطع نشود.
    return compiled;
  }
}

/**
 * هدرهای امضاشده‌ی درخواست به پنل.
 *
 * صادر شده تا تست بتواند این سمت را به‌طور مستقیم به `verify` سمت پنل بدهد:
 * قالب payload در دو فایل جدا نوشته شده و اگر یکی‌شان عوض شود، هیچ تستی که فقط
 * یک طرف را بسنجد خبردار نمی‌شود — و نتیجه‌اش این است که همه‌ی نودها یک‌جا ۴۰۱
 * می‌گیرند.
 */
export async function signHeaders(key: string, node: string, method: string, path: string, body: string): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await hmacSign(key, `${method}\n${path}\n${ts}\n${await sha256Hex(body)}`);
  return {
    authorization: `PPL ${node}:${sig}`,
    'x-ppl-ts': String(ts),
  };
}

function compile(cfg: NodeConfig, etag: string): Compiled {
  const byUuidHex = new Map<string, MatchedClient>();
  const byTrojan = new Map<string, MatchedClient>();
  const vmess: Compiled['vmess'] = [];
  const paths = new Map<string, number>();
  const earlyData = new Map<number, number>();

  const protoOf = new Map<number, string>();
  const transportOf = new Map<number, string>();
  for (const ib of cfg.inbounds) {
    protoOf.set(ib.id, ib.protocol);
    transportOf.set(ib.id, ib.transport || 'ws');
    if (ib.path) paths.set(ib.path, ib.id);
    earlyData.set(ib.id, ib.max_early_data);
  }

  const now = Math.floor(Date.now() / 1000);
  for (const c of cfg.clients) {
    const protocol = (protoOf.get(c.inbound_id) ?? 'vless') as Protocol;
    const matched: MatchedClient = {
      clientId: c.id,
      inboundId: c.inbound_id,
      name: c.name,
      dial: dialFor(c, cfg.net),
      ...(rejectOf(c, cfg.net, now) ? { reject: rejectOf(c, cfg.net, now)! } : {}),
    };

    if (protocol === 'vless' || protocol === 'vmess') {
      if (!/^[0-9a-f-]{32,36}$/i.test(c.auth)) continue;
      const uuid = uuidToBytes(c.auth);
      byUuidHex.set(hex(uuid), matched);
      const cmdKey = vmessCmdKey(uuid);
      vmess.push({ uuid, cmdKey, authIdKey: authIdKey(cmdKey) });
    } else if (protocol === 'trojan') {
      byTrojan.set(trojanKey(c.auth), matched);
    }
  }

  return { cfg, at: Date.now(), etag, byUuidHex, byTrojan, vmess, paths, earlyData, transportOf };
}

function rejectOf(c: NodeConfig['clients'][number], net: NodeConfig['net'], now: number): string | null {
  if (net.kill_switch) return 'سرویس موقتاً غیرفعال است';
  if (!c.enable) return 'کاربر غیرفعال است';
  if (c.expiry_at > 0 && now >= c.expiry_at) return 'اشتراک منقضی شده';
  if (c.total_gb > 0) {
    // مصرفِ محلیِ هنوز-push-نشده هم حساب می‌شود، وگرنه کاربر تا push بعدی
    // می‌توانست بی‌سقف مصرف کند.
    const local = stats.get(c.id);
    const used = c.up + c.down + (local ? local.up + local.down : 0);
    if (used >= c.total_gb * GB) return 'ترافیک تمام شده';
  }
  return null;
}

function dialFor(c: NodeConfig['clients'][number], net: NodeConfig['net']): DialOptions {
  const proxyList = parseProxyList((c.proxyip || '').trim() || net.proxyip);
  const nat64 = ((c.nat64_prefix || '').trim() || net.nat64_prefixes)
    .split(/[\r\n,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const order: DialOptions['order'] =
    net.proxyip_mode === 'nat64' ? ['direct', 'nat64', 'proxyip', 'trojan'] : ['direct', 'proxyip', 'nat64', 'trojan'];
  return {
    proxyList,
    nat64,
    order,
    timeoutMs: net.dial_timeout,
    ...(net.dial_parallel > 1 ? { parallel: net.dial_parallel } : {}),
  };
}

/** `ClientStore` نود — روی ایندکسِ کانفیگِ pull‌شده. */
class NodeStore implements ClientStore {
  constructor(
    private readonly c: Compiled,
    private readonly inboundId: number,
  ) {}

  async byUuid(uuid: Uint8Array): Promise<MatchedClient | null> {
    return this.pick(this.c.byUuidHex.get(hex(uuid)));
  }
  async byTrojanKey(hashHex: string): Promise<MatchedClient | null> {
    return this.pick(this.c.byTrojan.get(hashHex));
  }
  async vmessCandidates(): Promise<Compiled['vmess']> {
    return this.c.vmess;
  }
  private pick(m: MatchedClient | undefined): MatchedClient | null {
    if (!m) return null;
    return m.inboundId === this.inboundId ? m : null;
  }
}

/** fetch نقش node. */
export async function nodeFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  reqToday++;

  const upgrade = (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
  const method = req.method.toUpperCase();

  const c = await pull(env);
  if (!c) return new Response(null, { status: 503 });

  const url = new URL(req.url);
  const ov = splitDynamicPath(url.pathname);
  const inboundId = c.paths.get(ov.base);
  if (inboundId === undefined) {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  const transport = c.transportOf.get(inboundId) ?? 'ws';
  const ip = req.headers.get('cf-connecting-ip') ?? '';

  // سه مسیر ورودی:
  //   • WS — درخواست upgrade: websocket (همان مسیر همیشگی)
  //   • XHTTP stream-one — POST/GET روی همان مسیر، بدون upgrade
  //   • httpupgrade — از دید Worker مثل WS است؛ لبه‌ی CF خودش سیمِ نهایی را
  //     برقرار می‌کند و کاربر بایت خام می‌فرستد. تفاوت فقط در فریم‌بندی نیست؛
  //     بایت‌ها همان بایت‌های WS بعد از handshake‌اند (بدون فریم‌بندیِ WS).
  // در نقش node همه‌ی سه حالت به یک `handleSession` می‌رسند؛ فقط آداپتور فرق می‌کند.
  if (transport === 'xhttp' && (method === 'POST' || method === 'GET')) {
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const adapter = new XHttpStreamOneAdapter(req, transform);

    const run = handleSession({
      ws: adapter as unknown as WsLike,
      store: new NodeStore(c, inboundId),
      dialDefaults: { timeoutMs: c.cfg.net.dial_timeout },
      earlyData: readEarlyData(req.headers.get('sec-websocket-protocol') ?? url.searchParams.get('ed')),
      ip,
      idleMs: c.cfg.net.idle_timeout,
    });

    ctx.waitUntil(
      run
        .then((res) => {
          const id = res.client?.clientId;
          if (id === undefined) return;
          note(id, res.usage.up, res.usage.down, ip);
        })
        .catch(() => {}),
    );

    const headers = new Headers({
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });

    return new Response(transform.readable, { status: 200, headers });
  }

  // WS یا httpupgrade — هر دو نیاز به هدر Upgrade دارند (کلاینت‌های httpupgrade
  // هم `Upgrade: websocket` می‌فرستند؛ فقط Sec-WebSocket-Key ندارند).
  if (!upgrade) {
    // نود صفحه‌ی عمومی ندارد؛ همان چیزی را می‌دهد که یک سرور بی‌سایت می‌دهد.
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  const pair = new WebSocketPair();
  pair[1].accept();

  const run = handleSession({
    ws: pair[1] as unknown as WsLike,
    store: new NodeStore(c, inboundId),
    dialDefaults: { timeoutMs: c.cfg.net.dial_timeout },
    earlyData: readEarlyData(req.headers.get('sec-websocket-protocol') ?? url.searchParams.get('ed')),
    ip,
    idleMs: c.cfg.net.idle_timeout,
  });

  ctx.waitUntil(
    run
      .then((res) => {
        const id = res.client?.clientId;
        if (id === undefined) return;
        note(id, res.usage.up, res.usage.down, ip);
      })
      .catch(() => {}),
  );

  return new Response(null, { status: 101, webSocket: pair[0] });
}

function note(id: number, up: number, down: number, ip: string): void {
  const cur = stats.get(id);
  const last = Math.floor(Date.now() / 1000);
  if (cur) {
    cur.up += up;
    cur.down += down;
    cur.last = last;
    if (ip && cur.ips.size < 16) cur.ips.add(ip);
  } else {
    stats.set(id, { up, down, last, ips: new Set(ip ? [ip] : []) });
  }
}

/** cron نقش node: کانفیگ تازه بگیر و آمار را بفرست. */
export async function nodeScheduled(env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(pushStats(env));
  await pull(env, true);
}

/**
 * آمار انباشته را به پنل می‌فرستد.
 * قبل از fetch از map برداشته می‌شود تا نشست‌های همزمان دلتای تازه را در دور
 * بعد بنویسند؛ اگر push شکست بخورد، دلتاها برگردانده می‌شوند.
 */
export async function pushStats(env: Env): Promise<void> {
  if (stats.size === 0) return;
  const base = (env.PANEL_URL ?? '').replace(/\/+$/, '');
  const token = env.NODE_TOKEN ?? '';
  const name = env.NODE_NAME ?? '';
  if (!base || !token || !name) return;

  const snapshot = new Map(stats);
  stats.clear();

  const body = JSON.stringify({
    req_today: reqToday,
    rows: [...snapshot].map(([id, v]) => ({ id, up: v.up, down: v.down, last: v.last, ips: [...v.ips] })),
  });

  try {
    const path = '/api/node/stats';
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await signHeaders(token, name, 'POST', path, body)) },
      body,
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    for (const [id, v] of snapshot) {
      const cur = stats.get(id);
      if (cur) {
        cur.up += v.up;
        cur.down += v.down;
        cur.last = Math.max(cur.last, v.last);
        for (const ip of v.ips) cur.ips.add(ip);
      } else {
        stats.set(id, v);
      }
    }
  }
}

/** برای تست: پاک کردن وضعیت isolate نود. */
export function resetNodeState(): void {
  compiled = null;
  pulling = null;
  stats.clear();
  reqToday = 0;
}


