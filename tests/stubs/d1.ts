/**
 * D1 جعلی برای تست — ضبط‌کننده‌ی SQL، نه یک SQLite واقعی.
 *
 * چیزی که این ماژول‌ها لازم دارند بررسی شود، «داده‌ی نهایی در جدول» نیست؛
 * چیزی است که **به D1 فرستاده می‌شود**: آیا دلتا با `up = up + ?` جمع می‌شود یا
 * set؟ آیا شرط `first_seen = 0` سرِ جایش هست؟ آیا دسته‌ها از سقف ۵۰ کوئری رد
 * می‌شوند؟ یک SQLite واقعی این‌ها را پنهان می‌کند (نتیجه‌ی نهایی یکی است)، پس
 * اینجا خودِ عبارت‌ها و مقادیرشان نگه داشته می‌شوند.
 *
 * `answer` برای خواندن‌ها است: با یک تابع، پاسخِ هر SQL را تعیین می‌کنید.
 */

/** یک عبارت اجراشده، همان‌طور که به D1 رسیده. */
export interface Executed {
  sql: string;
  args: unknown[];
  /** `batch` = داخل یک دسته اجرا شده، با شماره‌ی دسته. */
  batch: number | null;
}

type Answer = (sql: string, args: unknown[]) => unknown;

export class FakeD1 {
  /** همه‌ی عبارت‌ها به‌ترتیب اجرا. */
  readonly log: Executed[] = [];
  /** اندازه‌ی هر `batch()` — برای بررسی سقف کوئری. */
  readonly batchSizes: number[] = [];
  /** شماره‌ی `run/first/all`های تکی (بیرون از دسته). */
  private batchNo = 0;
  private answer: Answer = () => null;
  /** اگر ست شود، نوشتن‌ها با این خطا می‌شکنند. */
  failWith: Error | null = null;
  /** `last_row_id` بعدی برای INSERT. */
  nextRowId = 1;

  /** پاسخ خواندن‌ها را تعیین می‌کند. `null` = ردیفی نیست. */
  onQuery(fn: Answer): this {
    this.answer = fn;
    return this;
  }

  reset(): void {
    this.log.length = 0;
    this.batchSizes.length = 0;
    this.batchNo = 0;
    this.failWith = null;
  }

  /** عبارت‌هایی که SQLشان شامل این تکه است. */
  find(part: string): Executed[] {
    return this.log.filter((x) => x.sql.includes(part));
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(stmts: FakeStatement[]): Promise<Array<{ results: unknown[]; meta: { changes: number; last_row_id: number } }>> {
    if (this.failWith) throw this.failWith;
    this.batchSizes.push(stmts.length);
    const n = ++this.batchNo;
    return stmts.map((st) => {
      this.log.push({ sql: st.sql, args: st.args, batch: n });
      return { results: [], meta: { changes: 1, last_row_id: this.nextRowId++ } };
    });
  }

  /** برای مسیرهای تکی (`run`/`first`/`all`). */
  record(st: FakeStatement): void {
    if (this.failWith) throw this.failWith;
    this.log.push({ sql: st.sql, args: st.args, batch: null });
  }

  reply(st: FakeStatement): unknown {
    return this.answer(st.sql, st.args);
  }
}

export class FakeStatement {
  args: unknown[] = [];
  constructor(
    private readonly db: FakeD1,
    readonly sql: string,
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    this.db.record(this);
    return { success: true, meta: { changes: 1, last_row_id: this.db.nextRowId++ } };
  }

  async first<T>(): Promise<T | null> {
    this.db.record(this);
    const v = this.db.reply(this);
    if (v === null || v === undefined) return null;
    return (Array.isArray(v) ? ((v[0] as T) ?? null) : (v as T)) as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    this.db.record(this);
    const v = this.db.reply(this);
    return { results: (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]) as T[], success: true };
  }
}

/** `Env` کمینه با همین D1. */
export function fakeEnv(db: FakeD1, extra: Record<string, string> = {}): { DB: unknown } & Record<string, unknown> {
  return { DB: db as unknown, ...extra };
}

/** `ExecutionContext` جعلی که کارهای پس‌زمینه را نگه می‌دارد تا تست بتواند await کند. */
export class FakeCtx {
  readonly tasks: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>): void {
    this.tasks.push(p);
  }
  passThroughOnException(): void {}
  /** همه‌ی کارهای پس‌زمینه را تمام می‌کند. */
  async settle(): Promise<void> {
    await Promise.allSettled(this.tasks);
  }
}
