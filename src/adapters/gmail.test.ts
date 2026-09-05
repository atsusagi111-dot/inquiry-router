import { describe, expect, it } from 'vitest';
import { decodeBase64Url, extractBody, stripHtml } from './gmail';

const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('gmail 本文抽出', () => {
  it('base64url の日本語を復元する', () => {
    expect(decodeBase64Url(enc('内見をお願いします'))).toBe('内見をお願いします');
  });
  it('multipart から text/plain を優先する', () => {
    const payload = { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: { data: enc('<p>HTML</p>') } },
      { mimeType: 'text/plain', body: { data: enc('PLAIN') } },
    ] };
    expect(extractBody(payload)).toBe('PLAIN');
  });
  it('text/html しか無ければタグを落とす', () => {
    const payload = { mimeType: 'text/html', body: { data: enc('<div>駅近の<b>1LDK</b><br>希望です&amp;</div>') } };
    expect(extractBody(payload)).toBe('駅近の1LDK\n希望です&\n');
  });
  it('stripHtml は style/script を丸ごと落とす', () => {
    expect(stripHtml('<style>x{}</style>本文<script>1</script>')).toBe('本文');
  });
});
