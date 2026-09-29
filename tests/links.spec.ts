/**
 * تست ساخت لینک کانفیگ.
 *
 * روش: لینک تولیدشده با `URL` (و برای VMess با base64+JSON) **دوباره پارس**
 * می‌شود، نه با رشته‌ی انتظاری مقایسه. دلیلش این است که یک لینک می‌تواند
 * ظاهراً درست باشد ولی برای پارسر کلاینت چیز دیگری معنی بدهد — مثل رمزی که
 * بعد از base64 یک «/» می‌سازد و بخش authority را نصف می‌کند. مقایسه‌ی رشته‌ای
 * چنین چیزی را نمی‌بیند؛ پارس‌کردن می‌بیند.
 */
import { describe, expect, it } from 'vitest';
import { buildLink, isPlainPort, ssLink, trojanLink, vlessLink, vmessLink, type LinkSpec } from '../src/sub/links';
import { HTTP_PORTS, TLS_PORTS, type GenOpts } from '../src/types';

function spec(over: Partial<LinkSpec> = {}): LinkSpec {
  return {
    protocol: 'vless',
    transport: 'ws',
    address: 'panel.example.com',
    port: 443,
    auth: '11111111-2222-3333-4444-555555555555',
    path: '/tunnel',
    host: '',
    sni: '',
    remark: 'Node-443',
    maxEarlyData: 0,
    ...over,
  };
}

/** پارامترهای query یک لینک URI-ای. */
function q(link: string): URLSearchParams {
  return new URL(link).searchParams;
}

describe('isPlainPort', () => {
  it('پورت‌های بدون TLS شناخته می‌شوند', () => {
    for (const p of HTTP_PORTS) expect(isPlainPort(p), String(p)).toBe(true);
  });
  it('پورت‌های TLS جزو بدون-TLS نیستند', () => {
    for (const p of TLS_PORTS) expect(isPlainPort(p), String(p)).toBe(false);
  });
  it('پورت ناشناس بدون-TLS حساب نمی‌شود', () => {
    expect(isPlainPort(12345)).toBe(false);
  });
});

