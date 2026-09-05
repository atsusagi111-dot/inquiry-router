import type { Env } from '../env';
import type { Deps } from '../types/ports';
import { GmailSource } from './gmail';
import { DiscordClient } from './discord-client';
import { DiscordSource } from './discord-source';
import { SupabaseRepo } from './supabase';

export function createIngestDeps(env: Env): Pick<Deps, 'sources' | 'repo'> {
  // loadEnv で本番時の必須チェックは済んでいるが、型の上では optional なのでここで確定させる
  const need = (k: keyof Env): string => {
    const v = env[k];
    if (typeof v !== 'string' || v === '') throw new Error(`${k} が未設定です`);
    return v;
  };
  return {
    sources: [
      new GmailSource({
        clientId: need('GMAIL_CLIENT_ID'),
        clientSecret: need('GMAIL_CLIENT_SECRET'),
        refreshToken: need('GMAIL_REFRESH_TOKEN'),
        query: env.GMAIL_QUERY,
      }),
      new DiscordSource(new DiscordClient(need('DISCORD_BOT_TOKEN')), need('DISCORD_INQUIRY_CHANNEL_ID')),
    ],
    repo: new SupabaseRepo(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY')),
  };
}
