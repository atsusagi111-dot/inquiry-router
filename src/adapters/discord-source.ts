import { z } from 'zod';
import type { RawMessage } from '../types/inquiry';
import type { FetchResult, MessageSource } from '../types/ports';
import type { DiscordClient } from './discord-client';

const FIRST_RUN_LOOKBACK_MS = 60 * 60_000;  // 初回は直近 1 時間だけ（過去ログを全部流さない）
const DISCORD_EPOCH_MS = 1420070400000n;    // Discord の ID（snowflake）は 2015-01-01 起点の時刻を含む

const messageSchema = z.object({
  id: z.string(),
  content: z.string(),
  timestamp: z.string(),
  author: z.object({ id: z.string(), username: z.string(), bot: z.boolean().optional() }),
});

/** 時刻から「その時刻以降」を意味する snowflake を作る。after= に渡す初期値用 */
export function snowflakeFromTime(ms: number): string {
  return String((BigInt(ms) - DISCORD_EPOCH_MS) << 22n);
}

export class DiscordSource implements MessageSource {
  readonly source = 'discord' as const;
  constructor(private readonly client: DiscordClient, private readonly channelId: string) {}

  async fetchNew(cursor: string | null): Promise<FetchResult> {
    const after = cursor ?? snowflakeFromTime(Date.now() - FIRST_RUN_LOOKBACK_MS);
    const list = await this.client.getJson(
      `/channels/${this.channelId}/messages?after=${after}&limit=100`,
      z.array(messageSchema),
      'discord.messages',
    );
    // Discord は新しい順で返すので、古い順（ID 昇順）に並べ替える
    const sorted = [...list].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const messages: RawMessage[] = sorted
      .filter((msg) => !msg.author.bot && msg.content.trim() !== '')  // Bot の投稿とスタンプのみ等は対象外
      .map((msg) => ({
        source: 'discord',
        sourceMessageId: msg.id,
        sourceThreadId: this.channelId,
        sender: `${msg.author.username} (${msg.author.id})`,
        body: msg.content,
        receivedAt: new Date(msg.timestamp),
      }));
    // 除外した投稿も cursor は進める（同じ Bot 投稿を毎分読み直さないため）
    const last = sorted.at(-1);
    return { messages, nextCursor: last ? last.id : cursor };
  }
}
