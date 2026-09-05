import { z } from 'zod';
import type {
  BreakerRecord, BreakerService, Classification, DeadLetterEntry, Inquiry, InquiryStatus,
  NormalizedMessage, RoutingDecision, RunMetrics, Source,
} from '../types/inquiry';
import type { Repo } from '../types/ports';
import { fetchJson, fetchWithRetry } from './http';

// 8 秒: Supabase は通常 100ms 台。1 ティックで十数回呼ぶので、1 回が長引いても全体 50 秒に収まる上限
const TIMEOUT_MS = 8_000;

const inquiryRow = z.object({
  id: z.string(),
  source: z.enum(['gmail', 'discord']),
  source_message_id: z.string(),
  sender: z.string().nullable(),
  subject: z.string().nullable(),
  body_clean: z.string(),
  received_at: z.string(),
  status: z.enum(['ingested', 'duplicate', 'classified', 'notified', 'failed']),
  category: z.enum(['賃貸', '売買', '内見', 'クレーム', '対象外']).nullable(),
  confidence: z.enum(['high', 'low']).nullable(),
  classified_by: z.enum(['keyword', 'llm', 'fallback']).nullable(),
  classification_reason: z.string().nullable(),
  target_channel: z.string().nullable(),
  is_urgent: z.boolean(),
  slack_notified_at: z.string().nullable(),
  urgent_notified_at: z.string().nullable(),
});
const deadLetterRow = z.object({
  id: z.number(),
  stage: z.enum(['ingest', 'classify', 'notify_slack', 'notify_urgent']),
  inquiry_id: z.string().nullable(),
  payload: z.unknown(),
  error: z.string(),
  attempts: z.number(),
  next_retry_at: z.string(),
});
const breakerRow = z.object({
  service: z.enum(['gmail', 'discord', 'openai', 'slack']),
  consecutive_failures: z.number(),
  state: z.enum(['closed', 'open', 'half_open']),
  opened_until: z.string().nullable(),
});

function toInquiry(r: z.infer<typeof inquiryRow>): Inquiry {
  const classification: Classification | undefined =
    r.category && r.confidence && r.classified_by
      ? { category: r.category, confidence: r.confidence, classifiedBy: r.classified_by, reason: r.classification_reason ?? '' }
      : undefined;
  return {
    id: r.id,
    source: r.source,
    sourceMessageId: r.source_message_id,
    sender: r.sender ?? undefined,
    subject: r.subject ?? undefined,
    bodyClean: r.body_clean,
    receivedAt: new Date(r.received_at),
    status: r.status,
    classification,
    targetChannel: r.target_channel ?? undefined,
    isUrgent: r.is_urgent,
    slackNotifiedAt: r.slack_notified_at ? new Date(r.slack_notified_at) : undefined,
    urgentNotifiedAt: r.urgent_notified_at ? new Date(r.urgent_notified_at) : undefined,
  };
}

type Init = RequestInit & { headers?: Record<string, string> };

/** Supabase の REST（PostgREST）を直接叩く Repo。SDK を使わないのは bundle を小さく保ち CPU 時間を節約するため */
export class SupabaseRepo implements Repo {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async insertMany(rows: NormalizedMessage[]) {
    if (rows.length === 0) return { inserted: 0, duplicates: 0 };
    const body = rows.map((r) => ({
      source: r.source,
      source_message_id: r.sourceMessageId,
      source_thread_id: r.sourceThreadId ?? null,
      sender: r.sender ?? null,
      subject: r.subject ?? null,
      body_raw: r.body,
      body_clean: r.bodyClean,
      content_hash: r.contentHash,
      received_at: r.receivedAt.toISOString(),
    }));
    // ignore-duplicates: unique 制約に当たった行は黙って捨て、挿入できた行だけ返してもらう
    const inserted = await this.json(
      'inquiries?on_conflict=source,source_message_id',
      { method: 'POST', body: JSON.stringify(body), headers: { Prefer: 'resolution=ignore-duplicates,return=representation' } },
      z.array(z.object({ id: z.string() })),
      'supabase.inquiries.insert',
    );
    return { inserted: inserted.length, duplicates: rows.length - inserted.length };
  }

  async getCursor(source: Source) {
    const rows = await this.json(`source_cursors?source=eq.${source}&select=cursor`, {}, z.array(z.object({ cursor: z.string() })), 'supabase.cursors');
    return rows[0]?.cursor ?? null;
  }
  async setCursor(source: Source, cursor: string) {
    await this.upsert('source_cursors', { source, cursor, updated_at: this.now().toISOString() });
  }

  async listByStatus(status: InquiryStatus, limit: number) {
    const rows = await this.json(`inquiries?status=eq.${status}&order=received_at.asc&limit=${limit}`, {}, z.array(inquiryRow), 'supabase.inquiries.list');
    return rows.map(toInquiry);
  }
  async saveClassification(id: string, c: Classification, r: RoutingDecision) {
    await this.patch(`inquiries?id=eq.${id}`, {
      category: c.category,
      confidence: c.confidence,
      classified_by: c.classifiedBy,
      classification_reason: c.reason,
      target_channel: r.targetChannel,
      is_urgent: r.isUrgent,
      status: 'classified',
      classified_at: this.now().toISOString(),
    });
  }
  async markSlackNotified(id: string) { await this.patch(`inquiries?id=eq.${id}`, { slack_notified_at: this.now().toISOString() }); }
  async markUrgentNotified(id: string) { await this.patch(`inquiries?id=eq.${id}`, { urgent_notified_at: this.now().toISOString() }); }
  async markNotified(id: string) { await this.patch(`inquiries?id=eq.${id}`, { status: 'notified' }); }
  async markFailed(id: string) { await this.patch(`inquiries?id=eq.${id}`, { status: 'failed' }); }

