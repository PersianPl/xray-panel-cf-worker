/**
 * ChaCha20-Poly1305 در برابر بردارهای رسمی RFC 8439 و node:crypto.
 */
import { describe, expect, it } from 'vitest';
import { chacha20, poly1305, chacha20poly1305Seal, chacha20poly1305Open } from '../src/lib/chacha20poly1305';
import { hex, unhex } from '../src/lib/hexutil';
import { utf8 } from '../src/lib/bytes';

describe('chacha20', () => {
  it('RFC 8439 §2.4.2 keystream/ciphertext', () => {
    const key = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const nonce = unhex('000000000000004a00000000');
    const pt = utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const ct = chacha20(key, nonce, pt, 1);
    expect(hex(ct).slice(0, 64)).toBe('6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b');
  });
});

describe('poly1305', () => {
  it('RFC 8439 §2.5.2', () => {
    const key = unhex('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b');
    const msg = utf8('Cryptographic Forum Research Group');
    expect(hex(poly1305(key, msg))).toBe('a8061dc1305136c6c22b8baf0c0127a9');
  });

  it('پیام کوتاه‌تر از ۱۶ بایت و خالی', () => {
    const key = unhex('0100000000000000000000000000000000000000000000000000000000000000');
    expect(poly1305(key, new Uint8Array(0))).toHaveLength(16);
    expect(poly1305(key, utf8('ab'))).toHaveLength(16);
  });
});

describe('chacha20-poly1305 AEAD', () => {
  it('RFC 8439 §2.8.2 seal', () => {
    const key = unhex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = unhex('070000004041424344454647');
    const aad = unhex('50515253c0c1c2c3c4c5c6c7');
    const pt = utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const out = chacha20poly1305Seal(key, nonce, pt, aad);
    expect(hex(out).slice(0, 64)).toBe('d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6');
    expect(hex(out.subarray(out.length - 16))).toBe('1ae10b594f09e26a7e902ecbd0600691');
  });

  it('roundtrip + رد کردن tag دست‌خورده', () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const pt = crypto.getRandomValues(new Uint8Array(300));
    const sealed = chacha20poly1305Seal(key, nonce, pt);
    expect(hex(chacha20poly1305Open(key, nonce, sealed)!)).toBe(hex(pt));
    sealed[sealed.length - 1]! ^= 1;
    expect(chacha20poly1305Open(key, nonce, sealed)).toBeNull();
  });

  it('هم‌خوان با node:crypto روی طول‌های مرزی', async () => {
    const { createCipheriv } = await import('node:crypto');
    const key = unhex('404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f');
    const nonce = unhex('101112131415161718191a1b');
    for (const n of [0, 1, 15, 16, 17, 63, 64, 65, 2048]) {
      const pt = new Uint8Array(n);
      for (let i = 0; i < n; i++) pt[i] = (i * 5 + 9) & 0xff;
      const aad = utf8(`aad-${n}`);
      const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      c.setAAD(aad, { plaintextLength: n });
      const want = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
      expect(hex(chacha20poly1305Seal(key, nonce, pt, aad)), `n=${n}`).toBe(want.toString('hex'));
    }
  });

  it('کلید VMess = MD5(k)+MD5(MD5(k)) — طول ۳۲ و قابل استفاده', async () => {
    const { md5 } = await import('../src/lib/md5');
    const reqKey = crypto.getRandomValues(new Uint8Array(16));
    const a = md5(reqKey);
    const b = md5(a);
    const key = new Uint8Array(32);
    key.set(a);
    key.set(b, 16);
    const nonce = new Uint8Array(12);
    const sealed = chacha20poly1305Seal(key, nonce, utf8('hello vmess'));
    expect(hex(chacha20poly1305Open(key, nonce, sealed)!)).toBe(hex(utf8('hello vmess')));
  });
});
