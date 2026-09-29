/**
 * VMess AEAD — بردار طلایی KDF و رفت‌وبرگشت کامل هدر/بادی.
 * بردار KDF مستقیماً از proxy/vmess/aead/kdf_test.go آمده است.
 */
import { describe, expect, it } from 'vitest';
import {
  vmessKDF,
  vmessKDF16,
  vmessCmdKey,
  authIdKey,
  createAuthId,
  tryAuthId,
  fnv1a32,
  buildVmessHeaderPlain,
  parseVmessHeader,
  sealVmessRequest,
  openVmessRequest,
  newVmessSession,
  buildVmessResponseHeader,
  openVmessResponseHeader,
  readChunk,
  writeChunk,
  writeEndChunk,
  maxPayload,
  ChunkStream,
  chachaKeyFrom,
  SEC_AES128_GCM,
  SEC_CHACHA20_POLY1305,
  SEC_NONE,
  CMD_TCP,
  CMD_UDP,
  OPT_CHUNK_STREAM,
  OPT_CHUNK_MASKING,
  OPT_GLOBAL_PADDING,
  OPT_AUTHENTICATED_LENGTH,
  type BodyCodec,
} from '../src/proxy/vmess';
import { hex, unhex } from '../src/lib/hexutil';
import { concat, utf8 } from '../src/lib/bytes';

const UUID = unhex('b831381d63244d53ad4f8cda48b30811');

describe('vmess KDF', () => {
  it('بردار رسمی kdf_test.go', () => {
    const out = vmessKDF(
      utf8('Demo Key for KDF Value Test'),
      'Demo Path for KDF Value Test',
      'Demo Path for KDF Value Test2',
      'Demo Path for KDF Value Test3',
    );
    expect(hex(out)).toBe('53e9d7e1bd7bd25022b71ead07d8a596efc8a845c7888652fd684b4903dc8892');
  });

  it('KDF بدون path = HMAC-SHA256 با کلید "VMess AEAD KDF"', async () => {
    const { hmacSha256 } = await import('../src/lib/sha256');
    const key = utf8('some-key');
    expect(hex(vmessKDF(key))).toBe(hex(hmacSha256(utf8('VMess AEAD KDF'), key)));
  });

  it('KDF16 = ۱۶ بایت اول', () => {
    const k = utf8('k');
    expect(hex(vmessKDF16(k, 'a', 'b'))).toBe(hex(vmessKDF(k, 'a', 'b')).slice(0, 32));
  });

  it('cmdKey = MD5(uuid || magic)', async () => {
    const { createHash } = await import('node:crypto');
    const magic = utf8('c48619fe-8f02-49e0-b9e9-edf763e17e21');
    const buf = new Uint8Array(UUID.length + magic.length);
    buf.set(UUID);
    buf.set(magic, UUID.length);
    expect(hex(vmessCmdKey(UUID))).toBe(createHash('md5').update(buf).digest('hex'));
  });
});

describe('authID', () => {
  it('ساخت و بازکردن با همان کلید', () => {
    const cmdKey = vmessCmdKey(UUID);
    const now = Math.floor(Date.now() / 1000);
    const id = createAuthId(cmdKey, now);
    expect(id).toHaveLength(16);
    expect(tryAuthId(authIdKey(cmdKey), id, now)).toBe(true);
  });

  it('کلید دیگری بازش نمی‌کند', () => {
    const now = Math.floor(Date.now() / 1000);
    const id = createAuthId(vmessCmdKey(UUID), now);
    const other = vmessCmdKey(unhex('00112233445566778899aabbccddeeff'));
    expect(tryAuthId(authIdKey(other), id, now)).toBe(false);
  });

  it('خارج از پنجره‌ی ۱۲۰ ثانیه رد می‌شود', () => {
    const cmdKey = vmessCmdKey(UUID);
    const now = 1_700_000_000;
    const id = createAuthId(cmdKey, now);
    expect(tryAuthId(authIdKey(cmdKey), id, now + 120)).toBe(true);
    expect(tryAuthId(authIdKey(cmdKey), id, now + 121)).toBe(false);
    expect(tryAuthId(authIdKey(cmdKey), id, now - 121)).toBe(false);
  });

  it('یک بیت دست‌خورده = رد شدن CRC', () => {
    const cmdKey = vmessCmdKey(UUID);
    const now = Math.floor(Date.now() / 1000);
    const id = createAuthId(cmdKey, now);
    id[3]! ^= 0x40;
    expect(tryAuthId(authIdKey(cmdKey), id, now)).toBe(false);
  });
});

