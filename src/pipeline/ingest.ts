import { z } from 'zod';
import type { Env } from '../env';
import type { Deps, MessageSource } from '../types/ports';
import type { DeadLetterEntry, RunMetrics } from '../types/inquiry';
import { normalize } from '../domain/normalize';
import { BreakerOpenError, withBreaker } from '../adapters/circuit-breaker';
import { errorMessage, log } from '../observability/logger';

/** 受信元ごとに: 取得 → 正規化 → 保存 → cursor 前進。1 つの受信元の失敗が他方を止めない */
export async function ingest(_env: Env, deps: Deps, m: RunMetrics): Promise<void> {
  for (const src of deps.sources) {
    try {
      await ingestOne(src, deps, m);
    } catch (e) {
      if (e instanceof BreakerOpenError) {
        log.warn('ingest skipped: 遮断中', { source: src.source });
        continue;
      }
      // 取得・保存に失敗しても cursor は進んでいないので、次ティックで自然に再試行される。
      // dead_letter には積まず、失敗として数えるだけにする（積むと二重取得と競合するため）
      m.failed++;
      m.errors.push(`ingest ${src.source}: ${errorMessage(e)}`);
      log.error('ingest failed', { source: src.source, error: errorMessage(e) });
    }
  }
}

async function ingestOne(src: MessageSource, deps: Deps, m: RunMetrics): Promise<void> {
  const cursor = await deps.repo.getCursor(src.source);
  // ブレーカーは外部 API の呼び出しだけを囲む（DB 側の失敗を Gmail/Discord の失敗として数えないため）
  const { messages, nextCursor } = await withBreaker(deps.repo, src.source, deps.now, () => src.fetchNew(cursor));
  if (src.source === 'gmail') m.fetchedGmail += messages.length;
  else m.fetchedDiscord += messages.length;

  if (messages.length > 0) {
    const rows = await Promise.all(messages.map(normalize));
    const { inserted, duplicates } = await deps.repo.insertMany(rows);
    m.stored += inserted;
    m.duplicates += duplicates;
  }
  // 保存が成功してから cursor を進める。先に進めると保存失敗時にその分を永久に取りこぼす
  if (nextCursor && nextCursor !== cursor) await deps.repo.setCursor(src.source, nextCursor);
}

// dead_letter の payload は JSON を経由するので Date が文字列になっている。それを戻す
const payloadSchema = z.object({
  messages: z.array(z.object({
    source: z.enum(['gmail', 'discord']),
    sourceMessageId: z.string(),
    sourceThreadId: z.string().optional(),
    sender: z.string().optional(),
    subject: z.string().optional(),
    body: z.string(),
    receivedAt: z.coerce.date(),
  })),
});

/** 現状 ingest は dead_letter を積まないが、将来手動で積んだ場合に備えて再保存だけ行う */
export async function retryIngest(entry: DeadLetterEntry, _env: Env, deps: Deps, m: RunMetrics): Promise<void> {
  const parsed = payloadSchema.safeParse(entry.payload);
  if (!parsed.success) throw new Error('retryIngest: payload の形が不正');
  const rows = await Promise.all(parsed.data.messages.map(normalize));
  const { inserted, duplicates } = await deps.repo.insertMany(rows);
  m.stored += inserted;
  m.duplicates += duplicates;
}
