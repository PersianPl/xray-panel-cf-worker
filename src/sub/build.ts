/**
 * تولید فهرست کانفیگ‌های یک کاربر: ضربِ «آدرس‌ها × پورت‌ها × نودها».
 *
 * منابع آدرس، به‌ترتیب اولویت نمایش:
 *   1. دامنه‌ی خود پنل (میزبان همان درخواستِ ساب)
 *   2. نودهای فعال (اگر کاربر `pref_node` دارد، فقط همان)
 *   3. IPهای تمیز (`clean_ips` به‌صورت `IP#Name` یا `IP:PORT#Name`)
 *   4. CDN سفارشی (`custom_cdn` به‌صورت `address|host|sni`)
 *
 * چرا ضرب پورت‌ها: در ایران بعضی پورت‌های TLS کلادفلر باز و بعضی بسته‌اند و
 * این بین ISPها فرق می‌کند؛ دادن همه‌ی پورت‌ها به کلاینت یعنی کاربر خودش
 * سریع‌ترین را پیدا می‌کند. سقف `max_configs` جلوی فهرست هزارتایی را می‌گیرد.
 */
import { TLS_PORTS, type GenOpts } from '../types';
import type { Settings } from '../lib/settings';
import type { LinkSpec } from './links';

/** یک مبدأ اتصال. */
export interface Endpoint {
  address: string;
  /** برچسبی که در نام کانفیگ می‌آید (نام نود، نام IP تمیز، …). */
  label: string;
  /** پورت‌های مجاز این مبدأ. خالی = پورت‌های پیش‌فرض. */
  ports: number[];
  /** override هدر Host و SNI (برای CDN سفارشی). */
  host?: string;
  sni?: string;
}

export interface SubContext {
  /** میزبانِ درخواست (دامنه‌ی Worker یا دامنه‌ی شخصی). */
  selfHost: string;
  nodes: Array<{ name: string; host: string; ports: string; region: string }>;
  settings: Settings;
  /** نود ترجیحی کاربر؛ خالی = همه. */
  prefNode: string;
  /**
   * متن فچ‌شده از `clean_ips_url` (best-effort). همان قالب `clean_ips` است و
   * بعد از آن اعمال می‌شود — فهرست دستی مدیر همیشه اولویت نمایش دارد.
   */
  cleanIpsExtra?: string;
}

/** پورت‌های یک رشته‌ی JSON مثل `[443,2053]`؛ خطا → پیش‌فرض. */
export function parsePorts(raw: string, fallback: number[] = [...TLS_PORTS]): number[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) {
      const out = v.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
      if (out.length) return out;
    }
  } catch {
    /* پیش‌فرض */
  }
  return fallback;
}

/**
 * `IP#Name` یا `IP:PORT#Name` (یک در هر خط) → Endpoint.
 *
 * پورتِ صریحِ نامعتبر باعث **حذف** خط می‌شود، نه نادیده‌گرفتنش: اگر مدیر
 * `1.2.3.4:99999` بنویسد و پورت را دور بیندازیم، `1.2.3.4:99999` تمامش آدرس
 * می‌شود و لینکِ بی‌مصرف `[1.2.3.4:99999]` می‌سازد که تشخیصش برای کاربر سخت
 * است. حذف خط، غلط املایی را زودتر نشان می‌دهد.
 */
