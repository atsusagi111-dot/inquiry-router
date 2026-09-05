import type { Classifier, ClassifyInput } from '../../types/ports';
import type { FixtureRow } from './fixtures-source';

/** CSV の期待カテゴリをそのまま返す。配管（保存→分類→通知）の確認用で、精度の確認には使わない */
export class FakeClassifier implements Classifier {
  private readonly byBody = new Map<string, FixtureRow>();
  constructor(rows: FixtureRow[]) {
    for (const r of rows) this.byBody.set(r.body.trim(), r);
  }
  async classify(input: ClassifyInput) {
    const row = this.byBody.get(input.body.trim());
    if (!row) return { category: '対象外' as const, confidence: 'low' as const, reason: 'mock: fixtures に無い本文' };
    return { category: row.expectedCategory, confidence: 'high' as const, reason: `mock: fixtures No.${row.no} の期待値` };
  }
}

/** OpenAI 障害を再現する。「LLM が落ちてもクレーム通知は届く」の検証に使う */
export class FailingClassifier implements Classifier {
  async classify(): Promise<never> { throw new Error('mock: OpenAI に接続できません'); }
}