describe('vlessLink', () => {
  it('ساختار پایه: scheme، uuid، میزبان و پورت', () => {
    const u = new URL(vlessLink(spec()));
    expect(u.protocol).toBe('vless:');
    expect(u.username).toBe('11111111-2222-3333-4444-555555555555');
    expect(u.hostname).toBe('panel.example.com');
    expect(u.port).toBe('443');
    expect(decodeURIComponent(u.hash.slice(1))).toBe('Node-443');
  });

  it('روی پورت TLS، security=tls و sni/fp ست می‌شود', () => {
    const p = q(vlessLink(spec({ port: 2053 })));
    expect(p.get('security')).toBe('tls');
    expect(p.get('type')).toBe('ws');
    expect(p.get('encryption')).toBe('none');
    expect(p.get('sni')).toBe('panel.example.com');
    expect(p.get('fp')).toBe('chrome');
  });

  it('روی پورت بدون TLS، security=none و sni/fp نمی‌آید', () => {
    const p = q(vlessLink(spec({ port: 8080 })));
    expect(p.get('security')).toBe('none');
    expect(p.has('sni')).toBe(false);
    expect(p.has('fp')).toBe(false);
    expect(p.has('alpn')).toBe(false);
  });

  it('flow برای XTLS تولید نمی‌شود (روی Worker ممکن نیست)', () => {
    // اگر روزی flow اضافه شود، کلاینت تلاش می‌کند XTLS بزند و اتصال می‌شکند.
    expect(q(vlessLink(spec())).has('flow')).toBe(false);
  });

  it('host از spec، وگرنه sni، وگرنه address', () => {
    expect(q(vlessLink(spec({ host: 'h.com', sni: 's.com' }))).get('host')).toBe('h.com');
    expect(q(vlessLink(spec({ sni: 's.com' }))).get('host')).toBe('s.com');
    expect(q(vlessLink(spec())).get('host')).toBe('panel.example.com');
  });

  it('مسیر بدون «/» ابتدایی اصلاح می‌شود', () => {
    expect(q(vlessLink(spec({ path: 'tunnel' }))).get('path')).toBe('/tunnel');
  });

  it('early-data فقط روی ws و فقط با مقدار مثبت می‌آید', () => {
    expect(q(vlessLink(spec({ maxEarlyData: 2560 }))).get('path')).toBe('/tunnel?ed=2560');
    expect(q(vlessLink(spec({ maxEarlyData: 0 }))).get('path')).toBe('/tunnel');
    expect(q(vlessLink(spec({ transport: 'httpupgrade', maxEarlyData: 2560 }))).get('path')).toBe('/tunnel');
  });

  it('مسیری که خودش query دارد با & ادامه می‌یابد', () => {
    expect(q(vlessLink(spec({ path: '/t?a=1', maxEarlyData: 100 }))).get('path')).toBe('/t?a=1&ed=100');
  });

  it('xhttp حالت stream-one می‌گیرد (تنها حالت ممکن روی Worker)', () => {
    const p = q(vlessLink(spec({ transport: 'xhttp' })));
    expect(p.get('type')).toBe('xhttp');
    expect(p.get('mode')).toBe('stream-one');
  });

  it('گزینه‌های کاربر (alpn/fp/sni/allowInsecure) اعمال می‌شوند', () => {
    const opts: GenOpts = { fingerprint: 'firefox', alpn: ['h2', 'http/1.1'], sni: 'cdn.example.com', allowInsecure: true };
    const p = q(vlessLink(spec({ opts })));
    expect(p.get('fp')).toBe('firefox');
    expect(p.get('alpn')).toBe('h2,http/1.1');
    expect(p.get('sni')).toBe('cdn.example.com');
    expect(p.get('allowInsecure')).toBe('1');
  });

  it('IPv6 داخل براکت می‌آید', () => {
    const u = new URL(vlessLink(spec({ address: '2606:4700::1' })));
    expect(u.hostname).toBe('[2606:4700::1]');
    expect(u.port).toBe('443');
  });

  it('IPv6ای که از قبل براکت دارد دوباره براکت نمی‌گیرد', () => {
    expect(new URL(vlessLink(spec({ address: '[2606:4700::1]' }))).hostname).toBe('[2606:4700::1]');
  });

  it('نام فارسی و کاراکترهای خاص در remark سالم برمی‌گردند', () => {
    const remark = 'ایران #۱ | 50% ← تست';
    const u = new URL(vlessLink(spec({ remark })));
    expect(decodeURIComponent(u.hash.slice(1))).toBe(remark);
    // remark نباید به query سرریز کند.
    expect(u.searchParams.has('type')).toBe(true);
  });
});

describe('trojanLink', () => {
  it('ساختار پایه', () => {
    const u = new URL(trojanLink(spec({ protocol: 'trojan', auth: 'mypassword' })));
    expect(u.protocol).toBe('trojan:');
    expect(decodeURIComponent(u.username)).toBe('mypassword');
    expect(u.hostname).toBe('panel.example.com');
  });

  it('رمزهایی که در URI معنی خاص دارند encode می‌شوند', () => {
    // `@` و `:` و `/` در رمز، بدون encode بخش authority را می‌شکنند.
    for (const pass of ['p@ss:word', 'a/b?c#d', 'رمز فارسی', 'p&q=r']) {
      const u = new URL(trojanLink(spec({ protocol: 'trojan', auth: pass })));
      expect(decodeURIComponent(u.username), pass).toBe(pass);
      expect(u.hostname, pass).toBe('panel.example.com');
      expect(u.port, pass).toBe('443');
    }
  });

  it('encryption ندارد (مخصوص vless است)', () => {
    expect(q(trojanLink(spec({ protocol: 'trojan' }))).has('encryption')).toBe(false);
  });

  it('پارامترهای transport مثل vless است', () => {
    const p = q(trojanLink(spec({ protocol: 'trojan', transport: 'httpupgrade', port: 2087 })));
    expect(p.get('type')).toBe('httpupgrade');
    expect(p.get('security')).toBe('tls');
  });
});

