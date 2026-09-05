import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMockDeps } from '../adapters/mock';
import { emptyMetrics } from '../types/inquiry';
import { loadEnv } from '../env';
import { ingest } from './ingest';
import type { MessageSource } from '../types/ports';

const csv = readFileSync('fixtures/case5-test-inquiries.csv', 'utf8');
const env = loadEnv({ MOCK_EXTERNAL_API: 'true' });

describe('ingest', () => {
  it('22 件を ingested で保存し、Gmail 11 / Discord 11 に振り分ける', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    const m = emptyMetrics();
    await ingest(env, deps, m);
    expect(m.fetchedGmail).toBe(11);
    expect(m.fetchedDiscord).toBe(11);
    expect(m.stored).toBe(22);
    expect([...deps.repo.inquiries.values()].every((q) => q.status === 'ingested')).toBe(true);
    expect(await deps.repo.getCursor('gmail')).toBe('22');
  });

  it('2 回目は cursor により取得 0 件。cursor を戻しても unique 制約で保存 0・重複 22', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    await ingest(env, deps, emptyMetrics());
    const second = emptyMetrics();
    await ingest(env, deps, second);
    expect(second.fetchedGmail + second.fetchedDiscord).toBe(0);
    deps.repo.resetCursors();
    const third = emptyMetrics();
    await ingest(env, deps, third);
    expect(third.stored).toBe(0);
    expect(third.duplicates).toBe(22);
  });

  it('片方の受信元が失敗しても、もう片方は保存され、失敗は数えられる', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    const broken: MessageSource = { source: 'gmail', fetchNew: async () => { throw new Error('boom'); } };
    deps.sources = [broken, deps.sources[1]!];
    const m = emptyMetrics();
    await ingest(env, deps, m);
    expect(m.stored).toBe(11);
    expect(m.failed).toBe(1);
    expect((await deps.repo.getBreaker('gmail')).consecutiveFailures).toBe(1);
  });

  it('連続 5 回失敗でブレーカーが開き、以後は呼び出さない', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    let calls = 0;
    deps.sources = [{ source: 'gmail', fetchNew: async () => { calls++; throw new Error('down'); } }];
    for (let i = 0; i < 6; i++) await ingest(env, deps, emptyMetrics());
    expect(calls).toBe(5);
    expect((await deps.repo.getBreaker('gmail')).state).toBe('open');
  });
});
