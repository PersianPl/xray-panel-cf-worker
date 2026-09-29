/**
 * ورودی Worker — هر دو نقش panel و node از همین فایل بوت می‌شوند.
 *
 * مسیریابی (به‌ترتیب، چون اولویت امنیتی دارد):
 *   1. WebSocket upgrade → لایه‌ی پروکسی (مسیر inbound از D1)
 *   2. `/<panel_path>/…`  → پنل (مسیر مخفی و تصادفی در اولین بوت)
 *   3. `/<sub_path>/<token>` → صفحه و فایل اشتراک
 *   4. `/api/node/…`     → API نودها (احراز با HMAC)
 *   5. هر چیز دیگر       → سایت استتار
 *
 * چرا این ترتیب: مسیر پنل نباید با هیچ مسیر عمومی تصادم کند و مسیرهای ناشناس
 * هرگز نباید ۴۰۴ـی بدهند که وجود پنل را لو بدهد.
 */
import { settings } from './lib/settings';
import { runCron } from './lib/cron';
import { flush, setNodeName } from './lib/usage';
import { handleProxyRequest, isWsUpgrade } from './proxy/entry';
import { handleDoh } from './sub/doh';
import { bootstrap } from './panel/auth';
import { serveDecoy } from './panel/decoy';
import { handlePanel } from './panel/router';
import { handleSubscription } from './sub/router';
import { handleNodeApi } from './node/api';
import { nodeFetch, nodeScheduled } from './node/worker';
import type { Env } from './types';

/** بوت‌استرپ فقط یک‌بار در هر isolate اجرا می‌شود. */
let booted = false;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if ((env.ROLE ?? 'panel') === 'node') return nodeFetch(req, env, ctx);

    try {
      return await route(req, env, ctx);
    } catch (e) {
      // هیچ خطایی نباید متن استک را به بیرون بدهد؛ در لاگ Worker می‌ماند.
      console.error('unhandled', e instanceof Error ? e.stack : String(e));
      return new Response(null, { status: 500 });
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if ((env.ROLE ?? 'panel') === 'node') return nodeScheduled(env, ctx);
    ctx.waitUntil(flush(env));
    await runCron(env);
  },
};

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!booted) {
    booted = true;
    const b = await bootstrap(env);
    if (b.created) {
      // تنها جای چاپ رمز؛ در D1 فقط هش می‌نشیند.
      console.log(`PersianPl-Panel آماده شد → مسیر پنل: /${b.path}${b.password ? ` · رمز: ${b.password}` : ''}`);
    }
  }

  setNodeName(env.NODE_NAME ?? 'local');

  // ۱) پروکسی: هر upgrade که مسیرش inbound باشد.
  if (isWsUpgrade(req)) {
    const out = await handleProxyRequest(req, env, ctx);
    if (out.matched) return out.response;
    // مسیر ناشناس با upgrade → مثل یک سرور معمولی رفتار کن.
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  const s = await settings(env);
  const url = new URL(req.url);
  const seg = url.pathname.split('/').filter(Boolean);
  const first = seg[0] ?? '';

  // ۲) پنل
  const panelPath = s.get('panel_path');
  if (panelPath && first === panelPath) {
    return handlePanel(req, env, s, seg.slice(1));
  }

  // ۳) اشتراک
  const subPath = s.get('sub_path');
  if (subPath && first === subPath) {
    // ۳الف) DoH خود پنل — کلاینت‌ها Remote DNS را روی همین می‌گذارند.
    if (seg[1] === 'dns-query' && s.bool('doh_enable')) {
      return handleDoh(req, s.get('dns_underlying_doh') || 'https://cloudflare-dns.com/dns-query');
    }
    return handleSubscription(req, env, s, seg.slice(1));
  }

  // ۴) API نود
  if (first === 'api' && seg[1] === 'node') {
    return handleNodeApi(req, env, s, seg.slice(2), ctx);
  }

  // ۵) استتار
  return serveDecoy(req, s);
}
