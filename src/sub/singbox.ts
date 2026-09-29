/**
 * خروجی sing-box (JSON) — برای Hiddify/sing-box/Karing و مشتقاتشان.
 *
 * ساختار مطابق sing-box ۱.۸+ است: `outbounds` با یک `selector` و یک `urltest`
 * در ابتدا، سپس outbound هر کانفیگ. DNS و route هم تولید می‌شود چون بدون آن‌ها
 * کلاینت همه‌ی ترافیک (از جمله دامنه‌های داخلی) را تونل می‌کند.
 *
 * تفاوت‌های مهم با Xray که اگر رعایت نشوند کانفیگ کار نمی‌کند:
 *   • VMess در sing-box کلید `security` را `security` نمی‌نامد بلکه `security`
 *     همان است ولی مقدار `auto` پذیرفته نیست → `aes-128-gcm` جایگزین می‌شود
 *   • early-data در WS با `max_early_data` + `early_data_header_name` می‌آید،
 *     نه با `?ed=` در مسیر
 *   • Trojan رمز را در `password` می‌گیرد و `tls.server_name` جدا از `host` است
 */
import type { ConfigItem } from './build';
import type { GenOpts } from '../types';
import type { WarpIdentity } from '../lib/warp';
import { parseEndpoint } from '../lib/warp';
import { isPlainPort } from './links';

interface RouteFlags {
  bypassIran: boolean;
  blockAds: boolean;
  blockPorn: boolean;
  blockQuic: boolean;
  ipv6: boolean;
  remoteDns: string;
  localDns: string;
  fakedns: boolean;
  /** قواعد سفارشی؛ خط `ip:` شروع = IP/CIDR، بقیه دامنه. */
  direct?: string[];
  block?: string[];
  proxy?: string[];
  /** WARP فعال — در صورت حضور outbound وایرگارد اضافه می‌شود. */
  warp?: { mode: 'direct' | 'chain'; sites: string[]; identity: WarpIdentity } | null;
}

export interface SingboxInput {
  items: ConfigItem[];
  opts: GenOpts;
  flags: RouteFlags;
}

export function buildSingbox(input: SingboxInput): unknown {
  const { items, flags } = input;
  const tags = items.map((it) => it.spec.remark);
  const warpTag = '🟢 WARP';
  const warp = flags.warp ?? null;

  const extra: Array<Record<string, unknown>> = [];
  if (warp) {
    extra.push(wireguardOutbound(warp.identity, warpTag));
    // در حالت chain همه‌ی کانفیگ‌های پنل از روی WARP عبور می‌کنند (دابل‌هاپ).
    if (warp.mode === 'chain') extra.push({ type: 'direct', tag: 'direct-via-warp', detour: warpTag });
  }

  const selectorOut = warp && warp.mode === 'chain' ? ['direct-via-warp'] : ['⚡ خودکار', ...tags];
  const autoOut = warp && warp.mode === 'chain' ? ['direct-via-warp'] : tags;

  return {
    log: { level: 'warn', timestamp: true },
    dns: dnsSection(flags),
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        address: flags.ipv6 ? ['172.19.0.1/28', 'fdfe:dcba:9876::1/126'] : ['172.19.0.1/28'],
        auto_route: true,
        strict_route: true,
        stack: 'mixed',
        sniff: true,
      },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080, sniff: true },
    ],
    outbounds: [
      { type: 'selector', tag: '✅ انتخاب', outbounds: selectorOut, default: warp && warp.mode === 'chain' ? 'direct-via-warp' : '⚡ خودکار' },
      {
        type: 'urltest',
        tag: '⚡ خودکار',
        outbounds: autoOut,
        url: 'https://www.gstatic.com/generate_204',
        interval: '3m',
        tolerance: 50,
        ...(autoOut.length ? {} : {}),
      },
      ...items.map((it) => outboundOf(it, input.opts)),
      ...extra,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
      { type: 'dns', tag: 'dns-out' },
    ],
    route: routeSection(flags),
    experimental: {
      cache_file: { enabled: true, store_fakeip: flags.fakedns },
      clash_api: { external_controller: '127.0.0.1:9090', default_mode: 'rule' },
    },
  };
}

