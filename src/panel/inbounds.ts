/**
 * inboundها — مدل x-ui روی Worker.
 *
 * تفاوت مهم با x-ui: «پورت» اینجا یک عدد نیست بلکه **فهرست** پورت‌های لبه‌ی
 * کلادفلر است. یک Worker روی همه‌ی پورت‌های TLS همزمان گوش می‌دهد، پس پورت
 * جزئی از inbound نیست و فقط در تولید ساب استفاده می‌شود.
 *
 * چیزی که واقعاً یک inbound را از دیگری جدا می‌کند `path` است: مسیر WS همان
 * چیزی است که در روتر به inbound نگاشت می‌شود، پس **باید یکتا باشد**.
 */
import { randomId } from '../lib/crypto';
import { invalidateClients } from '../proxy/store';
import { HttpError } from './clients';
import { TLS_PORTS, type Env, type Protocol, type Transport } from '../types';

const PROTOCOLS = new Set<Protocol>(['vless', 'vmess', 'trojan', 'shadowsocks']);
const TRANSPORTS = new Set<Transport>(['ws', 'httpupgrade', 'xhttp']);
const RESETS = new Set(['never', 'daily', 'weekly', 'monthly']);

export async function listInbounds(env: Env): Promise<unknown[]> {
  const rows = await env.DB.prepare(
    `SELECT i.*, (SELECT COUNT(*) FROM clients c WHERE c.inbound_id = i.id) AS clients_count
       FROM inbounds i ORDER BY i.id`,
  ).all<Record<string, unknown>>();
  return rows.results ?? [];
}

export interface InboundInput {
  id?: number;
  tag?: string;
  remark?: string;
  enable?: boolean;
  protocol?: string;
  transport?: string;
  path?: string;
  host?: string;
  sni?: string;
  ports?: number[] | string;
  max_early_data?: number;
  ss_method?: string;
  vmess_security?: string;
  total_gb?: number;
  traffic_reset?: string;
  expiry_at?: number;
  extra?: unknown;
}

/** ساخت یا ویرایش. `id` نداشته باشد → ساخت. */
export async function saveInbound(env: Env, input: InboundInput): Promise<{ id: number; path: string; tag: string }> {
  const protocol = (input.protocol ?? 'vless') as Protocol;
  if (!PROTOCOLS.has(protocol)) throw new HttpError(400, 'پروتکل نامعتبر');
  const transport = (input.transport ?? 'ws') as Transport;
  if (!TRANSPORTS.has(transport)) throw new HttpError(400, 'transport نامعتبر');

  const reset = input.traffic_reset ?? 'never';
  if (!RESETS.has(reset)) throw new HttpError(400, 'دوره‌ی ریست نامعتبر');

  const tag = (input.tag ?? '').trim() || `${protocol}-${randomId(5)}`;
  const path = normalizePath(input.path ?? '') || `/${randomId(10)}`;
  const ports = JSON.stringify(normalizePorts(input.ports));
  const extra = typeof input.extra === 'string' ? input.extra : JSON.stringify(input.extra ?? {});

  // مسیر باید یکتا باشد، وگرنه روتر نمی‌داند اتصال به کدام inbound تعلق دارد.
  const clash = await env.DB.prepare('SELECT id FROM inbounds WHERE path = ? AND id != ?')
    .bind(path, input.id ?? 0)
    .first<{ id: number }>();
  if (clash) throw new HttpError(409, `مسیر «${path}» قبلاً استفاده شده`);

  const args = [
    tag,
    input.remark ?? '',
    input.enable === false ? 0 : 1,
    protocol,
    transport,
    path,
    input.host ?? '',
    input.sni ?? '',
    ports,
    Math.max(0, Math.floor(input.max_early_data ?? 2560)),
    input.ss_method ?? 'aes-128-gcm',
    input.vmess_security ?? 'auto',
    Math.max(0, input.total_gb ?? 0),
    reset,
    Math.max(0, Math.floor(input.expiry_at ?? 0)),
    extra,
  ];

  let id = input.id ?? 0;
  if (id > 0) {
    await env.DB.prepare(
      `UPDATE inbounds SET tag=?, remark=?, enable=?, protocol=?, transport=?, path=?, host=?, sni=?,
              ports=?, max_early_data=?, ss_method=?, vmess_security=?, total_gb=?, traffic_reset=?,
              expiry_at=?, extra=? WHERE id=?`,
    )
      .bind(...args, id)
      .run();
  } else {
    const res = await env.DB.prepare(
      `INSERT INTO inbounds (tag, remark, enable, protocol, transport, path, host, sni, ports,
                             max_early_data, ss_method, vmess_security, total_gb, traffic_reset, expiry_at, extra)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(...args)
      .run();
    id = Number(res.meta.last_row_id);
  }

  invalidateClients();
  return { id, path, tag };
}

export async function deleteInbound(env: Env, id: number): Promise<number> {
  // کلاینت‌ها با CASCADE پاک می‌شوند؛ این عمداً است چون یک inbound بدون کاربر
  // معنی ندارد و نگه‌داشتن کاربر بی‌inbound به رکورد یتیم منجر می‌شد.
  const r = await env.DB.prepare('DELETE FROM inbounds WHERE id = ?').bind(id).run();
  invalidateClients();
  return r.meta.changes ?? 0;
}

/** مسیر را به فرم `/xxx` می‌برد و کاراکترهای ناامن را حذف می‌کند. */
export function normalizePath(raw: string): string {
  const t = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!t) return '';
  // مسیر در URL می‌نشیند و با `=` هم مسیر داینامیک تفسیر می‌شود، پس محدودش می‌کنیم.
  const clean = t.replace(/[^A-Za-z0-9._~/-]/g, '');
  return clean ? `/${clean}` : '';
}

function normalizePorts(raw: number[] | string | undefined): number[] {
  if (Array.isArray(raw)) {
    const out = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    if (out.length) return [...new Set(out)];
  }
  if (typeof raw === 'string') {
    const out = raw
      .split(/[,\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    if (out.length) return [...new Set(out)];
  }
  return [...TLS_PORTS];
}
