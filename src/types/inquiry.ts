// 3 つの worktree が共有するドメイン型。
// ここを変えると全ブランチに波及するため、変更は必ず main で合意してから行う。

export type Source = 'gmail' | 'discord';

/** 分類カテゴリ。「対象外」は不動産と無関係なメッセージの受け皿（誤分類防止のため必須） */
export type Category = '賃貸' | '売買' | '内見' | 'クレーム' | '対象外';
export const CATEGORIES: readonly Category[] = ['賃貸', '売買', '内見', 'クレーム', '対象外'];

export type Confidence = 'high' | 'low';

/** どの経路で分類が決まったか。精度分析と障害時の説明に使う */
export type ClassifiedBy = 'keyword' | 'llm' | 'fallback';

export type InquiryStatus = 'ingested' | 'duplicate' | 'classified' | 'notified' | 'failed';

/** 受信直後・正規化前。Source アダプタが返す形 */
export interface RawMessage {
  source: Source;
  sourceMessageId: string;
  sourceThreadId?: string;
  sender?: string;
  subject?: string;
  body: string;
  receivedAt: Date;
}

/** 署名・引用除去とハッシュ計算を終え、DB に入れる直前の形 */
export interface NormalizedMessage extends RawMessage {
  bodyClean: string;
  contentHash: string;
}

export interface Classification {
  category: Category;
  confidence: Confidence;
  classifiedBy: ClassifiedBy;
  reason: string;
}

/** (category, confidence) から決まる振り分け結果 */
export interface RoutingDecision {
  targetChannel: string;
  isUrgent: boolean;
}

/** DB 保存後の問い合わせ。classify / notify はこれを受け取る */
export interface Inquiry {
  id: string;
  source: Source;
  sourceMessageId: string;
  sender?: string;
  subject?: string;
  bodyClean: string;
  receivedAt: Date;
  status: InquiryStatus;
  classification?: Classification;
  targetChannel?: string;
  isUrgent: boolean;
  slackNotifiedAt?: Date;
  urgentNotifiedAt?: Date;
}

export type DeadLetterStage = 'ingest' | 'classify' | 'notify_slack' | 'notify_urgent';

export interface DeadLetterEntry {
  id?: number;
  stage: DeadLetterStage;
  inquiryId?: string;
  payload?: unknown;
  error: string;
  attempts: number;
  nextRetryAt: Date;
}

export type BreakerService = 'gmail' | 'discord' | 'openai' | 'slack';
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerRecord {
  service: BreakerService;
  consecutiveFailures: number;
  state: BreakerState;
  openedUntil?: Date;
}

/** 1 ティック分の集計。run_metrics テーブルの 1 行に対応 */
export interface RunMetrics {
  durationMs: number;
  fetchedGmail: number;
  fetchedDiscord: number;
  stored: number;
  duplicates: number;
  classifiedKeyword: number;
  classifiedLlm: number;
  classifiedFallback: number;
  openaiCalls: number;
  notifiedSlack: number;
  notifiedUrgent: number;
  failed: number;
  errors: string[];
}

export function emptyMetrics(): RunMetrics {
  return {
    durationMs: 0, fetchedGmail: 0, fetchedDiscord: 0, stored: 0, duplicates: 0,
    classifiedKeyword: 0, classifiedLlm: 0, classifiedFallback: 0, openaiCalls: 0,
    notifiedSlack: 0, notifiedUrgent: 0, failed: 0, errors: [],
  };
}
