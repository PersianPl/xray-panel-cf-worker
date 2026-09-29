/**
 * VLESS v0 — پارس درخواست و ساخت پاسخ.
 * درخواست: ver(1)=0 | uuid(16) | addonsLen(1)=0 | addons(0) | cmd(1) | port(2)+addr
 * پاسخ: ver(1)=0 | addonsLen(1)=0
 */
import { parseTarget } from './target';
import type { ParsedRequest } from './types';

const CMD_TCP = 1;
const CMD_UDP = 2;

export function parseVlessRequest(b: Uint8Array, validate: (uuid: Uint8Array) => boolean): ParsedRequest | null {
  if (b.length < 1 + 16 + 1 + 1 + 3) return null;
  if (b[0] !== 0) return null;
  const uuid = b.subarray(1, 17);
  if (!validate(uuid)) return null;
  let p = 17;
  const addonsLen = b[p]!;
  p += 1 + addonsLen;
  if (p + 1 > b.length) return null;
  const cmd = b[p]!;
  p += 1;
  if (cmd !== CMD_TCP && cmd !== CMD_UDP) return null;
  const t = parseTarget(b, p);
  if (!t) return null;
  return {
    proto: 'vless',
    target: t.target,
    responseHeader: new Uint8Array([0, 0]),
    rest: b.subarray(t.next),
    udp: cmd === CMD_UDP,
  };
}
