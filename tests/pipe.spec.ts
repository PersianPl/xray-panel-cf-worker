/**
 * تست رله‌ی دوطرفه: چسباندن هدر پاسخ به اولین بسته، ترتیب نوشتن،
 * شمارش بایت، فریم‌بندی VMess در هر دو جهت، و مسیرهای بسته‌شدن/خطا.
 */
import { describe, expect, it } from 'vitest';
import { RawCodec, VmessCodec, newCounter, relay, vmessResponsePrefix } from '../src/proxy/pipe';
import { FakeTarget, FakeWs, tick } from './stubs/ws';
import { hex } from '../src/lib/hexutil';
import { utf8 } from '../src/lib/bytes';
import {
  OPT_AUTHENTICATED_LENGTH,
  OPT_CHUNK_MASKING,
  OPT_CHUNK_STREAM,
  OPT_GLOBAL_PADDING,
  SEC_AES128_GCM,
  buildVmessHeaderPlain,
  newVmessSession,
  openVmessResponseHeader,
  parseVmessHeader,
  readChunk,
  writeChunk,
  type VmessSession,
} from '../src/proxy/vmess';

/** یک نشست VMess کامل با گزینه‌های دلخواه می‌سازد (سمت سرور و سمت کلاینت). */
async function pairSession(option: number, security = SEC_AES128_GCM): Promise<{ server: VmessSession; client: VmessSession }> {
  const reqKey = new Uint8Array(16).fill(7);
  const reqIV = new Uint8Array(16).fill(9);
  const plain = buildVmessHeaderPlain({
    reqIV,
    reqKey,
    respV: 0x5a,
    option,
    security,
    command: 1,
    target: { host: 'example.com', port: 443 },
    padLen: 0,
  });
  const header = parseVmessHeader(plain)!;
  return { server: await newVmessSession(header), client: await newVmessSession(header) };
}

describe('relay — عبور خام (VLESS/Trojan)', () => {
  it('هدر پاسخ به اولین بسته‌ی downlink چسبانده می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({
      ws,
      socket: target,
      codec: new RawCodec(),
      responsePrefix: new Uint8Array([0, 0]),
    });

    target.push(utf8('HTTP/1.1 200 OK'));
    await tick(8);
    expect(ws.sent).toHaveLength(1);
    expect(hex(ws.sent[0]!)).toBe(hex(new Uint8Array([0, 0, ...utf8('HTTP/1.1 200 OK')])));

    target.push(utf8('body'));
    await tick(8);
    // بسته‌ی دوم دیگر پیشوند ندارد.
    expect(hex(ws.sent[1]!)).toBe(hex(utf8('body')));

    target.end();
    await done;
  });

  it('اگر مقصد هیچ بایتی نفرستد، هدر پاسخ جداگانه فرستاده می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new RawCodec(), responsePrefix: new Uint8Array([0, 0]) });
    target.end();
    await done;
    expect(hex(ws.all())).toBe('0000');
  });

  it('preamble قبل از هر داده‌ای روی سوکت می‌رود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({
      ws,
      socket: target,
      codec: new RawCodec(),
      preamble: utf8('TROJAN-HEADER'),
      firstPayload: utf8('GET /'),
    });
    await tick(8);
    expect(hex(target.written())).toBe(hex(utf8('TROJAN-HEADERGET /')));
    target.end();
    await done;
  });

  it('firstPayload در شمارش up می‌آید ولی preamble نه', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const counter = newCounter();
    const done = relay({
      ws,
      socket: target,
      codec: new RawCodec(),
      preamble: utf8('XXXX'),
      firstPayload: utf8('12345'),
      counter,
    });
    await tick(8);
    target.end();
    await done;
    expect(counter.up).toBe(5);
  });

  it('فریم‌های بعدی کلاینت به مقصد می‌روند و شمرده می‌شوند', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const counter = newCounter();
    const done = relay({ ws, socket: target, codec: new RawCodec(), counter });

    ws.emitMessage(utf8('one'));
    ws.emitMessage(utf8('two'));
    await tick(10);
    expect(hex(target.written())).toBe(hex(utf8('onetwo')));
    expect(counter.up).toBe(6);

    target.end();
    await done;
  });

  it('downlink شمرده می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const counter = newCounter();
    const done = relay({ ws, socket: target, codec: new RawCodec(), counter });
    target.push(new Uint8Array(100));
    target.push(new Uint8Array(23));
    await tick(8);
    target.end();
    await done;
    expect(counter.down).toBe(123);
  });

  it('ArrayBuffer و رشته هر دو از WS پذیرفته می‌شوند', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new RawCodec() });
    ws.emitMessage(new Uint8Array([1, 2, 3]).buffer);
    ws.emitMessage('abc');
    await tick(10);
    expect(hex(target.written())).toBe(`010203${hex(utf8('abc'))}`);
    target.end();
    await done;
  });

  it('بسته‌شدن WS سوکت مقصد را می‌بندد', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new RawCodec() });
    ws.emitClose();
    await done;
    expect(target.isClosed).toBe(true);
  });

  it('پایان مقصد باعث بسته شدن WS می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new RawCodec() });
    target.end();
    await done;
    expect(ws.closeCode).toBe(1000);
  });

  it('خطای error روی WS نشست را با کد ۱۰۱۱ می‌بندد', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new RawCodec() });
    ws.emitError();
    await done;
    expect(ws.closeCode).toBe(1011);
    expect(target.isClosed).toBe(true);
  });

  it('idle نشست را می‌بندد', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const counter = await relay({ ws, socket: target, codec: new RawCodec(), idleMs: 20 });
    expect(ws.closeCode).toBe(1001);
    expect(ws.closeReason).toBe('idle');
    expect(counter.up).toBe(0);
  });

  it('شکست نوشتن روی مقصد نشست را می‌بندد', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    target.failWrite = new Error('EPIPE');
    const done = relay({ ws, socket: target, codec: new RawCodec() });
    ws.emitMessage(utf8('x'));
    await done;
    expect(ws.closeCode).toBe(1011);
  });

  it('بسته‌ی خالی از WS نادیده گرفته می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new RawCodec() });
    ws.emitMessage(new Uint8Array(0));
    await tick(8);
    expect(target.writes).toHaveLength(0);
    target.end();
    await done;
  });
});

