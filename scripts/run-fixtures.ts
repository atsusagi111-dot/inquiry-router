// 22 件の fixtures をモックで流し、期待 vs 実際の合否表を出す。
//   npm run fixtures               … 配管確認（分類は CSV の期待値を返すモック）
//   npm run fixtures -- --llm-down … OpenAI 断を再現。クレーム 2 件の緊急通知だけは届くことを確認
//   npm run eval:llm               … 分類だけ本物の OpenAI を使い精度を測る（feat/classify マージ後）
import { readFileSync } from 'node:fs';
import { loadEnv, type Env } from '../src/env';
import { runTick } from '../src/pipeline/run';
import { createMockDeps } from '../src/adapters/mock';
import type { Classifier } from '../src/types/ports';
import { setLogLevel } from '../src/observability/logger';

const args = new Set(process.argv.slice(2));
const env = loadEnv({ ...process.env, MOCK_EXTERNAL_API: 'true' });
setLogLevel(args.has('--verbose') ? 'debug' : 'warn');
const csv = readFileSync('fixtures/case5-test-inquiries.csv', 'utf8');

async function realClassifier(): Promise<Classifier> {
  try {
    // パスを変数にしているのは、feat/classify のマージ前（ファイル未存在）でも型チェックを通すため
    const modPath = '../src/adapters/openai';
    const mod = (await import(modPath)) as { createOpenAIClassifier: (env: Env) => Classifier };
    return mod.createOpenAIClassifier(env);
  } catch (e) {
    throw new Error(`--real-llm は feat/classify のマージ後に使えます: ${String(e)}`);
  }
}

const llmDown = args.has('--llm-down');
const deps = createMockDeps({
  fixturesCsv: csv,
  classifier: args.has('--real-llm') ? await realClassifier() : llmDown ? 'failing' : 'fake',
});
const channelOf = {
  賃貸: env.SLACK_CHANNEL_RENTAL,
  売買: env.SLACK_CHANNEL_SALES,
  内見: env.SLACK_CHANNEL_VIEWING,
  クレーム: env.SLACK_CHANNEL_COMPLAINT,
  対象外: env.SLACK_CHANNEL_UNSORTED,
} as const;

// 1 ティックの処理件数に上限があるので、未処理が無くなるまで回す（無限ループ防止で最大 10 回）
const pending = () =>
  [...deps.repo.inquiries.values()].filter((q) => q.status === 'ingested' || q.status === 'classified').length;
for (let i = 0; i < 10; i++) {
  await runTick(env, deps);
  if (i > 0 && pending() === 0) break;
}

// 2 周目：cursor を戻して同じ CSV を再取り込み → 保存 0・通知は増えない（冪等性）
const slackBefore = deps.slack.posts.length;
const urgentBefore = deps.urgent.urgent.length;
deps.repo.resetCursors();
const second = await runTick(env, deps);

let failures = 0;
const lines: string[] = [];
for (const row of deps.rows) {
  const q = [...deps.repo.inquiries.values()].find((x) => x.sourceMessageId === `fixture-${row.no}`);
  const actualCat = q?.classification?.category ?? '-';
  const actualCh = deps.slack.posts.find((p) => p.inquiry.id === q?.id)?.channel ?? '-';
  const actualUrgent = deps.urgent.urgent.some((u) => u.id === q?.id);
  // OpenAI 断のときは「緊急通知が正しいか」だけを判定する（カテゴリは #未分類 になるのが正）
  const okCat = llmDown ? true : actualCat === row.expectedCategory;
  const okCh = llmDown ? true : actualCh === channelOf[row.expectedCategory];
  const okUrgent = actualUrgent === row.expectedUrgent;
  const ok = okCat && okCh && okUrgent && q?.status === 'notified';
  if (!ok) failures++;
  lines.push(
    `${ok ? '✅' : '❌'} No.${String(row.no).padStart(2)} 期待:${row.expectedCategory}${row.expectedUrgent ? '(緊急)' : ''} ` +
    `実際:${actualCat} → ${actualCh}${actualUrgent ? ' 🚨緊急通知' : ''} [${q?.status ?? '未保存'}] ${row.feature}`,
  );
}
console.log(lines.join('\n'));
console.log(`\n--- 集計 ---\nSlack 投稿: ${deps.slack.posts.length} 件 / 緊急通知: ${deps.urgent.urgent.length} 件 / 運用アラート: ${deps.urgent.ops.length} 件`);
console.log(`2 周目: 保存 ${second.stored} 件・重複 ${second.duplicates} 件・Slack 増分 ${deps.slack.posts.length - slackBefore}・緊急増分 ${deps.urgent.urgent.length - urgentBefore}`);
if (second.stored !== 0 || deps.slack.posts.length !== slackBefore || deps.urgent.urgent.length !== urgentBefore) {
  failures++;
  console.log('❌ 冪等性: 2 周目で保存または通知が増えました');
}
console.log(failures === 0 ? '\n合格 ✅' : `\n不合格 ❌ ${failures} 件`);
process.exit(failures === 0 ? 0 : 1);
