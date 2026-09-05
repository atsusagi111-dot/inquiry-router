import { describe, expect, it } from 'vitest';
import { formatSlackText } from './slack';
import type { Inquiry } from '../types/inquiry';

const base: Inquiry = {
  id: 'x',
  source: 'gmail',
  sourceMessageId: 'm1',
  sender: 'a@example.com',
  subject: '内見希望',
  bodyClean: '週末に内見をお願いします。\n2 件です。',
  receivedAt: new Date('2026-09-05T01:00:00Z'),
  status: 'classified',
  isUrgent: false,
  classification: { category: '内見', confidence: 'high', classifiedBy: 'llm', reason: '内見の日程相談' },
};

describe('formatSlackText', () => {
  it('カテゴリ・送信元・件名・引用本文・理由を含む', () => {
    const t = formatSlackText(base);
    expect(t).toContain('*[内見]*');
    expect(t).toContain('📧 メール | a@example.com');
    expect(t).toContain('*件名:* 内見希望');
    expect(t).toContain('> 週末に内見をお願いします。\n> 2 件です。');
    expect(t).toContain('_内見の日程相談_');
  });
  it('confidence low は ⚠️ 要確認 と推定カテゴリを出す', () => {
    const t = formatSlackText({ ...base, classification: { ...base.classification!, confidence: 'low' } });
    expect(t).toContain('⚠️ *要確認*（推定: 内見 / llm）');
  });
  it('長い本文は 1500 文字で打ち切る', () => {
    const t = formatSlackText({ ...base, bodyClean: 'あ'.repeat(3000) });
    expect(t).toContain('あ'.repeat(1500) + '…');
    expect(t).not.toContain('あ'.repeat(1501));
  });
});
