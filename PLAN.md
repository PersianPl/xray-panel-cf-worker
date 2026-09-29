# PersianPl-Panel — پلن نهایی

پنل چند-کاربره VLESS/VMess/Trojan روی Cloudflare Worker + D1، با تجربه‌ی مدیریتی 3x-ui و
حداکثر تنظیمات ممکن. یک کدبیس، دو نقش: `ROLE=panel` و `ROLE=node`.

---

## ۰. تصحیح‌های مهم نسبت به بررسی قبلی

| موضوع | نتیجه‌ی قبلی | نتیجه‌ی واقعی (تأیید شده) |
|---|---|---|
| XHTTP | غیرممکن | حالت `stream-one` **کار می‌کند** و به Durable Object هم نیاز ندارد (Re_edgetunnel). حالت‌های `packet-up`/`stream-up` نه. |
| gRPC | غیرممکن | حالت **gRPC Hunk کار می‌کند**، به شرط دامنه‌ی شخصی + فعال بودن gRPC روی zone. |
| ECH | مشکوک | واقعی است. روی zoneهای **Free پیش‌فرض فعال** است و `cloudflare-ech.com` نام بیرونی مشترک است. |
| Durable Objects | فرض: پولی | روی **Free هست** (فقط بک‌اند SQLite) + WebSocket Hibernation. |
| آمار دقیق | تقریبی | با شمارش در isolate + flush در `waitUntil` **دقیق** می‌شود؛ DO را در مسیر داده نمی‌گذاریم چون هر پیام WS یک ریکوئست DO حساب می‌شود. |

اعداد سقف (رسمی، Free): ۱۰۰٬۰۰۰ ریکوئست/روز · ۵۰ subrequest per request · **۶ اتصال همزمان
در هر invocation** · ۱۰ms CPU · D1: ۵۰۰MB per DB و ۱۰ DB و ۵GB/اکانت · KV: ۱۰۰k read و
**فقط ۱۰۰۰ write در روز** (پس KV هرگز برای آمار استفاده نمی‌شود) · DO: 100k req + 5M row read.

---

## ۱. معماری

```
                 ┌───────────────────── ROLE=panel ─────────────────────┐
   کلاینت  ──WS──►  proxy handler  →  connect() TCP / proxyip / NAT64    │
                 │  panel UI (مسیر مخفی)   ساب‌ساز   D1   Cron   API نود │
                 └───────┬──────────────────────────────────────────────┘
              config pull │ (امضای HMAC، هر ۵ دقیقه، ETag)
              stats push  │ (delta، هر ۵ دقیقه = heartbeat)
        ┌────────────┬────┴────────┬─────────────┐
   ROLE=node     ROLE=node     ROLE=node      ...   ← اکانت‌های دیگر CF، هرکدام +100k/روز
   (اکانت B)     (اکانت C)     (اکانت D)              stateless، فقط PANEL_URL + NODE_TOKEN
```

- نود UI ندارد، D1 ندارد، فقط کش کانفیگ امضاشده + شمارنده‌ی لوکال. پنل down شود، نود با کش کار می‌کند.
- سقف‌ها را نود لوکال اعمال می‌کند (snapshot مصرف + delta لوکال) → تأخیر صفر روی مسیر داده.
- ساب همیشه از پنل اصلی سرو می‌شود؛ دامنه‌ی نود فقط داخل فیلد `address` کانفیگ‌ها ظاهر می‌شود.
- **هر نود دامنه‌ی خودش را لازم دارد** (zone بین اکانت‌ها مشترک نمی‌شود). گزینه‌ها: دامنه ارزان،
  ساب‌دامنه‌ی رایگان (dpdns.org / us.kg)، یا `workers.dev` + fragment. نودها اختیاری‌اند؛ پنل تک‌نودی کامل کار می‌کند.

## ۲. اسکیمای D1

`settings(k,v)` · `inbounds` · `clients` · `client_usage_daily(client_id,day,up,down)` ·
`client_ips(client_id,ip,last_seen)` · `nodes(name,url,token_hash,region,health,last_seen)` ·
`node_stats` · `sub_tokens` · `routing_profiles` · `api_keys` · `sessions` · `audit_log`

---

## ۳. ماتریس تنظیمات — «حداکثر آپشن»

هرچه x-ui دارد و روی Worker معنی دارد، به‌علاوه‌ی هرچه BPB/nahan/edge دارند.
ستون منبع: X=3x-ui · B=BPB · N=nahan · E=edgetunnel · ★=هیچ پنل Worker فعلاً ندارد.

