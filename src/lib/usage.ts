/**
 * انباشت آمار مصرف در حافظه‌ی isolate و نوشتن دسته‌ای در D1.
 *
 * چرا اینجا و نه در مسیر داده: KV روی Free فقط ۱۰۰۰ write در روز دارد و D1 هم
 * سقف ۵۰ کوئری در هر invocation. اگر هر بسته یا هر نشست یک UPDATE بزند، هم
 * سهمیه می‌سوزد و هم تأخیر به مسیر داده اضافه می‌شود. پس:
 *   • هر نشست دلتای خودش را در یک Map در سطح isolate جمع می‌کند
 *   • `flush()` با `waitUntil` بعد از پایان نشست اجرا می‌شود (بیرون از مسیر پاسخ)
 *   • نوشتن‌ها در `DB.batch` جمع می‌شوند
 *
 * دقت آمار حفظ می‌شود چون دلتاها با `up = up + ?` جمع می‌شوند، نه با set.
 * سقف ترافیک هم درست می‌ماند چون `pendingOf()` بایت‌های هنوز-نوشته‌نشده را به
 * محاسبه‌ی سقف اضافه می‌کند.
 */
import type { Env } from '../types';

/** دلتای یک کاربر از آخرین flush. */
interface Delta {
  up: number;
  down: number;
  lastOnline: number;
  /** روز → {up, down} برای جدول آمار روزانه. */
  days: Map<string, { up: number; down: number }>;
  /** IPهای دیده‌شده در این بازه، با colo. */
  ips: Map<string, string>;
  /** آیا این کاربر باید فعال شود (شروع تعویقی، اولین اتصال). */
  activate: boolean;
}

/** دلتاهای انباشته‌ی این isolate. */
const pending = new Map<number, Delta>();
/** دلتای هر inbound (برای آمار per-inbound در پنل). */
const pendingInbound = new Map<number, { up: number; down: number }>();
/** نام نودی که آمار به اسم آن ثبت می‌شود. */
let nodeName = 'local';

export function setNodeName(name: string): void {
  nodeName = name || 'local';
}

function slot(clientId: number): Delta {
  let d = pending.get(clientId);
  if (!d) {
    d = { up: 0, down: 0, lastOnline: 0, days: new Map(), ips: new Map(), activate: false };
    pending.set(clientId, d);
  }
  return d;
}

/** روز UTC به قالب `YYYY-MM-DD` — کلید جدول آمار روزانه. */
export function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface RecordOpts {
  ip?: string;
  colo?: string;
  /** inbound برای آمار تفکیکی. */
  inboundId?: number;
  /** اولین اتصالِ کاربرِ «شروع تعویقی». */
  activate?: boolean;
  at?: number;
}

/** مصرف یک نشست را ثبت می‌کند. */
export function record(clientId: number, up: number, down: number, opts: RecordOpts = {}): void {
  const at = opts.at ?? Date.now();
  const d = slot(clientId);
  d.up += up;
  d.down += down;
  d.lastOnline = Math.max(d.lastOnline, Math.floor(at / 1000));
  if (opts.activate) d.activate = true;

  if (up > 0 || down > 0) {
    const key = utcDay(at);
    const day = d.days.get(key);
    if (day) {
      day.up += up;
      day.down += down;
    } else {
      d.days.set(key, { up, down });
    }

    if (opts.inboundId !== undefined) {
      const ib = pendingInbound.get(opts.inboundId);
      if (ib) {
        ib.up += up;
        ib.down += down;
      } else {
        pendingInbound.set(opts.inboundId, { up, down });
      }
    }
  }

  if (opts.ip) d.ips.set(opts.ip, opts.colo ?? '');
}

/**
 * بایت‌های ثبت‌شده‌ی یک کاربر که هنوز در D1 نوشته نشده‌اند.
 * بدون این، کاربر می‌توانست در فاصله‌ی دو flush از سقف ترافیکش رد شود.
 */
export function pendingOf(clientId: number): number {
  const d = pending.get(clientId);
  return d ? d.up + d.down : 0;
}

/** آیا چیزی برای نوشتن هست؟ */
export function hasPending(): boolean {
  return pending.size > 0 || pendingInbound.size > 0;
}