/** outbound وایرگارد sing-box از هویت WARP. */
function wireguardOutbound(id: WarpIdentity, tag: string): Record<string, unknown> {
  const { host, port } = parseEndpoint(id.endpoint);
  return {
    type: 'wireguard',
    tag,
    server: host,
    server_port: port,
    local_address: id.v6 ? [id.v4, id.v6.split('/')[0] + '/128'] : [id.v4],
    private_key: id.priv,
    peer_public_key: id.peer,
    reserved: id.reserved,
    mtu: 1280,
  };
}

function outboundOf(it: ConfigItem, opts: GenOpts): Record<string, unknown> {
  const s = it.spec;
  const tls = !isPlainPort(s.port);
  const host = s.host || s.sni || s.address;

  const base: Record<string, unknown> = {
    tag: s.remark,
    server: s.address,
    server_port: s.port,
    transport: transportOf(s.transport, s.path, host, s.maxEarlyData),
  };

  if (tls) {
    base.tls = {
      enabled: true,
      server_name: opts.sni || s.sni || host,
      insecure: opts.allowInsecure === true,
      ...(opts.alpn && opts.alpn.length ? { alpn: opts.alpn } : {}),
      utls: { enabled: true, fingerprint: opts.fingerprint || 'chrome' },
      ...(opts.ech ? { ech: { enabled: true, config: [] } } : {}),
    };
  }

  if (opts.mux?.enabled) {
    base.multiplex = {
      enabled: true,
      protocol: opts.mux.protocol ?? 'h2mux',
      max_streams: opts.mux.concurrency > 0 ? opts.mux.concurrency : 8,
      padding: opts.mux.padding === true,
    };
  }

  switch (s.protocol) {
    case 'vless':
      return { type: 'vless', ...base, uuid: s.auth, flow: '' };
    case 'vmess':
      return {
        type: 'vmess',
        ...base,
        uuid: s.auth,
        alter_id: 0,
        // sing-box مقدار `auto` را نمی‌شناسد.
        security: s.vmessSecurity && s.vmessSecurity !== 'auto' ? s.vmessSecurity : 'aes-128-gcm',
      };
    case 'trojan':
      return { type: 'trojan', ...base, password: s.auth };
    case 'shadowsocks':
      return { type: 'shadowsocks', ...base, method: s.ssMethod || 'aes-128-gcm', password: s.auth };
  }
}

function transportOf(kind: string, path: string, host: string, maxEarlyData: number): Record<string, unknown> {
  const p = path.startsWith('/') ? path : `/${path}`;
  // مسیر در sing-box نباید `?ed=` داشته باشد؛ همان مقدار در فیلد جدا می‌آید.
  const clean = p.split('?')[0]!;
  if (kind === 'httpupgrade') return { type: 'httpupgrade', path: clean, host };
  if (kind === 'xhttp') return { type: 'http', path: clean, host: [host], method: 'GET' };
  return {
    type: 'ws',
    path: clean,
    headers: { Host: host },
    ...(maxEarlyData > 0 ? { max_early_data: maxEarlyData, early_data_header_name: 'Sec-WebSocket-Protocol' } : {}),
  };
}

function dnsSection(f: RouteFlags): Record<string, unknown> {
  const servers: Array<Record<string, unknown>> = [
    { tag: 'dns-remote', address: f.remoteDns, address_resolver: 'dns-direct', strategy: f.ipv6 ? 'prefer_ipv4' : 'ipv4_only', detour: '✅ انتخاب' },
    { tag: 'dns-direct', address: f.localDns, detour: 'direct' },
    { tag: 'dns-block', address: 'rcode://success' },
  ];
  if (f.fakedns) servers.push({ tag: 'dns-fake', address: 'fakeip' });

  const rules: Array<Record<string, unknown>> = [
    { outbound: 'any', server: 'dns-direct' },
    { clash_mode: 'Direct', server: 'dns-direct' },
    { clash_mode: 'Global', server: 'dns-remote' },
  ];
  if (f.bypassIran) rules.push({ rule_set: ['geosite-ir'], server: 'dns-direct' });
  if (f.blockAds) rules.push({ rule_set: ['geosite-ads'], server: 'dns-block', disable_cache: true });
  if (f.fakedns) rules.push({ query_type: ['A', 'AAAA'], server: 'dns-fake' });

  return {
    servers,
    rules,
    final: 'dns-remote',
    strategy: f.ipv6 ? 'prefer_ipv4' : 'ipv4_only',
    independent_cache: true,
    ...(f.fakedns ? { fakeip: { enabled: true, inet4_range: '198.18.0.0/15' } } : {}),
  };
}

