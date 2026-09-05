// [feat/notify] このファイルを実装する。main では何もしないスタブ
import type { Env } from '../env';
import type { Deps } from '../types/ports';
import type { DeadLetterEntry, RunMetrics } from '../types/inquiry';
import { log } from '../observability/logger';

export async function notify(_env: Env, _deps: Deps, _m: RunMetrics): Promise<void> {
  log.debug('notify: 未実装（feat/notify で実装）');
}

export async function retryNotify(_e: DeadLetterEntry, _env: Env, _deps: Deps, _m: RunMetrics): Promise<void> {
  throw new Error('retryNotify: 未実装');
}