describe('vmessLink', () => {
  /** JSON درون لینک vmess. */
  function parse(link: string): Record<string, string> {
    expect(link.startsWith('vmess://')).toBe(true);
    const b64 = link.slice('vmess://'.length);
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, string>;
  }

  it('نسخه‌ی ۲ با کلیدهای رشته‌ای', () => {
    const o = parse(vmessLink(spec({ protocol: 'vmess' })));
    expect(o.v).toBe('2');
    expect(o.add).toBe('panel.example.com');
    expect(o.port).toBe('443');
    expect(o.id).toBe('11111111-2222-3333-4444-555555555555');
    expect(o.aid).toBe('0');
    expect(o.net).toBe('ws');
    expect(o.type).toBe('none');
    // v2rayN همه‌ی مقادیر را رشته می‌فرستد؛ عدد بعضی کلاینت‌ها را می‌شکند.
    for (const [k, v] of Object.entries(o)) expect(typeof v, k).toBe('string');
  });

  it('روی پورت TLS، tls/sni/fp پر است', () => {
    const o = parse(vmessLink(spec({ protocol: 'vmess', port: 8443 })));
    expect(o.tls).toBe('tls');
    expect(o.sni).toBe('panel.example.com');
    expect(o.fp).toBe('chrome');
  });

  it('روی پورت بدون TLS، tls/sni/fp خالی است (کلید حذف نمی‌شود)', () => {
    const o = parse(vmessLink(spec({ protocol: 'vmess', port: 80 })));
    expect(o.tls).toBe('');
    expect(o.sni).toBe('');
    expect(o.fp).toBe('');
    expect(o.alpn).toBe('');
    // بعضی کلاینت‌ها روی کلید غایب خطا می‌دهند، پس باید حاضر و خالی باشد.
    expect(Object.keys(o)).toContain('tls');
  });

  it('security پیش‌فرض auto است و قابل تغییر', () => {
    expect(parse(vmessLink(spec({ protocol: 'vmess' }))).scy).toBe('auto');
    expect(parse(vmessLink(spec({ protocol: 'vmess', vmessSecurity: 'zero' }))).scy).toBe('zero');
  });

  it('نام فارسی از base64 سالم برمی‌گردد', () => {
    const remark = 'نود ایران ۱';
    expect(parse(vmessLink(spec({ protocol: 'vmess', remark }))).ps).toBe(remark);
  });

  it('early-data در path می‌آید', () => {
    expect(parse(vmessLink(spec({ protocol: 'vmess', maxEarlyData: 2560 }))).path).toBe('/tunnel?ed=2560');
  });

  it('IPv6 در add بدون براکت است (قالب JSON براکت نمی‌خواهد)', () => {
    expect(parse(vmessLink(spec({ protocol: 'vmess', address: '2606:4700::1' }))).add).toBe('2606:4700::1');
  });
});