/** rule-setهای remote که در sing-box با URL می‌آیند. */
const RULE_SETS: Record<string, string> = {
  'geosite-ir': 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-ir.srs',
  'geoip-ir': 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geoip-ir.srs',
  'geosite-ads': 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-category-ads-all.srs',
  'geosite-porn': 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-nsfw.srs',
  'geosite-malware': 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-malware.srs',
  'geosite-phishing': 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-phishing.srs',
};

function routeSection(f: RouteFlags): Record<string, unknown> {
  const used = new Set<string>();
  const rules: Array<Record<string, unknown>> = [
    { action: 'sniff' },
    { protocol: 'dns', outbound: 'dns-out' },
    { clash_mode: 'Direct', outbound: 'direct' },
    { clash_mode: 'Global', outbound: '✅ انتخاب' },
    { ip_is_private: true, outbound: 'direct' },
  ];

  if (f.blockQuic) rules.push({ protocol: 'quic', outbound: 'block' });
  for (const [flag, set, outbound] of [
    [f.blockAds, 'geosite-ads', 'block'],
    [f.blockPorn, 'geosite-porn', 'block'],
    [f.blockAds, 'geosite-malware', 'block'],
    [f.blockAds, 'geosite-phishing', 'block'],
    [f.bypassIran, 'geosite-ir', 'direct'],
    [f.bypassIran, 'geoip-ir', 'direct'],
  ] as Array<[boolean, string, string]>) {
    if (!flag) continue;
    used.add(set);
    rules.push({ rule_set: [set], outbound });
  }

  // قواعد سفارشی پروفایل — قبل از MATCH نهایی می‌نشینند.
  const custom = customRuleSets(f);
  for (const cs of custom.sets) used.add(cs);
  for (const r of custom.rules) rules.push(r);

  // دامنه‌های انتخابی → WARP
  if (f.warp && f.warp.sites.length) {
    rules.push({ domain_suffix: f.warp.sites, outbound: '🟢 WARP' });
  }

  return {
    rules,
    rule_set: [...used].map((tag) => ({
      type: 'remote',
      tag,
      format: 'binary',
      url: RULE_SETS[tag],
      download_detour: 'direct',
      update_interval: '7d',
    })),
    final: '✅ انتخاب',
    auto_detect_interface: true,
    override_android_vpn: true,
  };
}

/**
 * قواعد سفارشی را به rule-set محلی + قانون تبدیل می‌کند.
 * چون sing-box برای دامنه‌ی خام rule-set آنلاین لازم ندارد، از `domain_suffix`
 * و `ip_cidr` مستقیم استفاده می‌کنیم — سبک‌تر و بدون وابستگی بیرونی.
 */
function customRuleSets(f: RouteFlags): { sets: string[]; rules: Array<Record<string, unknown>> } {
  const out: Array<Record<string, unknown>> = [];
  const pick = (lines: string[] | undefined, outbound: string) => {
    if (!lines?.length) return;
    const domains: string[] = [];
    const ips: string[] = [];
    for (const l of lines) {
      if (l.startsWith('ip:')) ips.push(l.slice(3).trim());
      else domains.push(l);
    }
    if (domains.length) out.push({ domain_suffix: domains, outbound });
    if (ips.length) out.push({ ip_cidr: ips, outbound });
  };
  pick(f.direct, 'direct');
  pick(f.block, 'block');
  pick(f.proxy, '✅ انتخاب');
  return { sets: [], rules: out };
}
