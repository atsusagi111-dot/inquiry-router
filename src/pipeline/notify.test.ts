import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMockDeps, type MockDeps } from '../adapters/mock';
import { CHANNEL_TO_SOURCE } from '../adapters/mock/fixtures-source';
import { emptyMetrics, type Category } from '../types/inquiry';
import { loadEnv } from '../env';
import { notify } from './notify';
import { runTick } from './run';

const csv = readFileSync('fixtures/case5-test-inquiries.csv', 'utf8');
const env = loadEnv({ MOCK_EXTERNAL_API: 'true' });
const channelOf: Record<Category, string> = { 賃貸: '#賃貸', 売買: '#売買', 内見: '#内見', クレーム: '#クレーム', 対象外: '#未分類' };

// ingest / classify は別ブランチなので、classified 済みの状態を直接作る
async function seedClassified(deps: MockDeps) {
  await deps.repo.insertMany(deps.rows.map((r) => ({
    source: CHANNEL_TO_SOURCE[r.channel],
    sourceMessageId: `fixture-${r.no}`,
    body: r.body,
    bodyClean: r.body,
    contentHash: `h${r.no}`,
    receivedAt: new Date(2026, 8, 5, 10, r.no),
  })));
  for (const r of deps.rows) {
    const q = [...deps.repo.inquiries.values()].find((x) => x.sourceMessageId === `fixture-${r.no}`)!;
    await deps.repo.saveClassification(
      q.id,
      { category: r.expectedCategory, confidence: 'high', classifiedBy: 'llm', reason: 'test' },
      { targetChannel: channelOf[r.expectedCategory], isUrgent: r.expectedCategory === 'クレーム' },
    );
  }
}
const find = (deps: MockDeps, no: number) =>
  [...deps.repo.inquiries.values()].find((q) => q.sourceMessageId === `fixture-${no}`)!;
async function notifyAll(deps: MockDeps) {
  const m = emptyMetrics();
  for (let i = 0; i < 3; i++) await notify(env, deps, m);
  return m;
}

describe('notify', () => {
  it('22 件を Slack に振り分け、緊急通知は No.19/20 の 2 回だけ', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    await seedClassified(deps);
    const m = await notifyAll(deps);
    expect(m.notifiedSlack).toBe(22);
    expect(m.notifiedUrgent).toBe(2);
    const count = (ch: string) => deps.slack.posts.filter((p) => p.channel === ch).length;
    expect([count('#賃貸'), count('#売買'), count('#内見'), count('#クレーム'), count('#未分類')]).toEqual([11, 4, 4, 2, 1]);
    expect(deps.urgent.urgent.map((u) => u.sourceMessageId).sort()).toEqual(['fixture-19', 'fixture-20']);
    expect([...deps.repo.inquiries.values()].every((q) => q.status === 'notified')).toBe(true);
  });

  it('もう一度実行しても再送しない（冪等性）', async () => {
    const deps = createMockDeps({ fixturesCsv: csv });
    await seedClassified(deps);
    await notifyAll(deps);
    const m = await notifyAll(deps);
    expect(m.notifiedSlack + m.notifiedUrgent).toBe(0);
    expect(deps.slack.posts).toHaveLength(22);
  });

  it('Discord 断: Slack は届き、緊急 2 件だけ failed + dead_letter(notify_urgent) になる', async () => {
    const deps = createMockDeps({ fixturesCsv: csv, failUrgent: true });
    await seedClassified(deps);
    const m = await notifyAll(deps);
    expect(m.notifiedSlack).toBe(22);
    expect(m.notifiedUrgent).toBe(0);
    expect(find(deps, 19).status).toBe('failed');
    expect(find(deps, 19).slackNotifiedAt).toBeDefined();
    const dl = [...deps.repo.deadLetters.values()];
    expect(dl.map((d) => d.stage)).toEqual(['notify_urgent', 'notify_urgent']);
    expect(find(deps, 22).status).toBe('notified');
  });

  it('復旧後の再処理で緊急だけ送り直し、Slack は再送しない', async () => {
    let clock = new Date('2026-09-05T01:00:00Z');
    const deps = createMockDeps({ fixturesCsv: csv, failUrgent: true, now: () => clock });
    await seedClassified(deps);
    await notifyAll(deps);
    deps.urgent.failUrgent = false;
    clock = new Date(clock.getTime() + 61_000);   // 初回の再試行は 1 分後
    const m = await runTick(env, deps);
    expect(m.notifiedUrgent).toBe(2);
    expect(m.notifiedSlack).toBe(0);
    expect(deps.slack.posts).toHaveLength(22);
    expect(find(deps, 19).status).toBe('notified');
    expect([...deps.repo.deadLetters.values()].every((d) => d.resolved)).toBe(true);
  });

  it('5 回再処理しても失敗したら諦めて failed のまま、運用アラートを出す', async () => {
    let clock = new Date('2026-09-05T01:00:00Z');
    const deps = createMockDeps({ fixturesCsv: csv, failUrgent: true, now: () => clock });
    await seedClassified(deps);
    await notifyAll(deps);
    for (let i = 0; i < 6; i++) {
      clock = new Date(clock.getTime() + 61 * 60_000);   // 最大 60 分待ちなので毎回 61 分進める
      await runTick(env, deps);
    }
    expect(find(deps, 19).status).toBe('failed');
    expect([...deps.repo.deadLetters.values()].every((d) => d.resolved)).toBe(true);
    expect(deps.urgent.ops.some((o) => o.includes('諦め'))).toBe(true);
    expect(deps.slack.posts).toHaveLength(22);
  });
});
