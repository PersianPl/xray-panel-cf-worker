/**
 * خروجی Clash-Meta (mihomo) — YAML.
 *
 * YAML را دستی می‌سازیم چون آوردن کتابخانه‌ی YAML به Worker هم حجم اسکریپت را
 * بالا می‌برد (سقف ۳MB gzip) و هم لازم نیست: ساختار خروجی ثابت و کنترل‌شده است.
 * فقط `quote()` باید درست باشد تا نام‌های فارسی و کاراکترهای خاص YAML را نشکنند.
 *
 * نکته‌های مخصوص mihomo:
 *   • VMess فیلد `cipher` ندارد، `cipher` را `auto` بگذاریم قبول است ولی
 *     نام درست `cipher` نیست — کلید صحیح `cipher` برای ss است و برای vmess
 *     `cipher` نداریم؛ `alterId` و `cipher: auto` هر دو در پروکسی vmess می‌آید
 *   • WS با `ws-opts.max-early-data` + `early-data-header-name` کار می‌کند
 *   • `client-fingerprint` بیرون از `tls` می‌آید (سطح پروکسی)
 */
import type { ConfigItem } from './build';
import type { GenOpts } from '../types';
import { parseEndpoint } from '../lib/warp';
import { isPlainPort } from './links';

export interface ClashInput {
  items: ConfigItem[];
  opts: GenOpts;
  flags: {
    bypassIran: boolean;
    blockAds: boolean;
    blockPorn: boolean;
    ipv6: boolean;
    direct?: string[];
    block?: string[];
    proxy?: string[];
    warp?: { mode: 'direct' | 'chain'; sites: string[]; identity: import('../lib/warp').WarpIdentity } | null;
  };
  subUrl: string;
  interval: number;
}

export function buildClash(input: ClashInput): string {
  const { items, opts } = input;
  const names = items.map((it) => it.spec.remark);
  const L: string[] = [];

  L.push('mixed-port: 7890');
  L.push('allow-lan: false');
  L.push('mode: rule');
  L.push('log-level: warning');
  L.push(`ipv6: ${input.flags.ipv6}`);
  L.push('external-controller: 127.0.0.1:9090');
  L.push('unified-delay: true');
  L.push('tcp-concurrent: true');
  L.push('');
  L.push('dns:');
  L.push('  enable: true');
  L.push('  listen: 0.0.0.0:1053');
  L.push(`  ipv6: ${input.flags.ipv6}`);
  L.push('  enhanced-mode: fake-ip');
  L.push('  fake-ip-range: 198.18.0.1/16');
  L.push('  nameserver:');
  L.push('    - https://dns.google/dns-query');
  L.push('    - https://cloudflare-dns.com/dns-query');
  L.push('  default-nameserver:');
  L.push('    - 8.8.8.8');
  L.push('    - 1.1.1.1');
  L.push('');
  L.push('proxies:');
  for (const it of items) L.push(...proxyBlock(it, opts));
  if (input.flags.warp) L.push(...warpProxy(input.flags.warp));

  L.push('');
  L.push('proxy-groups:');
  L.push(`  - name: ${quote('✅ انتخاب')}`);
  L.push('    type: select');
  L.push('    proxies:');
  L.push(`      - ${quote('⚡ خودکار')}`);
  if (input.flags.warp) L.push(`      - ${quote('🟢 WARP')}`);
  for (const n of names) L.push(`      - ${quote(n)}`);
  L.push(`  - name: ${quote('⚡ خودکار')}`);
  L.push('    type: url-test');
  L.push('    url: https://www.gstatic.com/generate_204');
  L.push('    interval: 180');
  L.push('    tolerance: 50');
  L.push('    proxies:');
  for (const n of names) L.push(`      - ${quote(n)}`);

  L.push('');
  L.push(...ruleProviders(input.flags));
  L.push('');
  L.push('rules:');
  for (const r of rules(input.flags)) L.push(`  - ${r}`);
  L.push('');
  return L.join('\n');
}

