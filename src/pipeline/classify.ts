// [feat/classify] このファイルを実装する。main では何もしないスタブ
import type { Env } from '../env';
import type { Deps } from '../types/ports';
import type { DeadLetterEntry, RunMetrics } from '../types/inquiry';
import { log } from '../observability/logger';

export async function classify(_env: Env, _deps: Deps, _m: RunMetrics): Promise<void> {
  log.debug('classify: 未実装（feat/classify で実装）');
}

export async function retryClassify(_e: DeadLetterEntry, _env: Env, _deps: Deps, _m: RunMetrics): Promise<void> {
  throw new Error('retryClassify: 未実装');
}
