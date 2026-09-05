import fixturesCsv from '../fixtures/case5-test-inquiries.csv';
import { loadEnv } from './env';
import { runTick } from './pipeline/run';
import { createMockDeps } from './adapters/mock';
import { createRealDeps } from './adapters';
import { log, setLogLevel } from './observability/logger';

export default {
  async scheduled(_event: ScheduledEvent, rawEnv: Record<string, unknown>, ctx: ExecutionContext): Promise<void> {
    const env = loadEnv(rawEnv);
    setLogLevel(env.LOG_LEVEL);
    // モック時は毎ティック CSV を取り込み直す（インメモリなので前回の記憶はない）。動作確認専用
    const deps = env.MOCK_EXTERNAL_API ? createMockDeps({ fixturesCsv }) : createRealDeps(env);
    log.info('tick start', { mock: env.MOCK_EXTERNAL_API });
    ctx.waitUntil(runTick(env, deps));
  },
};
