// 各層の「境界」。pipeline はこのインターフェースだけを見て動き、
// 本物の API アダプタとモックはどちらもこれを実装する。
import type {
  BreakerRecord, BreakerService, Classification, DeadLetterEntry, Inquiry,
  InquiryStatus, NormalizedMessage, RawMessage, RoutingDecision, RunMetrics, Source,
} from './inquiry';

export interface FetchResult {
  messages: RawMessage[];
  /** 次回の差分取得に使う位置。取得ゼロなら前回の cursor をそのまま返す */
  nextCursor: string | null;
}

/** 受信元（Gmail / Discord / fixtures モック） */
export interface MessageSource {
  readonly source: Source;
  fetchNew(cursor: string | null): Promise<FetchResult>;
}

export interface ClassifyInput {
  source: Source;
  subject?: string;
  body: string;
}

/** LLM 分類器。classifiedBy は呼び出し側（pipeline）が付ける */
export interface Classifier {
  classify(input: ClassifyInput): Promise<Omit<Classification, 'classifiedBy'>>;
}

export interface SlackNotifier {
  post(channel: string, inquiry: Inquiry): Promise<void>;
}

export interface UrgentNotifier {
  /** 営業部長 DM ＋ #緊急対応 への @営業部 メンション投稿 */
  notifyUrgent(inquiry: Inquiry): Promise<void>;
  /** 運用アラート（連続失敗など）。#緊急対応 のみ */
  notifyOps(message: string): Promise<void>;
}

/** 永続化。Supabase 実装とインメモリ実装の 2 つがある */
export interface Repo {
  // --- ingest ---
  insertMany(rows: NormalizedMessage[]): Promise<{ inserted: number; duplicates: number }>;
  getCursor(source: Source): Promise<string | null>;
  setCursor(source: Source, cursor: string): Promise<void>;

  // --- classify / notify ---
  listByStatus(status: InquiryStatus, limit: number): Promise<Inquiry[]>;
  /** dead_letter からの再処理で、DB の最新フラグを見て未送信分だけ送るために使う */
  getById(id: string): Promise<Inquiry | null>;
  saveClassification(id: string, c: Classification, r: RoutingDecision): Promise<void>;
  markSlackNotified(id: string): Promise<void>;
  markUrgentNotified(id: string): Promise<void>;
  markNotified(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;

  // --- 障害対策 ---
  pushDeadLetter(entry: DeadLetterEntry): Promise<void>;
  popDueDeadLetters(limit: number): Promise<DeadLetterEntry[]>;
  resolveDeadLetter(id: number): Promise<void>;
  getBreaker(service: BreakerService): Promise<BreakerRecord>;
  saveBreaker(record: BreakerRecord): Promise<void>;

  // --- 監視・制御 ---
  incrementDailyCounter(key: string): Promise<number>;
  getDailyCounter(key: string): Promise<number>;
  saveRunMetrics(m: RunMetrics): Promise<void>;
  shouldSendOpsAlert(key: string, minIntervalSec: number): Promise<boolean>;
  acquireLock(name: string, holder: string, ttlSec: number): Promise<boolean>;
  releaseLock(name: string, holder: string): Promise<void>;
}

/** run.ts が受け取る依存一式。モック時はこれ全部が差し替わる */
export interface Deps {
  sources: MessageSource[];
  classifier: Classifier;
  slack: SlackNotifier;
  urgent: UrgentNotifier;
  repo: Repo;
  now: () => Date;
}
