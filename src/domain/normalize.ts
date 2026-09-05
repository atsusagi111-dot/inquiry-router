import type { NormalizedMessage, RawMessage } from '../types/inquiry';

// ここより下は署名・引用とみなして切り捨てる行のパターン
const CUT_MARKERS: RegExp[] = [
  /^-- ?$/,                                  // メーラー標準の署名区切り
  /^[-_=*─━]{3,}\s*$/,                       // 罫線
  /^On .+ wrote:\s*$/,                       // 英語 Gmail の引用ヘッダ
  /^\d{4}年\d{1,2}月\d{1,2}日.*:\s*$/,        // 日本語 Gmail の引用ヘッダ「2026年9月5日(金) 12:00 山田 <..>:」
  /^-+ ?Original Message ?-+$/i,
  /^Sent from my (iPhone|iPad|Galaxy)/i,
  /^iPhoneから送信$/,
];

/** 署名と引用を落とし、空白を整える。分類に効かないノイズを減らし、同一内容の判定を安定させるため */
export function cleanBody(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (CUT_MARKERS.some((re) => re.test(t))) break;     // 以降はすべて捨てる
    if (t.startsWith('>')) continue;                      // 引用行
    kept.push(line.replace(/[ \t　]+/g, ' ').trim()); // 全角スペース含め空白を 1 個に
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** sender + 本文の SHA-256。同じ人が同じ内容を再送したことを検出する */
export async function contentHash(sender: string | undefined, bodyClean: string): Promise<string> {
  const data = new TextEncoder().encode(`${sender ?? ''}\n${bodyClean}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function normalize(raw: RawMessage): Promise<NormalizedMessage> {
  const bodyClean = cleanBody(raw.body);
  return { ...raw, bodyClean, contentHash: await contentHash(raw.sender, bodyClean) };
}
