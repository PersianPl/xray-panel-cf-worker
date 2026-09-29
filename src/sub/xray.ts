/**
 * خروجی Xray JSON — تنها فرمتی که Fragment و Noise را واقعاً پشتیبانی می‌کند.
 *
 * چرا این فرمت لازم است: در ایران بسته‌ی ClientHello مربوط به دامنه‌های
 * مسدودشده با SNI-filtering قطع می‌شود. `fragment` همان ClientHello را به چند
 * بسته‌ی TCP می‌شکند و `noise` بسته‌های بی‌معنی جلوترش می‌فرستد؛ هر دو فقط در
 * هسته‌ی Xray (v2rayNG/Streisand/v2rayN) پیاده شده‌اند و در sing-box و mihomo
 * معادلی ندارند. پس ساب سه‌فرمته باید این چهارمی را هم داشته باشد.
 *
 * چیدمان: outbound `fragment` (protocol=freedom) به‌عنوان `dialerProxy` زیر
 * streamSettings هر outbound اصلی می‌نشیند — همان الگویی که BPB و v2rayNG
 * تولید می‌کنند.
 */
import type { ConfigItem } from './build';
import type { GenOpts } from '../types';
import { parseEndpoint } from '../lib/warp';
import { isPlainPort } from './links';

export interface XrayInput {
  items: ConfigItem[];
  opts: GenOpts;
  flags: {
    bypassIran: boolean;
    blockAds: boolean;
    blockPorn: boolean;
    blockQuic: boolean;
    remoteDns: string;
    localDns: string;
    underlyingDoh: string;
    ipv6: boolean;
    fakedns: boolean;
    direct?: string[];
    block?: string[];
    proxy?: string[];
    warp?: { mode: 'direct' | 'chain'; sites: string[]; identity: import('../lib/warp').WarpIdentity } | null;
  };
}

/** یک کانفیگ Xray کامل برای هر آیتم (کلاینت‌ها آرایه را به‌عنوان چند پروفایل می‌خوانند). */
export function buildXray(input: XrayInput): unknown[] {
  return input.items.map((it) => oneConfig(it, input));
}

function oneConfig(it: ConfigItem, input: XrayInput): unknown {
  const { opts, flags } = input;
  const s = it.spec;
  const useFragment = !!opts.fragment;
  const useNoise = !!(opts.noise && opts.noise.length);

  const outbounds: unknown[] = [main(it, opts, useFragment || useNoise)];
  if (useFragment || useNoise) outbounds.push(fragmentOutbound(opts));
  if (input.flags.warp) outbounds.push(warpOutboundXray(input.flags.warp));
  outbounds.push({ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'block' });

  return {
    remarks: s.remark,
    log: { loglevel: 'warning' },
    dns: dns(flags),
    inbounds: [
      {
        tag: 'socks-in',
        protocol: 'socks',
        listen: '127.0.0.1',
        port: 10808,
        settings: { auth: 'noauth', udp: true, userLevel: 8 },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
      },
      {
        tag: 'http-in',
        protocol: 'http',
        listen: '127.0.0.1',
        port: 10809,
        settings: { userLevel: 8 },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
      },
    ],
    outbounds,
    routing: routing(flags),
    ...(opts.mux?.enabled
      ? {
          // Xray مقدار `-1` را «غیرفعال» می‌فهمد، پس مقدار معتبر می‌فرستیم.
          mux: {
            enabled: true,
            concurrency: opts.mux.concurrency > 0 ? opts.mux.concurrency : 8,
            xudpConcurrency: opts.mux.xudpConcurrency > 0 ? opts.mux.xudpConcurrency : 16,
            xudpProxyUDP443: opts.mux.xudpProxyUDP443 ?? 'reject',
          },
        }
      : {}),
  };
}

function main(it: ConfigItem, opts: GenOpts, viaFragment: boolean): unknown {
  const s = it.spec;
  const tls = !isPlainPort(s.port);
  const host = s.host || s.sni || s.address;

  const stream: Record<string, unknown> = {
    network: s.transport === 'httpupgrade' ? 'httpupgrade' : s.transport,
    security: tls ? 'tls' : 'none',
    ...(tls
      ? {
          tlsSettings: {
            serverName: opts.sni || s.sni || host,
            allowInsecure: opts.allowInsecure === true,
            fingerprint: opts.fingerprint || 'chrome',
            ...(opts.alpn && opts.alpn.length ? { alpn: opts.alpn } : {}),
            ...(opts.ech ? { echConfigList: opts.echServerName || 'cloudflare-ech.com' } : {}),
          },
        }
      : {}),
    ...transportSettings(s.transport, s.path, host, s.maxEarlyData),
    // dialerProxy باعث می‌شود اتصال از داخل outbound فرگمنت برود.
    ...(viaFragment ? { sockopt: { dialerProxy: 'fragment', tcpKeepAliveIdle: 100, tcpNoDelay: true } } : {}),
  };

  const settings =
    s.protocol === 'vless'
      ? { vnext: [{ address: s.address, port: s.port, users: [{ id: s.auth, encryption: 'none', flow: '', level: 8 }] }] }
      : s.protocol === 'vmess'
        ? {
            vnext: [
              {
                address: s.address,
                port: s.port,
                users: [{ id: s.auth, alterId: 0, security: s.vmessSecurity || 'auto', level: 8 }],
              },
            ],
          }
        : s.protocol === 'trojan'
          ? { servers: [{ address: s.address, port: s.port, password: s.auth, level: 8 }] }
          : { servers: [{ address: s.address, port: s.port, method: s.ssMethod || 'aes-128-gcm', password: s.auth, level: 8 }] };

  return {
    tag: 'proxy',
    protocol: s.protocol === 'shadowsocks' ? 'shadowsocks' : s.protocol,
    settings,
    streamSettings: stream,
  };
}

