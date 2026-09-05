// [feat/ingest] 本番の受信元と Repo をここで組み立てる
import type { Env } from '../env';
import type { Deps } from '../types/ports';

export function createIngestDeps(_env: Env): Pick<Deps, 'sources' | 'repo'> {
  throw new Error('createIngestDeps: feat/ingest で実装');
}
