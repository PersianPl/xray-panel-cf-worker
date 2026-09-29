/**
 * تایپ‌های مشترک پنل و نود.
 */

export interface Env {
  DB: D1Database;
  CACHE?: KVNamespace;

  /** panel | node */
  ROLE?: string;

  // نقش node
  PANEL_URL?: string;
  NODE_TOKEN?: string;
  NODE_NAME?: string;

  // بوت‌استرپ اولیه‌ی پنل (بعد از اولین اجرا در D1 ذخیره می‌شود)
  ADMIN_USER?: string;
  ADMIN_PASS?: string;
  PANEL_PATH?: string;
}

export type Protocol = 'vless' | 'vmess' | 'trojan' | 'shadowsocks';
export type Transport = 'ws' | 'httpupgrade' | 'xhttp';
export type TrafficReset = 'never' | 'daily' | 'weekly' | 'monthly';

/** پورت‌هایی که لبه‌ی کلادفلر روی TLS قبول می‌کند. */
export const TLS_PORTS = [443, 2053, 2083, 2087, 2096, 8443] as const;
/** پورت‌های بدون TLS — فقط با دامنه‌ی شخصی. */
export const HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095] as const;

export const FINGERPRINTS = [
  'chrome', 'firefox', 'safari', 'ios', 'android',
  'edge', '360', 'qq', 'random', 'randomized',
] as const;

export const VMESS_SECURITY = ['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'] as const;
export const SS_METHODS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305'] as const;

/** گزینه‌های سمت‌کلاینت که در ژنراتور ساب تزریق می‌شوند. */
export interface GenOpts {
  fingerprint?: string;
  alpn?: string[];
  sni?: string;
  host?: string;
  allowInsecure?: boolean;
  ech?: boolean;
  echServerName?: string;
  fragment?: { packets: string; length: string; interval: string };
  noise?: Array<{ type: 'rand' | 'base64' | 'str' | 'hex'; packet: string; delay: string; applyTo: 'ip' | 'ipv4' | 'ipv6' }>;
  mux?: { enabled: boolean; concurrency: number; xudpConcurrency: number; xudpProxyUDP443: 'reject' | 'allow' | 'skip'; protocol?: 'h2mux' | 'smux' | 'yamux'; padding?: boolean };
  chain?: string;
  cdn?: { address: string; host: string; sni: string };
}

export interface Inbound {
  id: number;
  tag: string;
  remark: string;
  enable: number;
  protocol: Protocol;
  transport: Transport;
  path: string;
  host: string;
  sni: string;
  ports: string;
  max_early_data: number;
  ss_method: string;
  vmess_security: string;
  total_gb: number;
  traffic_reset: TrafficReset;
  last_reset_at: number;
  expiry_at: number;
  up: number;
  down: number;
  extra: string;
  created_at: number;
}

export interface Client {
  id: number;
  inbound_id: number;
  name: string;
  comment: string;
  auth: string;
  enable: number;
  total_gb: number;
  up: number;
  down: number;
  expiry_at: number;
  delayed_days: number;
  renew_days: number;
  reset_count: number;
  limit_ip: number;
  sub_token: string;
  tg_chat_id: string;
  pref_node: string;
  proxyip: string;
  nat64_prefix: string;
  routing_id: number | null;
  gen_opts: string;
  last_online: number;
  first_seen: number;
  created_at: number;
}

export interface Node {
  id: number;
  name: string;
  host: string;
  url: string;
  token_hash: string;
  enable: number;
  ports: string;
  proxyip: string;
  region: string;
  weight: number;
  last_seen: number;
  req_today: number;
  health: string;
  created_at: number;
}

/** تصمیم مسیریابی برای یک اتصال ورودی. */
export interface ResolvedClient {
  client: Client;
  inbound: Inbound;
}
