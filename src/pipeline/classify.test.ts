import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMockDeps, type MockDeps } from '../adapters/mock';
import { CHANNEL_TO_SOURCE } from '../adapters/mock/fixtures-source';
import { emptyMetrics } from '../types/inquiry';
import { loadEnv } from '../env';
import { classify } from './classify';

const csv = readFileSync('fixtures/case5-test-inquiries.csv', 'utf8');
const env = loadEnv({ MOCK_EXTERNAL_API: 'true' });

// ingest は別ブランチなので、fixtures を直接 Repo に入れる
async function seed(deps: MockDeps) {
  await deps.repo.insertMany(deps.rows.map((r) => ({
    source: CHANNEL_TO_SOURCE[r.channel],
    sourceMessageId: `fixture-${r.no}`,
    body: r.body,
    bodyClean: r.body,
    contentHash: `h${r.no}`,
    receivedAt: new Date(2026, 8, 5, 10, r.no),
  })));
}
const find = (deps: MockDeps, no: number) =>
  [...deps.repo.inquiries.values()].find((q) => q.sourceMessageId === `fixture-${no}`)!;
async function runAll(deps: MockDeps, e = env) {
  const m = emptyMetrics();
  for (let i = 0; i < 5; i++) await classify(e, deps, m);
  return m;
}

describe('classify', () => {
  it('22 件すべて期待カテゴリになり、No.19/20 だけ緊急', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    await seed(deps);
    const m = await runAll(deps);
    for (const r of deps.rows) {
      const q = find(deps, r.no);
      expect(q.classification?.category, `No.${r.no}`).toBe(r.expectedCategory);
      expect(q.isUrgent, `No.${r.no} urgent`).toBe(r.expectedUrgent);
      expect(q.status).toBe('classified');
    }
    expect(m.classifiedKeyword + m.classifiedLlm).toBe(22);
    expect(m.classifiedFallback).toBe(0);
  });

  it('No.19/20/22 はキーワード、No.8/21 は LLM で決まる', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    await seed(deps);
    await runAll(deps);
    expect(find(deps, 19).classification?.classifiedBy).toBe('keyword');
    expect(find(deps, 20).classification?.classifiedBy).toBe('keyword');
    expect(find(deps, 22).classification?.classifiedBy).toBe('keyword');
    expect(find(deps, 8).classification?.classifiedBy).toBe('llm');
    expect(find(deps, 21).classification?.classifiedBy).toBe('llm');
  });

  it('OpenAI 断: クレーム 2 件は緊急のまま、残りは fallback で #未分類、No.22 は緊急にならない', async () => {
    const deps = createMockDeps({ fixturesCsv: csv, classifier: 'failing' });
    await seed(deps);
    const m = await runAll(deps);
    expect(find(deps, 19).isUrgent).toBe(true);
    expect(find(deps, 20).isUrgent).toBe(true);
    expect(find(deps, 22).isUrgent).toBe(false);
    expect(find(deps, 22).targetChannel).toBe('#賃貸');
    expect(find(deps, 21).targetChannel).toBe('#未分類');
    expect(find(deps, 8).classification?.classifiedBy).toBe('fallback');
    expect(m.classifiedFallback).toBeGreaterThan(0);
    // 5 回失敗した時点でブレーカーが開き、以降は呼ばれない
    expect((await deps.repo.getBreaker('openai')).state).toBe('open');
    expect(m.openaiCalls).toBe(5);
  });

  it('日次上限に達したら LLM を呼ばず fallback にする', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    await seed(deps);
    const m = await runAll(deps, { ...env, OPENAI_DAILY_LIMIT: 2 });
    expect(m.openaiCalls).toBe(2);
    expect(m.classifiedLlm).toBe(2);
    expect(m.classifiedFallback).toBeGreaterThan(0);
  });

  it('CLASSIFY_BATCH_SIZE 件ずつ処理する', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    await seed(deps);
    const m = emptyMetrics();
    await classify({ ...env, CLASSIFY_BATCH_SIZE: 5 }, deps, m);
    expect(m.classifiedKeyword + m.classifiedLlm).toBe(5);
  });
});
