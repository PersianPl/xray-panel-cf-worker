/**
 * تست فهرست‌سازی کانفیگ‌ها: پارس ورودی‌های مدیر، ضرب آدرس×پورت، و نام‌گذاری.
 *
 * تمرکز روی جاهایی است که ورودی **دستیِ** مدیر پارس می‌شود (`clean_ips`،
 * `custom_cdn`، `ports`). این‌ها تنها نقاطی‌اند که یک اشتباه تایپی می‌تواند
 * بی‌صدا به یک لینک بی‌مصرف تبدیل شود؛ بقیه‌ی مسیر از داده‌ی خودِ D1 می‌آید.
 */
import { describe, expect, it } from 'vitest';
import {
  buildConfigs,
  endpointsFor,
  humanBytes,
  parseCleanIps,
  parseCustomCdn,
  parsePorts,
  renderRemark,
  type SubContext,
} from '../src/sub/build';
import { DEFAULTS, Settings } from '../src/lib/settings';
import { TLS_PORTS } from '../src/types';

/** `Settings` با چند کلید بازنویسی‌شده روی پیش‌فرض‌ها. */
function conf(over: Record<string, string> = {}): Settings {
  return new Settings(new Map<string, string>([...Object.entries(DEFAULTS), ...Object.entries(over)]));
}

function ctx(over: Partial<SubContext> = {}): SubContext {
  return { selfHost: 'panel.example.com', nodes: [], settings: conf(), prefNode: '', ...over };
}

describe('parsePorts', () => {
  it('آرایه‌ی JSON معتبر', () => {
    expect(parsePorts('[443,2053,8443]')).toEqual([443, 2053, 8443]);
  });
  it('پورت‌های نامعتبر فیلتر می‌شوند', () => {
    expect(parsePorts('[443,0,65536,-1,"x",null,80]')).toEqual([443, 80]);
  });
  it('JSON خراب یا آرایه‌ی خالی → پیش‌فرض', () => {
    for (const raw of ['', 'x', '{}', '[]', '[0]', 'null']) {
      expect(parsePorts(raw), raw).toEqual([...TLS_PORTS]);
    }
  });
  it('پیش‌فرض قابل تعیین است (نود بدون پورت = بدون پورت)', () => {
    expect(parsePorts('', [])).toEqual([]);
    expect(parsePorts('[]', [8443])).toEqual([8443]);
  });
});

describe('parseCleanIps', () => {
  it('آدرس ساده، با و بدون برچسب', () => {
    expect(parseCleanIps('1.2.3.4')).toEqual([{ address: '1.2.3.4', label: '1.2.3.4', ports: [] }]);
    expect(parseCleanIps('1.2.3.4#تهران')).toEqual([{ address: '1.2.3.4', label: 'تهران', ports: [] }]);
  });

  it('پورت صریح به همان آدرس می‌چسبد', () => {
    expect(parseCleanIps('1.2.3.4:2087#A')).toEqual([{ address: '1.2.3.4', label: 'A', ports: [2087] }]);
  });

  it('IPv6 داخل براکت، با و بدون پورت', () => {
    expect(parseCleanIps('[2606:4700::1]')).toEqual([{ address: '2606:4700::1', label: '2606:4700::1', ports: [] }]);
    expect(parseCleanIps('[2606:4700::1]:8443#v6')).toEqual([{ address: '2606:4700::1', label: 'v6', ports: [8443] }]);
  });

  it('IPv6 بدون براکت به‌عنوان آدرس بدون پورت خوانده می‌شود', () => {
    // بیش از یک «:» یعنی نمی‌شود پورت را از آدرس تشخیص داد، پس همه‌اش آدرس است.
    expect(parseCleanIps('2606:4700::1')).toEqual([{ address: '2606:4700::1', label: '2606:4700::1', ports: [] }]);
  });

  it('چند خط، با خط خالی و کامنت', () => {
    const out = parseCleanIps('1.1.1.1#A\n\n# این یک کامنت است\n  2.2.2.2:443#B  \r\n3.3.3.3');
    expect(out.map((x) => x.address)).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
    expect(out[1]!.ports).toEqual([443]);
  });

  it('پورت نامعتبر خط را حذف می‌کند، نه فقط پورت را', () => {
    // اگر پورت را دور بیندازیم، `1.2.3.4:99999` تمامش آدرس می‌شود و لینک
    // بی‌مصرفی می‌سازد که مدیر دلیلش را نمی‌فهمد.
    for (const raw of ['1.2.3.4:99999', '1.2.3.4:0', '1.2.3.4:abc', '[2606::1]:70000', '[2606::1]junk']) {
      expect(parseCleanIps(raw), raw).toEqual([]);
    }
  });

  it('براکت بازِ بی‌بسته حذف می‌شود', () => {
    expect(parseCleanIps('[2606:4700::1')).toEqual([]);
    expect(parseCleanIps('[]:443')).toEqual([]);
  });

  it('برچسبِ خالی به آدرس برمی‌گردد', () => {
    expect(parseCleanIps('1.2.3.4#   ')[0]!.label).toBe('1.2.3.4');
  });

  it('برچسب می‌تواند خودش «#» داشته باشد', () => {
    expect(parseCleanIps('1.2.3.4#سرور #۲')[0]!.label).toBe('سرور #۲');
  });

  it('ورودی خالی → فهرست خالی', () => {
    for (const raw of ['', '\n\n', '   ', '# فقط کامنت']) expect(parseCleanIps(raw), JSON.stringify(raw)).toEqual([]);
  });
});

