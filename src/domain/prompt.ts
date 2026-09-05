import type { ClassifyInput } from '../types/ports';

export const SYSTEM_PROMPT = `あなたは不動産管理会社の問い合わせ受付担当です。届いたメッセージを次の 5 つのいずれか 1 つに分類してください。

- 賃貸: 部屋を借りたい／借りている人からの相談。物件探し、契約・更新・退去・敷金など入居中の事務手続きを含む
- 売買: 物件を買いたい／売りたい。購入相談、住宅ローン、査定、投資用物件
- 内見: 具体的な物件を見に行く日程・方法の相談が主目的のもの
- クレーム: 不満・苦情・設備不良・約束と違うなど、会社側の対応が必要な申し立て
- 対象外: 不動産と無関係なもの。雑談、天気、スパム、誤送信、空メッセージ

ルール:
1. 不動産に関係ないなら迷わず「対象外」にする。無理にどれかに当てはめない。
2. 「緊急ではない」「クレームではない」のように否定されている語は判断の根拠にしない。
3. 物件探しの中で内見に触れているだけなら「賃貸」または「売買」。内見の日程・方法そのものが主題なら「内見」。
4. 2 つ以上のカテゴリに跨る、情報が少ない、判断に迷う場合は confidence を "low" にする。
5. reason は日本語 1 文で、判断根拠となった語句を含める。`;

/** Structured Outputs 用スキーマ。enum を固定することで 5 値以外が返る余地をなくす */
export const RESPONSE_SCHEMA = {
  name: 'inquiry_classification',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['賃貸', '売買', '内見', 'クレーム', '対象外'] },
      confidence: { type: 'string', enum: ['high', 'low'] },
      reason: { type: 'string' },
    },
    required: ['category', 'confidence', 'reason'],
    additionalProperties: false,
  },
} as const;

export function buildUserMessage(input: ClassifyInput): string {
  const channel = input.source === 'gmail' ? 'メール' : 'Discord';
  const subject = input.subject ? `件名: ${input.subject}\n` : '';
  // 本文は長くても 2000 文字で打ち切る。分類に必要なのは冒頭で十分で、トークン費用と時間を抑えるため
  return `チャネル: ${channel}\n${subject}本文:\n${input.body.slice(0, 2000)}`;
}
