/**
 * تست لایه‌ی دیال: پارس ورودی‌ها، ساخت و ترتیب مسیرها، رفتار fallback،
 * بسته شدن بازنده‌های مسابقه‌ی موازی، هدر Trojan، و رله‌ی DNS روی TCP.
 *
 * `cloudflare:sockets` با استاب [tests/stubs/sockets.ts](stubs/sockets.ts)
 * جا شده است (alias در vitest.config.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DNS,
  DialError,
  DnsRelay,
  buildRoutes,
  dial,
  isIPv4,
  isIPv6,
  nat64Address,
  parseHostPort,
  parseProxyList,
  parseTargetSpec,
  pickProxies,
  type DialOptions,
  type ProxyEntry,
} from '../src/proxy/dial';
import { attempts, reset, setRouter, sockets, type Attempt } from './stubs/sockets';
import { hex, unhex } from '../src/lib/hexutil';
import { utf8 } from '../src/lib/bytes';
import { hostMatches } from '../src/proxy/dial';

describe('parseHostPort', () => {
  it('میزبان بدون پورت → port=null', () => {
    expect(parseHostPort('example.com')).toEqual({ host: 'example.com', port: null });
    expect(parseHostPort('  1.2.3.4  ')).toEqual({ host: '1.2.3.4', port: null });
  });

  it('میزبان با پورت', () => {
    expect(parseHostPort('example.com:8443')).toEqual({ host: 'example.com', port: 8443 });
    expect(parseHostPort('1.2.3.4:80')).toEqual({ host: '1.2.3.4', port: 80 });
  });

  it('IPv6 داخل براکت، با و بدون پورت', () => {
    expect(parseHostPort('[2606:4700::1]')).toEqual({ host: '2606:4700::1', port: null });
    expect(parseHostPort('[2606:4700::1]:2053')).toEqual({ host: '2606:4700::1', port: 2053 });
  });

  it('IPv6 خام بدون براکت → کل رشته میزبان است', () => {
    expect(parseHostPort('2606:4700::1')).toEqual({ host: '2606:4700::1', port: null });
    expect(parseHostPort('::1')).toEqual({ host: '::1', port: null });
  });

  it('ورودی نامعتبر رد می‌شود', () => {
    expect(parseHostPort('')).toBeNull();
    expect(parseHostPort('   ')).toBeNull();
    expect(parseHostPort(':443')).toBeNull();
    expect(parseHostPort('host:0')).toBeNull();
    expect(parseHostPort('host:65536')).toBeNull();
    expect(parseHostPort('host:abc')).toBeNull();
    expect(parseHostPort('host:-1')).toBeNull();
    expect(parseHostPort('host:44 3')).toBeNull();
    expect(parseHostPort('[2606:4700::1')).toBeNull();
    expect(parseHostPort('[]:443')).toBeNull();
    expect(parseHostPort('[2606:4700::1]x')).toBeNull();
  });

  it('parseTargetSpec پورت پیش‌فرض را می‌گذارد', () => {
    expect(parseTargetSpec('example.com')).toEqual({ host: 'example.com', port: 443 });
    expect(parseTargetSpec('example.com', 53)).toEqual({ host: 'example.com', port: 53 });
    expect(parseTargetSpec('example.com:8080', 53)).toEqual({ host: 'example.com', port: 8080 });
    expect(parseTargetSpec('')).toBeNull();
  });
});

describe('parseProxyList', () => {
  it('چندخطی، کامایی، و فاصله‌دار', () => {
    const list = parseProxyList('a.com:443, b.com\n c.com:8443\t[::1]:2053');
    expect(list).toEqual([
      { host: 'a.com', port: 443 },
      { host: 'b.com', port: null },
      { host: 'c.com', port: 8443 },
      { host: '::1', port: 2053 },
    ]);
  });

  it('کامنت و خطوط خالی حذف می‌شوند', () => {
    const list = parseProxyList('a.com # اصلی\n\n# کل خط کامنت\nb.com:2087\n');
    expect(list).toEqual([
      { host: 'a.com', port: null },
      { host: 'b.com', port: 2087 },
    ]);
  });

  it('ورودی خالی → لیست خالی', () => {
    expect(parseProxyList('')).toEqual([]);
    expect(parseProxyList('   \n  \n')).toEqual([]);
  });

  it('ورودی‌های نامعتبر دور ریخته می‌شوند نه اینکه throw کنند', () => {
    expect(parseProxyList('good.com:1,bad:0,also.com:70000,ok.com')).toEqual([
      { host: 'good.com', port: 1 },
      { host: 'ok.com', port: null },
    ]);
  });
});

describe('pickProxies', () => {
  const list: ProxyEntry[] = [
    { host: 'a', port: null },
    { host: 'b', port: null },
    { host: 'c', port: null },
  ];

  it('لیست خالی → خالی', () => {
    expect(pickProxies([], 3)).toEqual([]);
  });

  it('بیشتر از طول لیست نمی‌دهد', () => {
    expect(pickProxies(list, 10)).toHaveLength(3);
  });

  it('در فراخوانی‌های پیاپی می‌چرخد', () => {
    const first = pickProxies(list, 1)[0]!.host;
    const second = pickProxies(list, 1)[0]!.host;
    const third = pickProxies(list, 1)[0]!.host;
    const fourth = pickProxies(list, 1)[0]!.host;
    expect(new Set([first, second, third]).size).toBe(3);
    expect(fourth).toBe(first);
  });
});

describe('isIPv4 / isIPv6', () => {
  it('IPv4 معتبر', () => {
    for (const s of ['0.0.0.0', '1.2.3.4', '255.255.255.255', '10.0.0.1']) expect(isIPv4(s), s).toBe(true);
  });
  it('IPv4 نامعتبر', () => {
    for (const s of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '1.2.3.', '', '1.2.3.-1', '01.2.3.4444'])
      expect(isIPv4(s), s).toBe(false);
  });
  it('IPv6 با «:» تشخیص داده می‌شود', () => {
    expect(isIPv6('::1')).toBe(true);
    expect(isIPv6('2606:4700::1')).toBe(true);
    expect(isIPv6('1.2.3.4')).toBe(false);
    expect(isIPv6('example.com')).toBe(false);
  });
});

describe('nat64Address', () => {
  it('چهار بایت IPv4 به دو گروه هگز', () => {
    expect(nat64Address('2602:fc59:b0:64::', '1.2.3.4')).toBe('2602:fc59:b0:64::102:304');
    expect(nat64Address('64:ff9b::', '8.8.8.8')).toBe('64:ff9b::808:808');
    expect(nat64Address('64:ff9b::', '255.255.255.255')).toBe('64:ff9b::ffff:ffff');
    expect(nat64Address('64:ff9b::', '0.0.0.1')).toBe('64:ff9b::0:1');
  });

  it('prefix با/بدون «::» و با براکت نرمال می‌شود', () => {
    expect(nat64Address('2602:fc59:b0:64', '1.2.3.4')).toBe('2602:fc59:b0:64::102:304');
    expect(nat64Address('2602:fc59:b0:64:', '1.2.3.4')).toBe('2602:fc59:b0:64::102:304');
    expect(nat64Address('[2602:fc59:b0:64::]', '1.2.3.4')).toBe('2602:fc59:b0:64::102:304');
    expect(nat64Address('  2602:fc59:b0:64::  ', '1.2.3.4')).toBe('2602:fc59:b0:64::102:304');
  });

  it('مقصد غیر-IPv4 → null', () => {
    expect(nat64Address('64:ff9b::', 'example.com')).toBeNull();
    expect(nat64Address('64:ff9b::', '2606:4700::1')).toBeNull();
  });
});

describe('buildRoutes', () => {
  const list: ProxyEntry[] = [{ host: 'p1.example', port: 8443 }];

  it('پیش‌فرض: مستقیم اول', () => {
    const r = buildRoutes(T('1.2.3.4', 80), {});
    expect(r.map((x) => x.via)).toEqual(['direct']);
  });

  it('forceProxy مسیر مستقیم را حذف می‌کند', () => {
    const r = buildRoutes(T('1.2.3.4', 80), { forceProxy: true, proxyList: list });
    expect(r.map((x) => x.via)).toEqual(['proxyip:p1.example:8443']);
  });

  it('ترتیب پیش‌فرض direct → proxyip → nat64 → trojan', () => {
    const r = buildRoutes(T('1.2.3.4', 443), {
      proxyList: list,
      nat64: ['64:ff9b::'],
      trojan: { host: 'tj.example', port: 443, passwordHashHex: 'ab'.repeat(28) },
    });
    expect(r.map((x) => x.via)).toEqual([
      'direct',
      'proxyip:p1.example:8443',
      'nat64:64:ff9b::',
      'trojan:tj.example:443',
    ]);
  });

  it('order سفارشی رعایت می‌شود', () => {
    const r = buildRoutes(T('1.2.3.4', 443), {
      order: ['nat64', 'proxyip', 'direct'],
      proxyList: list,
      nat64: ['64:ff9b::'],
    });
    expect(r.map((x) => x.via)).toEqual(['nat64:64:ff9b::', 'proxyip:p1.example:8443', 'direct']);
  });

  it('proxyip بدون پورت، پورت مقصد را عبور می‌دهد', () => {
    const r = buildRoutes(T('example.com', 2087), { forceProxy: true, proxyList: [{ host: 'p.example', port: null }] });
    expect(r.map((x) => x.via)).toEqual(['proxyip:p.example:2087']);
  });

  it('NAT64 روی مقصد دامنه‌ای ساخته نمی‌شود (نیازمند resolve و subrequest)', () => {
    const r = buildRoutes(T('example.com', 443), { order: ['nat64'], nat64: ['64:ff9b::'] });
    expect(r).toHaveLength(0);
  });

  it('NAT64 روی مقصد IPv6 هم ساخته نمی‌شود', () => {
    const r = buildRoutes(T('2606:4700::1', 443), { order: ['nat64'], nat64: ['64:ff9b::'] });
    expect(r).toHaveLength(0);
  });

  it('چند prefix NAT64 → چند مسیر', () => {
    const r = buildRoutes(T('1.2.3.4', 443), { order: ['nat64'], nat64: ['64:ff9b::', '2602:fc59:b0:64::'] });
    expect(r.map((x) => x.via)).toEqual(['nat64:64:ff9b::', 'nat64:2602:fc59:b0:64::']);
  });

  it('trojan بدون تنظیمات ساخته نمی‌شود', () => {
    expect(buildRoutes(T('1.2.3.4'), { order: ['trojan'] })).toHaveLength(0);
  });

  it('سقف proxyip در هر گروه ۳ است (سهمیه‌ی ۶ اتصالی CF)', () => {
    const many: ProxyEntry[] = ['a', 'b', 'c', 'd', 'e'].map((h) => ({ host: h, port: 443 }));
    const r = buildRoutes(T('1.2.3.4'), { order: ['proxyip'], proxyList: many });
    expect(r).toHaveLength(3);
  });
});

describe('dial — انتخاب مسیر و fallback', () => {
  const allFail = () => setRouter(() => ({ kind: 'fail' as const }));

  it('مسیر مستقیم که باز شود، همان برمی‌گردد و مسیر دیگری امتحان نمی‌شود', async () => {
    setRouter(() => ({ kind: 'open' }));
    const r = await dial(T('example.com', 443), { proxyList: [{ host: 'p', port: null }] });
    expect(r.via).toBe('direct');
    expect(attempts).toEqual([{ hostname: 'example.com', port: 443, tls: false }]);
  });

  it('شکست مستقیم → proxyip امتحان می‌شود', async () => {
    setRouter((a: Attempt) => (a.hostname === 'example.com' ? { kind: 'fail' } : { kind: 'open' }));
    const r = await dial(T('example.com', 2087), { proxyList: [{ host: 'p.example', port: null }] });
    expect(r.via).toBe('proxyip:p.example:2087');
    expect(attempts.map((a) => `${a.hostname}:${a.port}`)).toEqual(['example.com:2087', 'p.example:2087']);
  });

  it('زنجیره‌ی کامل تا NAT64 پیش می‌رود', async () => {
    setRouter((a: Attempt) => (a.hostname.startsWith('64:ff9b') ? { kind: 'open' } : { kind: 'fail' }));
    const r = await dial(T('1.2.3.4', 443), {
      proxyList: [{ host: 'p.example', port: 443 }],
      nat64: ['64:ff9b::'],
    });
    expect(r.via).toBe('nat64:64:ff9b::');
    expect(attempts).toHaveLength(3);
    expect(attempts[2]!.hostname).toBe('64:ff9b::102:304');
  });

  it('شکست همه‌ی مسیرها → DialError با شرح تلاش‌ها', async () => {
    allFail();
    const opts: DialOptions = { proxyList: [{ host: 'p.example', port: 443 }], nat64: ['64:ff9b::'] };
    await expect(dial(T('1.2.3.4', 443), opts)).rejects.toBeInstanceOf(DialError);
    try {
      await dial(T('1.2.3.4', 443), opts);
      expect.unreachable('باید خطا می‌داد');
    } catch (e) {
      const err = e as DialError;
      expect(err.attempts.map((a) => a.via)).toEqual(['direct', 'proxyip:p.example:443', 'nat64:64:ff9b::']);
      expect(err.message).toContain('1.2.3.4:443');
    }
  });

  it('بدون هیچ مسیری → DialError بدون تلاش', async () => {
    await expect(dial(T('example.com'), { forceProxy: true })).rejects.toThrow('هیچ مسیری');
  });

  it('سوکتی که در timeout باز نشود بسته می‌شود و مسیر بعدی می‌رود', async () => {
    setRouter((a: Attempt) => (a.hostname === 'slow.example' ? { kind: 'hang' } : { kind: 'open' }));
    const r = await dial(T('slow.example', 443), {
      timeoutMs: 30,
      proxyList: [{ host: 'p.example', port: 443 }],
    });
    expect(r.via).toBe('proxyip:p.example:443');
    expect(sockets[0]!.isClosed).toBe(true);
    expect(sockets[1]!.isClosed).toBe(false);
  });

  it('موازی‌سازی: برنده اولی است و بازنده‌ی باز بسته می‌شود', async () => {
    setRouter((a: Attempt) => ({ kind: 'open', delayMs: a.hostname === 'p1' ? 30 : 5 }));
    const r = await dial(T('1.2.3.4', 443), {
      forceProxy: true,
      parallel: 3,
      proxyList: [
        { host: 'p1', port: 443 },
        { host: 'p2', port: 443 },
      ],
    });
    // هر دو باز می‌شوند؛ اولی در ترتیب مسیرها برنده است، دومی بسته می‌شود.
    expect(r.via).toBe('proxyip:p1:443');
    expect(sockets[0]!.isClosed).toBe(false);
    expect(sockets[1]!.isClosed).toBe(true);
  });

  it('parallel بیش از سقف به MAX_PARALLEL محدود می‌شود', async () => {
    let open = 0;
    setRouter(() => {
      open++;
      return { kind: 'fail' };
    });
    await expect(
      dial(T('1.2.3.4', 443), {
        parallel: 99,
        proxyList: [{ host: 'p1', port: 443 }],
        nat64: ['64:ff9b::'],
      }),
    ).rejects.toBeInstanceOf(DialError);
    // ۳ مسیر داریم و همه امتحان می‌شوند؛ فقط گروه‌بندی فرق می‌کند.
    expect(open).toBe(3);
  });
});

describe('dial — هدر Trojan', () => {
  const pw = 'ab'.repeat(28); // ۵۶ کاراکتر هگز

  it('مسیر trojan با TLS باز می‌شود و preamble هدر Trojan است', async () => {
    setRouter(() => ({ kind: 'open' }));
    const r = await dial(T('example.com', 443), {
      order: ['trojan'],
      trojan: { host: 'tj.example', port: 8443, passwordHashHex: pw },
    });
    expect(r.via).toBe('trojan:tj.example:8443');
    expect(attempts[0]).toEqual({ hostname: 'tj.example', port: 8443, tls: true });

    // hex(56) | CRLF | cmd=1 | atype=3 (domain در Trojan) | len | "example.com" | port(2BE) | CRLF
    // پورت **آخر** می‌آید: Trojan گزینه‌ی PortThenAddress را ندارد.
    const want = hex(
      new Uint8Array([
        ...utf8(pw),
        0x0d,
        0x0a,
        0x01,
        0x03,
        11,
        ...utf8('example.com'),
        0x01,
        0xbb,
        0x0d,
        0x0a,
      ]),
    );
    expect(r.preamble).toBeDefined();
    expect(hex(r.preamble!)).toBe(want);
  });

  it('مقصد IPv4 با atype=1 و پورتِ آخر کد می‌شود', async () => {
    setRouter(() => ({ kind: 'open' }));
    const r = await dial(T('1.2.3.4', 80), {
      order: ['trojan'],
      trojan: { host: 'tj', port: 443, passwordHashHex: pw },
    });
    expect(hex(r.preamble!.subarray(56 + 2))).toBe(hex(new Uint8Array([0x01, 0x01, 1, 2, 3, 4, 0x00, 0x50, 0x0d, 0x0a])));
  });

  it('مقصد IPv6 با atype=4 (نگاشت مخصوص Trojan) و ۱۶ بایت', async () => {
    setRouter(() => ({ kind: 'open' }));
    const r = await dial(T('2606:4700::1', 443), {
      order: ['trojan'],
      trojan: { host: 'tj', port: 443, passwordHashHex: pw },
    });
    const body = r.preamble!.subarray(56 + 2);
    expect(body[0]).toBe(0x01); // cmd TCP
    expect(body[1]).toBe(0x04); // atype IPv6 در Trojan
    expect(hex(body.subarray(2, 18))).toBe('26064700000000000000000000000001');
    // پورت بعد از آدرس، سپس CRLF.
    expect(hex(body.subarray(18))).toBe('01bb0d0a');
  });

  it('udp=true → cmd=3', async () => {
    setRouter(() => ({ kind: 'open' }));
    const r = await dial(T('1.1.1.1', 53), {
      order: ['trojan'],
      udp: true,
      trojan: { host: 'tj', port: 443, passwordHashHex: pw },
    });
    expect(r.preamble![58]).toBe(0x03);
  });

  it('مسیرهای غیر-trojan preamble ندارند', async () => {
    setRouter(() => ({ kind: 'open' }));
    const r = await dial(T('example.com', 443), {});
    expect(r.preamble).toBeUndefined();
  });
});

describe('DnsRelay — UDP روی TCP (RFC 1035 §4.2.2)', () => {
  /** پیام DNS جعلی: هدر ۱۲ بایتی + پرسش. محتوا برای رله بی‌اهمیت است. */
  const query = (id: number) => {
    const b = new Uint8Array(12 + 5);
    b[0] = (id >> 8) & 0xff;
    b[1] = id & 0xff;
    b[2] = 0x01;
    b[12] = 0xaa;
    return b;
  };

  /** سرور جعلی: هر فریم `len|msg` را می‌گیرد و همان msg را echo می‌کند. */
  const echoServer = (transform?: (msg: Uint8Array) => Uint8Array[]) =>
    setRouter(() => ({
      kind: 'open',
      onWrite: (chunk, sock) => {
        const len = (chunk[0]! << 8) | chunk[1]!;
        const msg = chunk.subarray(2, 2 + len);
        const reply = new Uint8Array(2 + msg.length);
        reply[0] = (msg.length >> 8) & 0xff;
        reply[1] = msg.length & 0xff;
        reply.set(msg, 2);
        if (transform) for (const part of transform(reply)) sock.push(part);
        else sock.push(reply);
      },
    }));

  it('پرسش را با پیشوند طول ۲ بایتی می‌فرستد', async () => {
    echoServer();
    const relay = new DnsRelay();
    const q = query(0x1234);
    await relay.query(q);
    const w = sockets[0]!.written();
    expect(w[0]).toBe(0x00);
    expect(w[1]).toBe(q.length);
    expect(hex(w.subarray(2))).toBe(hex(q));
    relay.close();
  });

  it('به سرور پیش‌فرض ۸.۸.۴.۴:۵۳ بدون TLS وصل می‌شود', async () => {
    echoServer();
    const relay = new DnsRelay();
    await relay.query(query(1));
    expect(attempts[0]).toEqual({ hostname: DEFAULT_DNS.host, port: DEFAULT_DNS.port, tls: false });
    relay.close();
  });

  it('پاسخ را بدون پیشوند طول برمی‌گرداند', async () => {
    echoServer();
    const relay = new DnsRelay();
    const q = query(0xbeef);
    const a = await relay.query(q);
    expect(hex(a)).toBe(hex(q));
    relay.close();
  });

  it('پاسخ تکه‌تکه (طول و بدنه در چند chunk) درست سرهم می‌شود', async () => {
    echoServer((full) => [full.subarray(0, 1), full.subarray(1, 2), full.subarray(2, 5), full.subarray(5)]);
    const relay = new DnsRelay();
    const q = query(7);
    expect(hex(await relay.query(q))).toBe(hex(q));
    relay.close();
  });

  it('چند پرسش روی یک سوکت (بدون باز کردن اتصال جدید)', async () => {
    echoServer();
    const relay = new DnsRelay();
    const a = await relay.query(query(1));
    const b = await relay.query(query(2));
    expect(a[1]).toBe(1);
    expect(b[1]).toBe(2);
    expect(attempts).toHaveLength(1);
    relay.close();
  });

  it('پرسش‌های همزمان ترتیبی می‌شوند و پاسخ‌ها قاطی نمی‌شوند', async () => {
    echoServer();
    const relay = new DnsRelay();
    const [a, b, c] = await Promise.all([relay.query(query(11)), relay.query(query(22)), relay.query(query(33))]);
    expect([a![1], b![1], c![1]]).toEqual([11, 22, 33]);
    expect(attempts).toHaveLength(1);
    relay.close();
  });

  it('اندازه‌ی نامعتبر پیام رد می‌شود و اتصالی باز نمی‌کند', async () => {
    echoServer();
    const relay = new DnsRelay();
    await expect(relay.query(new Uint8Array(0))).rejects.toThrow('نامعتبر');
    await expect(relay.query(new Uint8Array(65536))).rejects.toThrow('نامعتبر');
    expect(attempts).toHaveLength(0);
    relay.close();
  });

  it('بسته شدن اتصال قبل از پاسخ کامل → خطا', async () => {
    setRouter(() => ({
      kind: 'open',
      onWrite: (_c, sock) => {
        sock.push(new Uint8Array([0x00, 0x10, 0x01]));
        sock.end();
      },
    }));
    const relay = new DnsRelay();
    await expect(relay.query(query(1))).rejects.toThrow('بسته شد');
    relay.close();
  });

  it('پس از خطا، پرسش بعدی سوکت تازه می‌گیرد', async () => {
    let first = true;
    setRouter(() => {
      if (first) {
        first = false;
        return {
          kind: 'open',
          onWrite: (_c, sock) => sock.end(),
        };
      }
      return {
        kind: 'open',
        onWrite: (chunk, sock) => {
          const len = (chunk[0]! << 8) | chunk[1]!;
          const msg = chunk.subarray(2, 2 + len);
          const reply = new Uint8Array(2 + msg.length);
          reply[0] = (msg.length >> 8) & 0xff;
          reply[1] = msg.length & 0xff;
          reply.set(msg, 2);
          sock.push(reply);
        },
      };
    });
    const relay = new DnsRelay();
    await expect(relay.query(query(1))).rejects.toThrow();
    const ok = await relay.query(query(2));
    expect(ok[1]).toBe(2);
    expect(attempts).toHaveLength(2);
    expect(sockets[0]!.isClosed).toBe(true);
    relay.close();
  });

  it('شکست باز شدن اتصال DNS منتشر می‌شود', async () => {
    setRouter(() => ({ kind: 'fail', error: 'DNS رد شد' }));
    const relay = new DnsRelay();
    await expect(relay.query(query(1))).rejects.toThrow('DNS رد شد');
    relay.close();
  });

  it('سرور سفارشی و timeout قابل تنظیم است', async () => {
    setRouter(() => ({ kind: 'hang' }));
    const relay = new DnsRelay({ host: '1.1.1.1', port: 5353 }, 25);
    await expect(relay.query(query(1))).rejects.toThrow('timeout');
    expect(attempts[0]).toEqual({ hostname: '1.1.1.1', port: 5353, tls: false });
    relay.close();
  });

  it('close سوکت را می‌بندد و پرسش بعد از آن دوباره وصل می‌شود', async () => {
    echoServer();
    const relay = new DnsRelay();
    await relay.query(query(1));
    relay.close();
    expect(sockets[0]!.isClosed).toBe(true);
    await relay.query(query(2));
    expect(attempts).toHaveLength(2);
    relay.close();
  });

  it('پیام ۶۵۵۳۵ بایتی (سقف مجاز) هم رد نمی‌شود', async () => {
    echoServer();
    const relay = new DnsRelay();
    const big = new Uint8Array(65535);
    big[0] = 0x5a;
    const a = await relay.query(big);
    expect(a).toHaveLength(65535);
    expect(a[0]).toBe(0x5a);
    relay.close();
  });
});

