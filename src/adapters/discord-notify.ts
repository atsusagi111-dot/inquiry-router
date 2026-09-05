import { z } from 'zod';
import type { Inquiry } from '../types/inquiry';
import type { UrgentNotifier } from '../types/ports';
import type { DiscordClient } from './discord-client';
import { errorMessage, log } from '../observability/logger';

const BODY_LIMIT = 1500;  // Discord の 1 メッセージ上限 2000 文字に収める
const dmChannelSchema = z.object({ id: z.string() });

export interface DiscordNotifyConfig { urgentChannelId: string; salesManagerUserId: string; salesRoleId: string }

export function formatUrgentText(q: Inquiry, roleId?: string): string {
  const mention = roleId ? ` <@&${roleId}>` : '';
  const received = q.receivedAt.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const src = q.source === 'gmail' ? 'メール' : 'Discord';
  const body = q.bodyClean.length > BODY_LIMIT ? `${q.bodyClean.slice(0, BODY_LIMIT)}…` : q.bodyClean;
  const subject = q.subject ? `件名: ${q.subject}\n` : '';
  return `🚨 **クレームを受信しました**${mention}\n${src} / ${q.sender ?? '送信者不明'} / ${received}\n${subject}> ${body.replace(/\n/g, '\n> ')}\n_${q.classification?.reason ?? ''}_`;
}

export class DiscordUrgentNotifier implements UrgentNotifier {
  constructor(private readonly client: DiscordClient, private readonly cfg: DiscordNotifyConfig) {}

  async notifyUrgent(q: Inquiry): Promise<void> {
    // 1. #緊急対応 に @営業部 メンション付きで投稿（確実に届く経路を先に）
    await this.client.post(`/channels/${this.cfg.urgentChannelId}/messages`, {
      content: formatUrgentText(q, this.cfg.salesRoleId),
      // parse: [] で @everyone 等を無効化し、roles で許可したロールだけ実際に通知する
      allowed_mentions: { parse: [], roles: [this.cfg.salesRoleId] },
    });
    // 2. 営業部長へ DM。相手の DM 設定次第で失敗し得るので、失敗してもチャンネル投稿は成立したものとして扱い、
    //    その旨をチャンネルに残す（人が気付けるようにする）
    try {
      const dm = await this.client.postJson(
        '/users/@me/channels',
        { recipient_id: this.cfg.salesManagerUserId },
        dmChannelSchema,
        'discord.dm_channel',
      );
      await this.client.post(`/channels/${dm.id}/messages`, { content: formatUrgentText(q), allowed_mentions: { parse: [] } });
    } catch (e) {
      log.error('urgent DM failed', { error: errorMessage(e) });
      await this.client.post(`/channels/${this.cfg.urgentChannelId}/messages`, {
        content: `⚠️ 営業部長への DM 送信に失敗しました（${errorMessage(e)}）。DM の受信設定を確認してください`,
        allowed_mentions: { parse: [] },
      });
    }
  }

  async notifyOps(message: string): Promise<void> {
    await this.client.post(`/channels/${this.cfg.urgentChannelId}/messages`, { content: message, allowed_mentions: { parse: [] } });
  }
}
