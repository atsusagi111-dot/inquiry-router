import type { Env } from '../env';
import type { Deps } from '../types/ports';
import { DiscordClient } from './discord-client';
import { DiscordUrgentNotifier } from './discord-notify';
import { SlackWebhookNotifier } from './slack';

export function createNotifyDeps(env: Env): Pick<Deps, 'slack' | 'urgent'> {
  const need = (k: keyof Env): string => {
    const v = env[k];
    if (typeof v !== 'string' || v === '') throw new Error(`${k} が未設定です`);
    return v;
  };
  // routing が返すチャンネル名をキーにして Webhook を引く
  const webhooks = {
    [env.SLACK_CHANNEL_RENTAL]: need('SLACK_WEBHOOK_RENTAL'),
    [env.SLACK_CHANNEL_SALES]: need('SLACK_WEBHOOK_SALES'),
    [env.SLACK_CHANNEL_VIEWING]: need('SLACK_WEBHOOK_VIEWING'),
    [env.SLACK_CHANNEL_COMPLAINT]: need('SLACK_WEBHOOK_COMPLAINT'),
    [env.SLACK_CHANNEL_UNSORTED]: need('SLACK_WEBHOOK_UNSORTED'),
  };
  return {
    slack: new SlackWebhookNotifier(webhooks),
    urgent: new DiscordUrgentNotifier(new DiscordClient(need('DISCORD_BOT_TOKEN')), {
      urgentChannelId: need('DISCORD_URGENT_CHANNEL_ID'),
      salesManagerUserId: need('DISCORD_SALES_MANAGER_USER_ID'),
      salesRoleId: need('DISCORD_SALES_ROLE_ID'),
    }),
  };
}
