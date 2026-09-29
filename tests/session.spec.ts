/**
 * تست هندلر نشست: تطبیق پروتکل/کاربر، هدرِ چندفریمی، early-data،
 * رد کردن کاربر بسته/منقضی، شکست دیال، و شمارش مصرف.
 */
import { describe, expect, it } from 'vitest';
import { handleSession, parseHeader, readEarlyData, type ClientStore, type MatchedClient } from '../src/proxy/session';
import { FakeTarget, FakeWs, tick } from './stubs/ws';
import { TROJAN_ADDR, buildTrojanRequest, trojanKey } from '../src/proxy/trojan';
import { XRAY_ADDR, writeTarget } from '../src/proxy/target';
import { ByteWriter, utf8 } from '../src/lib/bytes';
import { b64encode, uuidToBytes } from '../src/lib/crypto';
import { hex } from '../src/lib/hexutil';
import {
  OPT_CHUNK_MASKING,
  OPT_CHUNK_STREAM,
  SEC_AES128_GCM,
  authIdKey,
  buildVmessHeaderPlain,
  createAuthId,
  sealVmessRequest,
  vmessCmdKey,
} from '../src/proxy/vmess';
import type { DialOptions, DialResult } from '../src/proxy/dial';
import { DialError } from '../src/proxy/dial';
import type { Target } from '../src/proxy/types';

const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const UUID_BYTES = uuidToBytes(UUID);
const TROJAN_PW = 'my-secret';
const TROJAN_KEY = trojanKey(TROJAN_PW);

const EMPTY: Uint8Array = new Uint8Array(0);

function client(over: Partial<MatchedClient> = {}): MatchedClient {
  return { clientId: 1, inboundId: 1, name: 'ali', dial: {}, ...over };
}

/** انبار کاربر جعلی با یک کاربر VLESS/VMess و یک Trojan. */
function store(over: Partial<ClientStore> = {}, matched: MatchedClient = client()): ClientStore {
  const cmdKey = vmessCmdKey(UUID_BYTES);
  return {
    byUuid: async (u) => (hex(u) === hex(UUID_BYTES) ? matched : null),
    byTrojanKey: async (h) => (h === TROJAN_KEY ? matched : null),
    vmessCandidates: async () => [{ uuid: UUID_BYTES, cmdKey, authIdKey: authIdKey(cmdKey) }],
    ...over,
  };
}

function addrBytes(host: string, port: number, map = XRAY_ADDR): Uint8Array {
  const w = new ByteWriter();
  writeTarget(w, host, port, map);
  return w.toBytes();
}

/** درخواست VLESS کامل. */
function vlessReq(host = 'example.com', port = 443, cmd = 1, payload: Uint8Array = EMPTY): Uint8Array {
  return new Uint8Array([0, ...UUID_BYTES, 0, cmd, ...addrBytes(host, port), ...payload]);
}

/** درخواست Trojan کامل. */
function trojanReq(host = 'example.com', port = 443, cmd = 1, payload: Uint8Array = EMPTY): Uint8Array {
  return new Uint8Array([...buildTrojanRequest(TROJAN_KEY, addrBytes(host, port, TROJAN_ADDR), cmd), ...payload]);
}

/** درخواست VMess کامل (با AEAD). */
async function vmessReq(host = 'example.com', port = 443, payload: Uint8Array = EMPTY, timeSec?: number): Promise<Uint8Array> {
  const cmdKey = vmessCmdKey(UUID_BYTES);
  const plain = buildVmessHeaderPlain({
    reqIV: new Uint8Array(16).fill(3),
    reqKey: new Uint8Array(16).fill(4),
    respV: 0x5a,
    option: OPT_CHUNK_STREAM | OPT_CHUNK_MASKING,
    security: SEC_AES128_GCM,
    command: 1,
    target: { host, port },
  });
  const sealed = await sealVmessRequest(cmdKey, plain, timeSec === undefined ? {} : { timeSec });
  return new Uint8Array([...sealed, ...payload]);
}

/** دیالِ جعلیِ موفق که همان FakeTarget را برمی‌گرداند. */
function okDial(target: FakeTarget, via = 'direct', preamble?: Uint8Array) {
  return async (_t: Target): Promise<DialResult> =>
    ({ socket: target as unknown, via, ...(preamble ? { preamble } : {}) }) as DialResult;
}

