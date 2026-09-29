/**
 * تنظیمات پنل: خواندن از D1 با کش در سطح isolate.
 * KV اینجا استفاده نمی‌شود چون Free فقط ۱۰۰۰ write در روز دارد.
 */
import type { Env } from '../types';

export const DEFAULTS: Record<string, string> = {
  // پنل
  panel_path: '', // در اولین بوت تولید می‌شود
  admin_user: 'admin',
  admin_pass_hash: '',
  session_max_age: '86400',
  page_size: '25',
  lang: 'fa',
  theme: 'dark',
  calendar: 'jalali',
  ip_limit_enable: '1',
  twofa_enabled: '0',
  twofa_secret: '',

  // استتار
  decoy_mode: 'proxy', // proxy | 404 | 1101 | redirect
  decoy_target: 'https://www.docker.com',

  // ساب
  sub_path: 'sub',
  sub_title: 'PersianPl',
  sub_update_interval: '12',
  sub_show_info: '1',
  remark_template: '{WORKER}-{NODE}-{PORT}',
  remark_separator: '-',
  fake_configs: '',
  /** سقف تعداد کانفیگ در هر ساب (ضربِ آدرس × پورت زود بزرگ می‌شود). */
  max_configs: '60',
  /** ساب‌های بیرونی که در خروجی ادغام می‌شوند (یک URL در هر خط). */
  external_subs: '',

  // مسیریابی سمت کلاینت
  bypass_iran: '1',
  bypass_lan: '1',
  block_ads: '1',
  block_porn: '0',
  block_quic: '0',
  custom_rules_direct: '',
  custom_rules_block: '',
  custom_rules_proxy: '',

  // شبکه و خروجی
  proxyip: '',
  proxyip_mode: 'proxyip', // proxyip | nat64
  nat64_prefixes: '2602:fc59:b0:64::',
  socks5: '',
  socks5_global: '0',
  socks5_domains: '',
  dynamic_paths: '1', // /proxyip= و /socks5= در مسیر
  clean_ips: '',
  clean_ips_url: '',
  custom_cdn: '',
  /** موازی‌سازی دیال؛ ۱ = ترتیبی. سقف ۳ (نصفِ ۶ اتصال همزمانِ CF). */
  dial_parallel: '1',
  /** مهلت باز شدن هر اتصال قبل از رفتن به مسیر بعدی (ms). */
  dial_timeout: '2500',
  /** بی‌فعالیتیِ نشست قبل از بستن (ms). */
  idle_timeout: '100000',
  /** سرور DNS رله (پرسش UDP روی TCP می‌رود). */
  dns_relay: '8.8.4.4:53',

  // DNS (سمت کلاینت)
  dns_remote: 'https://dns.google/dns-query',
  dns_local: '8.8.8.8',
  dns_underlying_doh: 'https://cloudflare-dns.com/dns-query',
  doh_enable: '1',
  fakedns: '0',
  ipv6: '1',

  // WARP (خروجی وایرگارد — هویت با «ثبت هویت» از API کلادفلر ساخته می‌شود)
  warp_enabled: '0',
  warp_mode: 'direct', // direct | chain (chain = وایرگارد روی کانفیگ‌های پنل)
  warp_sites: '', // دامنه‌هایی که به outbound WARP می‌روند (یک در هر خط)
  warp_identity: '', // JSON هویت ثبت‌شده (کلید خصوصی + reserved)

  // پیش‌فرض گزینه‌های ساب‌ساز
  default_gen_opts: JSON.stringify({
    fingerprint: 'chrome',
    alpn: ['h2', 'http/1.1'],
    allowInsecure: false,
    ech: false,
    mux: { enabled: false, concurrency: 8, xudpConcurrency: 16, xudpProxyUDP443: 'reject', protocol: 'h2mux', padding: false },
  }),

  // نودها
  node_secret: '',
  node_pull_interval: '300',

  // تلگرام
  tg_bot_token: '',
  tg_chat_id: '',
  tg_notify_expiry: '1',
  tg_notify_traffic: '1',
  tg_notify_login: '1',
  tg_webhook_secret: '', // secret مسیر/هدر وب‌هوک — در اولین اتصال تولید می‌شود
  tg_bound_chat: '', // chat_id چت بایندشده با API Key
  tg_bound_name: '', // نام نمایشی چت بایندشده
  tg_last_digest: '0', // آخرین گزارش روزانه (unix) — جلوگیری از هشدار تکراری

  // عملیاتی
  kill_switch: '0',
  cf_api_token: '',
  cf_account_id: '',
};

type Cache = { at: number; map: Map<string, string> };
let cache: Cache | null = null;
const TTL_MS = 15_000;

export async function loadSettings(env: Env, force = false): Promise<Map<string, string>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const map = new Map<string, string>(Object.entries(DEFAULTS));
  try {
    const rs = await env.DB.prepare('SELECT k, v FROM settings').all<{ k: string; v: string }>();
    for (const row of rs.results ?? []) map.set(row.k, row.v);
  } catch {
    // پیش از اجرای migration، پیش‌فرض‌ها استفاده می‌شود
  }
  cache = { at: Date.now(), map };
  return map;
}

export function invalidateSettings(): void {
  cache = null;
}

export async function setSetting(env: Env, k: string, v: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO settings (k, v, updated_at) VALUES (?, ?, unixepoch()) ' +
      'ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
  )
    .bind(k, v)
    .run();
  invalidateSettings();
}

export async function setSettings(env: Env, entries: Record<string, string>): Promise<void> {
  const stmts = Object.entries(entries).map(([k, v]) =>
    env.DB.prepare(
      'INSERT INTO settings (k, v, updated_at) VALUES (?, ?, unixepoch()) ' +
        'ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
    ).bind(k, v),
  );
  if (stmts.length) await env.DB.batch(stmts);
  invalidateSettings();
}

export class Settings {
  constructor(private readonly map: Map<string, string>) {}
  get(k: string): string {
    return this.map.get(k) ?? DEFAULTS[k] ?? '';
  }
  int(k: string, fallback = 0): number {
    const n = Number(this.get(k));
    return Number.isFinite(n) ? n : fallback;
  }
  bool(k: string): boolean {
    const v = this.get(k);
    return v === '1' || v === 'true';
  }
  json<T>(k: string, fallback: T): T {
    try {
      return JSON.parse(this.get(k)) as T;
    } catch {
      return fallback;
    }
  }
  /** یک مقدار چندخطی را به آرایه‌ی خطوط غیرخالی تبدیل می‌کند. */
  lines(k: string): string[] {
    return this.get(k)
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

export async function settings(env: Env): Promise<Settings> {
  return new Settings(await loadSettings(env));
}
