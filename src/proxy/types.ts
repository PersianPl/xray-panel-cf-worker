/** تایپ‌های مشترک لایه‌ی پروکسی. */

export interface Target {
  host: string;
  port: number;
}

export type Proto = 'vless' | 'vmess' | 'trojan';

/** نتیجه‌ی پارس اولین پیام WS: کانفیگ کامل اتصال. */
export interface ParsedRequest {
  proto: Proto;
  target: Target;
  /** بایت‌های پاسخ اولیه‌ی پروتکل که باید قبل از دیتای downlink به کلاینت برود. */
  responseHeader: Uint8Array | null;
  /** دیتای باقی‌مانده بعد از هدر که باید به سوکت مقصد برود. */
  rest: Uint8Array | null;
  /** برای UDP-over-TCP (فقط Trojan-UDP و DNS وصل می‌شوند). */
  udp?: boolean;
}

/** تصمیم dial برای مقصد. */
export interface DialContext {
  target: Target;
  /** proxyip اختصاصی کلاینت/نود — خالی = تنظیم سراسری. */
  proxyip?: string;
  nat64Prefix?: string;
  /** آیا Trojan-proxyip فعال است (دستگاه مقصد باید TLS را بفهمد). */
  trojanProxy?: { host: string; port: number; password: string };
}
