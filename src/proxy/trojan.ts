/**
 * Trojan — پارس درخواست و ساخت درخواست برای رله‌ی بیرونی.
 *
 * قالب سیم (تأییدشده روی `_audit/v2ray-src/proxy/trojan/protocol.go`):
 *   `hex(SHA224(password))` (۵۶ بایت اسکی) | CRLF | cmd(1) | addr | CRLF | payload
 *
 * `addr` **دو تفاوت** با VLESS/VMess دارد و هر دو در `TROJAN_ADDR` کدگذاری شده:
 *   • نگاشت atype: `1=IPv4 · 3=domain · 4=IPv6` (در VLESS/VMess: `1/2/3`)
 *   • ترتیب: `atype | address | port(2BE)` — یعنی پورت **آخر**. چون
 *     `addrParser` در Trojan گزینه‌ی `protocol.PortThenAddress()` را پاس
 *     نمی‌دهد، `NewAddressParser` یک `portLastAddressParser` برمی‌گرداند
 *     (`common/protocol/address.go:74,113`). VLESS/VMess آن گزینه را دارند و
 *     پورت‌شان اول می‌آید.
 *
 * cmd: 1=TCP · 3=UDP.
 *
 * پاسخ **هیچ هدری ندارد** — سرور مستقیم بایت‌های مقصد را برمی‌گرداند
 * (`handleConnection` با `buf.NewWriter(conn)` می‌نویسد، بدون پیشوند).
 */
import { parseTarget, writeTarget, type AddrMap } from './target';
import { concat } from '../lib/bytes';
import { sha224 } from '../lib/sha256';
import { hex } from '../lib/hexutil';
import type { ParsedRequest } from './types';

const CMD_TCP = 0x01;
const CMD_UDP = 0x03;

/** نگاشت نوع آدرس + ترتیب پورت، مخصوص Trojan. */
export const TROJAN_ADDR: AddrMap = { ipv4: 1, domain: 3, ipv6: 4, portFirst: false };

/** کوچک‌ترین درخواست ممکن: هش + CRLF + cmd + (atype+IPv4+port) + CRLF. */
const MIN_REQUEST = 56 + 2 + 1 + (1 + 4 + 2) + 2;

/** کلید Trojan یک رمز: هگزِ SHA-224 (۵۶ کاراکتر). */
export function trojanKey(password: string): string {
  return hex(sha224(new TextEncoder().encode(password)));
}

export function parseTrojanRequest(b: Uint8Array, validate: (hashHex: string) => boolean): ParsedRequest | null {
  if (b.length < MIN_REQUEST) return null;
  const hash = new TextDecoder().decode(b.subarray(0, 56)).toLowerCase();
  if (!/^[0-9a-f]{56}$/.test(hash)) return null;
  if (b[56] !== 0x0d || b[57] !== 0x0a) return null;
  if (!validate(hash)) return null;
  const cmd = b[58]!;
  if (cmd !== CMD_TCP && cmd !== CMD_UDP) return null;
  const t = parseTarget(b, 59, TROJAN_ADDR);
  if (!t) return null;
  let p = t.next;
  if (p + 2 > b.length || b[p] !== 0x0d || b[p + 1] !== 0x0a) return null;
  p += 2;
  return {
    proto: 'trojan',
    target: t.target,
    responseHeader: null,
    rest: b.subarray(p),
    udp: cmd === CMD_UDP,
  };
}

/** درخواست Trojan برای وقتی خودمان به یک رله‌ی Trojan بیرونی وصل می‌شویم. */
export function buildTrojanRequest(passwordHashHex: string, targetBytes: Uint8Array, cmd: number): Uint8Array {
  const enc = new TextEncoder();
  return concat(enc.encode(passwordHashHex), new Uint8Array([0x0d, 0x0a, cmd]), targetBytes, new Uint8Array([0x0d, 0x0a]));
}

/** بایت‌های آدرس با نگاشت Trojan (برای ساخت درخواستِ رله). */
export function trojanTargetBytes(w: { u16(v: number): void; byte(v: number): void; write(b: Uint8Array): void }, host: string, port: number): void {
  writeTarget(w, host, port, TROJAN_ADDR);
}
