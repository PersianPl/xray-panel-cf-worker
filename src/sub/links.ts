/**
 * ساخت لینک کانفیگ (vless:// · vmess:// · trojan:// · ss://).
 *
 * قالب‌ها از خود کلاینت‌ها گرفته شده‌اند:
 *   • VLESS/Trojan → URI با query (استاندارد «VMessAEAD/VLESS URI»)
 *   • VMess        → JSON بیس‌۶۴ (نسخه‌ی ۲، همان چیزی که v2rayN تولید می‌کند)
 *
 * محدودیت واقعی Workers که در همه‌ی این‌ها اثر دارد: CF خودش TLS را terminate
 * می‌کند، پس `security` فقط `tls` (یا `none` روی پورت HTTP با دامنه‌ی شخصی)
 * است — REALITY/XTLS ممکن نیست و اصلاً تولید نمی‌شود.
 */
import { b64encode, b64urlencode } from '../lib/crypto';
import { HTTP_PORTS, type GenOpts, type Protocol, type Transport } from '../types';

/** هرچه برای ساخت یک لینک لازم است. */
export interface LinkSpec {
  protocol: Protocol;
  transport: Transport;
  /** آدرسی که کلاینت به آن وصل می‌شود (دامنه‌ی Worker، نود، IP تمیز یا CDN). */
  address: string;
  port: number;
  /** UUID یا رمز. */
  auth: string;
  /** مسیر WS/HTTPUpgrade/XHTTP. */
  path: string;
  /** هدر Host؛ اگر خالی باشد از `sni` یا `address` پر می‌شود. */
  host: string;
  sni: string;
  /** نامی که در کلاینت دیده می‌شود. */
  remark: string;
  /** early-data (`?ed=`) — صفر یعنی خاموش. */
  maxEarlyData: number;
  /** فقط VMess. */
  vmessSecurity?: string;
  /** فقط Shadowsocks. */
  ssMethod?: string;
  opts?: GenOpts;
}

/** آیا این پورت بدون TLS است؟ */
export function isPlainPort(port: number): boolean {
  return (HTTP_PORTS as readonly number[]).includes(port);
}

/** نام مسیر با early-data. */
function pathWithEd(spec: LinkSpec): string {
  const p = spec.path.startsWith('/') ? spec.path : `/${spec.path}`;
  if (spec.transport === 'ws' && spec.maxEarlyData > 0) {
    return `${p}${p.includes('?') ? '&' : '?'}ed=${spec.maxEarlyData}`;
  }
  return p;
}

/** پارامترهای مشترک transport/TLS در URI. */
function commonParams(spec: LinkSpec): URLSearchParams {
  const q = new URLSearchParams();
  const o = spec.opts ?? {};
  const tls = !isPlainPort(spec.port);
  const host = spec.host || spec.sni || spec.address;

  q.set('type', spec.transport === 'httpupgrade' ? 'httpupgrade' : spec.transport);
  q.set('security', tls ? 'tls' : 'none');
  q.set('path', pathWithEd(spec));
  q.set('host', host);

  if (tls) {
    q.set('sni', o.sni || spec.sni || host);
    q.set('fp', o.fingerprint || 'chrome');
    if (o.alpn && o.alpn.length) q.set('alpn', o.alpn.join(','));
    if (o.allowInsecure) q.set('allowInsecure', '1');
  }
  if (spec.transport === 'xhttp') {
    // تنها حالتی که روی Worker کار می‌کند: پاسخ یک‌جریانه.
    q.set('mode', 'stream-one');
  }
  return q;
}

export function vlessLink(spec: LinkSpec): string {
  const q = commonParams(spec);
  // Worker پشت CF است و XTLS/REALITY ندارد، پس flow همیشه خالی است.
  q.set('encryption', 'none');
  return `vless://${spec.auth}@${hostPart(spec.address)}:${spec.port}?${q.toString()}#${encodeURIComponent(spec.remark)}`;
}

export function trojanLink(spec: LinkSpec): string {
  const q = commonParams(spec);
  return `trojan://${encodeURIComponent(spec.auth)}@${hostPart(spec.address)}:${spec.port}?${q.toString()}#${encodeURIComponent(spec.remark)}`;
}

/**
 * VMess نسخه‌ی ۲: JSON بیس‌۶۴. کلیدها **رشته‌اند** (نه عدد) چون بعضی کلاینت‌ها
 * روی نوع سخت‌گیرند و v2rayN هم همین را تولید می‌کند.
 */
export function vmessLink(spec: LinkSpec): string {
  const o = spec.opts ?? {};
  const tls = !isPlainPort(spec.port);
  const host = spec.host || spec.sni || spec.address;
  const obj: Record<string, string> = {
    v: '2',
    ps: spec.remark,
    add: spec.address,
    port: String(spec.port),
    id: spec.auth,
    aid: '0',
    scy: spec.vmessSecurity || 'auto',
    net: spec.transport === 'httpupgrade' ? 'httpupgrade' : spec.transport,
    type: 'none',
    host,
    path: pathWithEd(spec),
    tls: tls ? 'tls' : '',
    sni: tls ? o.sni || spec.sni || host : '',
    alpn: tls && o.alpn ? o.alpn.join(',') : '',
    fp: tls ? o.fingerprint || 'chrome' : '',
  };
  return `vmess://${b64encode(JSON.stringify(obj))}`;
}

/** Shadowsocks — قالب SIP002. */
export function ssLink(spec: LinkSpec): string {
  const method = spec.ssMethod || 'aes-128-gcm';
  // base64url، نه base64: خروجی استاندارد می‌تواند `/` داشته باشد و آن‌وقت پارسر
  // URI بخش authority را همان‌جا می‌بندد و لینک بی‌مصرف می‌شود.
  const userinfo = b64urlencode(`${method}:${spec.auth}`);
  const q = new URLSearchParams();
  const tls = !isPlainPort(spec.port);
  const host = spec.host || spec.sni || spec.address;
  q.set('type', spec.transport === 'httpupgrade' ? 'httpupgrade' : spec.transport);
  q.set('path', pathWithEd(spec));
  q.set('host', host);
  if (tls) {
    q.set('security', 'tls');
    q.set('sni', spec.opts?.sni || spec.sni || host);
  }
  return `ss://${userinfo}@${hostPart(spec.address)}:${spec.port}?${q.toString()}#${encodeURIComponent(spec.remark)}`;
}

/** IPv6 باید داخل براکت بیاید وگرنه پارس URI می‌شکند. */
function hostPart(address: string): string {
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
}

/** لینک را بر اساس پروتکل می‌سازد. */
export function buildLink(spec: LinkSpec): string {
  switch (spec.protocol) {
    case 'vless':
      return vlessLink(spec);
    case 'vmess':
      return vmessLink(spec);
    case 'trojan':
      return trojanLink(spec);
    case 'shadowsocks':
      return ssLink(spec);
  }
}