/** پروکسی wireguard برای mihomo — از هویت WARP. */
function warpProxy(w: NonNullable<ClashInput['flags']['warp']>): string[] {
  const id = w.identity;
  const { host, port } = parseEndpoint(id.endpoint);
  const L: string[] = [];
  L.push(`  - name: ${quote('🟢 WARP')}`);
  L.push('    type: wireguard');
  L.push(`    server: ${quote(host)}`);
  L.push(`    port: ${port}`);
  L.push(`    ip: ${quote(id.v4.split('/')[0] ?? id.v4)}`);
  if (id.v6) L.push(`    ipv6: ${quote(id.v6.split('/')[0] ?? id.v6)}`);
  L.push(`    private-key: ${quote(id.priv)}`);
  L.push(`    public-key: ${quote(id.peer)}`);
  if (id.reserved.length === 3) L.push(`    reserved: [${id.reserved.join(',')}]`);
  L.push('    udp: true');
  L.push('    mtu: 1280');
  if (w.mode === 'chain') L.push(`    dialer-proxy: ${quote('✅ انتخاب')}`);
  L.push('    remote-dns-resolve: true');
  L.push('    dns: [1.1.1.1]');
  return L;
}

function proxyBlock(it: ConfigItem, opts: GenOpts): string[] {
  const s = it.spec;
  const tls = !isPlainPort(s.port);
  const host = s.host || s.sni || s.address;
  const L: string[] = [];

  L.push(`  - name: ${quote(s.remark)}`);
  L.push(`    server: ${quote(s.address)}`);
  L.push(`    port: ${s.port}`);
  L.push(`    udp: true`);

  switch (s.protocol) {
    case 'vless':
      L.push('    type: vless');
      L.push(`    uuid: ${quote(s.auth)}`);
      L.push(`    flow: ${quote('')}`);
      break;
    case 'vmess':
      L.push('    type: vmess');
      L.push(`    uuid: ${quote(s.auth)}`);
      L.push('    alterId: 0');
      L.push(`    cipher: ${quote(s.vmessSecurity && s.vmessSecurity !== 'zero' ? s.vmessSecurity : 'auto')}`);
      break;
    case 'trojan':
      L.push('    type: trojan');
      L.push(`    password: ${quote(s.auth)}`);
      break;
    case 'shadowsocks':
      L.push('    type: ss');
      L.push(`    cipher: ${quote(s.ssMethod || 'aes-128-gcm')}`);
      L.push(`    password: ${quote(s.auth)}`);
      break;
  }

  if (tls) {
    L.push('    tls: true');
    L.push(`    servername: ${quote(opts.sni || s.sni || host)}`);
    L.push(`    sni: ${quote(opts.sni || s.sni || host)}`);
    L.push(`    skip-cert-verify: ${opts.allowInsecure === true}`);
    L.push(`    client-fingerprint: ${quote(opts.fingerprint || 'chrome')}`);
    if (opts.alpn && opts.alpn.length) {
      L.push('    alpn:');
      for (const a of opts.alpn) L.push(`      - ${quote(a)}`);
    }
  }

  const path = (s.path.startsWith('/') ? s.path : `/${s.path}`).split('?')[0]!;
  if (s.transport === 'ws') {
    L.push('    network: ws');
    L.push('    ws-opts:');
    L.push(`      path: ${quote(path)}`);
    L.push('      headers:');
    L.push(`        Host: ${quote(host)}`);
    if (s.maxEarlyData > 0) {
      L.push(`      max-early-data: ${s.maxEarlyData}`);
      L.push(`      early-data-header-name: ${quote('Sec-WebSocket-Protocol')}`);
    }
  } else if (s.transport === 'httpupgrade') {
    L.push('    network: ws');
    L.push('    ws-opts:');
    L.push(`      path: ${quote(path)}`);
    L.push(`      v2ray-http-upgrade: true`);
    L.push('      headers:');
    L.push(`        Host: ${quote(host)}`);
  } else {
    // XHTTP در mihomo پشتیبانی مستقیم ندارد؛ نزدیک‌ترین چیز h2 است.
    L.push('    network: h2');
    L.push('    h2-opts:');
    L.push(`      path: ${quote(path)}`);
    L.push('      host:');
    L.push(`        - ${quote(host)}`);
  }

  if (opts.mux?.enabled) {
    L.push('    smux:');
    L.push('      enabled: true');
    L.push(`      protocol: ${quote(opts.mux.protocol === 'h2mux' ? 'smux' : (opts.mux.protocol ?? 'smux'))}`);
    L.push(`      max-streams: ${opts.mux.concurrency > 0 ? opts.mux.concurrency : 8}`);
    L.push(`      padding: ${opts.mux.padding === true}`);
  }

  return L;
}

