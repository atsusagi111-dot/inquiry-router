import type { Env } from '../env';
import type { Deps } from '../types/ports';

/** 本番 Deps。各 worktree のマージ時に、担当行だけをここへ足していく */
export function createRealDeps(_env: Env): Deps {
  throw new Error('本番アダプタは feat/ingest・feat/classify・feat/notify のマージ後に有効になります');
}
