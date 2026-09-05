import { z } from 'zod';
import type { Env } from '../env';
import type { Classifier, ClassifyInput } from '../types/ports';
import { fetchJson } from './http';
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, buildUserMessage } from '../domain/prompt';

// 20 秒: 生成待ちがあるため他の API より長い。1 件数秒で返る前提で、超えたら 1 回だけ再試行して fallback に落とす
const TIMEOUT_MS = 20_000;

const resultSchema = z.object({
  category: z.enum(['賃貸', '売買', '内見', 'クレーム', '対象外']),
  confidence: z.enum(['high', 'low']),
  reason: z.string(),
});
const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable(), refusal: z.string().nullable().optional() }),
  })).min(1),
});

export class OpenAIClassifier implements Classifier {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async classify(input: ClassifyInput) {
    const res = await fetchJson(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,   // 環境変数で差し替え可能（モデル廃止に備える）
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserMessage(input) },
          ],
          // gpt-5 系は temperature を受け付けないため送らない。出力の形は json_schema で固定される
          response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        }),
      },
      { service: 'openai', timeoutMs: TIMEOUT_MS, maxRetries: 1, schema: responseSchema, schemaName: 'openai.chat.completions' },
    );

    const msg = res.choices[0]!.message;
    if (msg.refusal) throw new Error(`OpenAI が回答を拒否: ${msg.refusal}`);
    if (!msg.content) throw new Error('OpenAI の応答が空');
    // Structured Outputs でも念のため zod で検証（モデル差し替え時の保険）
    return resultSchema.parse(JSON.parse(msg.content));
  }
}

export function createOpenAIClassifier(env: Env): Classifier {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY が未設定です');
  return new OpenAIClassifier(env.OPENAI_API_KEY, env.OPENAI_MODEL);
}
