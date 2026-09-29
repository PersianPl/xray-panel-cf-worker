/**
 * پارس آدرس/پورت مشترک VLESS/VMess/Trojan.
 *
 * هر سه از یک `AddressParser` در v2ray استفاده می‌کنند ولی با **دو تفاوت** که
 * اگر یکی‌شان جا بیفتد، بایت‌ها روی سیم بی‌سر‌و‌صدا خراب می‌شوند:
 *
 * ۱) نگاشت بایتِ نوع آدرس:
 *   • VLESS/VMess → `1=IPv4 · 2=domain · 3=IPv6`
 *   • Trojan      → `1=IPv4 · 3=domain · 4=IPv6`
 *
 * ۲) ترتیب پورت و آدرس:
 *   • VLESS/VMess → `protocol.PortThenAddress()` دارند → `port(2BE) | atype | addr`
 *   • Trojan      → این گزینه را **ندارد** → `portLastAddressParser` →
 *                    `atype | addr | port(2BE)`
 *
 * (منابع: `proxy/vless/encoding/encoding.go` و `proxy/vmess/encoding/encoding.go`
 * هر دو `protocol.PortThenAddress()` را پاس می‌دهند؛ `proxy/trojan/protocol.go`
 * نمی‌دهد، و `common/protocol/address.go:74` بر همان اساس
 * `portFirstAddressParser` یا `portLastAddressParser` برمی‌گرداند.)
 *
 * پس هر دو تفاوت داخل `AddrMap` هستند تا خواننده و نویسنده نتوانند روی یک
 * قالبِ غلطِ *مشترک* توافق کنند — دقیقاً همان اشتباهی که تست واحد نمی‌گیرد.
 */
import type { Target } from './types';

/** نگاشت بایت نوع آدرس + ترتیب پورت. */
export interface AddrMap {
  ipv4: number;
  domain: number;
  ipv6: number;
  /** آیا پورت **قبل** از آدرس می‌آید (`PortThenAddress` در v2ray). */
  portFirst: boolean;
}

/** نگاشت VLESS و VMess: نوع‌های ۱/۲/۳ و پورت اول. */
export const XRAY_ADDR: AddrMap = { ipv4: 1, domain: 2, ipv6: 3, portFirst: true };

export function parseTarget(b: Uint8Array, off: number, map: AddrMap = XRAY_ADDR): { target: Target; next: number } | null {
  let p = off;
  let port = 0;

  if (map.portFirst) {
    if (p + 2 > b.length) return null;
    port = (b[p]! << 8) | b[p + 1]!;
    p += 2;
  }

  if (p + 1 > b.length) return null;
  const atype = b[p]!;
  p += 1;
  let host: string;

  if (atype === map.ipv4) {
    if (p + 4 > b.length) return null;
    host = `${b[p]}.${b[p + 1]}.${b[p + 2]}.${b[p + 3]}`;
    p += 4;
  } else if (atype === map.domain) {
    if (p + 1 > b.length) return null;
    const len = b[p]!;
    if (len === 0) return null;
    p += 1;
    if (p + len > b.length) return null;
    host = new TextDecoder().decode(b.subarray(p, p + len));
    p += len;
  } else if (atype === map.ipv6) {
    if (p + 16 > b.length) return null;
    host = formatIPv6(b.subarray(p, p + 16));
    p += 16;
  } else {
    return null;
  }

  if (!map.portFirst) {
    if (p + 2 > b.length) return null;
    port = (b[p]! << 8) | b[p + 1]!;
    p += 2;
  }

  return { target: { host, port }, next: p };
}

/**
 * ۱۶ بایت را به فرم متعارف RFC 5952 درمی‌آورد: هگز کوچک، بدون صفر ابتدایی،
 * و بلندترین دنباله‌ی ≥۲ گروه صفر با `::` (در تساوی، چپ‌ترین).
 * فرم فشرده لازم است تا لاگ/UI و مقایسه‌ی رشته‌ای با ورودی کاربر جور بیاید.
 */
export function formatIPv6(b: Uint8Array): string {
  const w: number[] = [];
  for (let i = 0; i < 8; i++) w.push((b[i * 2]! << 8) | b[i * 2 + 1]!);

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (w[i] === 0) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return w.map((x) => x.toString(16)).join(':');

  const head = w.slice(0, bestStart).map((x) => x.toString(16)).join(':');
  const tail = w.slice(bestStart + bestLen).map((x) => x.toString(16)).join(':');
  return `${head}::${tail}`;
}

/** ۴ بایت IPv4 یا null. */
export function parseIPv4(host: string): Uint8Array | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const s = parts[i]!;
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    out[i] = v;
  }
  return out;
}

/** ۱۶ بایت IPv6 (با پشتیبانی «::» و دنباله‌ی IPv4) یا null. */
export function parseIPv6(host: string): Uint8Array | null {
  let s = host.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('%')) s = s.slice(0, s.indexOf('%'));
  if (!s.includes(':')) return null;

  const dbl = s.indexOf('::');
  if (dbl !== s.lastIndexOf('::')) return null;

  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const items = part.split(':');
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.includes('.')) {
        // دنباله‌ی IPv4 فقط در آخرین گروه مجاز است
        if (i !== items.length - 1) return null;
        const v4 = parseIPv4(it);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(it)) return null;
      out.push(parseInt(it, 16));
    }
    return out;
  };

  let head: number[] | null;
  let tail: number[] | null;
  if (dbl >= 0) {
    head = groups(s.slice(0, dbl));
    tail = groups(s.slice(dbl + 2));
    if (!head || !tail || head.length + tail.length > 8) return null;
  } else {
    head = groups(s);
    tail = [];
    if (!head || head.length !== 8) return null;
  }

  const words = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (words[i]! >> 8) & 0xff;
    out[i * 2 + 1] = words[i]! & 0xff;
  }
  return out;
}

interface AddrWriter {
  u16(v: number): void;
  byte(v: number): void;
  write(b: Uint8Array): void;
}

/** آدرس را به بایت‌های پروتکل می‌نویسد (برای رله‌ی Trojan و زنجیره). */
export function writeTarget(w: AddrWriter, host: string, port: number, map: AddrMap = XRAY_ADDR): void {
  if (map.portFirst) w.u16(port);
  const h = host.trim();

  const v4 = parseIPv4(h);
  if (v4) {
    w.byte(map.ipv4);
    w.write(v4);
  } else {
    const v6 = parseIPv6(h);
    if (v6) {
      w.byte(map.ipv6);
      w.write(v6);
    } else {
      const d = new TextEncoder().encode(h);
      w.byte(map.domain);
      w.byte(d.length);
      w.write(d);
    }
  }

  if (!map.portFirst) w.u16(port);
}