export function parseCleanIps(raw: string): Endpoint[] {
  const out: Endpoint[] = [];
  for (const line of raw.split(/[\r\n]+/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const hashIdx = t.indexOf('#');
    const addrPart = (hashIdx >= 0 ? t.slice(0, hashIdx) : t).trim();
    const label = hashIdx >= 0 ? t.slice(hashIdx + 1).trim() : '';
    if (!addrPart) continue;

    // IPv6 داخل براکت، وگرنه آخرین «:» پورت است.
    let address = addrPart;
    let ports: number[] = [];
    if (addrPart.startsWith('[')) {
      const close = addrPart.indexOf(']');
      if (close < 1) continue;
      address = addrPart.slice(1, close);
      const rest = addrPart.slice(close + 1);
      if (rest.startsWith(':')) {
        const p = Number(rest.slice(1));
        if (!Number.isInteger(p) || p <= 0 || p >= 65536) continue;
        ports = [p];
      } else if (rest) {
        continue; // چیزی جز پورت بعد از «]» بی‌معنی است
      }
    } else {
      const colons = (addrPart.match(/:/g) ?? []).length;
      if (colons === 1) {
        const i = addrPart.indexOf(':');
        const p = Number(addrPart.slice(i + 1));
        if (!Number.isInteger(p) || p <= 0 || p >= 65536) continue;
        address = addrPart.slice(0, i);
        ports = [p];
      }
    }
    if (!address) continue;
    out.push({ address, label: label || address, ports });
  }
  return out;
}

/** `address|host|sni` (یک در هر خط) → Endpoint با override هدرها. */
export function parseCustomCdn(raw: string): Endpoint[] {
  const out: Endpoint[] = [];
  for (const line of raw.split(/[\r\n]+/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [address, host, sni, label] = t.split('|').map((x) => x.trim());
    if (!address) continue;
    out.push({
      address,
      label: label || 'CDN',
      ports: [],
      ...(host ? { host } : {}),
      ...(sni ? { sni } : {}),
    });
  }
  return out;
}

/** همه‌ی مبدأهای اتصال یک کاربر. */
export function endpointsFor(ctx: SubContext): Endpoint[] {
  const s = ctx.settings;
  const out: Endpoint[] = [];
  const pref = ctx.prefNode.trim();

  if (!pref || pref === 'local') {
    out.push({ address: ctx.selfHost, label: s.get('sub_title') || 'Panel', ports: [] });
  }

  for (const n of ctx.nodes) {
    if (pref && pref !== n.name) continue;
    out.push({
      address: n.host,
      label: n.region ? `${n.name}-${n.region}` : n.name,
      ports: parsePorts(n.ports, []),
    });
  }

  out.push(...parseCleanIps(s.get('clean_ips')));
  if (ctx.cleanIpsExtra) out.push(...parseCleanIps(ctx.cleanIpsExtra));
  out.push(...parseCustomCdn(s.get('custom_cdn')));
  return out;
}

/**
 * الگوی نام کانفیگ را جایگزین می‌کند.
 * تگ‌های ناشناس حذف می‌شوند تا نام کانفیگ آشغال نداشته باشد.
 */
export function renderRemark(template: string, vars: Record<string, string>, separator = '-'): string {
  const out = template.replace(/\{([A-Z_]+)\}/g, (_m, key: string) => vars[key] ?? '');
  // جداکننده‌های تکراری و ابتدا/انتها که از تگ خالی مانده‌اند پاک می‌شوند.
  const sep = separator || '-';
  const esc = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return out
    .replace(new RegExp(`(${esc})+`, 'g'), sep)
    .replace(new RegExp(`^${esc}|${esc}$`, 'g'), '')
    .trim();
}

/** بایت به رشته‌ی خوانا (برای تگ `{usage}` در نام). */
export function humanBytes(n: number): string {
  if (n <= 0) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${u[i]}`;
}

export interface ConfigItem {
  spec: LinkSpec;
  endpoint: Endpoint;
}

export interface BuildInput {
  ctx: SubContext;
  protocol: LinkSpec['protocol'];
  transport: LinkSpec['transport'];
  auth: string;
  path: string;
  host: string;
  sni: string;
  maxEarlyData: number;
  vmessSecurity?: string;
  ssMethod?: string;
  opts: GenOpts;
  /** پورت‌های inbound (اگر مبدأ پورت خودش را نداشته باشد). */
  inboundPorts: number[];
  /** متغیرهای نام کانفیگ. */
  remarkVars: Record<string, string>;
  /** سقف تعداد کانفیگ. */
  max: number;
}

/** فهرست کانفیگ‌های نهایی (قبل از سریال‌سازی به هر فرمت). */
export function buildConfigs(input: BuildInput): ConfigItem[] {
  const s = input.ctx.settings;
  const template = s.get('remark_template') || '{WORKER}-{PORT}';
  const separator = s.get('remark_separator') || '-';
  const out: ConfigItem[] = [];

  for (const ep of endpointsFor(input.ctx)) {
    const ports = ep.ports.length ? ep.ports : input.inboundPorts;
    for (const port of ports) {
      if (out.length >= input.max) return out;
      const remark = renderRemark(
        template,
        {
          ...input.remarkVars,
          NODE: ep.label,
          WORKER: input.remarkVars.WORKER ?? ep.label,
          PORT: String(port),
          PROTO: input.protocol,
          HOST: ep.address,
        },
        separator,
      );
      out.push({
        endpoint: ep,
        spec: {
          protocol: input.protocol,
          transport: input.transport,
          address: ep.address,
          port,
          auth: input.auth,
          path: input.path,
          host: ep.host ?? input.host,
          sni: ep.sni ?? input.sni,
          remark: remark || `${ep.label}-${port}`,
          maxEarlyData: input.maxEarlyData,
          ...(input.vmessSecurity ? { vmessSecurity: input.vmessSecurity } : {}),
          ...(input.ssMethod ? { ssMethod: input.ssMethod } : {}),
          opts: input.opts,
        },
      });
    }
  }
  return out;
}
