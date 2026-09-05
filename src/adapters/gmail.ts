import { z } from 'zod';
import type { RawMessage } from '../types/inquiry';
import type { FetchResult, MessageSource } from '../types/ports';
import { fetchJson } from './http';

// 10 秒: Gmail API は通常 1〜2 秒。list 1 回＋get 最大 20 回を 50 秒予算に収めるための上限
const TIMEOUT_MS = 10_000;
const MAX_PER_TICK = 20;                 // Workers Free の CPU 制限を考慮し 1 ティックの get 回数を抑える
const REWIND_SEC = 60;                   // after: は秒単位なので、同一秒の取りこぼしを防ぐため少し巻き戻して取る
const FIRST_RUN_LOOKBACK_SEC = 60 * 60;  // 初回は直近 1 時間だけ。過去メールを大量に流し込まないため

const tokenSchema = z.object({ access_token: z.string() });
const listSchema = z.object({ messages: z.array(z.object({ id: z.string() })).optional() });

export interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[] }
const partSchema: z.ZodType<Part> = z.lazy(() => z.object({
  mimeType: z.string().optional(),
  body: z.object({ data: z.string().optional() }).optional(),
  parts: z.array(partSchema).optional(),
}));
const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  internalDate: z.string(),
  payload: partSchema.and(z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() })),
});

export interface GmailConfig { clientId: string; clientSecret: string; refreshToken: string; query: string }

export class GmailSource implements MessageSource {
  readonly source = 'gmail' as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: GmailConfig) {}

  async fetchNew(cursor: string | null): Promise<FetchResult> {
    const auth = { Authorization: `Bearer ${await this.accessToken()}` };
    const nowSec = Math.floor(Date.now() / 1000);
    const since = cursor ? Number(cursor) - REWIND_SEC : nowSec - FIRST_RUN_LOOKBACK_SEC;
    const q = `${this.cfg.query} after:${since}`;
    const list = await fetchJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q, maxResults: String(MAX_PER_TICK) })}`,
      { headers: auth },
      { service: 'gmail', timeoutMs: TIMEOUT_MS, schema: listSchema, schemaName: 'gmail.messages.list' },
    );

    const messages: RawMessage[] = [];
    let maxEpoch = cursor ? Number(cursor) : 0;
    for (const { id } of list.messages ?? []) {
      const full = await fetchJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        { headers: auth },
        { service: 'gmail', timeoutMs: TIMEOUT_MS, schema: messageSchema, schemaName: 'gmail.messages.get' },
      );
      const receivedMs = Number(full.internalDate);
      maxEpoch = Math.max(maxEpoch, Math.floor(receivedMs / 1000));
      const header = (name: string) => full.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value;
      messages.push({
        source: 'gmail',
        sourceMessageId: full.id,
        sourceThreadId: full.threadId,
        sender: header('from'),
        subject: header('subject'),
        body: extractBody(full.payload),
        receivedAt: new Date(receivedMs),
      });
    }
    messages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    return { messages, nextCursor: maxEpoch > 0 ? String(maxEpoch) : cursor };
  }

  /** リフレッシュトークンからアクセストークンを得る。1 時間有効なので 50 分はキャッシュする */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: this.cfg.refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetchJson(
      'https://oauth2.googleapis.com/token',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      { service: 'gmail', timeoutMs: TIMEOUT_MS, schema: tokenSchema, schemaName: 'google.oauth.token' },
    );
    this.token = { value: res.access_token, expiresAt: Date.now() + 50 * 60_000 };
    return res.access_token;
  }
}

/** text/plain を優先し、無ければ text/html のタグを落として使う */
export function extractBody(part: Part): string {
  const plain = findPart(part, 'text/plain');
  if (plain) return decodeBase64Url(plain);
  const html = findPart(part, 'text/html');
  if (html) return stripHtml(decodeBase64Url(html));
  return '';
}

function findPart(part: Part, mime: string): string | undefined {
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return undefined;
}

/** Gmail の本文は URL-safe な base64。標準 base64 に戻してから UTF-8 として読む */
export function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}
