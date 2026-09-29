-- PersianPl-Panel — اسکیمای اولیه
-- D1 Free: 500MB/DB، ۵۰ کوئری در هر invocation. همه‌ی مسیرهای داغ ایندکس دارند.

CREATE TABLE settings (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE inbounds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tag           TEXT    NOT NULL UNIQUE,
  remark        TEXT    NOT NULL DEFAULT '',
  enable        INTEGER NOT NULL DEFAULT 1,
  protocol      TEXT    NOT NULL,              -- vless | vmess | trojan | shadowsocks
  transport     TEXT    NOT NULL DEFAULT 'ws', -- ws | httpupgrade | xhttp
  path          TEXT    NOT NULL DEFAULT '/',
  host          TEXT    NOT NULL DEFAULT '',
  sni           TEXT    NOT NULL DEFAULT '',
  ports         TEXT    NOT NULL DEFAULT '[443]',
  max_early_data INTEGER NOT NULL DEFAULT 2560,
  ss_method     TEXT    NOT NULL DEFAULT 'aes-128-gcm',
  vmess_security TEXT   NOT NULL DEFAULT 'auto',
  total_gb      REAL    NOT NULL DEFAULT 0,    -- 0 = بی‌نهایت
  traffic_reset TEXT    NOT NULL DEFAULT 'never', -- never|daily|weekly|monthly
  last_reset_at INTEGER NOT NULL DEFAULT 0,
  expiry_at     INTEGER NOT NULL DEFAULT 0,    -- 0 = بدون انقضا
  up            INTEGER NOT NULL DEFAULT 0,
  down          INTEGER NOT NULL DEFAULT 0,
  extra         TEXT    NOT NULL DEFAULT '{}', -- headers، external_proxy، sniffing
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_inbounds_enable ON inbounds(enable);

-- کلاینت‌ها: قلب پنل. هر فیلد x-ui که روی Worker معنی دارد + افزوده‌های ما.
CREATE TABLE clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inbound_id    INTEGER NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,              -- معادل email در x-ui
  comment       TEXT    NOT NULL DEFAULT '',
  auth          TEXT    NOT NULL,              -- UUID (vless/vmess) یا password (trojan/ss)
  enable        INTEGER NOT NULL DEFAULT 1,

  total_gb      REAL    NOT NULL DEFAULT 0,    -- 0 = بی‌نهایت
  up            INTEGER NOT NULL DEFAULT 0,
  down          INTEGER NOT NULL DEFAULT 0,

  expiry_at     INTEGER NOT NULL DEFAULT 0,    -- 0 = بدون انقضا
  delayed_days  INTEGER NOT NULL DEFAULT 0,    -- شروع تعویقی: +N روز از اولین اتصال
  renew_days    INTEGER NOT NULL DEFAULT 0,    -- تمدید خودکار هر N روز
  reset_count   INTEGER NOT NULL DEFAULT 0,

  limit_ip      INTEGER NOT NULL DEFAULT 0,    -- 0 = بی‌نهایت
  sub_token     TEXT    NOT NULL UNIQUE,
  tg_chat_id    TEXT    NOT NULL DEFAULT '',

  pref_node     TEXT    NOT NULL DEFAULT '',   -- نود ترجیحی (خالی = همه)
  proxyip       TEXT    NOT NULL DEFAULT '',   -- override
  nat64_prefix  TEXT    NOT NULL DEFAULT '',
  routing_id    INTEGER,                       -- پروفایل مسیریابی اختصاصی

  gen_opts      TEXT    NOT NULL DEFAULT '{}', -- fingerprint/alpn/fragment/noise/mux/ech
  last_online   INTEGER NOT NULL DEFAULT 0,
  first_seen    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX idx_clients_auth ON clients(auth);
CREATE INDEX idx_clients_inbound ON clients(inbound_id);
CREATE INDEX idx_clients_enable ON clients(enable);
CREATE UNIQUE INDEX idx_clients_name ON clients(inbound_id, name);

-- آمار روزانه: منبع چارت‌ها. کلید ترکیبی تا UPSERT ارزان باشد.
CREATE TABLE client_usage_daily (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  day       TEXT    NOT NULL,                  -- YYYY-MM-DD (UTC)
  node      TEXT    NOT NULL DEFAULT 'local',
  up        INTEGER NOT NULL DEFAULT 0,
  down      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, day, node)
);
CREATE INDEX idx_usage_day ON client_usage_daily(day);

-- IPهای فعال هر کلاینت برای limit_ip و نمایش «کاربران آنلاین»
CREATE TABLE client_ips (
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ip        TEXT    NOT NULL,
  colo      TEXT    NOT NULL DEFAULT '',
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (client_id, ip)
);
CREATE INDEX idx_client_ips_seen ON client_ips(last_seen);

-- نودها: ورکرهای اکانت‌های دیگر که کانفیگ pull و آمار push می‌کنند
CREATE TABLE nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  host        TEXT    NOT NULL,                -- دامنه‌ای که در address کانفیگ می‌آید
  url         TEXT    NOT NULL DEFAULT '',     -- آدرس مدیریتی نود (اختیاری)
  token_hash  TEXT    NOT NULL,                -- SHA-256 توکن نود
  enable      INTEGER NOT NULL DEFAULT 1,
  ports       TEXT    NOT NULL DEFAULT '[443]',
  proxyip     TEXT    NOT NULL DEFAULT '',
  region      TEXT    NOT NULL DEFAULT '',
  weight      INTEGER NOT NULL DEFAULT 100,
  last_seen   INTEGER NOT NULL DEFAULT 0,
  req_today   INTEGER NOT NULL DEFAULT 0,
  health      TEXT    NOT NULL DEFAULT 'unknown', -- ok | stale | down | unknown
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_nodes_enable ON nodes(enable);

-- پروفایل‌های مسیریابی، قابل تخصیص به هر کلاینت
CREATE TABLE routing_profiles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  is_default INTEGER NOT NULL DEFAULT 0,
  rules      TEXT    NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE sessions (
  token      TEXT    PRIMARY KEY,              -- SHA-256 توکن کوکی
  ip         TEXT    NOT NULL DEFAULT '',
  ua         TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_exp ON sessions(expires_at);

CREATE TABLE api_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  key_hash   TEXT    NOT NULL UNIQUE,
  scope      TEXT    NOT NULL DEFAULT 'read',
  last_used  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL DEFAULT (unixepoch()),
  kind    TEXT    NOT NULL,                    -- login | login_fail | settings | client | node
  actor   TEXT    NOT NULL DEFAULT '',
  ip      TEXT    NOT NULL DEFAULT '',
  detail  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_audit_at ON audit_log(at);
