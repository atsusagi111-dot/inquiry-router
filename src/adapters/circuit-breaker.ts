import type { BreakerRecord, BreakerService } from '../types/inquiry';
import type { Repo } from '../types/ports';
import { errorMessage, log } from '../observability/logger';

// 連続 5 回失敗で 5 分間遮断。5 分は「一時障害なら復旧している」「本障害なら無駄打ちを 5 分に 1 回に抑える」の折衷
export const BREAKER = { failureThreshold: 5, openMs: 5 * 60_000 } as const;

export class BreakerOpenError extends Error {
  constructor(readonly service: BreakerService, readonly openedUntil?: Date) {
    super(`${service} は遮断中（${openedUntil?.toISOString() ?? '?'} まで）`);
    this.name = 'BreakerOpenError';
  }
}

export async function withBreaker<T>(
  repo: Repo, service: BreakerService, now: () => Date, fn: () => Promise<T>,
): Promise<T> {
  const rec = await repo.getBreaker(service);
  const t = now();

  if (rec.state === 'open') {
    if (rec.openedUntil && rec.openedUntil > t) throw new BreakerOpenError(service, rec.openedUntil);
    // 遮断時間が過ぎた。1 回だけ通して様子を見る
    rec.state = 'half_open';
    await repo.saveBreaker(rec);
  }

  try {
    const result = await fn();
    if (rec.state !== 'closed' || rec.consecutiveFailures > 0) {
      await repo.saveBreaker({ service, state: 'closed', consecutiveFailures: 0 });
      if (rec.state !== 'closed') log.info('circuit closed', { service });
    }
    return result;
  } catch (e) {
    const failures = rec.consecutiveFailures + 1;
    // half_open での失敗は即再遮断（試しに通した 1 回が失敗したなら復旧していない）
    const shouldOpen = rec.state === 'half_open' || failures >= BREAKER.failureThreshold;
    const next: BreakerRecord = shouldOpen
      ? { service, state: 'open', consecutiveFailures: failures, openedUntil: new Date(t.getTime() + BREAKER.openMs) }
      : { service, state: rec.state, consecutiveFailures: failures };
    await repo.saveBreaker(next);
    if (shouldOpen) log.error('circuit opened', { service, failures, error: errorMessage(e) });
    throw e;
  }
}
