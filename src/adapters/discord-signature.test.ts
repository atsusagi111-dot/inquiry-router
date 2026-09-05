import { beforeAll, describe, expect, it } from 'vitest';
import { verifyDiscordSignature } from './discord-signature';
import { handleDiscordInteraction } from './discord-interactions';

const toHex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

let publicKeyHex: string;
let privateKey: CryptoKey;
let otherPublicKeyHex: string;

// Discord と同じ Ed25519 で鍵ペアを作り、自分で署名して検証する
async function sign(timestamp: string, body: string, key: CryptoKey = privateKey): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(timestamp + body));
  return toHex(sig);
}
const nowTs = () => String(Math.floor(Date.now() / 1000));

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKeyHex = toHex((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  otherPublicKeyHex = toHex((await crypto.subtle.exportKey('raw', other.publicKey)) as ArrayBuffer);
});

describe('verifyDiscordSignature', () => {
  it('正しい署名は通る', async () => {
    const ts = nowTs();
    const body = '{"type":1}';
    expect(await verifyDiscordSignature(publicKeyHex, await sign(ts, body), ts, body)).toBe(true);
  });
  it('本文を 1 文字でも変えると弾く', async () => {
    const ts = nowTs();
    const sig = await sign(ts, '{"type":1}');
    expect(await verifyDiscordSignature(publicKeyHex, sig, ts, '{"type":2}')).toBe(false);
  });
  it('別の鍵で検証すると弾く', async () => {
    const ts = nowTs();
    const body = '{"type":1}';
    expect(await verifyDiscordSignature(otherPublicKeyHex, await sign(ts, body), ts, body)).toBe(false);
  });
  it('10 分前のタイムスタンプは弾く（リプレイ対策）', async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const body = '{"type":1}';
    expect(await verifyDiscordSignature(publicKeyHex, await sign(ts, body), ts, body)).toBe(false);
  });
  it('署名やタイムスタンプが無い・hex でない場合は例外を出さず false', async () => {
    expect(await verifyDiscordSignature(publicKeyHex, null, nowTs(), '{}')).toBe(false);
    expect(await verifyDiscordSignature(publicKeyHex, 'zz', nowTs(), '{}')).toBe(false);
    expect(await verifyDiscordSignature('not-hex', 'abcd', nowTs(), '{}')).toBe(false);
  });
});

describe('handleDiscordInteraction', () => {
  const request = async (body: string, headers: Record<string, string>) =>
    new Request('https://example.com/discord/interactions', { method: 'POST', body, headers });

  it('正しく署名された PING に PONG を返す', async () => {
    const ts = nowTs();
    const body = '{"type":1}';
    const res = await handleDiscordInteraction(
      await request(body, { 'x-signature-ed25519': await sign(ts, body), 'x-signature-timestamp': ts }),
      publicKeyHex,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });
  it('署名が無ければ 401', async () => {
    const res = await handleDiscordInteraction(await request('{"type":1}', {}), publicKeyHex);
    expect(res.status).toBe(401);
  });
  it('公開鍵が未設定なら 500', async () => {
    const res = await handleDiscordInteraction(await request('{"type":1}', {}), undefined);
    expect(res.status).toBe(500);
  });
  it('PING 以外は本人だけに見える案内文を返す', async () => {
    const ts = nowTs();
    const body = '{"type":2,"data":{"name":"status"}}';
    const res = await handleDiscordInteraction(
      await request(body, { 'x-signature-ed25519': await sign(ts, body), 'x-signature-timestamp': ts }),
      publicKeyHex,
    );
    const json = (await res.json()) as { type: number; data: { flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
  });
});
