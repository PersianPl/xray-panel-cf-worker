/**
 * تست پارس آدرس و هدرهای VLESS/Trojan.
 *
 * نکته‌ی مهم: نگاشت بایت نوع آدرس بین Trojan و VLESS/VMess **فرق دارد**
 * (`3` در VLESS یعنی IPv6 ولی در Trojan یعنی domain)، پس هر دو نگاشت جدا
 * آزمایش می‌شوند تا یکی آدرس دیگری را غلط تفسیر نکند.
 */
import { describe, expect, it } from 'vitest';
import { XRAY_ADDR, formatIPv6, parseIPv4, parseIPv6, parseTarget, writeTarget } from '../src/proxy/target';
import { TROJAN_ADDR, buildTrojanRequest, parseTrojanRequest, trojanKey } from '../src/proxy/trojan';
import { parseVlessRequest } from '../src/proxy/vless';
import { ByteWriter, utf8 } from '../src/lib/bytes';
import { hex, unhex } from '../src/lib/hexutil';

/** آدرس را با نگاشت داده‌شده به بایت می‌برد. */
const EMPTY: Uint8Array = new Uint8Array(0);

function addr(host: string, port: number, map = XRAY_ADDR): Uint8Array {
  const w = new ByteWriter();
  writeTarget(w, host, port, map);
  return w.toBytes();
}