describe('ssLink', () => {
  /** userinfo لینک ss را باز می‌کند (base64url بدون padding). */
  function creds(link: string): { method: string; password: string } {
    const u = new URL(link);
    const raw = decodeURIComponent(u.username);
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const txt = Buffer.from(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='), 'base64').toString('utf8');
    const i = txt.indexOf(':');
    return { method: txt.slice(0, i), password: txt.slice(i + 1) };
  }

  it('قالب SIP002 با userinfo بیس‌۶۴', () => {
    const link = ssLink(spec({ protocol: 'shadowsocks', auth: 'secret123', ssMethod: 'aes-256-gcm' }));
    const u = new URL(link);
    expect(u.protocol).toBe('ss:');
    expect(u.hostname).toBe('panel.example.com');
    expect(creds(link)).toEqual({ method: 'aes-256-gcm', password: 'secret123' });
  });

  it('روش پیش‌فرض aes-128-gcm است', () => {
    expect(creds(ssLink(spec({ protocol: 'shadowsocks', auth: 'p' }))).method).toBe('aes-128-gcm');
  });

  it('رمزی که بیس‌۶۴ استاندارد آن «/» می‌سازد لینک را نمی‌شکند', () => {
    // `aes-128-gcm:pa?s` در base64 استاندارد به `…cGE/cw==` می‌رسد و آن «/»
    // بخش authority را می‌بندد: میزبان می‌شود بخشی از userinfo و پورت گم می‌شود.
    // base64url این را حذف می‌کند. این تست دقیقاً همان رگرسیون را می‌گیرد.
    for (const pass of ['pa?s', 'xÿy', 'p+q/r', 'ÿþ', 'رمز', '~'.repeat(5)]) {
      const link = ssLink(spec({ protocol: 'shadowsocks', auth: pass }));
      const u = new URL(link);
      expect(u.hostname, pass).toBe('panel.example.com');
      expect(u.port, pass).toBe('443');
      expect(u.pathname, pass).toBe('');
      expect(creds(link).password, pass).toBe(pass);
    }
  });

  it('userinfo هیچ‌وقت «/» یا «+» یا «=» ندارد', () => {
    for (let i = 0; i < 200; i++) {
      const pass = Buffer.from(Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('latin1');
      const raw = new URL(ssLink(spec({ protocol: 'shadowsocks', auth: pass }))).username;
      expect(raw, pass).not.toMatch(/[/+=]/);
    }
  });

  it('روی TLS، security و sni ست می‌شود', () => {
    const p = q(ssLink(spec({ protocol: 'shadowsocks', port: 2096 })));
    expect(p.get('security')).toBe('tls');
    expect(p.get('sni')).toBe('panel.example.com');
  });

  it('روی پورت بدون TLS، security نمی‌آید', () => {
    const p = q(ssLink(spec({ protocol: 'shadowsocks', port: 2052 })));
    expect(p.has('security')).toBe(false);
    expect(p.has('sni')).toBe(false);
  });

  it('IPv6 داخل براکت می‌آید', () => {
    expect(new URL(ssLink(spec({ protocol: 'shadowsocks', address: '2606::1' }))).hostname).toBe('[2606::1]');
  });
});

describe('buildLink', () => {
  it('هر پروتکل به سازنده‌ی خودش می‌رود', () => {
    const cases: Array<[LinkSpec['protocol'], string]> = [
      ['vless', 'vless://'],
      ['vmess', 'vmess://'],
      ['trojan', 'trojan://'],
      ['shadowsocks', 'ss://'],
    ];
    for (const [protocol, prefix] of cases) {
      expect(buildLink(spec({ protocol })).startsWith(prefix), protocol).toBe(true);
    }
  });

  it('خروجی هر پروتکل با سازنده‌ی مستقیمش یکسان است', () => {
    const s = spec({ remark: 'x' });
    expect(buildLink({ ...s, protocol: 'vless' })).toBe(vlessLink({ ...s, protocol: 'vless' }));
    expect(buildLink({ ...s, protocol: 'vmess' })).toBe(vmessLink({ ...s, protocol: 'vmess' }));
    expect(buildLink({ ...s, protocol: 'trojan' })).toBe(trojanLink({ ...s, protocol: 'trojan' }));
    expect(buildLink({ ...s, protocol: 'shadowsocks' })).toBe(ssLink({ ...s, protocol: 'shadowsocks' }));
  });

  it('همه‌ی ترکیب‌های پروتکل × ترنسپورت × پورت لینکِ پارس‌شدنی می‌دهند', () => {
    for (const protocol of ['vless', 'vmess', 'trojan', 'shadowsocks'] as const) {
      for (const transport of ['ws', 'httpupgrade', 'xhttp'] as const) {
        for (const port of [443, 80, 2053, 8880]) {
          const link = buildLink(spec({ protocol, transport, port }));
          const tag = `${protocol}/${transport}/${port}`;
          if (protocol === 'vmess') {
            const o = JSON.parse(Buffer.from(link.slice(8), 'base64').toString('utf8')) as Record<string, string>;
            expect(o.port, tag).toBe(String(port));
          } else {
            expect(new URL(link).port, tag).toBe(String(port));
          }
        }
      }
    }
  });
});