describe('fnv1a32', () => {
  it('بردارهای شناخته‌شده', () => {
    expect(fnv1a32(new Uint8Array(0))).toBe(0x811c9dc5);
    expect(fnv1a32(utf8('a'))).toBe(0xe40c292c);
    expect(fnv1a32(utf8('foobar'))).toBe(0xbf9cf968);
  });
});

const OPT_FULL = OPT_CHUNK_STREAM | OPT_CHUNK_MASKING | OPT_GLOBAL_PADDING;

function reqOpts(security: number, option: number, command = CMD_TCP, padLen = 0) {
  return {
    reqIV: unhex('000102030405060708090a0b0c0d0e0f'),
    reqKey: unhex('101112131415161718191a1b1c1d1e1f'),
    respV: 0x5a,
    option,
    security,
    command,
    target: { host: 'example.com', port: 443 },
    padLen,
  };
}

describe('هدر درخواست', () => {
  it('ساخت → پارس با همه‌ی انواع آدرس و پدینگ', () => {
    for (const host of ['example.com', '1.2.3.4', '2001:db8:0:0:0:0:0:1']) {
      for (const padLen of [0, 1, 7, 15]) {
        const spec = { ...reqOpts(SEC_AES128_GCM, OPT_FULL), target: { host, port: 8443 }, padLen };
        const h = parseVmessHeader(buildVmessHeaderPlain(spec));
        expect(h, `${host}/${padLen}`).not.toBeNull();
        expect(h!.target.port).toBe(8443);
        expect(h!.option).toBe(OPT_FULL);
        expect(h!.security).toBe(SEC_AES128_GCM);
        expect(h!.respV).toBe(0x5a);
        expect(hex(h!.reqKey)).toBe('101112131415161718191a1b1c1d1e1f');
      }
    }
  });

  it('دامنه درست decode می‌شود و FNV دست‌خورده رد می‌شود', () => {
    const p = buildVmessHeaderPlain(reqOpts(SEC_AES128_GCM, OPT_FULL));
    expect(parseVmessHeader(p)!.target.host).toBe('example.com');
    p[p.length - 1]! ^= 1;
    expect(parseVmessHeader(p)).toBeNull();
  });

  it('security پشتیبانی‌نشده (legacy/zero) رد می‌شود', () => {
    for (const sec of [1, 2, 6, 7]) {
      expect(parseVmessHeader(buildVmessHeaderPlain(reqOpts(sec, OPT_FULL))), `sec=${sec}`).toBeNull();
    }
  });

  it('فرمان ناشناخته رد می‌شود', () => {
    expect(parseVmessHeader(buildVmessHeaderPlain(reqOpts(SEC_AES128_GCM, OPT_FULL, 9)))).toBeNull();
  });

  it('seal → open کامل با AEAD', async () => {
    const cmdKey = vmessCmdKey(UUID);
    const plain = buildVmessHeaderPlain(reqOpts(SEC_AES128_GCM, OPT_FULL, CMD_UDP, 11));
    const wire = await sealVmessRequest(cmdKey, plain);
    const body = utf8('trailing body bytes');
    const r = await openVmessRequest(new Uint8Array([...wire, ...body]), cmdKey);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.consumed).toBe(wire.length);
    expect(r.header.packet).toBe(true);
    expect(r.header.target).toEqual({ host: 'example.com', port: 443 });
  });

  it('بایت‌های ناقص → need-more (بدون خطا)', async () => {
    const cmdKey = vmessCmdKey(UUID);
    const wire = await sealVmessRequest(cmdKey, buildVmessHeaderPlain(reqOpts(SEC_AES128_GCM, OPT_FULL)));
    for (const n of [0, 16, 33, 41, wire.length - 1]) {
      expect((await openVmessRequest(wire.subarray(0, n), cmdKey)).kind, `n=${n}`).toBe('need-more');
    }
  });

  it('cmdKey اشتباه → bad', async () => {
    const wire = await sealVmessRequest(vmessCmdKey(UUID), buildVmessHeaderPlain(reqOpts(SEC_AES128_GCM, OPT_FULL)));
    const other = vmessCmdKey(unhex('ffeeddccbbaa99887766554433221100'));
    const r = await openVmessRequest(wire, other);
    expect(r.kind).toBe('bad');
  });
});