  async pushDeadLetter(e: DeadLetterEntry) {
    const row = {
      stage: e.stage,
      inquiry_id: e.inquiryId ?? null,
      payload: e.payload ?? null,
      error: e.error,
      attempts: e.attempts,
      next_retry_at: e.nextRetryAt.toISOString(),
    };
    if (e.id !== undefined) await this.patch(`dead_letter?id=eq.${e.id}`, row);
    else await this.send('dead_letter', { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=minimal' } });
  }
  async popDueDeadLetters(limit: number) {
    const rows = await this.json(
      `dead_letter?resolved_at=is.null&next_retry_at=lte.${encodeURIComponent(this.now().toISOString())}&order=next_retry_at.asc&limit=${limit}`,
      {},
      z.array(deadLetterRow),
      'supabase.dead_letter',
    );
    return rows.map((r): DeadLetterEntry => ({
      id: r.id,
      stage: r.stage,
      inquiryId: r.inquiry_id ?? undefined,
      payload: r.payload,
      error: r.error,
      attempts: r.attempts,
      nextRetryAt: new Date(r.next_retry_at),
    }));
  }
  async resolveDeadLetter(id: number) { await this.patch(`dead_letter?id=eq.${id}`, { resolved_at: this.now().toISOString() }); }

  async getBreaker(service: BreakerService): Promise<BreakerRecord> {
    const rows = await this.json(`circuit_breakers?service=eq.${service}`, {}, z.array(breakerRow), 'supabase.breakers');
    const r = rows[0];
    if (!r) return { service, state: 'closed', consecutiveFailures: 0 };
    return {
      service,
      state: r.state,
      consecutiveFailures: r.consecutive_failures,
      openedUntil: r.opened_until ? new Date(r.opened_until) : undefined,
    };
  }
  async saveBreaker(b: BreakerRecord) {
    await this.upsert('circuit_breakers', {
      service: b.service,
      state: b.state,
      consecutive_failures: b.consecutiveFailures,
      opened_until: b.openedUntil?.toISOString() ?? null,
      updated_at: this.now().toISOString(),
    });
  }

  async incrementDailyCounter(key: string) {
    return this.json('rpc/increment_daily_counter', { method: 'POST', body: JSON.stringify({ p_key: key }) }, z.number(), 'supabase.rpc.counter');
  }
  async getDailyCounter(key: string) {
    const day = this.now().toISOString().slice(0, 10);
    const rows = await this.json(`daily_counters?day=eq.${day}&key=eq.${key}&select=value`, {}, z.array(z.object({ value: z.number() })), 'supabase.counters');
    return rows[0]?.value ?? 0;
  }
  async saveRunMetrics(m: RunMetrics) {
    await this.send('run_metrics', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        duration_ms: m.durationMs,
        fetched_gmail: m.fetchedGmail,
        fetched_discord: m.fetchedDiscord,
        stored: m.stored,
        duplicates: m.duplicates,
        classified_keyword: m.classifiedKeyword,
        classified_llm: m.classifiedLlm,
        classified_fallback: m.classifiedFallback,
        openai_calls: m.openaiCalls,
        notified_slack: m.notifiedSlack,
        notified_urgent: m.notifiedUrgent,
        failed: m.failed,
        errors: m.errors,
      }),
    });
  }
  async shouldSendOpsAlert(key: string, minIntervalSec: number) {
    const rows = await this.json(`ops_alerts?key=eq.${encodeURIComponent(key)}&select=last_sent_at`, {}, z.array(z.object({ last_sent_at: z.string() })), 'supabase.ops_alerts');
    const last = rows[0] ? new Date(rows[0].last_sent_at).getTime() : 0;
    if (this.now().getTime() - last < minIntervalSec * 1000) return false;
    await this.upsert('ops_alerts', { key, last_sent_at: this.now().toISOString() });
    return true;
  }
  async acquireLock(name: string, holder: string, ttlSec: number) {
    return this.json(
      'rpc/acquire_run_lock',
      { method: 'POST', body: JSON.stringify({ p_name: name, p_holder: holder, p_ttl_sec: ttlSec }) },
      z.boolean(),
      'supabase.rpc.lock',
    );
  }
  async releaseLock(name: string, holder: string) {
    await this.send(`run_locks?name=eq.${name}&holder=eq.${holder}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }

  // ---- 共通 ----
  private headers(extra?: Record<string, string>): Record<string, string> {
    return { apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}`, 'Content-Type': 'application/json', ...extra };
  }
  private json<T>(path: string, init: Init, schema: z.ZodType<T>, name: string) {
    return fetchJson(
      `${this.url}/rest/v1/${path}`,
      { ...init, headers: this.headers(init.headers) },
      { service: 'supabase', timeoutMs: TIMEOUT_MS, maxRetries: 2, schema, schemaName: name },
    );
  }
  private async send(path: string, init: Init) {
    await fetchWithRetry(
      `${this.url}/rest/v1/${path}`,
      { ...init, headers: this.headers(init.headers) },
      { service: 'supabase', timeoutMs: TIMEOUT_MS, maxRetries: 2 },
    );
  }
  private patch(path: string, body: Record<string, unknown>) {
    return this.send(path, { method: 'PATCH', body: JSON.stringify(body), headers: { Prefer: 'return=minimal' } });
  }
  private upsert(table: string, row: Record<string, unknown>) {
    // merge-duplicates: 主キーが既にあれば更新、無ければ挿入
    return this.send(table, { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  }
}
