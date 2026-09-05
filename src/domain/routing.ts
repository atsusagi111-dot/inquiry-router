import type { Env } from '../env';
import type { Classification, RoutingDecision } from '../types/inquiry';

type ChannelEnv = Pick<Env,
  'SLACK_CHANNEL_RENTAL' | 'SLACK_CHANNEL_SALES' | 'SLACK_CHANNEL_VIEWING' | 'SLACK_CHANNEL_COMPLAINT' | 'SLACK_CHANNEL_UNSORTED'>;

/**
 * 振り分けの唯一の決定点。
 * 誤った振り分けより「人が見る場所（#未分類）に置く」ほうが実害が小さい、という方針をここに集約する
 */
export function route(c: Classification, env: ChannelEnv): RoutingDecision {
  if (c.confidence === 'low' || c.classifiedBy === 'fallback') {
    return { targetChannel: env.SLACK_CHANNEL_UNSORTED, isUrgent: false };
  }
  switch (c.category) {
    case '賃貸': return { targetChannel: env.SLACK_CHANNEL_RENTAL, isUrgent: false };
    case '売買': return { targetChannel: env.SLACK_CHANNEL_SALES, isUrgent: false };
    case '内見': return { targetChannel: env.SLACK_CHANNEL_VIEWING, isUrgent: false };
    case 'クレーム': return { targetChannel: env.SLACK_CHANNEL_COMPLAINT, isUrgent: true };
    case '対象外': return { targetChannel: env.SLACK_CHANNEL_UNSORTED, isUrgent: false };
  }
}
