import type { Env } from '../env';
import type { Deps } from '../types/ports';
import { createOpenAIClassifier } from './openai';

export function createClassifyDeps(env: Env): Pick<Deps, 'classifier'> {
  return { classifier: createOpenAIClassifier(env) };
}