describe('SOCKS5 زنجیره', () => {
  it('parseSocks5Upstream فرم‌های مجاز', () => {
    expect(parseSocks5Upstream('1.2.3.4')).toEqual({ host: '1.2.3.4', port: 1080, user: '', pass: '' });
    expect(parseSocks5Upstream('u:p@h:1080')).toEqual({ host: 'h', port: 1080, user: 'u', pass: 'p' });
    expect(parseSocks5Upstream('u@h:2080')).toEqual({ host: 'h', port: 2080, user: 'u', pass: '' });
    expect(parseSocks5Upstream('[::1]:1090')).toEqual({ host: '::1', port: 1090, user: '', pass: '' });
    // رمز حاوی «@» — فقط آخرین «@» جدا می‌کند.
    expect(parseSocks5Upstream('u:p@x@h:1080')).toEqual({ host: 'h', port: 1080, user: 'u', pass: 'p@x' });
    expect(parseSocks5Upstream('')).toBeNull();
    expect(parseSocks5Upstream('h:0')).toBeNull();
    expect(parseSocks5Upstream('h:99999')).toBeNull();
 expect(parseSocks5Upstream('[::1]x')).toBeNull();
  });

  it('connectRequestBytes: IPv4 خام و دامنه', () => {
    expect(connectRequestBytes('1.2.3.4', 443)).toEqual(unhex('05010001 01020304 01bb'));
    const d = connectRequestBytes('example.com', 80);
    expect(d[3]).toBe(0x03);
    expect(d[4]).toBe(11);
    expect([...d.subarray(5, 16)]).toEqual([...utf8('example.com')]);
    expect(d[d.length - 2]).toBe(0);
    expect(d[d.length - 1]).toBe(80);
  });

  it('hostMatches پسوند کامل دامنه است', () => {
    expect(hostMatches('a.example.com', 'example.com')).toBe(true);
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
    expect(hostMatches('a.com', 'b.com')).toBe(false);
  });

  it('زنجیره‌ی کامل: greeting → auth → CONNECT → رله روی سوکت تأییدشده', async () => {
    // سرور SOCKS5 جعلی: متد را انتخاب می‌کند و بعد از CONNECT اکو می‌کند.
    let stage = 0;
    setRouter(() => ({
      kind: 'open',
      onWrite: (chunk, sock) => {
        if (stage === 0) {
          stage = 1;
          sock.push(new Uint8Array([5, 0])); // بدون احراز هویت
          return;
        }
        stage = 0;
        expect(chunk[0]).toBe(5);
        expect(chunk[1]).toBe(1);
        expect(chunk[3]).toBe(3); // دامنه
        sock.push(new Uint8Array([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      },
    }));
    const r = await dial(T('example.com', 443), {
      order: ['socks5'],
      socks5: { upstream: { host: 'up.example', port: 1080, user: '', pass: '' } },
    });
    expect(r.via).toBe('socks5:up.example:1080');
    expect(attempts[0]).toEqual({ hostname: 'up.example', port: 1080, tls: false });
    const sock = sockets[0]!;
    // greeting (3 بایت) + CONNECT (4+1+11+2 برای example.com:443)
    expect(sock.written()).toHaveLength(21);
    const connect = sock.writes[1]!;
    expect(connect[0]).toBe(5);
    expect(connect[1]).toBe(1);
    expect(connect[3]).toBe(3);
    expect(connect[connect.length - 1]).toBe(443 & 0xff);
  });

  it('رد شدن CONNECT → fallback به مسیر بعدی', async () => {
    let stage = 0;
    setRouter((a) => ({
      kind: 'open',
      onWrite: (chunk, sock) => {
        if (a.hostname === 'dead.example') {
          if (stage === 0) {
            stage = 1;
            sock.push(new Uint8Array([5, 0]));
            return;
          }
          stage = 0;
          sock.push(new Uint8Array([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); // rep=1
          return;
        }
        void chunk;
      },
    }));
    const r = await dial(T('example.com', 443), {
      order: ['socks5', 'proxyip'],
      proxyList: [{ host: 'p.example', port: null }],
      socks5: { upstream: { host: 'dead.example', port: 1080, user: '', pass: '' } },
    });
    expect(r.via).toBe('proxyip:p.example:443');
    expect(attempts.map((x) => x.hostname)).toEqual(['dead.example', 'p.example']);
  });

  it('udp از مسیر SOCKS5 نمی‌رود (ASSOCIATE ممکن نیست)', () => {
    const r = buildRoutes(T('example.com', 443), {
      order: ['socks5', 'direct'],
      udp: true,
      socks5: { upstream: { host: 'u', port: 1080, user: '', pass: '' } },
    });
    // با socks5 سراسری، direct حذف می‌شود و UDP هم مسیر ندارد — عمداً؛ نشت
    // UDP به direct بهتر از گذر ناخواسته از direct است (proxyip/trojan جایگزینند).
    expect(r).toHaveLength(0);
  });

  it('دامنه‌ها: مقصد خورده مسیر direct را حذف می‌کند، ناخورده نه', () => {
    const o: DialOptions = {
      order: ['direct', 'socks5'],
      socks5: { upstream: { host: 'u', port: 1080, user: '', pass: '' }, domains: ['cf.example'] },
    };
    expect(buildRoutes(T('x.cf.example', 443), o).map((r) => r.via)).toEqual(['socks5:u:1080']);
    expect(buildRoutes(T('other.com', 443), o).map((r) => r.via)).toEqual(['direct']);
  });

  it('بالادست timeout می‌خورد و سوکت بسته می‌شود', async () => {
    setRouter(() => ({ kind: 'hang' }));
    await expect(
      dial(T('example.com', 443), {
        order: ['socks5'],
        timeoutMs: 30,
        socks5: { upstream: { host: 'slow.example', port: 1080, user: '', pass: '' } },
      }),
    ).rejects.toThrow();
    // «timeout» می‌تواند از openSocket بیاید یا از دست‌دادن؛ هر دو مسیر بستن می‌دهند.
    expect(sockets.some((s) => s.isClosed)).toBe(true);
  });
});

import { connectRequestBytes, parseSocks5Upstream } from '../src/proxy/socks5';

beforeEach(() => reset());

const T = (host: string, port = 443) => ({ host, port });
