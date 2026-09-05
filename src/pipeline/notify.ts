import type { Env } from '../env';
import type { Deps } from '../types/ports';
import type { DeadLetterEntry, DeadLetterStage, Inquiry, RunMetrics } from '../types/inquiry';
import { withBreaker } from '../adapters/circuit-breaker';
import { toDeadLetter } from './run';
import { errorMessage, log } from '../observability/logger';

/** classified を古い順に取り、Slack と緊急通知を送る */
export async function notify(env: Env, deps: Deps, m: RunMetrics): Promise<void> {
  const batch = await deps.repo.listByStatus('classified', env.NOTIFY_BATCH_SIZE);
  for (const q of batch) {
    const failure = await deliver(q, deps, m);
    if (!failure) continue;
    // 失敗した行は failed にして通常バッチから外し、dead_letter の再処理に任せる。
    // classified のままだと、壊れた行が毎分バッチの先頭を占有して新しい通知を止めてしまう
    await toDeadLetter(deps, m, failure.stage, failure.error, { inquiryId: q.id });
    await deps.repo.markFailed(q.id);
    log.error('notify failed', { id: q.id, stage: failure.stage, error: errorMessage(failure.error) });
  }
}

/** dead_letter からの再処理。DB の最新フラグを見て、未送信の経路だけ送り直す */
export async function retryNotify(entry: DeadLetterEntry, _env: Env, deps: Deps, m: RunMetrics): Promise<void> {
  if (!entry.inquiryId) return;
  const q = await deps.repo.getById(entry.inquiryId);
  if (!q) return;   // 行が消えていれば再処理の対象外（resolve される）
  const failure = await deliver(q, deps, m);
  if (failure) throw failure.error;   // 投げると run.ts の requeue が回数を増やして先送りする
}

interface Failure { stage: DeadLetterStage; error: unknown }

/**
 * Slack と緊急通知を「済んでいないものだけ」送り、送信成功の直後にフラグを書く。
 * Slack が落ちていても緊急通知は試す（緊急のほうが重要）。両方失敗なら緊急側を stage にする
 */
async function deliver(q: Inquiry, deps: Deps, m: RunMetrics): Promise<Failure | null> {
  let failure: Failure | null = null;

  if (!q.slackNotifiedAt) {
    try {
      await withBreaker(deps.repo, 'slack', deps.now, () => deps.slack.post(q.targetChannel ?? '#未分類', q));
      await deps.repo.markSlackNotified(q.id);
      m.notifiedSlack++;
    } catch (e) {
      failure = { stage: 'notify_slack', error: e };
    }
  }

  if (q.isUrgent && !q.urgentNotifiedAt) {
    try {
      await withBreaker(deps.repo, 'discord', deps.now, () => deps.urgent.notifyUrgent(q));
      await deps.repo.markUrgentNotified(q.id);
      m.notifiedUrgent++;
    } catch (e) {
      failure = { stage: 'notify_urgent', error: e };
    }
  }

  if (!failure) await deps.repo.markNotified(q.id);
  return failure;
}
