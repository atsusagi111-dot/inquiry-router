import type { Inquiry } from '../types/inquiry';
import type { SlackNotifier } from '../types/ports';
import { fetchWithRetry } from './http';

// 5 秒: Webhook は数百 ms で返る。1 ティックで最大 10 件送るので、1 件が長引いても全体に響かない上限
const TIMEOUT_MS = 5_000;
const BODY_LIMIT = 1500;  // Slack の 1 メッセージ上限（約 4000 文字）に余裕をもって収める

const SOURCE_LABEL = { gmail: '📧 メール', discord: '💬 Discord' } as const;

export function formatSlackText(q: Inquiry): string {
  const c = q.classification;
  // low / fallback は「機械が決めきれなかった」ことを人に伝える
  const head = c && (c.confidence === 'low' || c.classifiedBy === 'fallback')
    ? `⚠️ *要確認*（推定: ${c.category} / ${c.classifiedBy}）`
    : `*[${c?.category ?? '未分類'}]*`;
  const received = q.receivedAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const meta = [SOURCE_LABEL[q.source], q.sender ?? '送信者不明', received].join(' | ');
  const subject = q.subject ? `*件名:* ${q.subject}\n` : '';
  const body = q.bodyClean.length > BODY_LIMIT ? `${q.bodyClean.slice(0, BODY_LIMIT)}…` : q.bodyClean;
  const quoted = body.split('\n').map((l) => `> ${l}`).join('\n');
  const reason = c ? `\n_${c.reason}_` : '';
  return `${head} ${meta}\n${subject}${quoted}${reason}`;
}

export class SlackWebhookNotifier implements SlackNotifier {
  /** チャンネル名 → Webhook URL。routing が決めたチャンネル名で引く */
  constructor(private readonly webhooks: Record<string, string>) {}

  async post(channel: string, q: Inquiry): Promise<void> {
    const url = this.webhooks[channel];
    if (!url) throw new Error(`Slack Webhook が未設定のチャンネル: ${channel}`);
    await fetchWithRetry(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: formatSlackText(q) }) },
      { service: 'slack', timeoutMs: TIMEOUT_MS },
    );
  }
}
