/**
 * ایمپورت از x-ui (3x-ui) — مهاجرت بدون دست‌بردن به دیتابیس.
 *
 * ورودی: خروجی JSON پنل x-ui، یعنی آبجکتی با `inbounds` یا خودِ آرایه‌ی
 * inbounds. فیلدهای مشکل‌ساز (reality، grpc، kcp، flow=xtls-*) پرش می‌شوند با
 * هشدار — Worker فقط TLS خود لبه را دارد و Reality معنا ندارد.
 *
 * چرا نرمال‌سازی سخت‌گیرانه: به‌جای «هرچه بود بریز تو دیتابیس»، هر inbound به
 * شکل مدل خودمان بازسازی می‌شود؛ کلاینت‌ها توکن ساب تازه می‌گیرند و مصرف از صفر
 * شروع می‌شود (ترافیک قدیمی x-ui قابل انتقال نیست و قیدش در پیام هست).
 */
import { randomId, uuidv4 } from '../lib/crypto';
import { invalidateClients } from '../proxy/store';
import type { Env } from '../types';

const GB = 1024 * 1024 * 1024;

interface XuiClient {
  id?: string;
  password?: string;
  email?: string;
  totalGB?: number;
  expiryTime?: number;
  limitIp?: number;
  tgId?: string | number;
  enable?: boolean;
  method?: string;
  flow?: string;
}

interface XuiInbound {
  port?: number;
  protocol?: string;
  tag?: string;
  settings?: string | { clients?: XuiClient[] };
  streamSettings?: string | {
    network?: string;
    security?: string;
    wsSettings?: { path?: string; headers?: Record<string, string> };
    tlsSettings?: { serverName?: string };
  };
  total?: number;
  expiryTime?: number;
}

export interface ImportResult {
  ok: boolean;
  inbounds: number;
  clients: number;
  skipped: number;
  warnings: string[];
}

function asObject(v: unknown): Record<string, unknown> {
  if (!v) return {};
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v !== 'string') return {};
  try {
    const j = JSON.parse(v) as unknown;
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeTransport(network: string | undefined): 'ws' | 'httpupgrade' | 'xhttp' | null {
  switch ((network ?? '').toLowerCase()) {
    case 'ws':
      return 'ws';
    case 'httpupgrade':
      return 'httpupgrade';
    case 'xhttp':
    case 'splithttp':
      return 'xhttp';
    default:
      // grpc/kcp/tcp در Worker معنا ندارند — به ws نمی‌چرخانیم چون کار نمی‌کند
      // و بهتر است مدیر بداند و تصمیم بگیرد.
      return null;
  }
}

function expirySeconds(t: number | undefined): number {
  if (!t || t < 0) return 0;
  // x-ui میلی‌ثانیه ذخیره می‌کند؛ اعداد کوچک‌تر از 1e11 ثانیه‌اند.
  return t > 1e11 ? Math.round(t / 1000) : Math.round(t);
}
export async function importXui(env: Env, data: unknown): Promise<ImportResult> {
  const warnings: string[] = [];
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const list = (Array.isArray(data) ? data : raw.inbounds) as XuiInbound[] | undefined;
  if (!Array.isArray(list) || !list.length) {
    return {
      ok: false,
      inbounds: 0,
      clients: 0,
      skipped: 0,
      warnings: ['ساختار شناخته نشد — خروجی 3x-ui باید «inbounds» داشته باشد'],
    };
  }

  const clientPlan: Array<{ inboundId: number; clients: XuiClient[]; protocol: string; method: string }> = [];
  let skipped = 0;
  let clientCount = 0;

  for (const [i, ib] of list.entries()) {
    const port = Math.floor(Number(ib.port) || 0);
    const protocol = (ib.protocol ?? '').toLowerCase();
    if (!port || !['vless', 'vmess', 'trojan', 'shadowsocks'].includes(protocol)) {
      warnings.push(`inbound #${i + 1}: پروتکل «${ib.protocol || '?'}» پشتیبانی نمی‌شود — پرش شد`);
      skipped++;
      continue;
    }

    const stream = asObject(ib.streamSettings);
    const security = (stream.security as string) ?? '';
    if (security === 'reality') {
      warnings.push(`inbound «${ib.tag ?? port}»: Reality روی Worker قابل اجرا نیست — پرش شد`);
      skipped++;
      continue;
    }
    const transport = safeTransport(stream.network as string | undefined);
    if (!transport) {
      warnings.push(
        `inbound «${ib.tag ?? port}»: ترنسپورت «${(stream.network as string) || '?'}» روی Worker کار نمی‌کند — پرش شد`,
      );
      skipped++;
      continue;
    }

    const ws = asObject(stream.wsSettings);
    const headers = ws.headers as Record<string, string> | undefined;
    const host = String(headers?.Host ?? headers?.host ?? '').trim();
    const sni = security === 'tls' ? String(asObject(stream.tlsSettings).serverName ?? '').trim() : '';
    const settings = asObject(ib.settings);
    const clients = Array.isArray(settings.clients) ? (settings.clients as XuiClient[]) : [];
    const ssMethod = protocol === 'shadowsocks' ? String(clients[0]?.method ?? settings.method ?? 'aes-128-gcm') : 'aes-128-gcm';

    const res = await env.DB.prepare(
      `INSERT INTO inbounds (tag, remark, enable, protocol, transport, path, host, sni, ports, ss_method)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        `xui-${String(ib.tag || port).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || port}`,
        `x-ui ${String(ib.tag ?? '').slice(0, 32)}`.trim(),
        1,
        protocol,
        transport,
        String(ws.path ?? '/') || '/',
        host,
        sni,
        JSON.stringify([port]),
        ssMethod,
      )
      .run();
    clientPlan.push({ inboundId: Number(res.meta.last_row_id), clients, protocol, method: ssMethod });
  }

  // حالا کلاینت‌ها — هر کدام با auth متناسب پروتکل و توکن ساب تازه.
  for (const plan of clientPlan) {
    for (const c of plan.clients) {
      const auth =
        plan.protocol === 'vless' || plan.protocol === 'vmess'
          ? String(c.id ?? '').trim() || uuidv4()
          : String(c.password ?? c.id ?? '').trim() || randomId(16);
      const name = String(c.email ?? '').trim().replace(/@.*$/, '').slice(0, 64) || `user${clientCount + 1}`;
      if (c.flow) warnings.push(`«${name}»: flow «${c.flow}» نادیده گرفته شد (XTLS روی Worker نیست)`);
      await env.DB.prepare(
        `INSERT INTO clients (inbound_id, name, auth, enable, total_gb, expiry_at, limit_ip, sub_token, tg_chat_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          plan.inboundId,
          name,
          auth,
          c.enable === false ? 0 : 1,
          Math.max(0, (Number(c.totalGB) || 0) / GB),
          expirySeconds(c.expiryTime),
          Math.max(0, Math.floor(Number(c.limitIp) || 0)),
          randomId(16),
          c.tgId ? String(c.tgId) : '',
        )
        .run();
      clientCount++;
    }
  }

  invalidateClients();
  return { ok: true, inbounds: clientPlan.length, clients: clientCount, skipped, warnings: warnings.slice(0, 30) };
}

