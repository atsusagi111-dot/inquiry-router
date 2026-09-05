import { describe, expect, it } from 'vitest';
import { loadEnv } from '../env';
import { route } from './routing';
import type { Category, ClassifiedBy, Confidence } from '../types/inquiry';

const env = loadEnv({ MOCK_EXTERNAL_API: 'true' });
const c = (category: Category, confidence: Confidence, classifiedBy: ClassifiedBy = 'llm') =>
  ({ category, confidence, classifiedBy, reason: '' });

describe('route', () => {
  it('high はカテゴリ別チャンネル、クレームだけ緊急', () => {
    expect(route(c('賃貸', 'high'), env)).toEqual({ targetChannel: '#賃貸', isUrgent: false });
    expect(route(c('売買', 'high'), env)).toEqual({ targetChannel: '#売買', isUrgent: false });
    expect(route(c('内見', 'high'), env)).toEqual({ targetChannel: '#内見', isUrgent: false });
    expect(route(c('クレーム', 'high'), env)).toEqual({ targetChannel: '#クレーム', isUrgent: true });
    expect(route(c('対象外', 'high'), env)).toEqual({ targetChannel: '#未分類', isUrgent: false });
  });
  it('low はカテゴリに関わらず #未分類、クレーム low でも緊急にしない', () => {
    expect(route(c('クレーム', 'low'), env)).toEqual({ targetChannel: '#未分類', isUrgent: false });
    expect(route(c('賃貸', 'low'), env).targetChannel).toBe('#未分類');
  });
  it('fallback は #未分類', () => {
    expect(route(c('賃貸', 'high', 'fallback'), env).targetChannel).toBe('#未分類');
  });
});
