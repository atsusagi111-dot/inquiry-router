// Discord は Interactions の全リクエストに Ed25519 署名を付けて送る。
// 検証しないと、URL を知った第三者が偽のリクエストを送り込める
const TIMESTAMP_TOLERANCE_SEC = 5 * 60;  // 古い署名の再送（リプレイ）を弾く。5 分は Discord 公式クライアントの許容と同程度

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}

/** 署名・タイムスタンプ・本文が公開鍵に対して正当なら true。形式不正はすべて false（例外にしない） */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  body: string,
  nowSec: number = Date.now() / 1000,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > TIMESTAMP_TOLERANCE_SEC) return false;
  const key = hexToBytes(publicKeyHex);
  const sig = hexToBytes(signatureHex);
  if (!key || !sig || key.length !== 32 || sig.length !== 64) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    // Discord の仕様: 署名対象は「timestamp 文字列 + 生の本文」の連結
    const data = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify('Ed25519', cryptoKey, sig, data);
  } catch {
    return false;
  }
}
