import { describe, expect, it } from 'vitest';
import { cleanBody, contentHash } from './normalize';

describe('cleanBody', () => {
  it('"-- " 以降の署名を落とす', () => {
    expect(cleanBody('内見をお願いします。\n-- \n山田太郎\n090-0000-0000')).toBe('内見をお願いします。');
  });
  it('> で始まる引用行を落とす', () => {
    expect(cleanBody('了解です。\n> 前回のメール\n> の引用')).toBe('了解です。');
  });
  it('"On ... wrote:" 以降を落とす', () => {
    expect(cleanBody('ありがとうございます。\n\nOn Fri, Sep 5, 2026 at 10:00 AM 山田 <a@b.c> wrote:\n> 元のメール')).toBe('ありがとうございます。');
  });
  it('日本語 Gmail の引用ヘッダ以降を落とす', () => {
    expect(cleanBody('承知しました。\n2026年9月5日(金) 10:00 山田 <a@b.c>:\n> 元のメール')).toBe('承知しました。');
  });
  it('罫線以降を落とし、連続空行を詰める', () => {
    expect(cleanBody('本文\n\n\n\n続き\n====\n署名')).toBe('本文\n\n続き');
  });
  it('全角スペースと CRLF を正規化する', () => {
    expect(cleanBody('駅近の　1LDK\r\nを探しています')).toBe('駅近の 1LDK\nを探しています');
  });
});

describe('contentHash', () => {
  it('同じ入力なら同じハッシュ、送信者が違えば別ハッシュ', async () => {
    const a = await contentHash('a@x', '本文');
    expect(a).toBe(await contentHash('a@x', '本文'));
    expect(a).not.toBe(await contentHash('b@x', '本文'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