describe('parseCustomCdn', () => {
  it('address|host|sni|label', () => {
    expect(parseCustomCdn('cdn.example.com|h.example.com|s.example.com|MyCDN')).toEqual([
      { address: 'cdn.example.com', label: 'MyCDN', ports: [], host: 'h.example.com', sni: 's.example.com' },
    ]);
  });

  it('فیلدهای اختیاری غایب کلید تولید نمی‌کنند', () => {
    // کلید `host: undefined` در ادغام بعدی مقدار inbound را پاک می‌کند، پس
    // نبودنِ کلید مهم است نه فقط خالی بودنش.
    const out = parseCustomCdn('cdn.example.com')[0]!;
    expect(out).toEqual({ address: 'cdn.example.com', label: 'CDN', ports: [] });
    expect('host' in out).toBe(false);
    expect('sni' in out).toBe(false);
  });

  it('فیلد میانیِ خالی نادیده گرفته می‌شود', () => {
    const out = parseCustomCdn('cdn.example.com||s.example.com')[0]!;
    expect('host' in out).toBe(false);
    expect(out.sni).toBe('s.example.com');
  });

  it('برچسب پیش‌فرض CDN است', () => {
    expect(parseCustomCdn('a.com|b.com')[0]!.label).toBe('CDN');
  });

  it('خط بدون آدرس و کامنت رد می‌شود', () => {
    expect(parseCustomCdn('|h|s\n# c\n\n  ')).toEqual([]);
  });

  it('فاصله‌های اضافه پاک می‌شوند', () => {
    expect(parseCustomCdn('  a.com | h.com | s.com | L  ')[0]).toEqual({
      address: 'a.com',
      label: 'L',
      ports: [],
      host: 'h.com',
      sni: 's.com',
    });
  });
});

