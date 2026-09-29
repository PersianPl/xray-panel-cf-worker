/**
 * تست AES-128 خالص در برابر بردارهای رسمی FIPS-197 و NIST SP 800-38A
 * + Keccak/SHAKE در برابر بردار رسمی + SHA3-224 (هش Trojan).
 */
import { describe, expect, it } from 'vitest';
import { aes128, aes128cfbDecrypt, aes128cfbEncrypt } from '../src/lib/aes';
import { shake128, sha3_224hex } from '../src/lib/keccak';
import { crc32, u64be } from '../src/lib/bytes';
import { hex, unhex } from '../src/lib/hexutil';


describe('aes128 (pure)', () => {
  it('FIPS-197 C.1: encrypt', () => {
    const a = aes128(unhex('000102030405060708090a0b0c0d0e0f'));
    const block = new Uint8Array(16);
    block.set(unhex('00112233445566778899aabbccddeeff'));
    a.encryptBlock(block, 0);
    expect(hex(block)).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
  });

  it('FIPS-197 C.1: decrypt', () => {
    const a = aes128(unhex('000102030405060708090a0b0c0d0e0f'));
    const block = unhex('69c4e0d86a7b0430d8cdb78070b4c55a');
    a.decryptBlock(block, 0);
    expect(hex(block)).toBe('00112233445566778899aabbccddeeff');
  });

  it('NIST SP 800-38A CFB128-AES128: full-block encrypt', () => {
    // IV=000102...، plaintext یک بلوک (۶۳۲۵... نمی‌گنجد؛ بردار ۴ بلوکی است — بلوک اول)
    const a = aes128(unhex('2b7e151628aed2a6abf7158809cf4f3c'));
    const iv = unhex('000102030405060708090a0b0c0d0e0f');
    const pt = unhex('6bc1bee22e409f96e93d7e117393172a');
    const ct = aes128cfbEncrypt(a, iv, pt);
    expect(hex(ct)).toBe('3b3fd92eb72dad20333449f8e83cfb4a');
  });

  it('CFB roundtrip (short header)', () => {
    const a = aes128(crypto.getRandomValues(new Uint8Array(16)));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const pt = crypto.getRandomValues(new Uint8Array(4));
    const ct = aes128cfbEncrypt(a, iv, pt);
    const back = aes128cfbDecrypt(a, iv, ct);
    expect(hex(back)).toBe(hex(pt));
  });
});

describe('keccak/shake', () => {
  it('SHA3-224 empty = official vector', () => {
    expect(sha3_224hex(new Uint8Array(0))).toBe('6b4e03423667dbb73b6e15454f0eb1abd4597f9a1b078e3f5b5a6bc7');
  });

  it('SHA3-224 "abc"', () => {
    expect(sha3_224hex(new TextEncoder().encode('abc'))).toBe(
      'e642824c3f8cf24ad09234ee7d3c766fc9a3a5168d0c94ad73b46fdf',
    );
  });

  it('SHAKE128("abc", 32) official', () => {
    const g = shake128(new TextEncoder().encode('abc'));
    expect(hex(g.read(32))).toBe(
      '5881092dd818bf5cf8a3ddb793fbcba74097d5c526a6d35f97b83351940f2cc8',
    );
  });
});

describe('crc32', () => {
  it('IEEE check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('u64be', () => {
    expect(hex(u64be(1720000000))).toBe('0000000066851e00'.slice(0, 16));
  });
});
