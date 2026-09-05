# 問い合わせ集約・自動分類システム（MVP）

Gmail と Discord `#お問い合わせ` に届く問い合わせを毎分集め、5 カテゴリ（賃貸 / 売買 / 内見 / クレーム / 対象外）に分類して
カテゴリ別の Slack チャンネルへ投稿します。クレームは Discord で営業部長 DM ＋ `#緊急対応` へ 5 分以内に通知します。
設計の詳細は [PLAN.md](./PLAN.md) を参照してください。

- 実行基盤: Cloudflare Workers（Cron 毎分）・Supabase（DB）・OpenAI（分類）
- 月額目安: OpenAI 数十〜100 円程度。他は Free プラン（合計 1,000 円未満）

---

## 0. 事前に用意するもの

| 必要なもの | 用途 |
|---|---|
| Node.js 20 以上（動作確認は v24）と git | ビルド・テスト |
| Cloudflare アカウント（Free） | Worker の実行 |
| Supabase アカウント（Free） | 問い合わせの保存 |
| Google Cloud アカウント | Gmail API（受信元のメールアドレスで認可する） |
| Discord サーバーの管理権限 | Bot の招待、チャンネル/ユーザー/ロール ID の取得 |
| Slack ワークスペース（Free） | Incoming Webhook（アプリ枠を 1 つ使う） |
| OpenAI API キー | 分類 |

---

## 1. ローカルで動かす（外部 API なし）

```bash
# 依存パッケージを入れる（初回のみ）
npm install

# ローカル用の環境変数ファイルを作る。既定でモック（外部 API を叩かない）になっている
cp .dev.vars.example .dev.vars

# ユニットテスト（外部依存なし）
npm test

# 22 件のテストデータを流し、22 件すべて ✅ と「合格」が出れば OK
npm run fixtures

# OpenAI が落ちた状態を再現。クレーム 2 件の緊急通知だけは届き、No.22 は緊急にならないことを確認
npm run fixtures -- --llm-down
```

Worker として起動して Cron を手動で発火させる場合（モックのまま）:

```bash
# 別ターミナルで起動しておく（初回は workerd のダウンロードで少し待つ）
npm run dev

# もう 1 つのターミナルから Cron を発火。ログに "tick done" と件数が出れば OK
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"
```

---

## 2. Supabase（DB）の準備

1. https://supabase.com/dashboard で **New project** を作る（リージョンは Tokyo 推奨）
2. 左メニュー **SQL Editor** → **New query** に `supabase/migrations/0001_init.sql` の中身を貼り付けて **Run**
3. 左メニュー **Project Settings → API** から次の 2 つを控える
   - `Project URL` → `SUPABASE_URL`
   - `service_role` キー（**secret** の方。anon ではない）→ `SUPABASE_SERVICE_ROLE_KEY`

> service_role キーは全データを読み書きできる鍵です。Worker のシークレットにだけ入れ、他には貼らないでください。

---

## 3. Gmail API の準備

1. https://console.cloud.google.com/ で新しいプロジェクトを作る
2. **API とサービス → ライブラリ** で「Gmail API」を検索して **有効にする**
3. **API とサービス → OAuth 同意画面**
   - Google Workspace のアカウントなら「内部」を選ぶ（これが一番楽）
   - 個人 Gmail なら「外部」→ 作成後に **アプリを公開**（「テスト」のままだとトークンが 7 日で失効します）
   - スコープに `https://www.googleapis.com/auth/gmail.readonly` を追加
4. **API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID** → 種類は「ウェブ アプリケーション」
   - 承認済みのリダイレクト URI に `https://developers.google.com/oauthplayground` を追加
   - 表示される `クライアント ID` → `GMAIL_CLIENT_ID`、`クライアント シークレット` → `GMAIL_CLIENT_SECRET`
5. リフレッシュトークンを取る
   1. https://developers.google.com/oauthplayground を開く
   2. 右上の歯車 → **Use your own OAuth credentials** にチェック → 上の ID とシークレットを入力
   3. 左の Step 1 で `https://www.googleapis.com/auth/gmail.readonly` を入力 → **Authorize APIs** → 問い合わせを受けるメールアドレスでログインして許可
   4. Step 2 で **Exchange authorization code for tokens** → 表示される `Refresh token` → `GMAIL_REFRESH_TOKEN`

取得対象のメールは `wrangler.toml` の `GMAIL_QUERY`（既定: 受信トレイからプロモーション/ソーシャルを除く）で絞れます。
特定の宛先だけにしたいときは `to:info@example.com` などに変えてください。

---

## 4. Discord Bot の準備