describe('renderRemark', () => {
  it('تگ‌های شناخته‌شده جایگزین می‌شوند', () => {
    expect(renderRemark('{WORKER}-{NODE}-{PORT}', { WORKER: 'PP', NODE: 'DE', PORT: '443' })).toBe('PP-DE-443');
  });

  it('تگ ناشناس حذف می‌شود و جداکننده‌ی اضافه نمی‌ماند', () => {
    expect(renderRemark('{WORKER}-{UNKNOWN}-{PORT}', { WORKER: 'PP', PORT: '443' })).toBe('PP-443');
  });

  it('تگ خالی در ابتدا و انتها جداکننده جا نمی‌گذارد', () => {
    expect(renderRemark('{X}-{WORKER}', { WORKER: 'PP' })).toBe('PP');
    expect(renderRemark('{WORKER}-{X}', { WORKER: 'PP' })).toBe('PP');
    expect(renderRemark('{X}-{Y}', {})).toBe('');
  });

  it('جداکننده‌ی سفارشی هم همان تمیزکاری را می‌گیرد', () => {
    expect(renderRemark('{A}|{B}|{C}', { A: 'x', C: 'z' }, '|')).toBe('x|z');
    expect(renderRemark('{A}·{B}', { B: 'b' }, '·')).toBe('b');
  });

  it('جداکننده‌ی regex-دار (مثل نقطه) به‌درستی escape می‌شود', () => {
    // بدون escape، `.` در regex همه‌چیز را می‌گیرد و نام کانفیگ نابود می‌شود.
    expect(renderRemark('{A}.{B}.{C}', { A: 'a', C: 'c' }, '.')).toBe('a.c');
    expect(renderRemark('{A}+{B}', { B: 'b' }, '+')).toBe('b');
    expect(renderRemark('{A}({B})', { A: 'a', B: 'b' }, '(')).toBe('a(b)');
  });

  it('متن ثابت و کاراکتر فارسی دست‌نخورده می‌ماند', () => {
    expect(renderRemark('ایران-{PORT}', { PORT: '443' })).toBe('ایران-443');
  });

  it('تگ باید حروف بزرگ باشد؛ حروف کوچک تگ نیست', () => {
    expect(renderRemark('{worker}-{PORT}', { worker: 'x', PORT: '443' })).toBe('{worker}-443');
  });

  it('جداکننده‌ی خالی به «-» برمی‌گردد', () => {
    expect(renderRemark('{A}-{B}', { B: 'b' }, '')).toBe('b');
  });

  it('تگ تکراری هر دو بار جایگزین می‌شود', () => {
    expect(renderRemark('{A}-{A}', { A: 'x' })).toBe('x-x');
  });
});

describe('humanBytes', () => {
  it('صفر و منفی', () => {
    expect(humanBytes(0)).toBe('0');
    expect(humanBytes(-5)).toBe('0');
  });

  it('واحد درست انتخاب می‌شود', () => {
    expect(humanBytes(512)).toBe('512B');
    expect(humanBytes(1024)).toBe('1.0KB');
    expect(humanBytes(1024 * 1024)).toBe('1.0MB');
    expect(humanBytes(1024 ** 3)).toBe('1.0GB');
    expect(humanBytes(1024 ** 4)).toBe('1.0TB');
  });

  it('بزرگ‌تر از TB در TB می‌ماند (واحد بعدی نداریم)', () => {
    expect(humanBytes(1024 ** 5)).toBe('1024TB');
  });

  it('بایت اعشار نمی‌گیرد', () => {
    expect(humanBytes(1023)).toBe('1023B');
  });

  it('از ۱۰۰ به بالا اعشار حذف می‌شود (نام کانفیگ کوتاه بماند)', () => {
    expect(humanBytes(Math.round(150.7 * 1024 ** 3))).toBe('151GB');
    expect(humanBytes(Math.round(99.5 * 1024 ** 2))).toBe('99.5MB');
  });
});

