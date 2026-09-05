import type { z } from 'zod';
import { fetchJson, fetchWithRetry, sleep, type RetryOptions } from './http';

const API = 'https://discord.com/api/v10';
// 10 秒: Discord は通常 1 秒未満で応答する。1 ティック 50 秒予算のうち受信＋送信で 2〜3 回呼んでも収まる上限
const TIMEOUT_MS = 10_000;

/** Bot トークンでの REST 呼び出し。受信（ingest）と送信（notify）の両方が使う */
export class DiscordClient {
  // Discord はバケット単位でレート制限するが、MVP では「直前の応答で残量 0 なら Reset-After 秒待つ」の単純戦略にする
  private waitUntilMs = 0;

  constructor(
    private readonly botToken: string,
    private readonly doSleep: (ms: number) => Promise<void> = sleep,
  ) {}

  async getJson<T>(path: string, schema: z.ZodType<T>, schemaName: string): Promise<T> {
    await this.waitIfLimited();
    return fetchJson(`${API}${path}`, { method: 'GET', headers: this.headers() }, { ...this.opts(), schema, schemaName });
  }

  async postJson<T>(path: string, body: unknown, schema: z.ZodType<T>, schemaName: string): Promise<T> {
    await this.waitIfLimited();
    return fetchJson(
      `${API}${path}`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      { ...this.opts(), schema, schemaName },
    );
  }

  /** 応答本文を使わない POST（投稿成功だけ分かればよいとき） */
  async post(path: string, body: unknown): Promise<void> {
    await this.waitIfLimited();
    await fetchWithRetry(
      `${API}${path}`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body) },
      this.opts(),
    );
  }

  private async waitIfLimited(): Promise<void> {
    const wait = this.waitUntilMs - Date.now();
    if (wait > 0) await this.doSleep(wait);
  }

  private readonly readRateLimit = (res: Response): void => {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const resetAfter = res.headers.get('x-ratelimit-reset-after');
    if (remaining === '0' && resetAfter) this.waitUntilMs = Date.now() + Number(resetAfter) * 1000;
  };

  private opts(): RetryOptions {
    return { service: 'discord', timeoutMs: TIMEOUT_MS, onResponse: this.readRateLimit, sleep: this.doSleep };
  }

  private headers(): Record<string, string> {
    // Discord は User-Agent が無いリクエストを拒否することがある
    return { Authorization: `Bot ${this.botToken}`, 'Content-Type': 'application/json', 'User-Agent': 'InquiryRouter/1.0' };
  }
}