/** دو نشستِ مستقل با یک هدر — یکی نقش «کلاینت» و یکی «سرور» را بازی می‌کند. */
async function pair(security: number, option: number, command = CMD_TCP) {
  const spec = reqOpts(security, option, command);
  const header = parseVmessHeader(buildVmessHeaderPlain(spec))!;
  const server = await newVmessSession(header);
  const client = await newVmessSession(parseVmessHeader(buildVmessHeaderPlain(spec))!);
  return { server, client };
}

/**
 * chunkهای داده را می‌نویسد، همه را می‌خواند، و بعد chunk پایانی را چک می‌کند.
 * دقت: AuthenticationReader وقتی طول = overhead+padding می‌بیند EOF می‌دهد و
 * بدنه‌ی آن chunk خالی را از سیم نمی‌خواند؛ پس فقط سرآیندش مصرف می‌شود.
 */
async function roundtrip(writer: BodyCodec, reader: BodyCodec, payloads: Uint8Array[]): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for (const p of payloads) parts.push(await writeChunk(writer, p));
  const wire = concat(...parts);

  const out: Uint8Array[] = [];
  let off = 0;
  while (off < wire.length) {
    const r = await readChunk(reader, wire, off);
    expect(r.kind, `at off=${off}`).toBe('data');
    if (r.kind !== 'data') break;
    out.push(r.payload.slice(0));
    off += r.consumed;
  }
  expect(off).toBe(wire.length);

  const end = await writeEndChunk(writer);
  expect((await readChunk(reader, end, 0)).kind).toBe('eof');
  return out;
}

const COMBOS: Array<[string, number, number, number]> = [
  ['aes-gcm + mask + padding', SEC_AES128_GCM, OPT_FULL, CMD_TCP],
  ['aes-gcm + mask بدون padding', SEC_AES128_GCM, OPT_CHUNK_STREAM | OPT_CHUNK_MASKING, CMD_TCP],
  ['aes-gcm بدون mask', SEC_AES128_GCM, OPT_CHUNK_STREAM, CMD_TCP],
  ['chacha + mask + padding', SEC_CHACHA20_POLY1305, OPT_FULL, CMD_TCP],
  ['chacha + authLen', SEC_CHACHA20_POLY1305, OPT_FULL | OPT_AUTHENTICATED_LENGTH, CMD_TCP],
  ['aes-gcm + authLen', SEC_AES128_GCM, OPT_FULL | OPT_AUTHENTICATED_LENGTH, CMD_TCP],
  ['aes-gcm + authLen بدون padding', SEC_AES128_GCM, OPT_CHUNK_STREAM | OPT_AUTHENTICATED_LENGTH, CMD_TCP],
  ['none + UDP (packet)', SEC_NONE, OPT_CHUNK_STREAM | OPT_CHUNK_MASKING, CMD_UDP],
  ['none + TCP (plain-stream)', SEC_NONE, OPT_CHUNK_STREAM | OPT_CHUNK_MASKING, CMD_TCP],
  ['none + TCP بدون mask', SEC_NONE, OPT_CHUNK_STREAM, CMD_TCP],
];