describe('endpointsFor', () => {
  it('دامنه‌ی خود پنل اول فهرست است', () => {
    const out = endpointsFor(ctx());
    expect(out[0]!.address).toBe('panel.example.com');
    expect(out[0]!.label).toBe('PersianPl');
    expect(out[0]!.ports).toEqual([]);
  });

  it('نودها بعد از پنل، با نام و منطقه در برچسب', () => {
    const out = endpointsFor(
      ctx({
        nodes: [
          { name: 'n1', host: 'n1.example.com', ports: '[443]', region: 'DE' },
          { name: 'n2', host: 'n2.example.com', ports: '', region: '' },
        ],
      }),
    );
    expect(out.map((x) => x.label)).toEqual(['PersianPl', 'n1-DE', 'n2']);
    expect(out[1]!.ports).toEqual([443]);
    // نودِ بدون پورت، پورت‌های inbound را می‌گیرد (نه پیش‌فرض TLS).
    expect(out[2]!.ports).toEqual([]);
  });

  it('نود ترجیحی: فقط همان نود، بدون دامنه‌ی پنل', () => {
    const nodes = [
      { name: 'n1', host: 'n1.example.com', ports: '', region: '' },
      { name: 'n2', host: 'n2.example.com', ports: '', region: '' },
    ];
    const out = endpointsFor(ctx({ nodes, prefNode: 'n2' }));
    expect(out.map((x) => x.address)).toEqual(['n2.example.com']);
  });

  it('نود ترجیحیِ «local» یعنی فقط دامنه‌ی پنل', () => {
    const nodes = [{ name: 'n1', host: 'n1.example.com', ports: '', region: '' }];
    expect(endpointsFor(ctx({ nodes, prefNode: 'local' })).map((x) => x.address)).toEqual(['panel.example.com']);
  });

  it('نود ترجیحیِ ناموجود فهرست را خالی می‌کند', () => {
    // اگر به دامنه‌ی پنل برگردیم، کاربری که عمداً به یک نود قید شده روی نود
    // اشتباه می‌رود؛ فهرست خالی خطای واضح‌تری است.
    const nodes = [{ name: 'n1', host: 'n1.example.com', ports: '', region: '' }];
    expect(endpointsFor(ctx({ nodes, prefNode: 'gone' }))).toEqual([]);
  });

  it('فاصله‌ی اضافه در نود ترجیحی نادیده گرفته می‌شود', () => {
    const nodes = [{ name: 'n1', host: 'n1.example.com', ports: '', region: '' }];
    expect(endpointsFor(ctx({ nodes, prefNode: '  n1  ' })).map((x) => x.address)).toEqual(['n1.example.com']);
  });

  it('IPهای تمیز و CDN سفارشی در انتها می‌آیند', () => {
    const out = endpointsFor(
      ctx({ settings: conf({ clean_ips: '1.2.3.4#A', custom_cdn: 'cdn.example.com|h.com|s.com|C' }) }),
    );
    expect(out.map((x) => x.label)).toEqual(['PersianPl', 'A', 'C']);
    expect(out[2]!.host).toBe('h.com');
  });

  it('عنوان خالی ساب به «Panel» برمی‌گردد', () => {
    expect(endpointsFor(ctx({ settings: conf({ sub_title: '' }) }))[0]!.label).toBe('Panel');
  });

  it('نودِ ترجیحی روی IPهای تمیز اثر ندارد', () => {
    // IP تمیز آدرس لبه‌ی کلادفلر است، نه نود؛ فیلترش کردن همه‌ی راه‌های
    // دورزدنِ فیلترینگ را از کاربرِ مقیدشده می‌گیرد.
    const nodes = [{ name: 'n1', host: 'n1.example.com', ports: '', region: '' }];
    const out = endpointsFor(ctx({ nodes, prefNode: 'n1', settings: conf({ clean_ips: '1.2.3.4#A' }) }));
    expect(out.map((x) => x.label)).toEqual(['n1', 'A']);
  });
});

/** `BuildInput` کمینه با پیش‌فرض‌های معقول. */
function input(over: Partial<Parameters<typeof buildConfigs>[0]> = {}): Parameters<typeof buildConfigs>[0] {
  return {
    ctx: ctx(),
    protocol: 'vless',
    transport: 'ws',
    auth: 'u-1',
    path: '/t',
    host: '',
    sni: '',
    maxEarlyData: 0,
    opts: {},
    inboundPorts: [443],
    remarkVars: {},
    max: 100,
    ...over,
  };
}

