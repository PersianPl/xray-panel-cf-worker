/**
 * تست X25519 (بردارهای آزمون رسمی RFC 7748) و WARP.
 */
import { describe, expect, it } from 'vitest';
import { scalarMult, publicKeyFrom, generatePrivateKey, fromHex, toHex } from '../src/lib/x25519';
import { parseEndpoint, parseIdentity, warpRuntime, wireguardConf } from '../src/lib/warp';
import { Settings } from '../src/lib/settings';

// RFC 7748 §5.1 — vector 1
const RFC1_IN = fromHex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4');
const RFC1_U = fromHex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c');
const RFC1_OUT = 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552';
// RFC 7748 §5.1 — vector 2
const RFC2_IN = fromHex('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d');
const RFC2_U = fromHex('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493');
const RFC2_OUT = '95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957';

describe('x25519 (RFC 7748)', () => {
  it('بردار آزمون ۱ درست است', () => {
    expect(toHex(scalarMult(RFC1_IN, RFC1_U))).toBe(RFC1_OUT);
  });
  it('بردار آزمون ۲ درست است', () => {
    expect(toHex(scalarMult(RFC2_IN, RFC2_U))).toBe(RFC2_OUT);
  });
  it('کلید خصوصیِ تصادفی → کلید عمومی ۳۲ بایتی (برابر ضرب در نقطه‌ی پایه)', () => {
    const priv = generatePrivateKey();
    expect(priv.length).toBe(32);
    const pub = publicKeyFrom(priv);
    expect(pub.length).toBe(32);
    const base9 = new Uint8Array(32);
    base9[0] = 9;
    expect(toHex(scalarMult(priv, base9))).toBe(toHex(pub));
    expect(pub.some((b) => b !== 0)).toBe(true);
  });
  it('کلید خصوصی پایدار: همان کلید → همان کلید عمومی', () => {
    const priv = fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    expect(toHex(publicKeyFrom(priv))).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  });
});

const ID = {
  priv: 'a'.repeat(64),
  v4: '172.16.0.2/32',
  v6: '2606:4700:110:8888:9d:b01c:1c28:5d02/128',
  peer: 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wSfVOs=',
  endpoint: '162.159.193.10:2408',
  reserved: [1, 2, 3],
  created: 1700000000,
};

describe('warp', () => {
  it('endpoint استاندارد و IPv6 را پارس می‌کند', () => {
    expect(parseEndpoint('162.159.193.10:2408')).toEqual({ host: '162.159.193.10', port: 2408 });
    expect(parseEndpoint('[2606:4700::]:500')).toEqual({ host: '2606:4700::', port: 500 });
    expect(parseEndpoint('garbage')).toEqual({ host: 'engage.cloudflareclient.com', port: 2408 });
  });
  it('هویت معتبر/نامعتبر', () => {
    expect(parseIdentity(JSON.stringify(ID))?.priv).toBe(ID.priv);
    expect(parseIdentity('')).toBeNull();
    expect(parseIdentity('not-json')).toBeNull();
    expect(parseIdentity('{"priv":"short"}')).toBeNull();
  });
  it('warpRuntime فقط با فعال+هویت کار می‌کند', () => {
    const mk = (o: Record<string, string>) => new Settings(new Map(Object.entries(o)));
    expect(warpRuntime(mk({ warp_enabled: '0', warp_identity: JSON.stringify(ID) }))).toBeNull();
    expect(warpRuntime(mk({ warp_enabled: '1' }))).toBeNull();
    const rt = warpRuntime(mk({ warp_enabled: '1', warp_identity: JSON.stringify(ID), warp_sites: 'a.com\nb.com', warp_mode: 'chain' }));
    expect(rt?.mode).toBe('chain');
    expect(rt?.sites).toEqual(['a.com', 'b.com']);
  });
  it('فایل وایرگارد کامل است', () => {
    const conf = wireguardConf(ID);
    expect(conf).toContain('PrivateKey = ' + ID.priv);
    expect(conf).toContain('PublicKey = ' + ID.peer);
    expect(conf).toContain('Endpoint = 162.159.193.10:2408');
    expect(conf).toContain('Address = 172.16.0.2/32');
  });
});
