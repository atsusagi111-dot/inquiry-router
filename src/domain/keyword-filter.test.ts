import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { keywordFilter } from './keyword-filter';
import { parseFixturesCsv } from '../adapters/mock/fixtures-source';

const rows = parseFixturesCsv(readFileSync('fixtures/case5-test-inquiries.csv', 'utf8'));
const body = (no: number) => rows.find((r) => r.no === no)!.body;

describe('keywordFilter: テストデータ', () => {
  it('No.19 / No.20 はキーワードだけでクレーム確定（LLM 不要）', () => {
    expect(keywordFilter(body(19)).decision?.category).toBe('クレーム');
    expect(keywordFilter(body(20)).decision?.category).toBe('クレーム');
  });
  it('No.22 「緊急ではありません」はクレーム語ゼロ、退去・敷金で賃貸確定', () => {
    const r = keywordFilter(body(22));
    expect(r.hits.filter((h) => h.category === 'クレーム')).toHaveLength(0);
    expect(r.decision?.category).toBe('賃貸');
  });
  it('No.8 は賃貸と内見の語が混在するので確定しない（LLM へ）', () => {
    expect(keywordFilter(body(8)).decision).toBeNull();
  });
  it('No.21 天気の話はどこにもヒットせず確定しない（LLM へ）', () => {
    const r = keywordFilter(body(21));
    expect(r.decision).toBeNull();
    expect(r.hits).toHaveLength(0);
  });
  it('No.1 は 1LDK・家賃で賃貸確定、No.16 は内見・日程調整で内見確定', () => {
    expect(keywordFilter(body(1)).decision?.category).toBe('賃貸');
    expect(keywordFilter(body(16)).decision?.category).toBe('内見');
  });
});

describe('keywordFilter: 否定表現', () => {
  it.each([
    '緊急ではありません。',
    '至急ではなく、来週で大丈夫です。',
    'クレームではないのですが、気になる点があります。',
    '故障ではないと思いますが確認したいです。',
  ])('「%s」で緊急語を数えない', (text) => {
    expect(keywordFilter(text).hits.filter((h) => h.category === 'クレーム')).toHaveLength(0);
  });
  it('否定は同じ文の中でだけ効く', () => {
    const r = keywordFilter('エアコンが故障しました。緊急ではありません。');
    expect(r.hits.map((h) => h.keyword)).toEqual(['故障']);
    expect(r.decision).toBeNull();   // 弱い語 1 つなので LLM へ
  });
  it('弱い語 1 つだけではクレーム確定しない', () => {
    expect(keywordFilter('至急お返事ください').decision).toBeNull();
  });
  it('空本文は対象外で確定', () => {
    expect(keywordFilter('   ').decision?.category).toBe('対象外');
  });
});