describe('relay — فریم‌بندی VMess', () => {
  const OPT_FULL = OPT_CHUNK_STREAM | OPT_CHUNK_MASKING | OPT_GLOBAL_PADDING;

  it('هدر پاسخ AEAD به اولین فریم downlink می‌چسبد و کلاینت آن را باز می‌کند', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({
      ws,
      socket: target,
      codec: new VmessCodec(server),
      responsePrefix: await vmessResponsePrefix(server),
    });

    const payload = utf8('salam donya');
    target.push(payload);
    await tick(10);
    target.end();
    await done;

    const wire = ws.all();
    // ۱۸ بایت طولِ AEAD + ۴ بایت هدر + ۱۶ تگ = ۳۸ بایتِ اول، هدر پاسخ است.
    const respPlain = await openVmessResponseHeader(client, wire.subarray(0, 38));
    expect(respPlain).not.toBeNull();
    expect(hex(respPlain!)).toBe('5a000000');

    // بقیه با کدکِ پاسخِ سمت کلاینت خوانده می‌شود.
    const r = await readChunk(client.response, wire, 38);
    expect(r.kind).toBe('data');
    if (r.kind === 'data') expect(hex(r.payload)).toBe(hex(payload));
  });

  it('uplinkِ فریم‌شده رمزگشایی و خام روی سوکت نوشته می‌شود', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new VmessCodec(server) });

    // کلاینت با کدکِ درخواستِ خودش می‌نویسد.
    const a = utf8('first chunk');
    const b = utf8('second');
    ws.emitMessage(await writeChunk(client.request, a));
    ws.emitMessage(await writeChunk(client.request, b));
    await tick(12);

    expect(hex(target.written())).toBe(hex(new Uint8Array([...a, ...b])));
    target.end();
    await done;
  });

  it('یک فریم WS که چند chunk دارد، همه را جدا می‌کند', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new VmessCodec(server) });

    const c1 = await writeChunk(client.request, utf8('AAA'));
    const c2 = await writeChunk(client.request, utf8('BBBB'));
    ws.emitMessage(new Uint8Array([...c1, ...c2]));
    await tick(12);

    expect(hex(target.written())).toBe(hex(utf8('AAABBBB')));
    target.end();
    await done;
  });

  it('chunk تکه‌شده بین دو فریم WS درست سرهم می‌شود', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new VmessCodec(server) });

    const c = await writeChunk(client.request, utf8('split me please'));
    // بایت‌به‌بایت — رگرسیونِ هم‌گامیِ SHAKE.
    for (const byte of c) ws.emitMessage(new Uint8Array([byte]));
    await tick(24);

    expect(hex(target.written())).toBe(hex(utf8('split me please')));
    target.end();
    await done;
  });

  it('گزینه‌ی authenticated-length هم کار می‌کند', async () => {
    const { server, client } = await pairSession(OPT_FULL | OPT_AUTHENTICATED_LENGTH);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new VmessCodec(server) });

    ws.emitMessage(await writeChunk(client.request, utf8('auth-len')));
    await tick(12);
    expect(hex(target.written())).toBe(hex(utf8('auth-len')));

    target.push(utf8('back'));
    await tick(10);
    target.end();
    await done;

    const r = await readChunk(client.response, ws.all(), 0);
    expect(r.kind).toBe('data');
    if (r.kind === 'data') expect(hex(r.payload)).toBe(hex(utf8('back')));
  });

  it('داده‌ی خراب نشست را با کد ۱۰۰۲ می‌بندد', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new VmessCodec(server) });

    const c = await writeChunk(client.request, utf8('tampered'));
    // بایت اول *بعد از* سرآیند طول = آغاز ciphertext. آخرین بایت را نمی‌زنیم چون
    // با روشن بودن پدینگ، آن بایت پدینگ است و از AEAD بیرون است.
    c[2] = c[2]! ^ 0xff;
    ws.emitMessage(c);
    await done;
    expect(ws.closeCode).toBe(1002);
  });

  it('دست‌کاری پدینگ بی‌اثر است (پدینگ داخل AEAD نیست)', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new VmessCodec(server) });

    const c = await writeChunk(client.request, utf8('ok'));
    // با پدینگ روشن، طول chunk از payload+tag بیشتر است؛ دنباله‌اش پدینگ است.
    expect(c.length).toBeGreaterThan(2 + 2 + 16);
    c[c.length - 1] = c[c.length - 1]! ^ 0xff;
    ws.emitMessage(c);
    await tick(12);

    expect(hex(target.written())).toBe(hex(utf8('ok')));
    expect(ws.closeCode).toBeNull();
    target.end();
    await done;
  });

  it('فریمِ پایانیِ downlink بعد از پایان مقصد فرستاده می‌شود', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new VmessCodec(server) });

    target.push(utf8('data'));
    await tick(10);
    target.end();
    await done;

    const wire = ws.all();
    const first = await readChunk(client.response, wire, 0);
    expect(first.kind).toBe('data');
    if (first.kind !== 'data') return;
    const end = await readChunk(client.response, wire, first.consumed);
    expect(end.kind).toBe('eof');
  });

  it('پاسخ بزرگ‌تر از سقف chunk به چند فریم شکسته می‌شود', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const codec = new VmessCodec(server);
    const cap = codec.maxDownlink;
    expect(cap).toBeLessThan(2048);

    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec });

    const big = new Uint8Array(cap * 2 + 100);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    target.push(big);
    await tick(12);
    target.end();
    await done;

    // کلاینت باید همان بایت‌ها را پشت سر هم بخواند.
    const wire = ws.all();
    let off = 0;
    const parts: Uint8Array[] = [];
    for (;;) {
      const r = await readChunk(client.response, wire, off);
      if (r.kind === 'eof' || r.kind === 'need-more') break;
      expect(r.kind).toBe('data');
      if (r.kind !== 'data') break;
      parts.push(r.payload.slice(0));
      off += r.consumed;
    }
    let n = 0;
    for (const p of parts) n += p.length;
    const joined = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    expect(hex(joined)).toBe(hex(big));
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });

  it('شمارش up/down بایتِ خالصِ کاربر است، نه بایتِ سیم', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const counter = newCounter();
    const done = relay({ ws, socket: target, codec: new VmessCodec(server), counter });

    ws.emitMessage(await writeChunk(client.request, new Uint8Array(300)));
    await tick(12);
    target.push(new Uint8Array(50));
    await tick(10);
    target.end();
    await done;

    expect(counter.up).toBe(300);
    expect(counter.down).toBe(50);
    // بایت سیم بیشتر است (تگ AEAD + طول + پدینگ).
    expect(ws.all().length).toBeGreaterThan(50);
  });

  it('فریم پایانیِ uplinkِ کلاینت، نوشتن روی مقصد را می‌بندد ولی downlink ادامه دارد', async () => {
    const { server, client } = await pairSession(OPT_FULL);
    const ws = new FakeWs();
    const target = new FakeTarget();
    const done = relay({ ws, socket: target, codec: new VmessCodec(server) });

    ws.emitMessage(await writeChunk(client.request, utf8('bye')));
    ws.emitMessage(await writeChunk(client.request, new Uint8Array(0)));
    await tick(12);
    expect(hex(target.written())).toBe(hex(utf8('bye')));
    expect(ws.closeCode).toBeNull();

    target.push(utf8('still here'));
    await tick(10);
    target.end();
    await done;

    const r = await readChunk(client.response, ws.all(), 0);
    expect(r.kind).toBe('data');
    if (r.kind === 'data') expect(hex(r.payload)).toBe(hex(utf8('still here')));
  });
});
