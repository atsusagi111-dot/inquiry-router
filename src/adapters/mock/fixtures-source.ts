import { CATEGORIES, type Category, type RawMessage, type Source } from '../../types/inquiry';
import type { FetchResult, MessageSource } from '../../types/ports';

export interface FixtureRow {
  no: number;
  channel: 'line' | 'mail';
  body: string;
  expectedCategory: Category;
  expectedUrgent: boolean;
  feature: string;
}

/** CSV の「チャネル」列は旧仕様の名残。mail→Gmail、line→Discord と読み替える */
export const CHANNEL_TO_SOURCE: Record<FixtureRow['channel'], Source> = { mail: 'gmail', line: 'discord' };

// 「その他/分類対象外」のような表記ゆれを enum に寄せる
function toCategory(raw: string): Category {
  if (raw.includes('対象外') || raw.includes('その他')) return '対象外';
  const hit = CATEGORIES.find((c) => c === raw);
  if (!hit) throw new Error(`fixtures: 未知の期待カテゴリ "${raw}"`);
  return hit;
}

/** ダブルクォートと CRLF に耐える最小限の CSV パーサ（依存を増やさないため自前） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');  // Excel 由来の BOM（先頭の見えない文字）を落とす
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

export function parseFixturesCsv(csv: string): FixtureRow[] {
  const [header, ...lines] = parseCsv(csv);
  if (!header || header[0] !== '番号') throw new Error('fixtures: ヘッダ行が想定と違います');
  return lines.map((cols) => {
    const [no, channel, body, category, urgent, feature] = cols;
    if (channel !== 'line' && channel !== 'mail') throw new Error(`fixtures: 未知のチャネル "${channel}"`);
    return {
      no: Number(no), channel, body: body ?? '',
      expectedCategory: toCategory(category ?? ''),
      expectedUrgent: (urgent ?? '').toUpperCase() === 'TRUE',
      feature: feature ?? '',
    };
  });
}

/** CSV の行を、あたかも Gmail / Discord から届いたかのように返す Source */
export class FixturesSource implements MessageSource {
  constructor(
    readonly source: Source,
    private readonly rows: FixtureRow[],
    private readonly baseTime: Date,
  ) {}

  async fetchNew(cursor: string | null): Promise<FetchResult> {
    const after = cursor ? Number(cursor) : 0;
    const mine = this.rows.filter((r) => CHANNEL_TO_SOURCE[r.channel] === this.source && r.no > after);
    const messages: RawMessage[] = mine.map((r) => ({
      source: this.source,
      sourceMessageId: `fixture-${r.no}`,
      sender: this.source === 'gmail' ? `test${r.no}@example.com` : `user${r.no}`,
      subject: this.source === 'gmail' ? r.body.slice(0, 20) : undefined,
      body: r.body,
      // 番号順に古い→新しいとなるよう、1 件 1 分ずつずらす
      receivedAt: new Date(this.baseTime.getTime() - (this.rows.length - r.no) * 60_000),
    }));
    const last = mine.at(-1);
    return { messages, nextCursor: last ? String(last.no) : cursor };
  }
}
