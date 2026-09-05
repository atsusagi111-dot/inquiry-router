import fixturesCsv from '../fixtures/case5-test-inquiries.csv';
import { cleanEnv, envSchema, loadEnv } from './env';
import { runTick } from './pipeline/run';
import { createMockDeps } from './adapters/mock';
import { createRealDeps } from './adapters';
import { handleDiscordInteraction } from './adapters/discord-interactions';
import { log, setLogLevel } from './observability/logger';

export default {
  /** 唯一の HTTP 受け口。Discord Interactions（署名検証あり）以外は何も公開しない */
  async fetch(req: Request, rawEnv: Record<string, unknown>): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/discord/interactions') {
      // ここでは本番用シークレットの必須チェックは通さず、公開鍵だけ読む（受信器は他のキーに依存しない）
      const env = envSchema.parse(cleanEnv(rawEnv));
      setLogLevel(env.LOG_LEVEL);
      return handleDiscordInteraction(req, env.DISCORD_PUBLIC_KEY);
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, rawEnv: Record<string, unknown>, ctx: ExecutionContext): Promise<void> {
    const env = loadEnv(rawEnv);
    setLogLevel(env.LOG_LEVEL);
    // モック時は毎ティック CSV を取り込み直す（インメモリなので前回の記憶はない）。動作確認専用
    const deps = env.MOCK_EXTERNAL_API ? createMockDeps({ fixturesCsv }) : createRealDeps(env);
    log.info('tick start', { mock: env.MOCK_EXTERNAL_API });
    ctx.waitUntil(runTick(env, deps));
  },
};
