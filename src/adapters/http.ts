import type { z } from 'zod';
import { errorMessage, log } from '../observability/logger';

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string, readonly bodySnippet: string) {
    super(`HTTP ${status} ${url}: ${bodySnippet}`);
    this.name = 'HttpError';
  }
}
export class TimeoutError extends Error {
  constructor(url: string, ms: number) { super(`${ms}ms でタイムアウト: ${url}`); this.name = 'TimeoutError'; }
}
export class SchemaMismatchError extends Error {
  constructor(schemaName: string, detail: string) { super(`想定外のレスポンス (${schemaName}): ${detail}`); this.name = 'SchemaMismatchError'; }
}

export interface RetryOptions {
  service: string;
  timeoutMs: number;
  /** 既定 3。合計 4 回まで試す */
  maxRetries?: number;
  /** レート制限ヘッダを読みたい呼び出し側（Discord）用 */
  onResponse?: (res: Response) => void | Promise<void>;
  /** テストで待ち時間をゼロにするため差し替え可能 */
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry-After は「秒数」か「HTTP 日付」のどちらかで来るので両対応 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export function backoffMs(attempt: number, retryAfterMs?: number): number {
  // Retry-After があれば尊重。なければ 1s→2s→4s… を 30s で頭打ちにし、
  // 複数の再試行が同じ瞬間に集中して相手を叩き続けないようジッターを足す
  const base = retryAfterMs ?? Math.min(30_000, 1_000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 500);
}

/** タイムアウト＋リトライ付き fetch。2xx の Response を返し、それ以外は例外 */
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOptions): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const doSleep = opts.sleep ?? sleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (opts.onResponse) await opts.onResponse(res);
      if (res.ok) return res;

      const snippet = (await res.text()).slice(0, 500);
      lastError = new HttpError(res.status, url, snippet);
      // 429 と 5xx だけ再試行。4xx は何度送っても同じ結果なので即失敗させる
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === maxRetries) throw lastError;
      const wait = backoffMs(attempt, parseRetryAfterMs(res.headers.get('retry-after')));
      log.warn('http retry', { service: opts.service, status: res.status, attempt, waitMs: wait });
      await doSleep(wait);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastError = controller.signal.aborted ? new TimeoutError(url, opts.timeoutMs) : e;
      if (attempt === maxRetries) throw lastError;
      const wait = backoffMs(attempt);
      log.warn('http retry (network)', { service: opts.service, error: errorMessage(lastError), attempt, waitMs: wait });
      await doSleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** fetchWithRetry ＋ JSON パース ＋ zod 検証。想定外の形はログに残して例外にする */
export async function fetchJson<T>(
  url: string, init: RequestInit,
  opts: RetryOptions & { schema: z.ZodType<T>; schemaName: string },
): Promise<T> {
  const res = await fetchWithRetry(url, init, opts);
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); }
  catch { throw new SchemaMismatchError(opts.schemaName, `JSON ではない: ${text.slice(0, 200)}`); }

  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    // 握りつぶさない。何が来たかを残すことで API の仕様変更を早期に気付けるようにする
    log.error('schema mismatch', {
      service: opts.service, schema: opts.schemaName,
      issues: parsed.error.issues.slice(0, 5), sample: text.slice(0, 500),
    });
    throw new SchemaMismatchError(opts.schemaName,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}