describe('parseHeader — تطبیق پروتکل', () => {
  it('VLESS شناسایی می‌شود', async () => {
    const out = await parseHeader(vlessReq(), store());
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.request.proto).toBe('vless');
    expect(out.request.target).toEqual({ host: 'example.com', port: 443 });
    expect(hex(out.responsePrefix)).toBe('0000');
  });

  it('Trojan شناسایی می‌شود و هدر پاسخ ندارد', async () => {
    const out = await parseHeader(trojanReq(), store());
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.request.proto).toBe('trojan');
    expect(out.responsePrefix).toHaveLength(0);
  });

  it('VMess شناسایی می‌شود و هدر پاسخ AEAD دارد', async () => {
    const out = await parseHeader(await vmessReq(), store());
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.request.proto).toBe('vmess');
    expect(out.request.target).toEqual({ host: 'example.com', port: 443 });
    // ۱۸ + ۴ + ۱۶
    expect(out.responsePrefix).toHaveLength(38);
  });

  it('UDP در VLESS تشخیص داده می‌شود', async () => {
    const out = await parseHeader(vlessReq('1.1.1.1', 53, 2), store());
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.request.udp).toBe(true);
  });

  it('UUID ناشناس رد می‌شود', async () => {
    const b = vlessReq();
    b.set(new Uint8Array(16), 1);
    const out = await parseHeader(b, store());
    expect(out.kind).toBe('bad');
  });

  it('رمز Trojan ناشناس رد می‌شود', async () => {
    const bad = trojanKey('wrong');
    const b = new Uint8Array([...buildTrojanRequest(bad, addrBytes('a.com', 443, TROJAN_ADDR), 1)]);
    const out = await parseHeader(b, store());
    expect(out.kind).toBe('bad');
  });

  it('بافر کوچک → need-more', async () => {
    for (const n of [1, 5, 16, 20]) {
      const out = await parseHeader(vlessReq().subarray(0, n), store());
      expect(out.kind, `n=${n}`).toBe('need-more');
    }
  });

  it('بافر خالی → need-more', async () => {
    expect((await parseHeader(EMPTY, store())).kind).toBe('need-more');
  });

  it('آشغال بزرگ → bad', async () => {
    const junk = new Uint8Array(200);
    for (let i = 0; i < junk.length; i++) junk[i] = 0x40 + (i % 20);
    expect((await parseHeader(junk, store())).kind).toBe('bad');
  });

  it('کاربرِ ردشده (reject) هدرش پارس می‌شود ولی نشست بسته می‌شود', async () => {
    const out = await parseHeader(vlessReq(), store({}, client({ reject: 'ترافیک تمام شده' })));
    expect(out.kind).toBe('bad');
    if (out.kind === 'bad') expect(out.reason).toBe('ترافیک تمام شده');
  });

  it('محدود کردن به یک پروتکل، بقیه را امتحان نمی‌کند', async () => {
    let vmessAsked = 0;
    const s = store({
      vmessCandidates: async () => {
        vmessAsked++;
        return [];
      },
    });
    const out = await parseHeader(vlessReq(), s, 'vless');
    expect(out.kind).toBe('ok');
    expect(vmessAsked).toBe(0);
  });

  it('inbound مشخص، پروتکل دیگر را قبول نمی‌کند', async () => {
    const out = await parseHeader(trojanReq(), store(), 'vless');
    expect(out.kind).toBe('bad');
  });

  it('authID خارج از بازه‌ی زمانی رد می‌شود', async () => {
    // بازه‌ی معتبر ±۱۲۰ ثانیه است؛ ۵۰۰ ثانیه قبل باید رد شود.
    const stale = await vmessReq('example.com', 443, EMPTY, Math.floor(Date.now() / 1000) - 500);
    const out = await parseHeader(stale, store());
    // authID تطبیق نمی‌کند → هیچ کاندیدی نمی‌ماند → bad
    expect(out.kind).toBe('bad');
  });

  it('authID دستیِ خارج از بازه هم رد می‌شود', async () => {
    const cmdKey = vmessCmdKey(UUID_BYTES);
    const old = createAuthId(cmdKey, Math.floor(Date.now() / 1000) - 500);
    const full = await vmessReq();
    full.set(old, 0);
    expect((await parseHeader(full, store())).kind).toBe('bad');
  });
});