### ۳.۱ پنل و امنیت
| تنظیم | منبع |
|---|---|
| نام کاربری + رمز (Argon2id/PBKDF2، نه رمز خالی) | X |
| **2FA (TOTP)** | X ★ |
| مسیر پایه‌ی پنل (`webBasePath`) قابل تغییر | X B N |
| Secret token + عمر نشست (`sessionMaxAge`) + محدودیت IP لاگین | X |
| **decoy زنده** (پروکسی به سایت واقعی) / fallback domain / 404 / خطای 1101 جعلی | N B E |
| تعداد رکورد هر صفحه، زبان (فا/EN)، تم، **تقویم شمسی/میلادی** | X ★ |
| audit log: لاگین‌ها + تغییر تنظیمات، هشدار لاگین ناموفق | X N |
| بکاپ/ریستور JSON + ایمپورت‌اکسپورت با لینک | X B N |
| API key برای دسترسی برنامه‌نویسی + آستانه‌ی هشدار مصرف | N ★ |

### ۳.۲ Inbound (مدل x-ui)
| تنظیم | منبع |
|---|---|
| protocol: VLESS / VMess / Trojan / Shadowsocks-WS | X |
| transport: **WS** (تضمینی) · **HTTPUpgrade** · **XHTTP stream-one** · **gRPC Hunk** (با دامنه) | X + Re_edge |
| remark, enable, port(های مجاز CF), path, host, **heartbeatPeriod** | X |
| سقف ترافیک کل inbound + **ریست دوره‌ای** (never/daily/weekly/monthly) + تاریخ انقضا | X |
| WS: `maxEarlyData` / `?ed=2560` / earlyDataHeaderName | X B |
| VMess: `security` (auto/aes-128-gcm/chacha20-poly1305/none) | X |
| SS: method (aes-128-gcm / aes-256-gcm / chacha20-ietf-poly1305) | X |
| sniffing (فقط برای مسیریابی داخلی: destOverride, metadataOnly, routeOnly) | X |
| **external proxy** (dest/port/forceTls=same\|none\|tls/remark) برای ساخت کانفیگ CDN | X ★ |

### ۳.۳ هر کلاینت (قلب پنل)
| تنظیم | منبع |
|---|---|
| UUID/password + تولید خودکار، email/نام، comment | X |
| enable/disable، سقف ترافیک (GB)، مصرف up/down/total + دکمه‌ی ریست | X |
| انقضا: تاریخ ثابت **یا** «شروع تعویقی» (+N روز از اولین اتصال) | X |
| **renew/reset دوره‌ای** (هر N روز خودکار تمدید) | X ★ |
| limitIp + **لاگ IPهای فعال** (نمایش و پاک‌کردن) | X |
| توکن ساب اختصاصی (subId) + `{usage}`/`{expiry}` در نام کانفیگ | X N |
| Telegram chatId برای هشدار شخصی | X |
| **نود ترجیحی** + **proxyip اختصاصی** + **NAT64 اختصاصی** | N ★ |
| **پروفایل مسیریابی اختصاصی** (کدام rule-set برای این کاربر) | ★ |
| **ساخت گروهی** (۵ روش نام‌گذاری: random / +prefix / +num / +postfix، تا ۱۰۰ تا) | X ★ |

### ۳.۴ ژنراتور ساب (اینجا «حداکثر تنظیم» واقعی می‌شود)
| تنظیم | منبع |
|---|---|
| سه خروجی: v2ray(base64) · sing-box JSON · Clash-Meta YAML + تشخیص خودکار UA | X B |
| هدر `subscription-userinfo` (up/down/total/expire) → مصرف در خود کلاینت | X |
| صفحه‌ی ساب: QR، دکمه‌ی مستقیم v2rayNG/Streisand/Happ/Shadowrocket/V2Box، تم، دو زبانه | X N |
| fingerprint: chrome/firefox/safari/ios/android/edge/360/qq/random/randomized | X B |
| ALPN (h2, http/1.1)، SNI جدا، Host جدا، allowInsecure، minVersion/maxVersion | X |
| **Fragment**: packets(tlshello/1-1/1-3) · length · interval · **پروفایل Low→Severe** · Max Split | B |
| **Noise (برای v2rayNG)**: type(rand/base64/str/hex) · packet · delay · applyTo(ip/ipv4/ipv6) | X B ★ |
| **Mux**: enabled · concurrency(−1..1024) · xudpConcurrency · xudpProxyUDP443(reject/allow/skip) · و sing-box: protocol(h2mux/smux/yamux) + padding | X ★ |
| **ECH**: on/off + ECH server name (پیش‌فرض دامنه‌ی خودت، یا `cloudflare-ech.com`) | N B |
| **Clean IP / Best-IP**: لیست دستی `IP#Name` یا URL، ضرب در پورت‌های TLS، تولید کانفیگ per-IP | N B E |
| **Custom CDN** (Fastly/Gcore): address + host + SNI → مخفی‌کردن دامنه‌ی Worker | B ★ |
| تگ‌های نام: `{FLAG}{COUNTRY}{CITY}{ISP}{HOST}{DATE}{WORKER}{NODE}{PORT}{PROTO}` | N |
| remark model + جداکننده، مرتب‌سازی، **کانفیگ‌های جعلی** برای پرکردن لیست | X N |
| بازه‌ی به‌روزرسانی ساب، عمر کش، رمزنگاری ساب | X |
| **پروکسی زنجیره‌ای** (chain/outProxy): vless/vmess/trojan/ss/socks/http + `dialerProxy` | B ★ |
| **ادغام ساب‌های بیرونی** در ساب نهایی | B N |