/** برای تست: پاک کردن وضعیت isolate. */
export function resetUsage(): void {
  pending.clear();
  pendingInbound.clear();
  nodeName = 'local';
  flushing = null;
}

let flushing: Promise<void> | null = null;

/**
 * دلتاها را در D1 می‌نویسد.
 * اگر flush دیگری در جریان باشد، همان promise برگردانده می‌شود و دلتاهای تازه
 * در دور بعد نوشته می‌شوند — هیچ‌چیز گم نمی‌شود چون map قبل از نوشتن خالی می‌شود.
 */
export function flush(env: Env): Promise<void> {
  if (flushing) return flushing;
  if (!hasPending()) return Promise.resolve();

  const batch = new Map(pending);
  const inbounds = new Map(pendingInbound);
  pending.clear();
  pendingInbound.clear();

  flushing = writeBatch(env, batch, inbounds)
    .catch(() => {
      // شکست نوشتن: دلتاها را برمی‌گردانیم تا دور بعد دوباره تلاش شود.
      for (const [id, d] of batch) mergeBack(id, d);
      for (const [id, v] of inbounds) {
        const cur = pendingInbound.get(id);
        if (cur) {
          cur.up += v.up;
          cur.down += v.down;
        } else {
          pendingInbound.set(id, { ...v });
        }
      }
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

function mergeBack(id: number, d: Delta): void {
  const cur = slot(id);
  cur.up += d.up;
  cur.down += d.down;
  cur.lastOnline = Math.max(cur.lastOnline, d.lastOnline);
  cur.activate = cur.activate || d.activate;
  for (const [day, v] of d.days) {
    const x = cur.days.get(day);
    if (x) {
      x.up += v.up;
      x.down += v.down;
    } else {
      cur.days.set(day, { ...v });
    }
  }
  for (const [ip, colo] of d.ips) if (!cur.ips.has(ip)) cur.ips.set(ip, colo);
}

/** سقف عبارت‌های یک batch — با فاصله از سقف ۵۰ کوئریِ D1. */
const MAX_STATEMENTS = 40;

async function writeBatch(
  env: Env,
  batch: Map<number, Delta>,
  inbounds: Map<number, { up: number; down: number }>,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [];

  for (const [id, d] of batch) {
    if (d.up > 0 || d.down > 0 || d.lastOnline > 0) {
      stmts.push(
        env.DB.prepare(
          'UPDATE clients SET up = up + ?, down = down + ?, last_online = MAX(last_online, ?) WHERE id = ?',
        ).bind(d.up, d.down, d.lastOnline, id),
      );
    }

    // شروع تعویقی: اولین اتصال، مبنای انقضا را ست می‌کند. شرط `first_seen = 0`
    // باعث می‌شود این UPDATE فقط یک‌بار در عمر کاربر اثر کند.
    if (d.activate) {
      stmts.push(
        env.DB.prepare(
          'UPDATE clients SET first_seen = ?, ' +
            'expiry_at = CASE WHEN delayed_days > 0 THEN ? + delayed_days * 86400 ELSE expiry_at END ' +
            'WHERE id = ? AND first_seen = 0',
        ).bind(d.lastOnline, d.lastOnline, id),
      );
    }

    for (const [day, v] of d.days) {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO client_usage_daily (client_id, day, node, up, down) VALUES (?, ?, ?, ?, ?) ' +
            'ON CONFLICT(client_id, day, node) DO UPDATE SET up = up + excluded.up, down = down + excluded.down',
        ).bind(id, day, nodeName, v.up, v.down),
      );
    }

    for (const [ip, colo] of d.ips) {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO client_ips (client_id, ip, colo, last_seen) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(client_id, ip) DO UPDATE SET last_seen = excluded.last_seen, colo = excluded.colo',
        ).bind(id, ip, colo, d.lastOnline),
      );
    }
  }

  for (const [id, v] of inbounds) {
    stmts.push(env.DB.prepare('UPDATE inbounds SET up = up + ?, down = down + ? WHERE id = ?').bind(v.up, v.down, id));
  }

  for (let i = 0; i < stmts.length; i += MAX_STATEMENTS) {
    await env.DB.batch(stmts.slice(i, i + MAX_STATEMENTS));
  }
}
