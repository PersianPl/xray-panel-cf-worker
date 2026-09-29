/**
 * تست هش‌های خالص: MD5، SHA-256 همگام، HMAC، و جریانی بودن SHAKE128.
 * SHA-256/HMAC مستقیماً با WebCrypto مقایسه می‌شوند تا هیچ اختلافی ممکن نباشد.
 */
import { describe, expect, it } from 'vitest';
import { md5 } from '../src/lib/md5';
import { sha224, sha256, hmacSha256, hmacWith } from '../src/lib/sha256';
import { shake128, Keccak } from '../src/lib/keccak';
import { hex, unhex } from '../src/lib/hexutil';
import { ab, utf8 } from '../src/lib/bytes';

describe('md5', () => {
  it('RFC 1321 vectors', () => {
    expect(hex(md5(utf8('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(utf8('a')))).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(hex(md5(utf8('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(hex(md5(utf8('message digest')))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(hex(md5(utf8('abcdefghijklmnopqrstuvwxyz')))).toBe('c3fcd3d76192e4007dfb496cca67e13b');
    expect(hex(md5(utf8('12345678901234567890123456789012345678901234567890123456789012345678901234567890')))).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
  });

  it('هم‌خوانی با node:crypto روی مرزهای پدینگ', async () => {
    const { createHash } = await import('node:crypto');
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i * 11 + 5) & 0xff;
      const want = createHash('md5').update(data).digest('hex');
      expect(hex(md5(data)), `n=${n}`).toBe(want);
    }
  });

  it('cmdKey وِمِس = MD5(uuid || magic)', async () => {
    const { createHash } = await import('node:crypto');
    const uuid = unhex('b831381d63244d53ad4f8cda48b30811');
    const magic = utf8('c48619fe-8f02-49e0-b9e9-edf763e17e21');
    const buf = new Uint8Array(uuid.length + magic.length);
    buf.set(uuid);
    buf.set(magic, uuid.length);
    const want = createHash('md5').update(buf).digest('hex');
    expect(hex(md5(buf))).toBe(want);
  });
});

describe('sha256 (sync) در برابر WebCrypto', () => {
  it('هم‌خوانی روی طول‌های مختلف', async () => {
    for (const n of [0, 1, 3, 31, 32, 55, 56, 57, 63, 64, 65, 100, 191, 192, 1000]) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i * 7 + 3) & 0xff;
      const want = new Uint8Array(await crypto.subtle.digest('SHA-256', ab(data)));
      expect(hex(sha256(data)), `n=${n}`).toBe(hex(want));
    }
  });

  it('HMAC-SHA256 هم‌خوان با WebCrypto (کلید کوتاه/دقیقاً ۶۴/بلند)', async () => {
    for (const kl of [1, 16, 32, 63, 64, 65, 100]) {
      const key = new Uint8Array(kl);
      for (let i = 0; i < kl; i++) key[i] = (i * 13 + 1) & 0xff;
      const msg = utf8('PersianPl-Panel VMess AEAD KDF probe');
      const ck = await crypto.subtle.importKey('raw', ab(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const want = new Uint8Array(await crypto.subtle.sign('HMAC', ck, ab(msg)));
      expect(hex(hmacSha256(key, msg)), `keylen=${kl}`).toBe(hex(want));
    }
  });

  it('hmacWith با هش پایه = HMAC معمولی', () => {
    const key = utf8('k');
    const msg = utf8('m');
    expect(hex(hmacWith(sha256, key, msg))).toBe(hex(hmacSha256(key, msg)));
  });
});

describe('sha224 (لازمِ Trojan)', () => {
  it('بردارهای FIPS 180-4', () => {
    expect(hex(sha224(utf8('')))).toBe('d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f');
    expect(hex(sha224(utf8('abc')))).toBe('23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7');
    expect(hex(sha224(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '75388b16512776cc5dba5da1fd890150b0c6455cb4f58b1952522525',
    );
  });

  it('طول خروجی ۲۸ بایت و هگزش ۵۶ کاراکتر (اندازه‌ی هش Trojan)', () => {
    const h = sha224(utf8('password'));
    expect(h).toHaveLength(28);
    expect(hex(h)).toHaveLength(56);
  });

  it('هم‌خوانی با node:crypto روی مرزهای پدینگ', async () => {
    const { createHash } = await import('node:crypto');
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i * 17 + 9) & 0xff;
      const want = createHash('sha224').update(data).digest('hex');
      expect(hex(sha224(data)), `n=${n}`).toBe(want);
    }
  });

  it('sha256 با اضافه‌شدن sha224 دست‌نخورده مانده', () => {
    expect(hex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('shake128 جریانی', () => {
  it('read(2)×16 = read(32)', () => {
    const seed = utf8('abc');
    const whole = hex(shake128(seed).read(32));
    const g = shake128(seed);
    let s = '';
    for (let i = 0; i < 16; i++) s += hex(g.read(2));
    expect(s).toBe(whole);
  });

  it('عبور از مرز rate (۱۶۸ بایت) درست است', () => {
    const seed = utf8('vmess-body-iv');
    const whole = hex(shake128(seed).read(400));
    const g = shake128(seed);
    let s = '';
    while (s.length < 800) s += hex(g.read(7));
    expect(s.slice(0, 800)).toBe(whole);
  });

  it('SHAKE128("") = بردار رسمی', () => {
    const k = new Keccak(168, 0x1f);
    k.update(new Uint8Array(0));
    k.finish();
    expect(hex(k.read(32))).toBe('7f9c2ba4e88f827d616045507605853ed73b8093f6efbc88eb1a6eacfa66ef26');
  });

  it('SHAKE128 با seed بلندتر از rate', () => {
    const seed = new Uint8Array(200);
    for (let i = 0; i < 200; i++) seed[i] = i & 0xff;
    const out = shake128(seed).read(16);
    expect(out).toHaveLength(16);
  });
});
