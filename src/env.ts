import { z } from 'zod';

// モック時は秘密情報が無くても起動できるよう optional にし、
// 本番時（MOCK_EXTERNAL_API=false）には loadEnv() で必須チェックする二段構え。
const boolish = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

export const envSchema = z.object({
  MOCK_EXTERNAL_API: boolish,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Workers Free の CPU 10ms 制限に収めるため、1 ティックの処理件数を絞る
  CLASSIFY_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  NOTIFY_BATCH_SIZE: z.coerce.number().int().positive().default(10),

  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_QUERY: z.string().default('in:inbox'),

  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_INQUIRY_CHANNEL_ID: z.string().optional(),
  DISCORD_URGENT_CHANNEL_ID: z.string().optional(),
  DISCORD_SALES_MANAGER_USER_ID: z.string().optional(),
  DISCORD_SALES_ROLE_ID: z.string().optional(),
  // Interactions Endpoint の署名検証用。Developer Portal に表示される公開鍵（64 桁 hex）なので秘密ではない
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, '64 桁の 16 進数').optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-5.6-luna'),
  OPENAI_DAILY_LIMIT: z.coerce.number().int().positive().default(300),

  SLACK_WEBHOOK_RENTAL: z.string().url().optional(),
  SLACK_WEBHOOK_SALES: z.string().url().optional(),
  SLACK_WEBHOOK_VIEWING: z.string().url().optional(),
  SLACK_WEBHOOK_COMPLAINT: z.string().url().optional(),
  SLACK_WEBHOOK_UNSORTED: z.string().url().optional(),
  SLACK_CHANNEL_RENTAL: z.string().default('#賃貸'),
  SLACK_CHANNEL_SALES: z.string().default('#売買'),
  SLACK_CHANNEL_VIEWING: z.string().default('#内見'),
  SLACK_CHANNEL_COMPLAINT: z.string().default('#クレーム'),
  SLACK_CHANNEL_UNSORTED: z.string().default('#未分類'),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** 本番モードで必須になるキー。欠落は起動時に検知して「何が足りないか」を明示する */
const REQUIRED_IN_REAL_MODE = [
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN',
  'DISCORD_BOT_TOKEN', 'DISCORD_INQUIRY_CHANNEL_ID', 'DISCORD_URGENT_CHANNEL_ID',
  'DISCORD_SALES_MANAGER_USER_ID', 'DISCORD_SALES_ROLE_ID',
  'OPENAI_API_KEY',
  'SLACK_WEBHOOK_RENTAL', 'SLACK_WEBHOOK_SALES', 'SLACK_WEBHOOK_VIEWING',
  'SLACK_WEBHOOK_COMPLAINT', 'SLACK_WEBHOOK_UNSORTED',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
] as const satisfies readonly (keyof Env)[];

/** .dev.vars や wrangler secret で「値が空」のキーは未設定扱いにする（空文字列は URL 検証に落ちるため） */
export function cleanEnv(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ''));
}

export function loadEnv(raw: Record<string, unknown>): Env {
  const env = envSchema.parse(cleanEnv(raw));
  if (!env.MOCK_EXTERNAL_API) {
    const missing = REQUIRED_IN_REAL_MODE.filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new Error(`本番モードに必要な環境変数が未設定です: ${missing.join(', ')}`);
    }
  }
  return env;
}
