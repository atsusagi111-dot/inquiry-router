import type {
  BreakerRecord, BreakerService, Classification, DeadLetterEntry, Inquiry, InquiryStatus,
  NormalizedMessage, RoutingDecision, RunMetrics, Source,
} from '../../types/inquiry';
import type { Repo } from '../../types/ports';

/** Supabase の代わり。プロセス内 Map に持つだけなので、実 API を叩かずに全ステージを通せる */
export class MemoryRepo implements Repo {
  readonly inquiries = new Map<string, Inquiry & { bodyRaw: string; contentHash: string }>();
  readonly deadLetters = new Map<number, DeadLetterEntry & { resolved: boolean }>();
  readonly metrics: RunMetrics[] = [];
  private cursors = new Map<Source, string>();
  private breakers = new Map<BreakerService, BreakerRecord>();
  private counters = new Map<string, number>();
  private opsAlerts = new Map<string, Date>();
  private locks = new Map<string, { until: Date; holder: string }>();
  private nextDeadLetterId = 1;
  private seq = 0;

  constructor(private readonly now: () => Date) {}

  async insertMany(rows: NormalizedMessage[]) {
    let inserted = 0;
    let duplicates = 0;
    for (const r of rows) {
      // 本番の unique(source, source_message_id) と同じ振る舞いを再現する
      const exists = [...this.inquiries.values()].some(
        (q) => q.source === r.source && q.sourceMessageId === r.sourceMessageId);
      if (exists) { duplicates++; continue; }
      const id = `mem-${++this.seq}`;
      this.inquiries.set(id, {
        id, source: r.source, sourceMessageId: r.sourceMessageId, sender: r.sender, subject: r.subject,
        bodyClean: r.bodyClean, bodyRaw: r.body, contentHash: r.contentHash,
        receivedAt: r.receivedAt, status: 'ingested', isUrgent: false,
      });
      inserted++;
    }
    return { inserted, duplicates };
  }
  async getCursor(source: Source) { return this.cursors.get(source) ?? null; }
  async setCursor(source: Source, cursor: string) { this.cursors.set(source, cursor); }
  /** テスト用：同じ CSV をもう一度取り込ませて重複排除を検証する */
  resetCursors() { this.cursors.clear(); }

  async listByStatus(status: InquiryStatus, limit: number) {
    return [...this.inquiries.values()]
      .filter((q) => q.status === status)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .slice(0, limit);
  }
  async saveClassification(id: string, c: Classification, r: RoutingDecision) {
    const q = this.must(id);
    q.classification = c;
    q.targetChannel = r.targetChannel;
    q.isUrgent = r.isUrgent;
    q.status = 'classified';
  }
  async markSlackNotified(id: string) { this.must(id).slackNotifiedAt = this.now(); }
  async markUrgentNotified(id: string) { this.must(id).urgentNotifiedAt = this.now(); }
  async markNotified(id: string) { this.must(id).status = 'notified'; }
  async markFailed(id: string) { this.must(id).status = 'failed'; }

  async pushDeadLetter(entry: DeadLetterEntry) {
    const id = entry.id ?? this.nextDeadLetterId++;
    this.deadLetters.set(id, { ...entry, id, resolved: false });
  }
  async popDueDeadLetters(limit: number) {
    const t = this.now();
    return [...this.deadLetters.values()]
      .filter((d) => !d.resolved && d.nextRetryAt <= t)
      .slice(0, limit);
  }
  async resolveDeadLetter(id: number) {
    const d = this.deadLetters.get(id);
    if (d) d.resolved = true;
  }
  async getBreaker(service: BreakerService): Promise<BreakerRecord> {
    return this.breakers.get(service) ?? { service, state: 'closed', consecutiveFailures: 0 };
  }
  async saveBreaker(record: BreakerRecord) { this.breakers.set(record.service, { ...record }); }

  async incrementDailyCounter(key: string) {
    const v = (this.counters.get(this.dayKey(key)) ?? 0) + 1;
    this.counters.set(this.dayKey(key), v);
    return v;
  }
  async getDailyCounter(key: string) { return this.counters.get(this.dayKey(key)) ?? 0; }
  async saveRunMetrics(m: RunMetrics) { this.metrics.push({ ...m, errors: [...m.errors] }); }
  async shouldSendOpsAlert(key: string, minIntervalSec: number) {
    const last = this.opsAlerts.get(key);
    const t = this.now();
    if (last && t.getTime() - last.getTime() < minIntervalSec * 1000) return false;
    this.opsAlerts.set(key, t);
    return true;
  }
  async acquireLock(name: string, holder: string, ttlSec: number) {
    const cur = this.locks.get(name);
    const t = this.now();
    if (cur && cur.until > t && cur.holder !== holder) return false;
    this.locks.set(name, { until: new Date(t.getTime() + ttlSec * 1000), holder });
    return true;
  }
  async releaseLock(name: string, holder: string) {
    if (this.locks.get(name)?.holder === holder) this.locks.delete(name);
  }

  private must(id: string) {
    const q = this.inquiries.get(id);
    if (!q) throw new Error(`MemoryRepo: inquiry ${id} が存在しません`);
    return q;
  }
  private dayKey(key: string) { return `${this.now().toISOString().slice(0, 10)}:${key}`; }
}