describe('buildConfigs', () => {
  it('آدرس × پورت ضرب می‌شود', () => {
    const out = buildConfigs(input({ inboundPorts: [443, 2053] }));
    expect(out.map((x) => x.spec.port)).toEqual([443, 2053]);
  });

  it('پورت خودِ مبدأ بر پورت inbound مقدم است', () => {
    const out = buildConfigs(
      input({
        ctx: ctx({ nodes: [{ name: 'n1', host: 'n1.com', ports: '[8443]', region: '' }] }),
        inboundPorts: [443],
      }),
    );
    expect(out.map((x) => [x.spec.address, x.spec.port])).toEqual([
      ['panel.example.com', 443],
      ['n1.com', 8443],
    ]);
  });

  it('سقف max دقیقاً رعایت می‌شود', () => {
    const out = buildConfigs(input({ inboundPorts: [443, 2053, 2087, 2096], max: 3 }));
    expect(out).toHaveLength(3);
  });

  it('سقف حتی با چند مبدأ هم نمی‌شکند', () => {
    const out = buildConfigs(
      input({
        ctx: ctx({ settings: conf({ clean_ips: '1.1.1.1#A\n2.2.2.2#B\n3.3.3.3#C' }) }),
        inboundPorts: [443, 2053, 2087],
        max: 5,
      }),
    );
    expect(out).toHaveLength(5);
  });

  it('host و sni مبدأ بر مقدار inbound مقدم است', () => {
    const out = buildConfigs(
      input({
        ctx: ctx({ settings: conf({ clean_ips: '', custom_cdn: 'cdn.com|cdnhost.com|cdnsni.com|C' }) }),
        host: 'ibhost.com',
        sni: 'ibsni.com',
      }),
    );
    expect(out[0]!.spec.host).toBe('ibhost.com');
    expect(out[1]!.spec.host).toBe('cdnhost.com');
    expect(out[1]!.spec.sni).toBe('cdnsni.com');
  });

  it('نام کانفیگ از الگوی تنظیمات ساخته می‌شود', () => {
    const out = buildConfigs(
      input({
        ctx: ctx({ settings: conf({ remark_template: '{NAME}|{NODE}|{PORT}', remark_separator: '|' }) }),
        remarkVars: { NAME: 'ali' },
      }),
    );
    expect(out[0]!.spec.remark).toBe('ali|PersianPl|443');
  });

  it('تگ‌های PROTO و HOST از خودِ کانفیگ پر می‌شوند', () => {
    const out = buildConfigs(
      input({
        ctx: ctx({ settings: conf({ remark_template: '{PROTO}-{HOST}' }) }),
        protocol: 'trojan',
      }),
    );
    expect(out[0]!.spec.remark).toBe('trojan-panel.example.com');
  });

  it('WORKER از remarkVars می‌آید و اگر نبود برچسب مبدأ', () => {
    const withVar = buildConfigs(
      input({ ctx: ctx({ settings: conf({ remark_template: '{WORKER}' }) }), remarkVars: { WORKER: 'MyPanel' } }),
    );
    expect(withVar[0]!.spec.remark).toBe('MyPanel');

    const noVar = buildConfigs(input({ ctx: ctx({ settings: conf({ remark_template: '{WORKER}' }) }) }));
    expect(noVar[0]!.spec.remark).toBe('PersianPl');
  });

  it('نامِ خالی به «برچسب-پورت» برمی‌گردد', () => {
    // یک کانفیگ بی‌نام در کلاینت گم می‌شود؛ باید همیشه چیزی داشته باشد.
    const out = buildConfigs(input({ ctx: ctx({ settings: conf({ remark_template: '{MISSING}' }) }) }));
    expect(out[0]!.spec.remark).toBe('PersianPl-443');
  });

  it('همه‌ی فیلدهای spec از ورودی منتقل می‌شوند', () => {
    const out = buildConfigs(
      input({
        protocol: 'vmess',
        transport: 'xhttp',
        auth: 'uuid-x',
        path: '/deep/path',
        maxEarlyData: 2560,
        vmessSecurity: 'zero',
        ssMethod: 'aes-256-gcm',
        opts: { fingerprint: 'safari' },
      }),
    );
    expect(out[0]!.spec).toMatchObject({
      protocol: 'vmess',
      transport: 'xhttp',
      auth: 'uuid-x',
      path: '/deep/path',
      maxEarlyData: 2560,
      vmessSecurity: 'zero',
      ssMethod: 'aes-256-gcm',
      opts: { fingerprint: 'safari' },
    });
  });

  it('مبدأ در خروجی همراه spec می‌آید', () => {
    const out = buildConfigs(input({ ctx: ctx({ settings: conf({ clean_ips: '9.9.9.9#Q' }) }) }));
    expect(out[1]!.endpoint.label).toBe('Q');
    expect(out[1]!.spec.address).toBe('9.9.9.9');
  });

  it('مبدأ بدون پورت و inbound بدون پورت → هیچ کانفیگی', () => {
    expect(buildConfigs(input({ inboundPorts: [] }))).toEqual([]);
  });

  it('الگوی خالی به پیش‌فرض {WORKER}-{PORT} برمی‌گردد', () => {
    const out = buildConfigs(input({ ctx: ctx({ settings: conf({ remark_template: '' }) }) }));
    expect(out[0]!.spec.remark).toBe('PersianPl-443');
  });

  it('cleanIpsExtra بعد از clean_ips دستی می‌آید', () => {
    const out = endpointsFor(
      ctx({
        settings: conf({ clean_ips: '1.1.1.1#دستی' }),
        cleanIpsExtra: '2.2.2.2#فچ‌شده\n3.3.3.3',
      }),
    );
    expect(out.map((x) => x.label)).toEqual(['PersianPl', 'دستی', 'فچ‌شده', '3.3.3.3']);
  });
});