function transportSettings(kind: string, rawPath: string, host: string, maxEarlyData: number): Record<string, unknown> {
  const p = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (kind === 'httpupgrade') {
    return { httpupgradeSettings: { path: p.split('?')[0], host } };
  }
  if (kind === 'xhttp') {
    // تنها حالت سازگار با Worker: پاسخ یک‌جریانه (بدون chunked upload جدا).
    return { xhttpSettings: { path: p.split('?')[0], host, mode: 'stream-one' } };
  }
  // در Xray مسیرِ `?ed=` خودش early-data را روشن می‌کند.
  const path = maxEarlyData > 0 ? `${p.split('?')[0]}?ed=${maxEarlyData}` : p;
  return { wsSettings: { path, headers: { Host: host } } };
}

/** outbound فرگمنت/نویز — همیشه freedom با تنظیم fragment. */
function fragmentOutbound(opts: GenOpts): unknown {
  const f = opts.fragment;
  return {
    tag: 'fragment',
    protocol: 'freedom',
    settings: {
      domainStrategy: 'UseIP',
      ...(f ? { fragment: { packets: f.packets, length: f.length, interval: f.interval } } : {}),
      ...(opts.noise && opts.noise.length
        ? {
            noises: opts.noise.map((n) => ({
              type: n.type,
              packet: n.packet,
              delay: n.delay,
              ...(n.applyTo ? { applyTo: n.applyTo } : {}),
            })),
          }
        : {}),
    },
    streamSettings: { sockopt: { tcpNoDelay: true, tcpKeepAliveIdle: 100 } },
  };
}

function dns(f: XrayInput['flags']): unknown {
  const servers: unknown[] = [
    { address: f.remoteDns, domains: ['geosite:geolocation-!ir'], skipFallback: true },
    ...(f.bypassIran
      ? [{ address: f.localDns, domains: ['geosite:category-ir', 'geosite:ir'], expectIPs: ['geoip:ir'], skipFallback: true }]
      : []),
    f.localDns,
  ];
  return {
    hosts: {
      // مسدود کردن در لایه‌ی DNS از مسدود کردن در routing ارزان‌تر است.
      ...(f.blockAds ? { 'geosite:category-ads-all': ['127.0.0.1'] } : {}),
    },
    servers,
    queryStrategy: f.ipv6 ? 'UseIP' : 'UseIPv4',
    tag: 'dns',
    ...(f.fakedns ? { fakedns: [{ ipPool: '198.18.0.0/15', poolSize: 10000 }] } : {}),
  };
}

function routing(f: XrayInput['flags']): unknown {
  const rules: unknown[] = [
    { type: 'field', inboundTag: ['dns'], outboundTag: 'proxy' },
    { type: 'field', port: '53', outboundTag: 'proxy' },
    { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
    { type: 'field', domain: ['geosite:private'], outboundTag: 'direct' },
  ];
  if (f.blockQuic) rules.push({ type: 'field', network: 'udp', port: '443', outboundTag: 'block' });
  if (f.blockAds)
    rules.push({ type: 'field', domain: ['geosite:category-ads-all', 'geosite:malware', 'geosite:phishing'], outboundTag: 'block' });
  if (f.blockPorn) rules.push({ type: 'field', domain: ['geosite:category-porn'], outboundTag: 'block' });
  if (f.bypassIran)
    rules.push(
      { type: 'field', domain: ['geosite:category-ir', 'geosite:ir'], outboundTag: 'direct' },
      { type: 'field', ip: ['geoip:ir'], outboundTag: 'direct' },
    );

  // قواعد سفارشی پروفایل — دامنه‌ی خام به‌عنوان زیردامنه‌ match می‌شود.
  const custom = (lines: string[] | undefined, outboundTag: string) => {
    if (!lines?.length) return;
    const domains: string[] = [];
    const ips: string[] = [];
    for (const l of lines) {
      if (l.startsWith('ip:')) ips.push(l.slice(3).trim());
      else domains.push(l);
    }
    if (domains.length) rules.push({ type: 'field', domain: domains, outboundTag });
    if (ips.length) rules.push({ type: 'field', ip: ips, outboundTag });
  };
  custom(f.direct, 'direct');
  custom(f.block, 'block');
  custom(f.proxy, 'proxy');

  // دامنه‌های WARP
  if (f.warp && f.warp.sites.length) {
    rules.push({ type: 'field', domain: f.warp.sites, outboundTag: 'warp' });
  }

  rules.push({ type: 'field', network: 'tcp,udp', outboundTag: 'proxy' });
  return { domainStrategy: f.ipv6 ? 'IPIfNonMatch' : 'IPIfNonMatch', rules };
}

/** outbound وایرگارد Xray از هویت WARP. */
export function warpOutboundXray(w: NonNullable<XrayInput['flags']['warp']>): unknown {
  const id = w.identity;
  const { host, port } = parseEndpoint(id.endpoint);
  const addrs = id.v6 ? [id.v4.split('/')[0] ?? id.v4, id.v6.split('/')[0] ?? id.v6] : [id.v4.split('/')[0] ?? id.v4];
  return {
    tag: 'warp',
    protocol: 'wireguard',
    settings: {
      secretKey: id.priv,
      address: addrs,
      peers: [
        {
          publicKey: id.peer,
          endpoint: `${host}:${port}`,
          ...(id.reserved.length === 3 ? { reserved: id.reserved } : {}),
          allowedIps: ['0.0.0.0/0', '::/0'],
        },
      ],
      mtu: 1280,
      ...(w.mode === 'chain' ? { } : {}),
    },
    streamSettings: w.mode === 'chain' ? { sockopt: { dialerProxy: 'proxy' } } : {},
  };
}
