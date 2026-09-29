/**
 * تست پارس «مسیر داینامیک»: `/vl/proxyip=1.2.3.4:2087`.
 *
 * این تنها ورودیِ **کاربر** است که به گزینه‌های دیال ترجمه می‌شود، پس دو خطر
 * دارد: یکی اینکه مسیر پایه را خراب بخواند و inbound پیدا نشود (سرویس کاربر
 * قطع)، دیگری اینکه بخشی از مسیر را به‌اشتباه دستور بفهمد. هر دو با پارسِ
 * دوباره‌ی خروجی سنجیده می‌شوند، نه با مقایسه‌ی رشته‌ای.
 */
import { describe, expect, it } from 'vitest';
import { isWsUpgrade, splitDynamicPath } from '../src/proxy/entry';

describe('splitDynamicPath — مسیر پایه', () => {
  it('مسیر بدون بخش داینامیک دست‌نخورده می‌ماند', () => {
    expect(splitDynamicPath('/tunnel')).toEqual({ base: '/tunnel' });
    expect(splitDynamicPath('/a/b/c')).toEqual({ base: '/a/b/c' });
  });

  it('مسیر ریشه به «/» می‌رسد', () => {
    expect(splitDynamicPath('/').base).toBe('/');
  });

  it('حذف همه‌ی بخش‌ها به «/» برمی‌گردد نه رشته‌ی خالی', () => {
    // رشته‌ی خالی با هیچ inboundای جور نمی‌شود و درخواست بی‌دلیل ۴۲۶ می‌گیرد.
    expect(splitDynamicPath('/proxyip=1.2.3.4').base).toBe('/');
  });

  it('بخش داینامیک از میان مسیر هم برداشته می‌شود', () => {
    const out = splitDynamicPath('/a/proxyip=1.2.3.4/b');
    expect(out.base).toBe('/a/b');
    expect(out.proxyip).toBe('1.2.3.4');
  });
});

describe('splitDynamicPath — کلیدها', () => {
  it('proxyip و مترادفش proxy', () => {
    expect(splitDynamicPath('/t/proxyip=1.2.3.4').proxyip).toBe('1.2.3.4');
    expect(splitDynamicPath('/t/proxy=1.2.3.4').proxyip).toBe('1.2.3.4');
  });

  it('nat64 و trojan', () => {
    expect(splitDynamicPath('/t/nat64=2602:fc59:b0:64::').nat64).toBe('2602:fc59:b0:64::');
    expect(splitDynamicPath('/t/trojan=srv.com:443:pass').trojan).toBe('srv.com:443:pass');
  });

  it('کلید بی‌توجه به بزرگی حروف شناخته می‌شود', () => {
    expect(splitDynamicPath('/t/ProxyIP=1.2.3.4').proxyip).toBe('1.2.3.4');
    expect(splitDynamicPath('/t/NAT64=x').nat64).toBe('x');
  });

  it('چند کلید با هم', () => {
    const out = splitDynamicPath('/t/proxyip=1.2.3.4/nat64=2602::/trojan=a.com:443:p');
    expect(out).toEqual({ base: '/t', proxyip: '1.2.3.4', nat64: '2602::', trojan: 'a.com:443:p' });
  });

  it('کلید تکراری، آخرین مقدار برنده است', () => {
    expect(splitDynamicPath('/t/proxyip=1.1.1.1/proxyip=2.2.2.2').proxyip).toBe('2.2.2.2');
  });

  it('کلید ناشناس در مسیر می‌ماند', () => {
    // یک inbound می‌تواند مسیری با «=» داشته باشد؛ نباید بی‌صدا بریده شود.
    const out = splitDynamicPath('/t/token=abc');
    expect(out.base).toBe('/t/token=abc');
    expect(out.proxyip).toBeUndefined();
  });

  it('مقدارِ URL-encoded باز می‌شود', () => {
    expect(splitDynamicPath('/t/proxyip=%5B2606%3A4700%3A%3A1%5D%3A2087').proxyip).toBe('[2606:4700::1]:2087');
    expect(splitDynamicPath('/t/trojan=a.com%3A443%3Ap%40ss').trojan).toBe('a.com:443:p@ss');
  });
});

describe('splitDynamicPath — ورودی مخرب یا بی‌ریخت', () => {
  it('مقدار خالی همان کلید را با رشته‌ی خالی می‌دهد', () => {
    // لایه‌ی بالاتر مقدار خالی را نادیده می‌گیرد (`if (ov.proxyip)`)، ولی مسیر
    // پایه باید تمیز شود.
    const out = splitDynamicPath('/t/proxyip=');
    expect(out.proxyip).toBe('');
    expect(out.base).toBe('/t');
  });

  it('«=» در ابتدای بخش کلید حساب نمی‌شود', () => {
    expect(splitDynamicPath('/t/=abc').base).toBe('/t/=abc');
  });

  it('چند «=» فقط اولی جداکننده است', () => {
    expect(splitDynamicPath('/t/proxyip=a=b').proxyip).toBe('a=b');
  });

  it('مقدار با درصدِ ناقص خطا نمی‌دهد', () => {
    // `decodeURIComponent('%zz')` پرتاب می‌کند؛ اگر مهار نشده باشد یک درخواست
    // ساده کل Worker را به ۵۰۰ می‌برد.
    expect(() => splitDynamicPath('/t/proxyip=%zz')).not.toThrow();
    expect(() => splitDynamicPath('/t/proxyip=%')).not.toThrow();
    expect(() => splitDynamicPath('/t/nat64=%E0%A4%A')).not.toThrow();
  });

  it('مسیر خالی و بدون اسلش', () => {
    expect(splitDynamicPath('').base).toBe('/');
    expect(splitDynamicPath('tunnel').base).toBe('tunnel');
  });

  it('مسیر طولانی با بخش‌های زیاد', () => {
    const long = '/t' + '/x'.repeat(200);
    expect(splitDynamicPath(long).base).toBe(long);
  });
});

describe('isWsUpgrade', () => {
  it('هدر websocket با هر حالت حروف پذیرفته می‌شود', () => {
    for (const v of ['websocket', 'WebSocket', 'WEBSOCKET']) {
      expect(isWsUpgrade(new Request('https://x.com', { headers: { upgrade: v } })), v).toBe(true);
    }
  });

  it('بدون هدر یا با مقدار دیگر false است', () => {
    expect(isWsUpgrade(new Request('https://x.com'))).toBe(false);
    expect(isWsUpgrade(new Request('https://x.com', { headers: { upgrade: 'h2c' } }))).toBe(false);
  });
});