describe('handleSession — جریان کامل', () => {
  it('VLESS: هدر پاسخ می‌رود، دیتا رله می‌شود، مصرف شمرده می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const run = handleSession({
      ws,
      store: store(),
      dialFn: okDial(target),
    });

    ws.emitMessage(vlessReq('example.com', 443, 1, utf8('GET / HTTP/1.1\r\n\r\n')));
    await tick(12);
    expect(hex(target.written())).toBe(hex(utf8('GET / HTTP/1.1\r\n\r\n')));

    target.push(utf8('HTTP/1.1 200 OK'));
    await tick(10);
    expect(hex(ws.sent[0]!)).toBe(hex(new Uint8Array([0, 0, ...utf8('HTTP/1.1 200 OK')])));

    target.end();
    const res = await run;
    expect(res.ok).toBe(true);
    expect(res.proto).toBe('vless');
    expect(res.target).toEqual({ host: 'example.com', port: 443 });
    expect(res.via).toBe('direct');
    expect(res.usage.up).toBe(18);
    expect(res.usage.down).toBe(15);
    expect(res.client?.clientId).toBe(1);
  });

  it('Trojan: بدون هدر پاسخ رله می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const run = handleSession({ ws, store: store(), dialFn: okDial(target) });

    ws.emitMessage(trojanReq('a.com', 80, 1, utf8('ping')));
    await tick(12);
    expect(hex(target.written())).toBe(hex(utf8('ping')));

    target.push(utf8('pong'));
    await tick(10);
    expect(hex(ws.all())).toBe(hex(utf8('pong')));

    target.end();
    const res = await run;
    expect(res.ok).toBe(true);
    expect(res.proto).toBe('trojan');
  });

  it('VMess: هدر پاسخ AEAD اول downlink می‌آید', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const run = handleSession({ ws, store: store(), dialFn: okDial(target) });

    ws.emitMessage(await vmessReq('example.com', 443));
    await tick(14);

    target.push(utf8('data'));
    await tick(12);
    target.end();
    const res = await run;

    expect(res.ok).toBe(true);
    expect(res.proto).toBe('vmess');
    // ۳۸ بایت هدر پاسخ + فریمِ chunk
    expect(ws.all().length).toBeGreaterThan(38);
  });

  it('هدر تکه‌شده در چند فریم WS سرهم می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const run = handleSession({ ws, store: store(), dialFn: okDial(target) });

    const req = vlessReq('example.com', 443, 1, utf8('payload'));
    for (const byte of req) ws.emitMessage(new Uint8Array([byte]));
    await tick(30);

    expect(hex(target.written())).toBe(hex(utf8('payload')));
    target.end();
    const res = await run;
    expect(res.ok).toBe(true);
  });

  it('early-data: هدر از هدر HTTP می‌آید، بدون هیچ فریم WS', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const req = vlessReq('example.com', 443, 1, utf8('early!'));
    const run = handleSession({
      ws,
      store: store(),
      dialFn: okDial(target),
      earlyData: readEarlyData(b64encode(req)),
    });

    await tick(12);
    expect(hex(target.written())).toBe(hex(utf8('early!')));
    target.end();
    const res = await run;
    expect(res.ok).toBe(true);
    expect(res.usage.up).toBe(6);
  });

  it('early-data ناقص + ادامه‌ی فریم WS', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const req = vlessReq('example.com', 443, 1, utf8('rest'));
    const cut = 12;
    const run = handleSession({
      ws,
      store: store(),
      dialFn: okDial(target),
      earlyData: readEarlyData(b64encode(req.subarray(0, cut))),
    });

    ws.emitMessage(req.subarray(cut));
    await tick(14);
    expect(hex(target.written())).toBe(hex(utf8('rest')));
    target.end();
    await run;
  });

  it('بایت‌هایی که بین کامل شدن هدر و راه افتادن رله می‌رسند گم نمی‌شوند', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const run = handleSession({ ws, store: store(), dialFn: okDial(target) });

    const req = vlessReq('example.com', 443, 1);
    ws.emitMessage(req);
    // بی‌فاصله، قبل از آنکه دیال تمام شود:
    ws.emitMessage(utf8('AAA'));
    ws.emitMessage(utf8('BBB'));
    await tick(16);

    expect(hex(target.written())).toBe(hex(utf8('AAABBB')));
    target.end();
    const res = await run;
    expect(res.usage.up).toBe(6);
  });

  it('preamble دیال (Trojan-relay) قبل از دیتا نوشته می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    const run = handleSession({
      ws,
      store: store(),
      dialFn: okDial(target, 'trojan:tj:443', utf8('PREAMBLE')),
    });

    ws.emitMessage(vlessReq('example.com', 443, 1, utf8('body')));
    await tick(14);
    expect(hex(target.written())).toBe(hex(utf8('PREAMBLEbody')));
    // preamble در up شمرده نمی‌شود.
    target.end();
    const res = await run;
    expect(res.usage.up).toBe(4);
    expect(res.via).toBe('trojan:tj:443');
  });

  it('کاربر ردشده نشست را با ۱۰۰۲ می‌بندد و دیال نمی‌کند', async () => {
    const ws = new FakeWs();
    let dialed = 0;
    const run = handleSession({
      ws,
      store: store({}, client({ reject: 'ترافیک تمام شده' })),
      dialFn: async () => {
        dialed++;
        throw new Error('نباید دیال شود');
      },
    });

    ws.emitMessage(vlessReq());
    const res = await run;
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ترافیک تمام شده');
    expect(dialed).toBe(0);
    expect(ws.closeCode).toBe(1002);
  });

  it('شکست دیال با شرح تلاش‌ها برمی‌گردد', async () => {
    const ws = new FakeWs();
    const run = handleSession({
      ws,
      store: store(),
      dialFn: async () => {
        throw new DialError('همه شکست خورد', [{ via: 'direct', error: 'refused' }]);
      },
    });

    ws.emitMessage(vlessReq());
    const res = await run;
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('direct: refused');
    expect(res.target).toEqual({ host: 'example.com', port: 443 });
    expect(ws.closeCode).toBe(1011);
  });

  it('تنظیمات دیالِ کاربر روی پیش‌فرض سراسری سوار می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    let seen: DialOptions | null = null;
    const run = handleSession({
      ws,
      store: store({}, client({ dial: { proxyList: [{ host: 'user-proxy', port: null }] } })),
      dialDefaults: { nat64: ['64:ff9b::'], proxyList: [{ host: 'global', port: null }], parallel: 2 },
      dialFn: async (_t, o) => {
        seen = o ?? null;
        return { socket: target as unknown, via: 'direct' } as DialResult;
      },
    });

    ws.emitMessage(vlessReq());
    await tick(12);
    target.end();
    await run;

    expect(seen).not.toBeNull();
    // پیش‌فرض‌های سراسری می‌مانند، ولی proxyList کاربر برنده است.
    expect(seen!.nat64).toEqual(['64:ff9b::']);
    expect(seen!.parallel).toBe(2);
    expect(seen!.proxyList).toEqual([{ host: 'user-proxy', port: null }]);
  });

  it('UDP بودن درخواست به دیال منتقل می‌شود', async () => {
    const ws = new FakeWs();
    const target = new FakeTarget();
    let seen: DialOptions | null = null;
    const run = handleSession({
      ws,
      store: store(),
      dialFn: async (_t, o) => {
        seen = o ?? null;
        return { socket: target as unknown, via: 'direct' } as DialResult;
      },
    });

    ws.emitMessage(vlessReq('1.1.1.1', 53, 2));
    await tick(12);
    target.end();
    await run;
    expect(seen!.udp).toBe(true);
  });

  it('timeout هدر نشست را می‌بندد', async () => {
    const ws = new FakeWs();
    const res = await handleSession({ ws, store: store(), headerTimeoutMs: 25, dialFn: okDial(new FakeTarget()) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('هدر کامل نشد');
    expect(ws.closeCode).toBe(1002);
  });

  it('بسته شدن WS قبل از هدر', async () => {
    const ws = new FakeWs();
    const run = handleSession({ ws, store: store(), dialFn: okDial(new FakeTarget()) });
    ws.emitClose();
    const res = await run;
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('قبل از هدر');
  });

  it('هدر بیش از حد بزرگ رد می‌شود', async () => {
    const ws = new FakeWs();
    const run = handleSession({ ws, store: store(), dialFn: okDial(new FakeTarget()) });
    // بایت اول صفر تا VLESS «need-more» بدهد و بافر رشد کند.
    for (let i = 0; i < 10; i++) {
      const chunk = new Uint8Array(600);
      chunk[0] = 0;
      ws.emitMessage(chunk);
    }
    const res = await run;
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/بزرگ|تطبیق/);
  });

  it('آشغال محض نشست را می‌بندد', async () => {
    const ws = new FakeWs();
    const run = handleSession({ ws, store: store(), dialFn: okDial(new FakeTarget()) });
    const junk = new Uint8Array(100);
    for (let i = 0; i < junk.length; i++) junk[i] = 0x47 + (i % 10);
    ws.emitMessage(junk);
    const res = await run;
    expect(res.ok).toBe(false);
    expect(ws.closeCode).toBe(1002);
  });
});

describe('readEarlyData', () => {
  it('base64 استاندارد', () => {
    const b = new Uint8Array([1, 2, 3, 250]);
    expect(hex(readEarlyData(b64encode(b))!)).toBe(hex(b));
  });

  it('base64url هم قبول است', () => {
    const b = new Uint8Array([0xfb, 0xff, 0xbe]);
    const url = b64encode(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(hex(readEarlyData(url)!)).toBe(hex(b));
  });

  it('خالی/نال → null', () => {
    expect(readEarlyData(null)).toBeNull();
    expect(readEarlyData('')).toBeNull();
    expect(readEarlyData('   ')).toBeNull();
  });

  it('بیش از حد بزرگ → null', () => {
    expect(readEarlyData('A'.repeat(9000))).toBeNull();
  });
});