1. https://discord.com/developers/applications → **New Application**
2. 左メニュー **Bot** → **Reset Token** で表示されるトークン → `DISCORD_BOT_TOKEN`
3. 同じ画面の **Privileged Gateway Intents** で **Message Content Intent** を ON にして保存
4. 左メニュー **OAuth2 → URL Generator** → SCOPES で `bot` → BOT PERMISSIONS で
   `View Channels` / `Send Messages` / `Read Message History` / `Mention Everyone`（ロールメンションに必要）を選び、
   生成された URL をブラウザで開いてサーバーに招待
5. Discord アプリの **ユーザー設定 → 詳細設定 → 開発者モード** を ON にしてから、右クリック → **ID をコピー** で次を控える
   - `#お問い合わせ` チャンネル → `DISCORD_INQUIRY_CHANNEL_ID`
   - `#緊急対応` チャンネル → `DISCORD_URGENT_CHANNEL_ID`
   - 営業部長のユーザー → `DISCORD_SALES_MANAGER_USER_ID`
   - `@営業部` ロール（サーバー設定 → ロール → 右クリック）→ `DISCORD_SALES_ROLE_ID`
6. Bot が `#お問い合わせ` と `#緊急対応` を閲覧・投稿できることをチャンネル権限で確認
7. **署名検証付きの受信器（Interactions Endpoint）を登録する**
   1. Developer Portal → **General Information** → **PUBLIC KEY** をコピー
   2. `wrangler.toml` の `DISCORD_PUBLIC_KEY = ""` の `""` の間に貼り、`npm run deploy` で反映（公開鍵なのでシークレットにしなくてよい）
   3. 同じ画面の **INTERACTIONS ENDPOINT URL** に `https://inquiry-router.<あなたのサブドメイン>.workers.dev/discord/interactions` を入力 → **Save Changes**
      （URL は `npm run deploy` の出力に表示される）
   4. Discord がその場で署名付きの確認リクエストを送り、検証に通れば保存される。通らないと「Could not verify」と出て保存できない
      → 保存できた時点で「署名検証が通る Webhook 受信器」が動いていることを Discord 自身が確認したことになる

> 営業部長への DM は、営業部長が「サーバーメンバーからの DM を許可」している必要があります。
> 許可がないと DM は失敗しますが、その場合も `#緊急対応` への投稿は届き、失敗した旨がチャンネルに残ります。

---

## 5. Slack Incoming Webhook の準備

1. Slack で 5 つのチャンネルを作る: `#賃貸` `#売買` `#内見` `#クレーム` `#未分類`
   （名前を変える場合は `wrangler.toml` の `SLACK_CHANNEL_*` も合わせる）
2. https://api.slack.com/apps → **Create New App → From scratch** → 名前を付けてワークスペースを選ぶ
3. 左メニュー **Incoming Webhooks** → **Activate Incoming Webhooks** を ON
4. **Add New Webhook to Workspace** を **5 回** 繰り返し、チャンネルごとに 1 本ずつ作る
   - 各 Webhook URL を `SLACK_WEBHOOK_RENTAL`（賃貸）/ `SLACK_WEBHOOK_SALES`（売買）/ `SLACK_WEBHOOK_VIEWING`（内見）/
     `SLACK_WEBHOOK_COMPLAINT`（クレーム）/ `SLACK_WEBHOOK_UNSORTED`（未分類）に対応させる

Free プランのアプリ枠は **この 1 アプリ** だけ消費します。

---

## 6. OpenAI の準備

1. https://platform.openai.com/api-keys で API キーを作る → `OPENAI_API_KEY`
2. モデルは `wrangler.toml` の `OPENAI_MODEL`（既定 `gpt-5.6-luna`）。廃止・変更時はここを書き換えるだけで済みます
3. 1 日の呼び出し上限は `OPENAI_DAILY_LIMIT`（既定 300）。超えた分は分類をスキップして `#未分類` に送ります

---

## 7. Cloudflare Workers にデプロイ

```bash
# Cloudflare にログイン（ブラウザが開く）
npx wrangler login

# シークレットをまとめて登録するためのファイルを作る（.gitignore 済み。値を埋めてから次へ）
cp secrets.example.json secrets.json

# secrets.json の値を Worker に登録する（コードや wrangler.toml には絶対に書かない）
npx wrangler secret bulk secrets.json

# 登録できたら手元のファイルは消す
rm secrets.json

# デプロイ。完了すると Cron Trigger（毎分）が有効になる
npm run deploy

# 動作ログをリアルタイムで見る（Ctrl+C で終了）。毎分 "tick done" が出れば動いている
npx wrangler tail
```

`secrets.json` のキー一覧は `.env.example` と同じです（`MOCK_EXTERNAL_API` と `*_CHANNEL_*` は `wrangler.toml` 側の設定なので不要）。

---

## 8. 本番の動作確認（納品前チェック）

