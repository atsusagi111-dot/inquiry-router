import type { RunMetrics, BreakerService } from '../types/inquiry';
import type { Deps } from '../types/ports';

const SERVICES: BreakerService[] = ['gmail', 'discord', 'openai', 'slack'];
const ALERT_FAILURE_THRESHOLD = 3;   // ブレーカー遮断（5 回）より前に人へ知らせる
const ALERT_INTERVAL_SEC = 60 * 60;  // 同じ警告は 1 時間に 1 回まで

/** 連続失敗と dead_letter の打ち切りを検知して #緊急対応 に運用アラートを送る */
export async function checkOpsAlerts(deps: Deps, m: RunMetrics): Promise<void> {
  for (const service of SERVICES) {
    const b = await deps.repo.getBreaker(service);
    if (b.consecutiveFailures < ALERT_FAILURE_THRESHOLD) continue;
    if (!(await deps.repo.shouldSendOpsAlert(`consecutive_failures:${service}`, ALERT_INTERVAL_SEC))) continue;
    await deps.urgent.notifyOps(
      `⚠️ 運用アラート: ${service} が ${b.consecutiveFailures} 回連続で失敗しています（状態: ${b.state}）`);
  }
  const gaveUp = m.errors.filter((e) => e.startsWith('dead_letter_gave_up'));
  if (gaveUp.length > 0 && (await deps.repo.shouldSendOpsAlert('dead_letter_gave_up', ALERT_INTERVAL_SEC))) {
    await deps.urgent.notifyOps(`⚠️ 運用アラート: 再処理を諦めた件があります（${gaveUp.length} 件）。dead_letter テーブルを確認してください`);
  }
}
