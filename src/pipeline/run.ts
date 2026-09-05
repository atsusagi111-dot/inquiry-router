import type { Env } from '../env';
import type { Deps } from '../types/ports';
import { emptyMetrics, type DeadLetterEntry, type DeadLetterStage, type RunMetrics } from '../types/inquiry';
import { ingest, retryIngest } from './ingest';
import { classify, retryClassify } from './classify';
import { notify, retryNotify } from './notify';
import { checkOpsAlerts } from '../observability/metrics';
import { errorMessage, log } from '../observability/logger';

const LOCK_NAME = 'tick';
const LOCK_TTL_SEC = 55;             // 毎分実行なので 1 分未満にし、前回が固まっても次の次で自動復帰させる
const DEAD_LETTER_BATCH = 20;
export const DEAD_LETTER_MAX_ATTEMPTS = 5;

/** 1 ティック分の処理。ステージ単位で例外を止め、後続ステージを巻き込まない */
export async function runTick(env: Env, deps: Deps): Promise<RunMetrics> {
  const m = emptyMetrics();
  const started = deps.now();
  const holder = crypto.randomUUID();

  if (!(await deps.repo.acquireLock(LOCK_NAME, holder, LOCK_TTL_SEC))) {
    log.warn('tick skipped: 前回の処理がまだ動いている');
    m.errors.push('lock_busy');
    return m;
  }
  try {
    await stage('dead_letter', () => retryDeadLetters(env, deps, m), m);
    await stage('ingest', () => ingest(env, deps, m), m);
    await stage('classify', () => classify(env, deps, m), m);
    await stage('notify', () => notify(env, deps, m), m);
  } finally {
    m.durationMs = deps.now().getTime() - started.getTime();
    // 後片付けの失敗でティック自体を落とさない
    await safely('metrics', () => deps.repo.saveRunMetrics(m));
    await safely('ops_alert', () => checkOpsAlerts(deps, m));
    await safely('unlock', () => deps.repo.releaseLock(LOCK_NAME, holder));
    log.info('tick done', { ...m });
  }
  return m;
}

async function stage(name: string, fn: () => Promise<void>, m: RunMetrics): Promise<void> {
  try { await fn(); }
  catch (e) {
    m.failed++;
    m.errors.push(`${name}: ${errorMessage(e)}`);
    log.error('stage failed', { stage: name, error: errorMessage(e) });
  }
}
async function safely(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (e) { log.error('post-tick step failed', { step: name, error: errorMessage(e) }); }
}

async function retryDeadLetters(env: Env, deps: Deps, m: RunMetrics): Promise<void> {
  const due = await deps.repo.popDueDeadLetters(DEAD_LETTER_BATCH);
  for (const entry of due) {
    try {
      await dispatchRetry(entry, env, deps, m);
      if (entry.id !== undefined) await deps.repo.resolveDeadLetter(entry.id);
    } catch (e) {
      await requeue(entry, e, deps, m);
    }
  }
}

function dispatchRetry(entry: DeadLetterEntry, env: Env, deps: Deps, m: RunMetrics): Promise<void> {
  switch (entry.stage) {
    case 'ingest': return retryIngest(entry, env, deps, m);
    case 'classify': return retryClassify(entry, env, deps, m);
    case 'notify_slack':
    case 'notify_urgent': return retryNotify(entry, env, deps, m);
  }
}

/** 各ステージが「初回失敗」を退避するときに呼ぶ */
export async function toDeadLetter(
  deps: Deps, m: RunMetrics, stage: DeadLetterStage, error: unknown,
  ref: { inquiryId?: string; payload?: unknown },
): Promise<void> {
  m.failed++;
  await deps.repo.pushDeadLetter({
    stage, error: errorMessage(error), attempts: 1,
    nextRetryAt: new Date(deps.now().getTime() + 60_000),
    ...ref,
  });
}

/** 再処理にも失敗した。回数を増やして次の時刻を先送りし、上限を超えたら諦める */
async function requeue(entry: DeadLetterEntry, error: unknown, deps: Deps, m: RunMetrics): Promise<void> {
  const attempts = entry.attempts + 1;
  if (attempts > DEAD_LETTER_MAX_ATTEMPTS) {
    if (entry.id !== undefined) await deps.repo.resolveDeadLetter(entry.id);
    if (entry.inquiryId) await deps.repo.markFailed(entry.inquiryId);
    m.errors.push(`dead_letter_gave_up: ${entry.stage} ${entry.inquiryId ?? ''} ${errorMessage(error)}`);
    return;
  }
  // 1 分 → 2 分 → 4 分 → 8 分 → 16 分。60 分で頭打ち
  const delayMs = Math.min(60, 2 ** (attempts - 1)) * 60_000;
  await deps.repo.pushDeadLetter({
    ...entry, attempts, error: errorMessage(error),
    nextRetryAt: new Date(deps.now().getTime() + delayMs),
  });
}
