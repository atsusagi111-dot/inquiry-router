// [feat/classify] 本番の分類器（OpenAI）をここで組み立てる
import type { Env } from '../env';
import type { Deps } from '../types/ports';

export function createClassifyDeps(_env: Env): Pick<Deps, 'classifier'> {
  throw new Error('createClassifyDeps: feat/classify で実装');
}
