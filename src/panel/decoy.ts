/**
 * سایت استتار (decoy) — هرچه مسیرش پنل و پروکسی و ساب نیست، اینجا می‌آید.
 *
 * چرا لازم است: یک Worker که به همه‌ی مسیرها ۴۰۴ می‌دهد در اسکن انبوه فوراً
 * مشکوک است. چهار حالت داریم:
 *   • `proxy`    → محتوای یک سایت واقعی را بازمی‌گرداند (باورپذیرترین)
 *   • `redirect` → ۳۰۲ به سایت هدف
 *   • `404`      → صفحه‌ی ۴۰۴ ساده
 *   • `1101`     → همان صفحه‌ی خطای معروف کلادفلر (Worker threw exception)
 *
 * حالت `proxy` هدرهای هویتِ درخواست را حذف می‌کند تا IP و کوکی کاربر به سایت
 * هدف نرود، و هدرهای پاسخ را هم از `set-cookie` پاک می‌کند.
 */
import type { Settings } from '../lib/settings';

/** هدرهایی که هرگز به سایت هدف فرستاده نمی‌شوند. */
const STRIP_REQUEST = [
  'cookie',
  'authorization',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
];

export async function serveDecoy(req: Request, s: Settings): Promise<Response> {
  const mode = s.get('decoy_mode');
  const target = s.get('decoy_target');

  if (mode === 'redirect' && target) {
    return Response.redirect(target, 302);
  }
  if (mode === '1101') return new Response(page1101(), { status: 500, headers: htmlHeaders() });
  if (mode === '404') return new Response(page404(), { status: 404, headers: htmlHeaders() });

  if (mode === 'proxy' && target) {
    const proxied = await proxyTo(req, target);
    if (proxied) return proxied;
  }
  return new Response(page404(), { status: 404, headers: htmlHeaders() });
}

function htmlHeaders(): HeadersInit {
  return { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
}

/** درخواست را به سایت هدف می‌فرستد و پاسخش را پاک‌سازی‌شده برمی‌گرداند. */
async function proxyTo(req: Request, target: string): Promise<Response | null> {
  let base: URL;
  try {
    base = new URL(target);
  } catch {
    return null;
  }

  const src = new URL(req.url);
  const dest = new URL(src.pathname + src.search, base);
  dest.protocol = base.protocol;

  const headers = new Headers(req.headers);
  for (const h of STRIP_REQUEST) headers.delete(h);
  headers.set('host', base.host);
  // Referer درخواست، دامنه‌ی Worker را لو می‌دهد.
  headers.set('referer', base.origin + '/');

  try {
    const upstream = await fetch(dest.toString(), {
      method: req.method === 'GET' || req.method === 'HEAD' ? req.method : 'GET',
      headers,
      redirect: 'follow',
    });
    const out = new Headers(upstream.headers);
    out.delete('set-cookie');
    out.delete('content-security-policy');
    out.delete('content-security-policy-report-only');
    out.delete('strict-transport-security');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return null;
  }
}

function page404(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 Not Found</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;
justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}div{text-align:center}
h1{font-size:3rem;margin:0 0 .5rem;font-weight:300}p{color:#888;margin:0}</style></head>
<body><div><h1>404</h1><p>The requested URL was not found on this server.</p></div></body></html>`;
}

function page1101(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Worker threw exception | Cloudflare</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;background:#fff;color:#313131}
.wrap{max-width:60rem;margin:0 auto;padding:2rem 1rem}h1{font-weight:500;font-size:1.6rem;border-bottom:1px solid #e6e6e6;padding-bottom:1rem}
.code{color:#bd2426;font-weight:600}.box{background:#f7f7f7;border:1px solid #e6e6e6;padding:1rem;margin-top:1rem;border-radius:4px}
footer{color:#888;font-size:.85rem;margin-top:2rem}</style></head>
<body><div class="wrap"><h1>Error <span class="code">1101</span> &mdash; Worker threw exception</h1>
<div class="box"><p>You've requested a page on a website that is on the Cloudflare network.
An unknown error occurred while rendering the page.</p></div>
<footer>Cloudflare Ray ID: <code>${randomRay()}</code></footer></div></body></html>`;
}

function randomRay(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