| # | 操作 | 期待結果 |
|---|---|---|
| 1 | Discord `#お問い合わせ` に「駅近の1LDKを探しています。家賃8万円くらいで」と投稿 | 2 分以内に Slack `#賃貸` に届く |
| 2 | 受信メールアドレス宛に「今日の天気はどうですか？」を送る | Slack `#未分類` に届く（他のチャンネルには出ない） |
| 3 | `#お問い合わせ` に「先月入居した部屋のエアコンが効きません。至急対応してください。苦情です。」と投稿 | 5 分以内に Slack `#クレーム`、Discord `#緊急対応`（@営業部 付き）、営業部長 DM に届く |
| 4 | `#お問い合わせ` に「退去時の敷金精算について教えてください。これは緊急ではありません。」と投稿 | Slack `#賃貸` にだけ届き、Discord には何も出ない |
| 5 | Supabase の Table Editor で `inquiries` を開く | 上記 4 件が `status = notified` で並ぶ |

---

## 9. 運用

**状態を見る（Supabase SQL Editor）**

```sql
-- 直近 1 時間の処理件数と失敗
select run_at, stored, classified_keyword, classified_llm, classified_fallback, openai_calls,
       notified_slack, notified_urgent, failed, errors
from run_metrics where run_at > now() - interval '1 hour' order by run_at desc;

-- 再処理待ち・諦めた通知
select * from dead_letter where resolved_at is null order by next_retry_at;

-- 外部 API の遮断状態（open なら 5 分間そのサービスを呼ばない）
select * from circuit_breakers;

-- 今日の OpenAI 呼び出し回数
select * from daily_counters where day = current_date;
```

**定期的な掃除**（メトリクスは毎分 1 行増えるので、月 1 回程度）

```sql
delete from run_metrics where run_at < now() - interval '30 days';
```

**運用アラート**: 同じ外部 API が 3 回連続で失敗、または再処理を 5 回諦めたとき、`#緊急対応` に ⚠️ 付きで投稿されます（同じ内容は 1 時間に 1 回まで）。

**CPU 制限に当たったら**: Cloudflare のログに `Exceeded CPU Limit` が出る場合は、Workers Paid（$5/月）に切り替えてください。
コード変更は不要です。それでも足りなければ `wrangler.toml` の `CLASSIFY_BATCH_SIZE` / `NOTIFY_BATCH_SIZE` を小さくします。

**設定を変えたら**: `wrangler.toml` を編集して `npm run deploy`。シークレットは `npx wrangler secret put 名前` で個別に更新できます。

---

## 10. 開発の進め方

```bash
npm test                  # ユニットテスト
npm run typecheck         # 型チェック
npm run fixtures          # 22 件の配管テスト（モック）
npm run fixtures -- --llm-down   # OpenAI 断の再現
npm run eval:llm          # 分類だけ本物の OpenAI で 22 件の精度を測る（OPENAI_API_KEY を環境変数に入れて実行）
```

- 外部 API の呼び出しは `src/adapters/` に閉じ込めています。API 仕様が変わったらそのファイルだけ直します
- キーワードの語彙は `src/domain/keywords.ts`、プロンプトは `src/domain/prompt.ts`、振り分けルールは `src/domain/routing.ts`
- 開発用 worktree（`.worktrees/`）は役目を終えたので、不要なら `git worktree remove .worktrees/ingest` などで消せます

---

## 11. 困ったとき

| 症状 | 原因と対処 |
|---|---|
| デプロイ直後に `本番モードに必要な環境変数が未設定です: ...` | 列挙されたシークレットが未登録。`npx wrangler secret put 名前` で追加 |
| Gmail が `HTTP 401` / `invalid_grant` | リフレッシュトークン失効。OAuth 同意画面が「テスト」のままだと 7 日で切れる。§3 の手順で取り直す |
| Discord が `HTTP 403` | Bot がチャンネルを見られない／投稿できない。チャンネル権限と招待時の権限を確認 |
| Discord の本文が空で `#未分類` に行く | Message Content Intent が OFF。§4-3 を確認 |
| Interactions Endpoint URL の保存で「Could not verify」 | `wrangler.toml` の `DISCORD_PUBLIC_KEY` が空か貼り間違い、または未デプロイ。§4-7 の手順で公開鍵を貼って `npm run deploy` してから再度保存 |
| Slack に届かない | Webhook URL のチャンネル対応がずれている。`#未分類` に届くなら分類は動いている |
| OpenAI が `HTTP 400` でモデル名エラー | `OPENAI_MODEL` を利用可能なモデル名に変更して再デプロイ |
| すべて `#未分類` に行く | OpenAI 断か日次上限。`circuit_breakers` と `daily_counters` を確認。クレームはこの状態でも緊急通知される |
