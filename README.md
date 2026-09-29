# PersianPl-Panel

پنل چندکاربره VLESS / VMess / Trojan / Shadowsocks روی **Cloudflare Workers + D1** —
ترکیب تجربه‌ی مدیریتی 3x-ui با امکانات BPB/nahan/edgetunnel، در یک Worker بدون سرور.

## قابلیت‌ها

- **پروکسی کامل** روی WS / HTTPUpgrade / XHTTP stream-one با شمارش دقیق ترافیک، proxyip چندتایی، NAT64، SOCKS5 و مسیر داینامیک (`/vl/proxyip=1.2.3.4`)
- **پنل فارسی RTL** با مسیر مخفی تصادفی، decoy زنده، 2FA (TOTP)، audit log و بکاپ/ریستور JSON اتمیک
- **ساب سه‌فرمته** (v2ray base64 · sing-box JSON · Clash-Meta YAML · Xray JSON) با تشخیص خودکار UA، صفحه‌ی کاربر با QR، fragment/noise/mux/ECH، clean-IP و CDN سفارشی
- **پروفایل‌های مسیریابی اختصاصی** برای هر کاربر (قابلیتی که هیچ پنل Worker دیگری ندارد)
- **WARP**: ثبت هویت وایرگارد از API کلادفلر و تزریق به هر سه خروجی ساب (direct یا chain دابل‌هاپ)
- **ربات تلگرام**: اتصال با API Key یک‌بارمصرف، مدیریت کامل کاربران با دکمه‌ی شیشه‌ای، هشدار انقضا/ترافیک/ورود
- **چند-نودی**: ورکرهای اکانت‌های دیگر به‌عنوان نود، pull کانفیگ با HMAC و push آمار — هر اکانت رایگان +۱۰۰k درخواست در روز
- **ایمپورت از x-ui**، ادغام ساب‌های بیرونی، DoH روی خود دامنه‌ی پنل، Kill Switch، نمایش مصرف کوتای CF

## مشاهدهٔ UI قبل از دیپلوی

برای اجرای پنل روی دستگاه خودتان با دیتابیس آزمایشی جدا، [راهنمای تست محلی](README.local.md) را ببینید؛ شامل دستور اجرا، اطلاعات ورود، چک‌لیست UI و عیب‌یابی است. برای این کار نیازی به دیپلوی یا ساخت D1 واقعی ندارید.


## نصب سریع

```bash
npm install
npm run db:create        # database_id را در wrangler.toml بگذار
npm run db:remote        # اجرای migrationها
npm run deploy
```

در لاگ دیپلوی/اولین بوت، **مسیر مخفی پنل و رمز ادمین** چاپ می‌شود — همان‌جا ذخیره کن.

## نود (اختیاری)

همین ریپو با `ROLE=node` روی اکانت دوم دیپلوی می‌شود؛ نود فقط `PANEL_URL` و
`NODE_TOKEN` (secret) می‌خواهد. ویزارد نصب داخل پنل، توکن و کرانِ نود را می‌سازد.

## ربات تلگرام

1. توکن ربات را از @BotFather بگیر و در پنل › تنظیمات › ربات ذخیره کن
2. «اتصال ربات» → API Key یک‌بارمصرف را کپی کن
3. در تلگرام: `/start pplk_…`

## توسعه

```bash
npm run dev      # wrangler dev (D1 لوکال: npm run db:local)
npm test         # ۵۳۴+ تست
npm run check    # typecheck + بیلد دیپلوی
```

دیپلوی خودکار با push به `main` از طریق `.github/workflows/deploy.yml`
(سکرت‌های `CLOUDFLARE_API_TOKEN` لازم است).

## محدودیت‌های پذیرفته‌شده

UDP خام نداریم (DNS تونل‌شده بله) · REALITY/XTLS/mKCP/Hysteria2 روی Worker معنا ندارد ·
هر اتصال TCP یک ریکوئست حساب می‌شود (mux کمک می‌کند) · ~۲-۵ کاربر فعال به‌ازای هر اکانت رایگان.
