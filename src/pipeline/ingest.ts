// [feat/ingest] このファイルを実装する。main では何もしないスタブ
import type { Env } from '../env';
import type { Deps } from '../types/ports';
import type { DeadLetterEntry, RunMetrics } from '../types/inquiry';
import { log } from '../observability/logger';

export async function ingest(_env: Env, _deps: Deps, _m: RunMetrics): Promise<void> {
  log.debug('ingest: 未実装（feat/ingest で実装）');
}

export async function retryIngest(_e: DeadLetterEntry, _env: Env, _deps: Deps, _m: RunMetrics): Promise<void> {
  throw new Error('retryIngest: 未実装');
}