const PROVIDERS: Record<string, string> = {
  ir: 'https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/ir.txt',
  irip: 'https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/irip.txt',
  ads: 'https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/ads.txt',
  nsfw: 'https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/nsfw.txt',
  malware: 'https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/malware.txt',
};

function ruleProviders(flags: ClashInput['flags']): string[] {
  const want: Array<[string, 'domain' | 'ipcidr']> = [];
  if (flags.bypassIran) want.push(['ir', 'domain'], ['irip', 'ipcidr']);
  if (flags.blockAds) want.push(['ads', 'domain'], ['malware', 'domain']);
  if (flags.blockPorn) want.push(['nsfw', 'domain']);
  if (!want.length) return [];

  const L = ['rule-providers:'];
  for (const [name, behavior] of want) {
    L.push(`  ${name}:`);
    L.push('    type: http');
    L.push(`    behavior: ${behavior}`);
    L.push('    format: text');
    L.push('    interval: 86400');
    L.push(`    url: ${quote(PROVIDERS[name]!)}`);
    L.push(`    path: ./ruleset/${name}.txt`);
  }
  return L;
}

function rules(flags: ClashInput['flags']): string[] {
  const out: string[] = ['GEOIP,private,DIRECT,no-resolve'];
  if (flags.blockAds) out.push('RULE-SET,ads,REJECT', 'RULE-SET,malware,REJECT');
  if (flags.blockPorn) out.push('RULE-SET,nsfw,REJECT');
  if (flags.bypassIran) out.push('RULE-SET,ir,DIRECT', 'RULE-SET,irip,DIRECT,no-resolve', 'GEOIP,IR,DIRECT,no-resolve');

  // قواعد سفارشی پروفایل — با سینتکس خام mihomo.
  const custom = (lines: string[] | undefined, policy: string) => {
    if (!lines?.length) return;
    const domains: string[] = [];
    const ips: string[] = [];
    for (const l of lines) {
      if (l.startsWith('ip:')) ips.push(l.slice(3).trim());
      else domains.push(l);
    }
    for (const d of domains) out.push(`DOMAIN-SUFFIX,${d},${policy}`);
    for (const ip of ips) out.push(`IP-CIDR,${ip},${policy},no-resolve`);
  };
  custom(flags.direct, 'DIRECT');
  custom(flags.block, 'REJECT');
  custom(flags.proxy, quote('✅ انتخاب'));

  // دامنه‌های WARP — گروهش پایین‌تر تعریف می‌شود.
  if (flags.warp && flags.warp.sites.length) {
    for (const d of flags.warp.sites) out.push(`DOMAIN-SUFFIX,${d},${quote('🟢 WARP')}`);
  }

  out.push(`MATCH,${quote('✅ انتخاب')}`);
  return out;
}

/**
 * رشته را برای YAML امن می‌کند.
 * همیشه نقل‌قول دوگانه می‌گذاریم (به‌جای منطق «کِی لازم است») چون هزینه‌اش صفر
 * است و هر کاراکتر خاصی — از `:` و `#` تا ایموجی و فارسی — بی‌خطر می‌شود.
 */
function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}
