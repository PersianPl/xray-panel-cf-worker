/**
 * هویت WARP — همانی که BPB در مرورگر می‌سازد، اینجا سمت Worker.
 *
 * جریان: کلید X25519 محلی ساخته می‌شود → با API عمومی کلاینت WARP کلادفلر
 * ثبت می‌شود → پاسخ شامل آدرس‌های داخل تونل، کلید عمومی همتا و `client_id`
 * (مبنای آرایه‌ی `reserved` برای دورزدن فیلتر IP آفیس) است. هویت در settings
 * ذخیره و در ساب‌ساز به‌صورت outbound وایرگارد تزریق می‌شود.
 */
import { fromHex, generatePrivateKey, publicKeyFrom, toHex } from './x25519';
import type { Settings } from './settings';

export interface WarpIdentity {
  priv: string;
  /** آدرس داخلی IPv4 (با پوشش، مثل 172.16.0.2/32). */
  v4: string;
  v6: string;
  /** کلید عمومی همتا (peer) — base64 استاندارد. */
  peer: string;
  /** `host:port` مثل 162.159.193.10:2408 */
  endpoint: string;
  /** سه بایت reserved از client_id. */
  reserved: number[];
  created: number;
}

const REG_URL = 'https://api.cloudflareclient.com/v0a2158/reg';
const FALLBACK_ENDPOINT = 'engage.cloudflareclient.com:2408';

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function registerWarp(fetchImpl: typeof fetch = fetch): Promise<WarpIdentity> {
  const priv = generatePrivateKey();
  const pub = publicKeyFrom(priv);

  const res = await fetchImpl(REG_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'okhttp/3.12.1',
      'cf-client-version': 'i-6.28/6.28.2961',
    },
    body: JSON.stringify({
      install_id: '',
      fcm_token: '',
      tos: `${new Date().toISOString().slice(0, 19)}Z`,
      type: 'Android',
      locale: 'en_us',
      model: 'PC',
      system_version: 'Windows 11',
      key: toB64(pub),
      config: {
        peers: [],
        interface: { addresses: { v4: '172.16.0.2/32', v6: '2606:4700:110:8888:9d:b01c:1c28:5d02/128' } },
      },
    }),
  });
  if (!res.ok) throw new Error(`ثبت WARP ناموفق بود (کد ${res.status})`);

  const j = (await res.json()) as {
    config?: {
      client_id?: string;
      interface?: { addresses?: { v4?: string; v6?: string } };
      peers?: Array<{ public_key?: string; endpoint?: { v4?: string; v6?: string } }>;
    };
  };
  const cfg = j.config ?? {};
  const v4 = cfg.interface?.addresses?.v4 ?? '172.16.0.2/32';
  const v6 = cfg.interface?.addresses?.v6 ?? '';
  const peer = cfg.peers?.[0]?.public_key ?? '';
  const raw = cfg.peers?.[0]?.endpoint?.v4 ?? FALLBACK_ENDPOINT;
  const endpoint = raw.startsWith('[') ? FALLBACK_ENDPOINT : raw;

  // client_id = base64 سه‌بایتی → reserved برای عبور از فیلتر اتاق‌های CF.
  let reserved: number[] = [];
  if (cfg.client_id) {
    try {
      reserved = Array.from(Uint8Array.from(atob(cfg.client_id), (c) => c.charCodeAt(0)));
    } catch {
      reserved = [];
    }
  }
  if (!peer || !reserved.length) throw new Error('پاسخ WARP ناقص بود — دوباره تلاش کنید');

  return { priv: toHex(priv), v4, v6, peer, endpoint, reserved, created: Math.floor(Date.now() / 1000) };
}

/** هویت ذخیره‌شده را می‌خواند؛ خراب → null. */
export function parseIdentity(raw: string): WarpIdentity | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as WarpIdentity;
    if (j && typeof j.priv === 'string' && j.priv.length === 64 && Array.isArray(j.reserved)) return j;
    return null;
  } catch {
    return null;
  }
}

export function parseEndpoint(endpoint: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(endpoint.trim());
  if (!m) return { host: 'engage.cloudflareclient.com', port: 2408 };
  return { host: m[1] ?? m[2] ?? 'engage.cloudflareclient.com', port: Number(m[3]) || 2408 };
}

export interface WarpRuntime {
  mode: 'direct' | 'chain';
  sites: string[];
  identity: WarpIdentity;
}

/**
 * وضعیت WARP از نگاه تنظیمات: روشن + هویت معتبر → پر می‌شود؛ وگرنه null
 * تا ساب‌ساز اصلاً outbound وایرگارد نسازد.
 */
export function warpRuntime(s: Settings): WarpRuntime | null {
  if (!s.bool('warp_enabled')) return null;
  const identity = parseIdentity(s.get('warp_identity'));
  if (!identity) return null;
  return {
    mode: s.get('warp_mode') === 'chain' ? 'chain' : 'direct',
    sites: s.lines('warp_sites'),
    identity,
  };
}

/** فایل .conf استاندارد وایرگارد — برای اتصال مستقیم خارج از پنل (نمایش/دانلود). */
export function wireguardConf(id: WarpIdentity, title = 'WARP'): string {
  const { host, port } = parseEndpoint(id.endpoint);
  return [
    `[Interface]`,
    `PrivateKey = ${id.priv}`,
    `Address = ${id.v4}`,
    id.v6 ? `Address = ${id.v6}` : '',
    `DNS = 1.1.1.1`,
    `MTU = 1280`,
    ``,
    `[Peer]`,
    `PublicKey = ${id.peer}`,
    `AllowedIPs = 0.0.0.0/0, ::/0`,
    `Endpoint = ${host}:${port}`,
    `PersistentKeepalive = 25`,
    ``,
    `# ${title}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}