### ۳.۵ مسیریابی و DNS (سمت کلاینت، مثل BPB اما کامل‌تر)
| تنظیم | منبع |
|---|---|
| bypass ایران/چین/روسیه/LAN · block QUIC/ads/porn/malware/phishing/cryptominer/torrent | B X |
| قوانین سفارشی: domain / IPv4 / IPv6 / CIDR / geosite / geoip | B X |
| **قواعد ضدتحریم** + DNS ضدتحریم (شکن) | B ★ |
| Remote DNS (DoH/DoT)، Local DNS، Underlying DoH، FakeDNS، IPv6 on/off | B X |
| **DoH سرور خود پنل** (`/dns-query`) | B E |
| **پروفایل‌های مسیریابی چندگانه و قابل تخصیص به هر کاربر** | ★ |

### ۳.۶ شبکه و خروجی
| تنظیم | منبع |
|---|---|
| proxyip: لیست چندتایی + auto + تست تأخیر داخل پنل + override هر کلاینت/نود | E B N |
| **NAT64** (چند prefix، per-user) | N |
| SOCKS5/HTTP upstream: کلی، یا **لیست دامنه‌ی خاص** (GO2SOCKS5) | E |
| **مسیر داینامیک**: `/proxyip=…` · `/socks5=…` · `/http=…` (تست سریع بدون تغییر تنظیم) | E ★ |
| **دیال موازی** (TCP concurrent dial) و **preload race dial** | E ★ |
| پورت‌های TLS: 443/2053/2083/2087/2096/8443 (+ HTTP فقط با دامنه) | B |
| WARP (تولید کانفیگ WireGuard + endpoint + noise mode) — فاز ۳ | B |

### ۳.۷ آمار و ربات
| تنظیم | منبع |
|---|---|
| آمار per-client / per-node / per-inbound + چارت روزانه + sparkline | X N |
| کاربران آنلاین، آخرین اتصال، edge colo، IP خروجی واقعی، تست تأخیر مرورگری | X N |
| **نمایش مصرف کوتای CF** (ریکوئست امروز از API خود کلادفلر) | E ★ |
| ربات تلگرام: `/status` `/pause` + مدیریت کاربر با دکمه‌ی شیشه‌ای + هشدار انقضا/ترافیک/لاگین/بکاپ | X N |
| **Kill Switch** سراسری | N |
| به‌روزرسانی خودکار از GitHub | N |

---

## ۴. فازها

**فاز ۱ — MVP (پنل کامل تک‌نودی)**
پروژه‌ی wrangler + TS، اسکیمای D1، هسته‌ی VLESS/VMess/Trojan روی WS با `connect()`،
احراز هویت + مسیر مخفی + decoy، CRUD کلاینت با **همه‌ی** فیلدهای ۳.۳، ساب سه‌فرمته + صفحه‌ی ساب + QR،
آمار پایه، Cron انقضا، و **API آماده‌ی نود**. → همین‌جا پنل قابل استفاده است.

**فاز ۲ — تنظیمات حرفه‌ای + چند-نودی**
کل ۳.۴ (fragment/noise/mux/ECH/clean-IP/CDN/chain)، کل ۳.۵ (پروفایل مسیریابی)، ۳.۶
(proxyip چندتایی + NAT64 + socks5 + مسیر داینامیک)، نود واقعی روی اکانت دوم + ویزارد
Add-Node، آمار per-node، چارت، ساخت گروهی، بکاپ.

**فاز ۳ — تکمیل**
HTTPUpgrade + XHTTP stream-one (+gRPC با دامنه)، WARP، ربات تلگرام، 2FA، ایمپورت از x-ui،
Kill Switch، مصرف کوتای CF، به‌روزرسانی خودکار.

## ۵. UI
فارسی RTL-first با Vazirmatn، دارک/لایت، چیدمان x-ui (کارت آمار بالا، جدول کلاینت با اکشن آیکونی،
تب‌های تنظیمات، مودال کلاینت بخش‌بندی‌شده)، به‌علاوه: گیج SVG مصرف با `stroke-dashoffset`،
count-up، sparkline، اسکلتون، ripple، ترنزیشن نرم بین تم. همه از خود Worker سرو می‌شود، بدون build سنگین.

## ۶. محدودیت‌های پذیرفته‌شده
UDP نداریم (DNS تونل‌شده بله) · REALITY/XTLS/mKCP/Hysteria2/TUIC/MTProto غیرممکن (CF خودش TLS
را terminate می‌کند) · هر اتصال TCP یک ریکوئست حساب می‌شود؛ با mux کمتر · ~۲-۵ کاربر فعال per اکانت رایگان ·
چند اکانت رایگان ناحیه‌ی خاکستری ToS است، پس ۳-۵ نود.