describe('فریم‌بندی بادی', () => {
  for (const [name, security, option, command] of COMBOS) {
    it(`رفت‌وبرگشت: ${name}`, async () => {
      const { server, client } = await pair(security, option, command);
      const payloads = [utf8('hello'), new Uint8Array(0), crypto.getRandomValues(new Uint8Array(300)), utf8('پایان')];
      // chunk خالیِ میانی در حالت‌های chunked به‌عنوان EOF خوانده می‌شود؛ حذفش می‌کنیم.
      const usable = payloads.filter((p) => p.length > 0);
      const got = await roundtrip(client.request, server.request, usable);
      expect(got.map(hex)).toEqual(usable.map(hex));
    });

    it(`جهت پاسخ: ${name}`, async () => {
      const { server, client } = await pair(security, option, command);
      const payloads = [crypto.getRandomValues(new Uint8Array(64)), utf8('resp')];
      const got = await roundtrip(server.response, client.response, payloads);
      expect(got.map(hex)).toEqual(payloads.map(hex));
    });
  }

  it('حالت raw (بدون chunkStream) بایت‌ها را دست‌نخورده می‌برد', async () => {
    const { server, client } = await pair(SEC_NONE, 0, CMD_TCP);
    expect(client.request.mode).toBe('raw');
    const data = crypto.getRandomValues(new Uint8Array(500));
    const wire = await writeChunk(client.request, data);
    expect(hex(wire)).toBe(hex(data));
    const r = await readChunk(server.request, wire, 0);
    expect(r.kind).toBe('data');
    if (r.kind === 'data') expect(hex(r.payload)).toBe(hex(data));
  });

  it('حالت‌ها درست انتخاب می‌شوند', async () => {
    expect((await pair(SEC_NONE, OPT_CHUNK_STREAM, CMD_TCP)).client.request.mode).toBe('plain-stream');
    expect((await pair(SEC_NONE, OPT_CHUNK_STREAM, CMD_UDP)).client.request.mode).toBe('aead');
    expect((await pair(SEC_AES128_GCM, OPT_CHUNK_STREAM, CMD_TCP)).client.request.mode).toBe('aead');
    expect((await pair(SEC_AES128_GCM, 0, CMD_TCP)).client.request.mode).toBe('raw');
  });

  it('پدینگ فقط با ماسک روشن فعال می‌شود', async () => {
    const withMask = await pair(SEC_AES128_GCM, OPT_CHUNK_STREAM | OPT_CHUNK_MASKING | OPT_GLOBAL_PADDING);
    expect(withMask.client.request.padding).toBe(true);
    const noMask = await pair(SEC_AES128_GCM, OPT_CHUNK_STREAM | OPT_GLOBAL_PADDING);
    expect(noMask.client.request.padding).toBe(false);
  });

  it('طول فریم با پدینگ بزرگ‌تر از payload+tag است', async () => {
    const { client } = await pair(SEC_AES128_GCM, OPT_FULL);
    const noPad = await pair(SEC_AES128_GCM, OPT_CHUNK_STREAM | OPT_CHUNK_MASKING);
    const a = await writeChunk(client.request, utf8('0123456789'));
    const b = await writeChunk(noPad.client.request, utf8('0123456789'));
    expect(b.length).toBe(2 + 10 + 16);
    expect(a.length).toBeGreaterThanOrEqual(b.length);
    expect(a.length).toBeLessThanOrEqual(b.length + 63);
  });

  it('sizeBytes با authLen برابر ۱۸ است', async () => {
    const { client } = await pair(SEC_AES128_GCM, OPT_FULL | OPT_AUTHENTICATED_LENGTH);
    expect(client.request.sizeBytes).toBe(18);
    expect(client.request.lenAead).not.toBeNull();
  });

  it('AEAD دست‌خورده رد می‌شود', async () => {
    const { server, client } = await pair(SEC_AES128_GCM, OPT_FULL);
    const wire = await writeChunk(client.request, utf8('secret payload'));
    wire[5]! ^= 0x80;
    const r = await readChunk(server.request, wire, 0);
    expect(r.kind).toBe('bad');
  });

  it('nonce برای هر chunk جلو می‌رود (chunkهای یکسان، بایت‌های متفاوت)', async () => {
    const { client } = await pair(SEC_AES128_GCM, OPT_CHUNK_STREAM);
    const a = await writeChunk(client.request, utf8('same'));
    const b = await writeChunk(client.request, utf8('same'));
    expect(hex(a)).not.toBe(hex(b));
  });

  it('maxPayload منطبق با سقف buf.Size است', async () => {
    const full = await pair(SEC_AES128_GCM, OPT_FULL);
    expect(maxPayload(full.client.request)).toBe(2048 - 16 - 2 - 64);
    const authLen = await pair(SEC_AES128_GCM, OPT_CHUNK_STREAM | OPT_AUTHENTICATED_LENGTH);
    expect(maxPayload(authLen.client.request)).toBe(2048 - 16 - 18);
  });

  it('chunk با اندازه‌ی maxPayload کار می‌کند', async () => {
    const { server, client } = await pair(SEC_AES128_GCM, OPT_FULL);
    const n = maxPayload(client.request);
    const data = crypto.getRandomValues(new Uint8Array(n));
    const got = await roundtrip(client.request, server.request, [data]);
    expect(hex(got[0]!)).toBe(hex(data));
  });
});

