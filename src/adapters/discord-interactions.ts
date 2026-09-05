import { verifyDiscordSignature } from './discord-signature';
import { log } from '../observability/logger';

const PING = 1;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const EPHEMERAL = 64;  // 送った本人にだけ見える返信

/** Discord Interactions Endpoint。署名検証 → PING 応答 → それ以外は案内文 */
export async function handleDiscordInteraction(req: Request, publicKeyHex: string | undefined): Promise<Response> {
  if (!publicKeyHex) {
    log.error('DISCORD_PUBLIC_KEY が未設定');
    return new Response('server misconfigured', { status: 500 });
  }
  // 署名対象は「生の本文」なので、JSON に変換する前の文字列で検証する
  const body = await req.text();
  const ok = await verifyDiscordSignature(
    publicKeyHex,
    req.headers.get('x-signature-ed25519'),
    req.headers.get('x-signature-timestamp'),
    body,
  );
  if (!ok) {
    log.warn('discord interaction: 署名検証に失敗', { ip: req.headers.get('cf-connecting-ip') });
    return new Response('invalid request signature', { status: 401 });
  }

  let payload: { type?: number };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  // Discord は URL 登録時とその後定期的に PING を送り、PONG が返らなければ登録を拒否する
  if (payload.type === PING) return json({ type: PONG });
  return json({ type: CHANNEL_MESSAGE, data: { content: 'この Bot は問い合わせ通知専用です。', flags: EPHEMERAL } });
}
