import type { Env } from '../env';
import type { Deps } from '../types/ports';
import type { Classification, DeadLetterEntry, Inquiry, RunMetrics } from '../types/inquiry';
import { dominantCategory, keywordFilter } from '../domain/keyword-filter';
import { route } from '../domain/routing';
import { withBreaker } from '../adapters/circuit-breaker';
import { errorMessage, log } from '../observability/logger';

const OPENAI_COUNTER = 'openai_calls';

/** ingested を古い順に取り、キーワード → LLM → fallback の順で決めて保存する */
export async function classify(env: Env, deps: Deps, m: RunMetrics): Promise<void> {
  const batch = await deps.repo.listByStatus('ingested', env.CLASSIFY_BATCH_SIZE);
  for (const q of batch) {
    try {
      const c = await decide(q, env, deps, m);
      await deps.repo.saveClassification(q.id, c, route(c, env));
    } catch (e) {
      // 保存に失敗した行は ingested のまま残り、次ティックで自然に再試行される
      m.failed++;
      m.errors.push(`classify ${q.id}: ${errorMessage(e)}`);
      log.error('classify failed', { id: q.id, error: errorMessage(e) });
    }
  }
}

async function decide(q: Inquiry, env: Env, deps: Deps, m: RunMetrics): Promise<Classification> {
  // 1. キーワードで確定できれば LLM を呼ばない。クレームはここで決まるので OpenAI 障害の影響を受けない
  const kw = keywordFilter(q.bodyClean);
  if (kw.decision) {
    m.classifiedKeyword++;
    return kw.decision;
  }

  // 2. LLM。日次上限とブレーカーで守る
  try {
    if ((await deps.repo.getDailyCounter(OPENAI_COUNTER)) >= env.OPENAI_DAILY_LIMIT) {
      throw new Error(`OpenAI の 1 日上限 ${env.OPENAI_DAILY_LIMIT} 回に達した`);
    }
    const result = await withBreaker(deps.repo, 'openai', deps.now, async () => {
      // 呼ぶ前に数える（失敗した呼び出しも上限に含めて暴走を止めるため）
      await deps.repo.incrementDailyCounter(OPENAI_COUNTER);
      m.openaiCalls++;
      return deps.classifier.classify({ source: q.source, subject: q.subject, body: q.bodyClean });
    });
    m.classifiedLlm++;
    return { ...result, classifiedBy: 'llm' };
  } catch (e) {
    // 3. LLM が使えない → 人が見る #未分類 へ。キーワードのヒントがあれば添える
    m.classifiedFallback++;
    log.warn('classify fallback', { id: q.id, error: errorMessage(e) });
    return {
      category: dominantCategory(kw.hits) ?? '対象外',
      confidence: 'low',
      classifiedBy: 'fallback',
      reason: `分類スキップ（${errorMessage(e)}）`,
    };
  }
}

/** classify は dead_letter を使わない（失敗行は ingested のまま残るため）。互換のため何もしない */
export async function retryClassify(_e: DeadLetterEntry, _env: Env, _deps: Deps, _m: RunMetrics): Promise<void> {}