describe('ChunkStream (بافر تجمعی)', () => {
  it('بایت‌بایت رسیدن داده هم‌گامی SHAKE را نمی‌شکند', async () => {
    const { server, client } = await pair(SEC_AES128_GCM, OPT_FULL);
    const payloads = [utf8('first'), crypto.getRandomValues(new Uint8Array(120)), utf8('third')];
    const parts: number[] = [];
    for (const p of payloads) parts.push(...(await writeChunk(client.request, p)));
    parts.push(...(await writeEndChunk(client.request)));
    const wire = new Uint8Array(parts);

    const cs = new ChunkStream(server.request);
    const got: Uint8Array[] = [];
    for (let i = 0; i < wire.length; i++) {
      cs.push(wire.subarray(i, i + 1));
      const chunks = await cs.drain();
      expect(chunks).not.toBeNull();
      got.push(...chunks!);
    }
    expect(cs.done).toBe(true);
    expect(got.map(hex)).toEqual(payloads.map(hex));
  });

  it('با authLen هم بایت‌بایت درست است', async () => {
    const { server, client } = await pair(SEC_CHACHA20_POLY1305, OPT_FULL | OPT_AUTHENTICATED_LENGTH);
    const payloads = [utf8('a'), utf8('bb'), crypto.getRandomValues(new Uint8Array(90))];
    const parts: number[] = [];
    for (const p of payloads) parts.push(...(await writeChunk(client.request, p)));
    const wire = new Uint8Array(parts);

    const cs = new ChunkStream(server.request);
    const got: Uint8Array[] = [];
    for (let i = 0; i < wire.length; i += 3) {
      cs.push(wire.subarray(i, Math.min(i + 3, wire.length)));
      const chunks = await cs.drain();
      expect(chunks).not.toBeNull();
      got.push(...chunks!);
    }
    expect(got.map(hex)).toEqual(payloads.map(hex));
  });

  it('داده‌ی خراب null برمی‌گرداند', async () => {
    const { server, client } = await pair(SEC_AES128_GCM, OPT_CHUNK_STREAM);
    const wire = await writeChunk(client.request, utf8('payload'));
    wire[wire.length - 1]! ^= 0xff;
    const cs = new ChunkStream(server.request);
    cs.push(wire);
    expect(await cs.drain()).toBeNull();
  });
});

describe('هدر پاسخ', () => {
  it('ساخت → بازکردن؛ ۳۸ بایت با respV درست', async () => {
    const { server, client } = await pair(SEC_AES128_GCM, OPT_FULL);
    const wire = await buildVmessResponseHeader(server);
    expect(wire).toHaveLength(18 + 4 + 16);
    const plain = await openVmessResponseHeader(client, wire);
    expect(plain).not.toBeNull();
    expect(hex(plain!)).toBe('5a000000');
  });

  it('کلید پاسخ = SHA256(reqKey)[:16]', async () => {
    const { sha256 } = await import('../src/lib/sha256');
    const { server } = await pair(SEC_AES128_GCM, OPT_FULL);
    expect(hex(server.respKey)).toBe(hex(sha256(server.header.reqKey).subarray(0, 16)));
    expect(hex(server.respIV)).toBe(hex(sha256(server.header.reqIV).subarray(0, 16)));
  });

  it('هدر پاسخِ دست‌خورده باز نمی‌شود', async () => {
    const { server, client } = await pair(SEC_AES128_GCM, OPT_FULL);
    const wire = await buildVmessResponseHeader(server);
    wire[20]! ^= 1;
    expect(await openVmessResponseHeader(client, wire)).toBeNull();
  });
});

describe('کلید ChaCha وِمِس', () => {
  it('MD5(k) || MD5(MD5(k))', async () => {
    const { md5 } = await import('../src/lib/md5');
    const k = unhex('101112131415161718191a1b1c1d1e1f');
    expect(hex(chachaKeyFrom(k))).toBe(hex(md5(k)) + hex(md5(md5(k))));
  });
});


