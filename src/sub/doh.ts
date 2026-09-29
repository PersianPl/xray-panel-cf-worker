/**
 * DoH سرور خود پنل — کلاینت‌ها می‌توانند Remote DNS را بگذارند:
 *   https://<دامنه>/<sub_path>/dns-query
 *
 * فقط یک رله‌ی به DoH آپ‌استریم است (پیش‌فرض cloudflare-dns). چرا مفید است:
 * در ایران خودِ cloudflare-dns.com و dns.google گاهی کنار گذاشته می‌شوند ولی
 * دامنه‌ی پنل که روی CDN است باز می‌ماند — پس DNS هم از مسیر پنل عبور می‌کند.
 * فرمت استاندارد RFC 8484 است: GET با ?dns= یا POST با body باینری.
 */
export async function handleDoh(req: Request, upstream = 'https://cloudflare-dns.com/dns-query', fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  if (method === 'GET') {
    const dns = url.searchParams.get('dns');
    if (!dns) return new Response('missing ?dns=', { status: 400 });
    return forwardDoH(upstream, fetchImpl, {
      method: 'GET',
      headers: { accept: 'application/dns-message' },
      // پارامتر همان base64urlRFC 8484 است؛ بدون تغییر عبور می‌دهیم.
    }, `${upstream}${upstream.includes('?') ? '&' : '?'}dns=${encodeURIComponent(dns)}`);
  }

  if (method === 'POST') {
    const ct = req.headers.get('content-type') ?? '';
    if (!ct.includes('application/dns-message')) {
      return new Response('content-type must be application/dns-message', { status: 415 });
    }
    return forwardDoH(upstream, fetchImpl, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message', accept: 'application/dns-message' },
      body: await req.arrayBuffer(),
    }, upstream);
  }

  return new Response(null, { status: 405 });
}

async function forwardDoH(
  _upstream: string,
  fetchImpl: typeof fetch,
  init: RequestInit,
  target: string,
): Promise<Response> {
  try {
    const res = await fetchImpl(target, { ...init, cf: { cacheTtl: 60 } } as RequestInit);
    return new Response(res.body, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/dns-message',
        'cache-control': 'max-age=60',
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
