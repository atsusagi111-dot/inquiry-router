import type { Env } from '../env';
import type { Deps } from '../types/ports';
import { createIngestDeps } from './real-ingest';
import { createClassifyDeps } from './real-classify';
import { createNotifyDeps } from './real-notify';

/** 本番 Deps。3 ブランチが同じファイルを触らずに済むよう、組み立てを 3 つに分けている */
export function createRealDeps(env: Env): Deps {
  const { sources, repo } = createIngestDeps(env);
  const { classifier } = createClassifyDeps(env);
  const { slack, urgent } = createNotifyDeps(env);
  return { sources, classifier, slack, urgent, repo, now: () => new Date() };
}