describe('parseIPv4', () => {
  it('معتبرها', () => {
    expect(hex(parseIPv4('1.2.3.4')!)).toBe('01020304');
    expect(hex(parseIPv4('0.0.0.0')!)).toBe('00000000');
    expect(hex(parseIPv4('255.255.255.255')!)).toBe('ffffffff');
  });
  it('نامعتبرها', () => {
    for (const s of ['256.0.0.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '1.2.3.', '', '1.2.3.04x'])
      expect(parseIPv4(s), s).toBeNull();
  });
});

describe('parseIPv6', () => {
  it('کامل', () => {
    expect(hex(parseIPv6('2606:4700:0000:0000:0000:0000:0000:0001')!)).toBe('26064700000000000000000000000001');
  });
  it('فشرده با ::', () => {
    expect(hex(parseIPv6('2606:4700::1')!)).toBe('26064700000000000000000000000001');
    expect(hex(parseIPv6('::1')!)).toBe('00000000000000000000000000000001');
    expect(hex(parseIPv6('::')!)).toBe('00000000000000000000000000000000');
    expect(hex(parseIPv6('fe80::')!)).toBe('fe800000000000000000000000000000');
  });
  it('براکت و zone حذف می‌شوند', () => {
    expect(hex(parseIPv6('[2606:4700::1]')!)).toBe('26064700000000000000000000000001');
    expect(hex(parseIPv6('fe80::1%eth0')!)).toBe('fe800000000000000000000000000001');
  });
  it('دنباله‌ی IPv4', () => {
    expect(hex(parseIPv6('64:ff9b::1.2.3.4')!)).toBe('0064ff9b000000000000000001020304');
    expect(hex(parseIPv6('::ffff:192.168.1.1')!)).toBe('00000000000000000000ffffc0a80101');
  });
  it('نامعتبرها', () => {
    for (const s of [
      '1.2.3.4',
      'example.com',
      '2606:4700::1::2',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      'gggg::1',
      '12345::1',
      '64:ff9b::1.2.3.4:5',
    ])
      expect(parseIPv6(s), s).toBeNull();
  });
});

describe('formatIPv6 — فرم متعارف RFC 5952', () => {
  const f = (s: string) => formatIPv6(parseIPv6(s)!);

  it('بلندترین دنباله‌ی صفر فشرده می‌شود', () => {
    expect(f('2606:4700:0:0:0:0:0:1')).toBe('2606:4700::1');
    expect(f('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(f('0:0:0:0:0:0:0:0')).toBe('::');
    expect(f('fe80:0:0:0:0:0:0:0')).toBe('fe80::');
  });

  it('در تساوی، چپ‌ترین دنباله فشرده می‌شود', () => {
    expect(f('1:0:0:2:0:0:3:4')).toBe('1::2:0:0:3:4');
  });

  it('یک گروه صفرِ تنها فشرده نمی‌شود', () => {
    expect(f('1:0:2:3:4:5:6:7')).toBe('1:0:2:3:4:5:6:7');
  });

  it('صفرهای ابتدایی هر گروه حذف می‌شوند', () => {
    expect(f('2606:0470:0000:0000:0000:0000:0000:0abc')).toBe('2606:470::abc');
  });

  it('بدون هیچ صفری دست‌نخورده می‌ماند', () => {
    expect(f('2606:4700:1:2:3:4:5:6')).toBe('2606:4700:1:2:3:4:5:6');
  });

  it('رفت‌وبرگشت: parse(format(x)) == x', () => {
    for (const s of ['::1', '2606:4700::1', 'fe80::', '1::2:0:0:3:4', '64:ff9b::102:304', '::']) {
      const b = parseIPv6(s)!;
      expect(hex(parseIPv6(formatIPv6(b))!), s).toBe(hex(b));
    }
  });
});

describe('writeTarget / parseTarget — رفت و برگشت', () => {
  const hosts: Array<[string, string]> = [
    ['1.2.3.4', 'IPv4'],
    ['255.0.0.1', 'IPv4 مرزی'],
    ['example.com', 'دامنه'],
    ['a'.repeat(255), 'دامنه‌ی حداکثری'],
    ['2606:4700::1', 'IPv6 فشرده'],
    ['::1', 'IPv6 لوکال'],
  ];

  for (const map of [XRAY_ADDR, TROJAN_ADDR]) {
    const label = map === XRAY_ADDR ? 'xray' : 'trojan';
    for (const [host, kind] of hosts) {
      it(`${label}: ${kind} (${host.length > 20 ? `${host.slice(0, 8)}…` : host})`, () => {
        const b = addr(host, 8443, map);
        const r = parseTarget(b, 0, map);
        expect(r).not.toBeNull();
        expect(r!.target.port).toBe(8443);
        expect(r!.target.host).toBe(host);
        expect(r!.next).toBe(b.length);
      });
    }
  }

  it('پورت big-endian و قبل از آدرس می‌آید (VLESS/VMess)', () => {
    const b = addr('1.2.3.4', 0x01bb);
    expect(b[0]).toBe(0x01);
    expect(b[1]).toBe(0xbb);
    expect(b[2]).toBe(1); // atype IPv4
  });

  it('در Trojan پورت **بعد از** آدرس می‌آید', () => {
    // Trojan گزینه‌ی PortThenAddress را ندارد → portLastAddressParser.
    const b = addr('1.2.3.4', 0x01bb, TROJAN_ADDR);
    expect(hex(b)).toBe('01010203040' + '1bb'); // atype=1 | 1.2.3.4 | 01bb
    expect(b[0]).toBe(1); // atype اول
    expect(hex(b.subarray(5))).toBe('01bb'); // پورت آخر
  });

  it('نگاشت‌ها واقعاً فرق دارند', () => {
    // در xray بایتِ نوع بعد از دو بایت پورت است؛ در Trojan بایتِ اول.
    expect(addr('example.com', 443, XRAY_ADDR)[2]).toBe(2);
    expect(addr('example.com', 443, TROJAN_ADDR)[0]).toBe(3);
    expect(addr('::1', 443, XRAY_ADDR)[2]).toBe(3);
    expect(addr('::1', 443, TROJAN_ADDR)[0]).toBe(4);
    // IPv4 در هر دو بایتِ ۱ است، فقط جایش فرق دارد.
    expect(addr('1.2.3.4', 443, XRAY_ADDR)[2]).toBe(1);
    expect(addr('1.2.3.4', 443, TROJAN_ADDR)[0]).toBe(1);
  });

  it('آدرس Trojan با نگاشت xray غلط خوانده می‌شود (نشان‌دهنده‌ی لزوم تفکیک)', () => {
    // هم نوعِ آدرس و هم جای پورت فرق دارد، پس نتیجه بی‌ربط درمی‌آید.
    const b = addr('example.com', 443, TROJAN_ADDR);
    const asXray = parseTarget(b, 0, XRAY_ADDR);
    expect(asXray?.target.host).not.toBe('example.com');
  });

  it('آدرس xray با نگاشت Trojan هم غلط خوانده می‌شود (جهت مخالف)', () => {
    const b = addr('example.com', 443, XRAY_ADDR);
    const asTrojan = parseTarget(b, 0, TROJAN_ADDR);
    // بایت اول ۰x01 است → در Trojan یعنی IPv4، پس ۴ بایت بعدی IP خوانده می‌شود.
    expect(asTrojan?.target.host).not.toBe('example.com');
  });

  it('بافر ناقص → null', () => {
    const b = addr('example.com', 443);
    for (let n = 0; n < b.length; n++) expect(parseTarget(b.subarray(0, n), 0), `n=${n}`).toBeNull();
    expect(parseTarget(b, 0)).not.toBeNull();
  });

  it('دامنه‌ی صفر-طول رد می‌شود', () => {
    expect(parseTarget(new Uint8Array([0x01, 0xbb, 0x02, 0x00]), 0)).toBeNull();
  });

  it('نوع آدرس ناشناس رد می‌شود', () => {
    expect(parseTarget(new Uint8Array([0x01, 0xbb, 0x09, 1, 2, 3, 4]), 0)).toBeNull();
    expect(parseTarget(new Uint8Array([0x01, 0xbb, 0x00, 1, 2, 3, 4]), 0)).toBeNull();
  });

  it('offset دلخواه رعایت می‌شود', () => {
    const b = new Uint8Array([0xde, 0xad, ...addr('1.2.3.4', 53)]);
    const r = parseTarget(b, 2);
    expect(r!.target).toEqual({ host: '1.2.3.4', port: 53 });
    expect(r!.next).toBe(b.length);
  });
});

describe('trojanKey', () => {
  it('هگزِ SHA-224 با ۵۶ کاراکتر', () => {
    const k = trojanKey('password');
    expect(k).toHaveLength(56);
    expect(k).toMatch(/^[0-9a-f]{56}$/);
    // SHA224("password") — بردار مستقل
    expect(k).toBe('d63dc919e201d7bc4c825630d2cf25fdc93d4b2f0d46706d29038d01');
  });

  it('رمزهای مختلف کلید مختلف می‌دهند', () => {
    expect(trojanKey('a')).not.toBe(trojanKey('b'));
  });

  it('یونیکد هم پشتیبانی می‌شود (UTF-8)', () => {
    expect(trojanKey('رمز عبور')).toMatch(/^[0-9a-f]{56}$/);
  });
});

describe('parseTrojanRequest', () => {
  const pw = 'secret-پسورد';
  const key = trojanKey(pw);
  const ok = (h: string) => h === key;

  /** یک درخواست کامل Trojan می‌سازد. */
  const req = (host: string, port: number, cmd = 1, payload = utf8('GET / HTTP/1.1\r\n'), k = key) =>
    new Uint8Array([...buildTrojanRequest(k, addr(host, port, TROJAN_ADDR), cmd), ...payload]);

  it('درخواست TCP دامنه‌ای', () => {
    const payload = utf8('hello');
    const r = parseTrojanRequest(req('example.com', 443, 1, payload), ok);
    expect(r).not.toBeNull();
    expect(r!.proto).toBe('trojan');
    expect(r!.target).toEqual({ host: 'example.com', port: 443 });
    expect(r!.udp).toBe(false);
    expect(hex(r!.rest!)).toBe(hex(payload));
  });

  it('پاسخ Trojan هیچ هدری ندارد', () => {
    const r = parseTrojanRequest(req('example.com', 443), ok);
    expect(r!.responseHeader).toBeNull();
  });

  it('cmd=3 یعنی UDP', () => {
    const r = parseTrojanRequest(req('1.1.1.1', 53, 3), ok);
    expect(r!.udp).toBe(true);
    expect(r!.target).toEqual({ host: '1.1.1.1', port: 53 });
  });

  it('مقصد IPv4 و IPv6', () => {
    expect(parseTrojanRequest(req('1.2.3.4', 80), ok)!.target).toEqual({ host: '1.2.3.4', port: 80 });
    expect(parseTrojanRequest(req('2606:4700::1', 443), ok)!.target).toEqual({ host: '2606:4700::1', port: 443 });
  });

  it('بدنه‌ی خالی مجاز است', () => {
    const r = parseTrojanRequest(req('example.com', 443, 1, new Uint8Array(0)), ok);
    expect(r).not.toBeNull();
    expect(r!.rest).toHaveLength(0);
  });

  it('رمز اشتباه رد می‌شود', () => {
    expect(parseTrojanRequest(req('example.com', 443, 1, utf8('x'), trojanKey('wrong')), ok)).toBeNull();
  });

  it('هش غیرهگز رد می‌شود', () => {
    const b = req('example.com', 443);
    b.set(utf8('ZZ'), 0);
    expect(parseTrojanRequest(b, ok)).toBeNull();
  });

  it('CRLF اول خراب → null', () => {
    const b = req('example.com', 443);
    b[57] = 0x00;
    expect(parseTrojanRequest(b, ok)).toBeNull();
  });

  it('CRLF دوم خراب → null', () => {
    const b = req('example.com', 443);
    // CRLF دوم بعد از آدرس: 59 + (2 پورت + 1 atype + 1 len + 11 دامنه)
    b[59 + 15] = 0x00;
    expect(parseTrojanRequest(b, ok)).toBeNull();
  });

  it('cmd نامعتبر رد می‌شود', () => {
    for (const cmd of [0, 2, 4, 0xff]) expect(parseTrojanRequest(req('example.com', 443, cmd), ok), `cmd=${cmd}`).toBeNull();
  });

  it('هر برش ناقصی → null (بدون استثنا)', () => {
    const full = req('example.com', 443, 1, utf8('payload'));
    for (let n = 0; n < full.length - 7; n++) {
      expect(parseTrojanRequest(full.subarray(0, n), ok), `n=${n}`).toBeNull();
    }
  });

  it('validate فقط بعد از بررسی قالب صدا زده می‌شود', () => {
    let calls = 0;
    const spy = (h: string) => {
      calls++;
      return h === key;
    };
    parseTrojanRequest(new Uint8Array(10), spy);
    expect(calls).toBe(0);
    parseTrojanRequest(req('example.com', 443), spy);
    expect(calls).toBe(1);
  });
});

describe('parseVlessRequest', () => {
  const uuid = unhex('b831381d63244d53ad4f8cda48b30811');
  const ok = (u: Uint8Array) => hex(u) === hex(uuid);

  /** درخواست VLESS v0: ver=0 | uuid | addonsLen | addons | cmd | addr */
  const req = (
    host: string,
    port: number,
    cmd = 1,
    payload: Uint8Array = EMPTY,
    addons: Uint8Array = EMPTY,
    id: Uint8Array = uuid,
  ) => new Uint8Array([0, ...id, addons.length, ...addons, cmd, ...addr(host, port), ...payload]);

  it('درخواست TCP دامنه‌ای', () => {
    const payload = utf8('hello');
    const r = parseVlessRequest(req('example.com', 443, 1, payload), ok);
    expect(r).not.toBeNull();
    expect(r!.proto).toBe('vless');
    expect(r!.target).toEqual({ host: 'example.com', port: 443 });
    expect(r!.udp).toBe(false);
    expect(hex(r!.rest!)).toBe(hex(payload));
  });

  it('هدر پاسخ = [0,0]', () => {
    const r = parseVlessRequest(req('example.com', 443), ok);
    expect(hex(r!.responseHeader!)).toBe('0000');
  });

  it('cmd=2 یعنی UDP', () => {
    expect(parseVlessRequest(req('1.1.1.1', 53, 2), ok)!.udp).toBe(true);
  });

  it('addons غیرخالی رد می‌شود (طولش عبور داده می‌شود)', () => {
    const r = parseVlessRequest(req('example.com', 443, 1, utf8('x'), utf8('{"flow":""}')), ok);
    expect(r).not.toBeNull();
    expect(r!.target.host).toBe('example.com');
  });

  it('نسخه‌ی غیر صفر رد می‌شود', () => {
    const b = req('example.com', 443);
    b[0] = 1;
    expect(parseVlessRequest(b, ok)).toBeNull();
  });

  it('UUID اشتباه رد می‌شود', () => {
    expect(parseVlessRequest(req('example.com', 443, 1, new Uint8Array(0), new Uint8Array(0), new Uint8Array(16)), ok)).toBeNull();
  });

  it('cmd نامعتبر رد می‌شود (mux پشتیبانی نمی‌شود)', () => {
    for (const cmd of [0, 3, 4, 0xff]) expect(parseVlessRequest(req('example.com', 443, cmd), ok), `cmd=${cmd}`).toBeNull();
  });

  it('هر برش ناقصی → null', () => {
    const full = req('example.com', 443, 1, utf8('payload'));
    for (let n = 0; n < full.length - 7; n++) {
      expect(parseVlessRequest(full.subarray(0, n), ok), `n=${n}`).toBeNull();
    }
  });

  it('مقصد IPv6', () => {
    expect(parseVlessRequest(req('2606:4700::1', 443), ok)!.target).toEqual({ host: '2606:4700::1', port: 443 });
  });
});
