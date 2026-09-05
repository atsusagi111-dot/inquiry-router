import type { Category } from '../types/inquiry';

export type Strength = 'strong' | 'weak';
export interface KeywordDef { pattern: string | RegExp; strength: Strength }

const weak = (p: string | RegExp): KeywordDef => ({ pattern: p, strength: 'weak' });
const strong = (p: string | RegExp): KeywordDef => ({ pattern: p, strength: 'strong' });

/**
 * 事前フィルタの語彙。運用しながらここに足す。
 * strong: 1 語で確定候補 / weak: 2 語以上で確定候補（クレーム以外は strong を置かない＝慎重側に倒す）
 */
export const KEYWORDS: Record<Exclude<Category, '対象外'>, KeywordDef[]> = {
  クレーム: [
    strong('苦情'), strong('クレーム'), strong('訴え'), strong('弁護士'), strong('消費者センター'), strong('申し入れ'),
    weak('至急'), weak('緊急'), weak('故障'), weak('壊れ'), weak('効かない'), weak('効きません'), weak('動かない'),
    weak('水漏れ'), weak('漏水'), weak('騒音'), weak('異臭'), weak('停電'), weak('開かない'),
    weak('話が違う'), weak('説明と違う'), weak('違いすぎ'), weak('納得できない'), weak('対応してください'), weak('困っています'),
  ],
  賃貸: [
    weak('賃貸'), weak('家賃'), weak(/\d+(?:LDK|DK|SLDK|K|R)\b/), weak('入居'), weak('退去'), weak('敷金'), weak('礼金'),
    weak('更新'), weak('アパート'), weak('借り'),
  ],
  売買: [
    weak('購入'), weak('売却'), weak('査定'), weak('住宅ローン'), weak('中古マンション'), weak('一戸建て'),
    weak('投資用'), weak('利回り'), weak('買い'),
  ],
  内見: [weak('内見'), weak('見学'), weak('日程調整'), weak('伺いたい')],
};

/**
 * キーワード直後 10 文字以内にこれが続けば「否定されている」とみなしヒットを無効にする。
 * 例: 緊急[ではありません] / 至急[ではなく] / クレーム[ではない]のですが
 */
export const NEGATION_AFTER = /^\s*(?:では|じゃ|で|には|という(?:わけ|こと)では)?(?:ありません|ない|なく|無い|ございません|なかった)/;
export const NEGATION_WINDOW = 10;
