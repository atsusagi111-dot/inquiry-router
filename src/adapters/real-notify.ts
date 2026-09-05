// [feat/notify] 本番の Slack / Discord 通知をここで組み立てる
import type { Env } from '../env';
import type { Deps } from '../types/ports';

export function createNotifyDeps(_env: Env): Pick<Deps, 'slack' | 'urgent'> {
  throw new Error('createNotifyDeps: feat/notify で実装');
}
