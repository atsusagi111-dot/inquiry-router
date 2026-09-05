import type { Category, Classification } from '../types/inquiry';
import { KEYWORDS, NEGATION_AFTER, NEGATION_WINDOW, type Strength } from './keywords';

export interface KeywordHit { category: Category; keyword: string; strength: Strength }
export interface FilterResult {
  /** 確定できたときだけ入る。null なら LLM に回す */
  decision: Classification | null;
  hits: KeywordHit[];
}

type Cat = keyof typeof KEYWORDS;

/** 文単位に分けるのは、否定表現が同じ文の中のキーワードにだけ効くようにするため */
function sentences(text: string): string[] {
  return text.split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 1 文の中でキーワードを探し、否定が続くものを除いて返す */
function findHits(sentence: string, category: Cat): KeywordHit[] {
  const hits: KeywordHit[] = [];
  for (const def of KEYWORDS[category]) {
    const re = def.pattern instanceof RegExp ? new RegExp(def.pattern.source, 'g') : new RegExp(escape(def.pattern), 'g');
    for (const m of sentence.matchAll(re)) {
      const end = m.index + m[0].length;
      const after = sentence.slice(end, end + NEGATION_WINDOW);
      if (NEGATION_AFTER.test(after)) continue;   // 「緊急ではありません」→ 数えない
      hits.push({ category, keyword: m[0], strength: def.strength });
      break;                                       // 同じ語は 1 回だけ数える（回数ではなく語の種類で判定）
    }
  }
  return hits;
}

export function keywordFilter(bodyClean: string): FilterResult {
  const text = bodyClean.trim();
  if (text === '') {
    return { decision: { category: '対象外', confidence: 'high', classifiedBy: 'keyword', reason: '本文が空' }, hits: [] };
  }
  const hits: KeywordHit[] = [];
  for (const s of sentences(text)) {
    for (const cat of Object.keys(KEYWORDS) as Cat[]) hits.push(...findHits(s, cat));
  }
  // 同じ語が別の文にも出た場合を 1 つにまとめる
  const uniq = hits.filter((h, i) => hits.findIndex((x) => x.category === h.category && x.keyword === h.keyword) === i);
  const by = (cat: Cat) => uniq.filter((h) => h.category === cat);
  const words = (hs: KeywordHit[]) => hs.map((h) => h.keyword).join('、');

  // 1. クレームは他カテゴリの語があっても優先（見逃しの実害が大きい）
  const complaint = by('クレーム');
  if (complaint.some((h) => h.strength === 'strong') || complaint.length >= 2) {
    return { decision: { category: 'クレーム', confidence: 'high', classifiedBy: 'keyword', reason: `キーワード: ${words(complaint)}` }, hits: uniq };
  }
  if (complaint.length > 0) return { decision: null, hits: uniq };  // 弱い語 1 つだけでは決めない

  // 2. 賃貸/売買/内見は「1 カテゴリだけに 2 語以上、他は 0」のときだけ確定
  const cats: Cat[] = ['賃貸', '売買', '内見'];
  const hitCats = cats.filter((c) => by(c).length > 0);
  const only = hitCats.length === 1 ? hitCats[0] : undefined;
  if (only && by(only).length >= 2) {
    return { decision: { category: only, confidence: 'high', classifiedBy: 'keyword', reason: `キーワード: ${words(by(only))}` }, hits: uniq };
  }
  return { decision: null, hits: uniq };
}

/** LLM が使えないときの補助: ヒット数が最多のカテゴリ（同数なら決めない） */
export function dominantCategory(hits: KeywordHit[]): Category | undefined {
  const count = new Map<Category, number>();
  for (const h of hits) count.set(h.category, (count.get(h.category) ?? 0) + 1);
  const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return undefined;
  if (sorted.length > 1 && sorted[0]![1] === sorted[1]![1]) return undefined;
  return sorted[0]![0];
}
