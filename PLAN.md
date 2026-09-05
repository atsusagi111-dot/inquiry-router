# 問い合わせ集約・自動分類システム（MVP）設計プラン

## Context

不動産管理会社向けに、Gmail と Discord に分散して届く問い合わせを Cloudflare Workers の毎分 Cron で吸い上げ、Supabase に保存し、キーワード事前フィルタ＋OpenAI Structured Outputs で 5 カテゴリに分類して、カテゴリ別 Slack チャンネルへ振り分ける。クレームは Discord で 5 分以内に緊急通知する。
品質の基準は「正しく分類できる」だけでなく「余計な反応をしない（誤検知しない）」「外部 API が壊れても止まらない」こと。

（このファイルは Plan Mode で承認された設計プランの写しです。）

---

## 1. テストデータの分析結果

**ファイルの所在**：仕様書では `fixtures/case5-test-inquiries.csv` だが、実際は **プロジェクト直下** `case5-test-inquiries.csv` にある。実装の最初に `fixtures/` へ移動する（差分提示のうえ）。

**列構成（6列・ヘッダあり・22行）**

| 列 | 内容 | 備考 |
|---|---|---|
| 番号 | 1〜22 | テスト ID として使う |
| チャネル | `line` / `mail` | **仕様（Gmail/Discord）と食い違い**。`mail`→gmail、`line`→discord に読み替える |
| 問い合わせ本文 | 1〜2文の日本語 | 署名・引用なし（除去ロジックの検証は別途ユニットテストで補う） |
| 期待カテゴリ | 賃貸/売買/内見/クレーム/その他・分類対象外 | No.21 の「その他/分類対象外」は `対象外` に読み替える |
| 緊急 | TRUE/FALSE | クレーム 2 件のみ TRUE |
| 検証する機能 | 説明文 | No.19/20 の「LINE Push」は旧仕様の名残。**通知先は Discord で確定**（クライアント確認済み）と読み替える |

**カテゴリ内訳（合計 22 件）**

| カテゴリ | 件数 | 番号 |
|---|---|---|
| 賃貸 | 11 | 1〜10, 22 |
| 売買 | 4 | 11〜14 |
| 内見 | 4 | 15〜18 |
| クレーム（緊急） | 2 | 19, 20 |
| 対象外 | 1 | 21 |

チャネル内訳：`line` 11 件 / `mail` 11 件。

**難しいケース**

- **No.21** 「今日の天気はどうですか？」→ `対象外` になること。4 値固定だとどこかに誤分類される。
- **No.22** 「退去時の敷金精算…これは緊急ではありません」→ 期待は `賃貸`・緊急 FALSE。「緊急」の単純一致で緊急通知が飛んではいけない。
- **No.8**（見落としやすい）「即入居可の賃貸を探しています。今週中に内見も含めて決めたい」→ 期待は `賃貸`。「内見」の語を含むので、キーワードだけで `内見` 確定にすると誤分類する。**複数カテゴリの語が混在したら LLM に回す** 根拠になる。
- **No.19** 「至急対応してください。苦情です」／**No.20** 「クレームとして正式に申し入れます」→ どちらも OpenAI が落ちていてもキーワード経路で緊急通知が届く必要がある。

---

## 2. ディレクトリ構成

```
.
├── PLAN.md                         # 本プラン
├── README.md                       # 環境構築〜デプロイを上からコピペで完走できる手順
├── .env.example                    # 必要な環境変数の一覧（値は空）と取得手順へのリンク
├── .dev.vars.example               # wrangler dev 用（.env.example と同内容、ローカル専用）
├── package.json / tsconfig.json / wrangler.toml / vitest.config.ts
├── fixtures/
│   └── case5-test-inquiries.csv    # テストデータ（直下から移動）
├── supabase/
│   └── migrations/0001_init.sql    # テーブル定義（§3）
├── scripts/
│   └── run-fixtures.ts             # モックで 22 件を流し、期待 vs 実際の合否表を出す
└── src/
    ├── index.ts                    # Worker エントリ。scheduled() で pipeline/run を呼ぶだけ
    ├── env.ts                      # 環境変数を zod で検証し型付き Env にする
    ├── types/                      # ★3 worktree 共通。最初に確定し、以後は合意なく変更しない
    │   ├── inquiry.ts              # Inquiry / Classification / Category など共有ドメイン型
    │   └── ports.ts                # 各層の境界インターフェース（Source / Classifier / Notifier / Repo）
    ├── pipeline/
    │   ├── run.ts                  # 1 ティックの流れ（ロック→再処理→ingest→classify→notify→metrics）
    │   ├── ingest.ts               # [feat/ingest] 取得→正規化→重複排除→保存
    │   ├── classify.ts             # [feat/classify] 事前フィルタ→LLM→フォールバック
    │   └── notify.ts               # [feat/notify] Slack 投稿→緊急通知→通知済みフラグ更新
    ├── domain/                     # 外部 API に依存しない純粋ロジック（テストしやすい）
    │   ├── normalize.ts            # 署名・引用除去、空白正規化、content_hash 生成
    │   ├── keywords.ts             # 語彙定義（カテゴリ別・強/弱・否定パターン）
    │   ├── keyword-filter.ts       # 事前フィルタ本体（否定表現の無効化を含む）
    │   ├── prompt.ts               # OpenAI システムプロンプトと JSON Schema
    │   └── routing.ts              # (category, confidence) → Slack チャンネル／緊急要否の決定
    ├── adapters/                   # 外部 API のラッパ。呼び出し側は API の詳細を知らない
    │   ├── http.ts                 # fetch 共通基盤：timeout・429/5xx リトライ・ジッター・zod 検証
    │   ├── circuit-breaker.ts      # サービス別サーキットブレーカー（状態は Supabase）
    │   ├── gmail.ts                # OAuth2 リフレッシュ→messages.list/get
    │   ├── discord.ts              # メッセージ取得／DM／チャンネル投稿、レート制限ヘッダ対応
    │   ├── openai.ts               # Responses API + Structured Outputs、日次上限カウンタ
    │   ├── slack.ts                # Incoming Webhook 投稿
    │   ├── supabase.ts             # PostgREST 経由の Repo 実装（insert ignore-duplicates 等）
    │   └── mock/
    │       ├── index.ts            # MOCK_EXTERNAL_API=true のとき本物の代わりに返す工場関数
    │       ├── fixtures-source.ts  # CSV を Gmail/Discord の Source として振る舞わせる
    │       ├── memory-repo.ts      # Supabase の代わりのインメモリ Repo
    │       ├── fake-classifier.ts  # CSV の期待カテゴリを返す（配管テスト用）
    │       └── recording-notifier.ts # 送信内容を配列に溜めるだけの Notifier
    ├── observability/
    │   ├── logger.ts               # 構造化ログ（JSON 1 行）。zod 不一致もここへ
    │   └── metrics.ts              # run_metrics / daily_counters / ops_alerts の更新
    └── __tests__/                  # vitest。domain と pipeline を中心に
```

---

## 3. Supabase テーブル設計

```sql
-- 問い合わせ本体。Slack Free は履歴 90 日で消えるため、ここが唯一の正本
create table inquiries (
  id                 uuid primary key default gen_random_uuid(),
  source             text not null check (source in ('gmail','discord')),
  source_message_id  text not null,           -- Gmail/Discord のメッセージ ID
  source_thread_id   text,                    -- Gmail threadId / Discord channel_id。返信スレッドの追跡用
  sender             text,                    -- 送信者（メールアドレス or Discord user id）
  subject            text,                    -- Gmail のみ。分類プロンプトに含める
  body_raw           text not null,           -- 原文。除去処理のバグ調査と再分類のため保持
  body_clean         text not null,           -- 署名・引用除去後。分類はこちらを使う
  content_hash       text not null,           -- sender+body_clean の SHA-256。同一内容の再送検出
  received_at        timestamptz not null,    -- 相手が送った時刻。「5 分以内」の起点
  ingested_at        timestamptz not null default now(),
  category           text check (category in ('賃貸','売買','内見','クレーム','対象外')),
  confidence         text check (confidence in ('high','low')),
  classified_by      text check (classified_by in ('keyword','llm','fallback')), -- どの経路で決まったか。精度分析用
  classification_reason text,                 -- LLM の理由／ヒットした語。誤分類の説明責任
  is_urgent          boolean not null default false,
  target_channel     text,                    -- 振り分け先 Slack チャンネル名（routing の結果を保存）
  status             text not null default 'ingested'
                     check (status in ('ingested','duplicate','classified','notified','failed')),
  duplicate_of       uuid references inquiries(id),
  slack_notified_at  timestamptz,             -- 通知済みフラグ（冪等性）。null なら未送信
  urgent_notified_at timestamptz,             -- 緊急通知の通知済みフラグ。Slack と独立に持つ
  classified_at      timestamptz,
  unique (source, source_message_id)          -- 二重取り込み防止の要
);
create index inquiries_pending_idx on inquiries (status) where status in ('ingested','classified');
create index inquiries_hash_idx on inquiries (content_hash, received_at);

-- 差分取得の「どこまで読んだか」
create table source_cursors (
  source     text primary key,                -- 'gmail' | 'discord'
  cursor     text not null,                   -- gmail: 最終取得 epoch 秒 / discord: last message id
  updated_at timestamptz not null default now()
);

-- 毎分 Cron の多重実行防止（前回が 60 秒を超えたときに 2 本走らないように）
create table run_locks (
  name         text primary key,
  locked_until timestamptz not null,
  holder       text                           -- 実行 ID。ログ突合用
);

-- 失敗した処理の退避先。次回ティックで再処理
create table dead_letter (
  id            bigserial primary key,
  stage         text not null,                -- 'ingest' | 'classify' | 'notify_slack' | 'notify_urgent'
  inquiry_id    uuid references inquiries(id),
  payload       jsonb,                        -- ingest 失敗時など inquiry 行がまだ無い場合の生データ
  error         text not null,
  attempts      int not null default 1,
  next_retry_at timestamptz not null,         -- 指数バックオフ後の再試行時刻
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz                   -- 成功したら埋める。削除せず履歴として残す
);

-- サーキットブレーカーの状態。Workers はステートレスなので DB に置く
create table circuit_breakers (
  service              text primary key,      -- 'gmail' | 'discord' | 'openai' | 'slack'
  consecutive_failures int not null default 0,
  state                text not null default 'closed' check (state in ('closed','open','half_open')),
  opened_until         timestamptz,
  updated_at           timestamptz not null default now()
);

-- 監視用。1 ティック 1 行
create table run_metrics (
  id                  bigserial primary key,
  run_at              timestamptz not null default now(),
  duration_ms         int,
  fetched_gmail       int default 0, fetched_discord int default 0,
  stored              int default 0, duplicates int default 0,
  classified_keyword  int default 0, classified_llm int default 0, classified_fallback int default 0,
  openai_calls        int default 0,
  notified_slack      int default 0, notified_urgent int default 0,
  failed              int default 0,
  errors              jsonb                   -- エラー要約の配列
);

-- 日次カウンタ（OpenAI の 1 日上限など）
create table daily_counters (
  day   date not null,
  key   text not null,                        -- 'openai_calls'
  value int not null default 0,
  primary key (day, key)
);

-- 運用アラートの送信抑制（同じ警告を毎分連打しない）
create table ops_alerts (
  key          text primary key,              -- 'consecutive_failures:openai' など
  last_sent_at timestamptz not null
);
```

Supabase の RLS（行レベルセキュリティ）は有効化し、Worker は `service_role` キーで接続する（公開クライアントは存在しないため）。

---

## 4. 処理フロー（毎分の Cron）

```
scheduled()
 0. ロック取得   run_locks を「locked_until < now()」条件で upsert。取れなければ即終了
 1. 再処理       dead_letter から next_retry_at <= now() を最大 20 件取り、stage に応じて再実行
 2. ingest       source ごとに: ブレーカー確認 → cursor 以降を取得 → normalize → hash
                 → insert (on conflict ignore) → 全件保存成功後に cursor を進める
                 （cursor を先に進めると取りこぼす。後に進めると重複するが unique 制約が弾く）
 3. classify     status='ingested' を最大 10 件（古い順）
                 → keyword-filter で確定なら classified_by='keyword'
                 （Free の CPU 制限に収めるため既定 10 件。環境変数で調整）
                 → 未確定: OpenAI ブレーカー closed かつ日次上限未満なら LLM
                 → それ以外: classified_by='fallback', confidence='low'
                 → routing で target_channel / is_urgent を決定し status='classified'
 4. notify       status='classified' を処理
                 → slack_notified_at が null なら Slack 投稿 → 成功直後に時刻を書く
                 → is_urgent かつ urgent_notified_at が null なら Discord DM ＋ #緊急対応 → 時刻を書く
                 → 両方済んだら status='notified'。片方失敗は dead_letter へ（成功側は再送しない）
 5. 監視         run_metrics に 1 行。ブレーカー open や連続失敗閾値超過なら #緊急対応 へ運用アラート
                 （ops_alerts で 1 時間 1 回に抑制）
 6. ロック解放
```

**「5 分以内」の見積り**：受信 → 次のティック（最大 60 秒待ち）→ 同一ティック内で 2〜4 を完走 → 通常 1〜2 分。1 ティックの実行時間は 50 秒以内を目標にし、超過時は次ティックに持ち越す（ロックで保護）。

**Cloudflare プラン**：月額 1,000 円未満の制約により **Workers Free を既定** とする。Free は 1 呼び出し CPU 10ms だが、fetch 待ち時間は含まれないため、1 ティックの処理件数を小さく区切れば収まる見込み（classify 10 件・notify 10 件／ティック。月 700 件 ≒ 1 件/分なので十分）。Cloudflare のログに CPU 超過（`Exceeded CPU Limit`）が出た場合のみ Paid（$5/月 ≒ 750 円。OpenAI 分と合わせても 1,000 円未満）へ移行する。

---

## 5. 分類ロジックの設計

### 5-1. キーワード事前フィルタ

**方針**：事前フィルタは「高精度で確定できるものだけ」を拾い、迷ったら LLM に回す。特に **クレーム判定は LLM に依存させない**（OpenAI 障害時も緊急通知を届けるため）。

**手順**
1. body_clean を文単位（`。！？!?\n`）に分割
2. 各文で否定表現を無効化（5-2）した後、語彙を照合
3. カテゴリ別スコアを算出し、確定ルールに掛ける

**語彙（初版。`keywords.ts` に集約し、運用しながら追加）**

| カテゴリ | 強（1 語で確定候補） | 弱（2 語以上で確定候補） |
|---|---|---|
| クレーム | 苦情, クレーム, 訴え, 弁護士, 消費者センター, 申し入れ | 至急, 緊急, 故障, 壊れ, 効かない, 効きません, 動かない, 水漏れ, 漏水, 騒音, 異臭, 停電, 開かない, 話が違う, 説明と違う, 違いすぎ, 納得できない, 対応してください, 困っています |
| 賃貸 | （なし） | 賃貸, 家賃, 1LDK/2DK 等の間取り, 入居, 退去, 敷金, 礼金, 更新, アパート, 借り |
| 売買 | （なし） | 購入, 売却, 査定, 住宅ローン, 中古マンション, 一戸建て, 投資用, 利回り, 予算〇〇万円 |
| 内見 | （なし） | 内見, 見学, 日程調整, 伺いたい, オンライン内見 |

**確定ルール**
- **クレーム確定**：強 1 語以上、または弱 2 語以上 → `クレーム / high / keyword`。他カテゴリの語があっても優先（クレームは見逃しの実害が大きい）
- **賃貸・売買・内見確定**：クレーム語がゼロ、かつ **1 カテゴリだけ** に 2 語以上ヒットし、他カテゴリのヒットがゼロ → そのカテゴリ `high / keyword`
- **上記以外** → LLM へ

**テストデータへの当てはめ**
- No.19：効きません(弱)・至急(弱)・苦情(強) → クレーム確定 ✅
- No.20：違いすぎ(弱)・クレーム(強)・申し入れ(強) → クレーム確定 ✅
- No.22：「緊急」は否定で無効化 → クレーム 0。退去・敷金 → 賃貸 2 語、他 0 → 賃貸確定 ✅（緊急通知なし）
- No.8：賃貸・入居(賃貸) ＋ 内見(内見) → 混在なので LLM へ ✅
- No.21：どこにもヒットなし → LLM へ（`対象外` は LLM に判断させる）

### 5-2. 否定表現の除外ルール

キーワードの **直後 10 文字以内** に以下が続く場合、そのヒットを無効にする（文字列を消すのではなく「そのヒットを数えない」）。

```
(?:では|じゃ|で|という(?:わけ|こと)では)?(?:ありません|ない|なく|無い|ございません|なかった)
```

例：「緊急ではありません」「至急ではなく」「クレームではないのですが」→ いずれも無効。
既知の限界：「故障ではないでしょうか？」のような疑問形も無効化される。ただし無効化の帰結は「LLM に回る」だけで、通常時は LLM が拾う。OpenAI 障害時にこの形だけ取りこぼす可能性は §9 に明記。

### 5-3. OpenAI プロンプト案

モデル名は環境変数 `OPENAI_MODEL`（既定 `gpt-5.6-luna`）。Structured Outputs（`strict: true`）で以下のスキーマを固定。

```json
{
  "type": "object",
  "properties": {
    "category":   { "type": "string", "enum": ["賃貸", "売買", "内見", "クレーム", "対象外"] },
    "confidence": { "type": "string", "enum": ["high", "low"] },
    "reason":     { "type": "string" }
  },
  "required": ["category", "confidence", "reason"],
  "additionalProperties": false
}
```

システムプロンプト（要旨）：
```
あなたは不動産管理会社の問い合わせ受付担当です。メッセージを次の 5 つのいずれか 1 つに分類してください。
- 賃貸: 部屋を借りたい／借りている人からの相談（物件探し、契約・更新・退去・敷金など入居中の事務手続きを含む）
- 売買: 物件を買いたい／売りたい（購入相談、住宅ローン、査定、投資用）
- 内見: 具体的な物件を見に行く日程・方法の相談が主目的のもの
- クレーム: 不満・苦情・設備不良・約束と違うなど、会社側の対応が必要な申し立て
- 対象外: 不動産と無関係（雑談、天気、スパム、誤送信、空メッセージ）
ルール:
1. 不動産に関係ないなら迷わず「対象外」。無理にどれかに当てはめない。
2. 「緊急ではない」「クレームではない」など否定されている語は根拠にしない。
3. 物件探しの中で内見に触れているだけなら「賃貸」または「売買」。内見の日程・方法そのものが主題なら「内見」。
4. 2 つ以上に跨る、情報が少ない、判断に迷う場合は confidence を "low" にする。
5. reason は日本語 1 文で、判断根拠となった語句を含める。
```
ユーザーメッセージには `チャネル / 件名（あれば） / 本文` を渡す。`temperature` は最小（決定的にする）。

### 5-4. `対象外` と `confidence: low` の扱い

`routing.ts` で一元決定：

| category | confidence | Slack 送り先 | 緊急通知 |
|---|---|---|---|
| 賃貸/売買/内見 | high | `#賃貸` / `#売買` / `#内見` | なし |
| クレーム | high | `#クレーム` | **あり** |
| 対象外 | high | `#未分類` | なし |
| 任意 | low | `#未分類`（本文と「LLM の推定: ○○」を添える） | **なし**（クレーム low も含む。ただし Slack 投稿に ⚠ を付ける） |
| fallback（LLM 不可） | low | `#未分類`（「分類スキップ: 理由」を添える） | なし（キーワード確定分は上の行で既に処理済み） |

---

## 6. リスク管理の実装方針

| # | 項目 | 実装場所 | 方針 |
|---|---|---|---|
| 1 | レート制限 | `adapters/http.ts` | 429/5xx/ネットワーク失敗を最大 3 回リトライ。待機 = `Retry-After` があればそれ、なければ `min(30s, 1s×2^n) + 0〜500ms ジッター`。`adapters/discord.ts` は毎レスポンスの `X-RateLimit-Remaining` が 0 なら `X-RateLimit-Reset-After` 秒だけ次リクエスト前に待つ。`adapters/openai.ts` は `daily_counters` を呼ぶ前に確認し、`OPENAI_DAILY_LIMIT`（既定 300。通常 25 件/日の 10 倍超、暴走検知の役割）超過で fallback |
| 2 | 障害 | `http.ts` / `circuit-breaker.ts` / `dead_letter` | **タイムアウト**：Gmail 10s・Discord 10s・OpenAI 20s・Slack 5s・Supabase 8s。根拠：1 ティック 50 秒予算のうち、最悪ケース（各 1 回ずつ上限＋リトライ 1 回）でも 60 秒を超えず次ティックとロックで整合するライン。OpenAI だけ長いのは生成待ちがあるため。**ブレーカー**：連続 5 失敗で open（5 分）、以後 1 回だけ half_open で試す。**dead_letter**：失敗をステージ単位で退避、`attempts` 5 回で打ち切り（運用アラート対象）。**OpenAI 断でもクレーム通知**：§5-1 のキーワード経路は `domain/` の純粋関数で外部依存ゼロ |
| 3 | 仕様変更 | `adapters/*` + zod | すべての外部レスポンスを zod スキーマで parse。失敗時は `logger.warn` に生レスポンス冒頭 500 文字と期待スキーマ名を残し、その 1 件を dead_letter へ（処理全体は止めない）。モデル名・チャンネル ID・上限値はすべて環境変数 |
| 4 | 冪等性 | DDL + `notify.ts` | `unique(source, source_message_id)` ＋ insert は `Prefer: resolution=ignore-duplicates`。`slack_notified_at` / `urgent_notified_at` を **送信成功直後に個別に** 書き、再試行時は null のものだけ送る。cursor は保存成功後にのみ前進 |
| 5 | 監視 | `observability/metrics.ts` | 毎ティック `run_metrics` 1 行。`circuit_breakers.consecutive_failures >= 3` または dead_letter 打ち切り発生で `#緊急対応` へ運用アラート（`ops_alerts` で 1 時間 1 回）。アラート自体の送信失敗はログのみ（無限ループ回避） |
| 6 | シークレット | `wrangler secret put` / `.env.example` | コード・`wrangler.toml` に値を書かない。`env.ts` の zod で起動時に欠落を検知。README に Gmail OAuth・Discord Bot・Slack Webhook・Supabase・OpenAI の取得手順を順番に記載 |
| 7 | モック | `adapters/mock/` + `MOCK_EXTERNAL_API` | `true` のとき工場関数が **5 本すべて**（Supabase 含む）をモックに差し替える。Source は CSV を読み `mail`→gmail / `line`→discord として返す。Classifier は CSV の期待値を返す「配管確認用」と、実 OpenAI を叩く「精度確認用（`npm run eval:llm`、明示実行のみ）」を分ける。3 つの worktree は既定でモックのみ動くため、実 API を同時に叩かない |

---

## 7. worktree への作業分割

### 先に main で確定するもの（分岐前・1 コミット）

- 雛形：`package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `.env.example`
- `src/types/inquiry.ts`, `src/types/ports.ts`（下記）
- `src/adapters/http.ts`, `circuit-breaker.ts`, `mock/index.ts`（骨組み）
- `src/pipeline/run.ts`（3 ステージをスタブ呼び出し）
- `supabase/migrations/0001_init.sql`, `fixtures/` への CSV 移動, `scripts/run-fixtures.ts`（骨組み）

### 共有型（`src/types/inquiry.ts`）

```ts
export type Source = 'gmail' | 'discord';
export type Category = '賃貸' | '売買' | '内見' | 'クレーム' | '対象外';
export type Confidence = 'high' | 'low';
export type ClassifiedBy = 'keyword' | 'llm' | 'fallback';

/** 受信直後、正規化前のメッセージ（ingest が Source から受け取る） */
export interface RawMessage {
  source: Source;
  sourceMessageId: string;
  sourceThreadId?: string;
  sender?: string;
  subject?: string;
  body: string;
  receivedAt: Date;
}

/** DB 保存後の問い合わせ（3 ステージが共通で扱う） */
export interface Inquiry {
  id: string;
  source: Source;
  sourceMessageId: string;
  sender?: string;
  subject?: string;
  bodyClean: string;
  receivedAt: Date;
  status: 'ingested' | 'duplicate' | 'classified' | 'notified' | 'failed';
  classification?: Classification;
  targetChannel?: string;
  isUrgent: boolean;
  slackNotifiedAt?: Date;
  urgentNotifiedAt?: Date;
}

export interface Classification {
  category: Category;
  confidence: Confidence;
  classifiedBy: ClassifiedBy;
  reason: string;
}

export interface RoutingDecision { targetChannel: string; isUrgent: boolean; }
```

### 境界インターフェース（`src/types/ports.ts`）

```ts
export interface Source       { fetchNew(cursor: string | null): Promise<{ messages: RawMessage[]; nextCursor: string | null }>; }
export interface Classifier   { classify(input: { subject?: string; body: string; source: Source }): Promise<Omit<Classification,'classifiedBy'>>; }
export interface SlackNotifier   { post(channel: string, inquiry: Inquiry): Promise<void>; }
export interface UrgentNotifier  { notifyUrgent(inquiry: Inquiry): Promise<void>; notifyOps(message: string): Promise<void>; }
export interface Repo {
  insertMany(rows: NormalizedMessage[]): Promise<{ inserted: number; duplicates: number }>;
  getCursor(source: Source): Promise<string | null>;  setCursor(source: Source, cursor: string): Promise<void>;
  listByStatus(status: Inquiry['status'], limit: number): Promise<Inquiry[]>;
  saveClassification(id: string, c: Classification, r: RoutingDecision): Promise<void>;
  markSlackNotified(id: string): Promise<void>;  markUrgentNotified(id: string): Promise<void>;  markNotified(id: string): Promise<void>;
  pushDeadLetter(entry: DeadLetterEntry): Promise<void>;  popDueDeadLetters(limit: number): Promise<DeadLetterEntry[]>;
  // ブレーカー・カウンタ・メトリクス・ロックも同様に Repo 経由
}
```

### ブランチ担当

| ブランチ | 担当ファイル | 完了条件（モックで確認） |
|---|---|---|
| `feat/ingest` | `pipeline/ingest.ts`, `domain/normalize.ts`, `adapters/gmail.ts`, `adapters/discord.ts`（取得側）, `adapters/supabase.ts`, `mock/fixtures-source.ts`, `mock/memory-repo.ts` | CSV 22 件が `ingested` で保存され、同じ実行をもう一度回すと inserted 0 / duplicates 22。署名・引用除去のユニットテスト |
| `feat/classify` | `pipeline/classify.ts`, `domain/keywords.ts`, `domain/keyword-filter.ts`, `domain/prompt.ts`, `domain/routing.ts`, `adapters/openai.ts`, `mock/fake-classifier.ts` | keyword-filter 単体で §8 の期待。Classifier をモック／失敗させたケースで fallback 動作 |
| `feat/notify` | `pipeline/notify.ts`, `adapters/slack.ts`, `adapters/discord.ts`（送信側）, `observability/*`, `mock/recording-notifier.ter` | 22 件に対して Slack 投稿 22 回・緊急 2 回。再実行で 0 回。Slack 成功・Discord 失敗 → dead_letter に notify_urgent のみ |

`adapters/discord.ts` は ingest と notify の両方が触るため、**取得側と送信側で関数を分け、ファイル内の別セクションにする**（衝突を最小化）。マージ順：ingest → classify → notify。

---

## 8. 受け入れ基準（22 件）

**A. ユニット（外部依存なし・必須）**
- `keyword-filter`：No.19, 20 → クレーム確定。No.22 → クレーム語ゼロ、賃貸確定。No.8 → 未確定（LLM 行き）。No.21 → 未確定
- `keyword-filter`：「緊急ではありません」「至急ではなく」「クレームではないです」の 3 パターンで緊急ヒット 0
- `normalize`：`-- 以降` の署名、`> ` 引用、「On ... wrote:」以降が除去される
- `routing`：§5-4 の表どおり

**B. 配管（`MOCK_EXTERNAL_API=true`・`scripts/run-fixtures.ts`・必須）**
- 22 件が status `notified`。Slack 投稿 22 回、内訳 `#賃貸` 11 / `#売買` 4 / `#内見` 4 / `#クレーム` 2 / `#未分類` 1
- 緊急通知は No.19, 20 の **2 回のみ**。No.22 は 0 回
- 同じ CSV で 2 回目を実行 → 保存 0・通知 0
- Classifier を強制失敗させた実行 → No.19, 20 は緊急通知される。残りは `#未分類` 20 件

**C. 精度（実 OpenAI・`npm run eval:llm`・明示実行）**
- 22 件中 22 件が期待カテゴリと一致（`対象外` を含む）。**No.21 と No.22 の一致は必須**、他は 21/22 以上なら合格として reason を記録
- `confidence: low` が出た件はチャンネルが `#未分類` になっている

**D. 本番相当（デプロイ後・手動）**
- Discord `#お問い合わせ` に No.19 相当を投稿 → 5 分以内に営業部長 DM と `#緊急対応` に届く
- No.22 相当を投稿 → `#賃貸` にのみ届く
- 同じ本文を 2 回送っても Slack は 2 回届く（別メッセージ ID なので正しい）。dead_letter 再処理で再送されないことを確認

---

## 9. 想定リスクと未確定事項（クライアント確認）

**要確認（実装に影響）**
1. **月額は 1,000 円未満が上限**（確認済み）。Workers Free で運用し、CPU 超過が出た場合のみ Paid（750 円）へ移行してよいか
2. **Gmail の OAuth 同意画面を「本番」に公開できるか**。テストモードのままだとリフレッシュトークンが 7 日で失効し、毎週手動再認証になる（Google Workspace の内部アプリなら回避可）
3. Gmail の取得対象：受信トレイ全件か、特定ラベル／宛先（`info@`）のみか。**返信メール（同一スレッドの 2 通目以降）も新規問い合わせとして扱うか**
4. Discord `#お問い合わせ` で **社内スタッフや Bot の投稿を除外するか**（除外しないと自社の返信も分類される）
5. 営業部長の Discord ユーザー ID、`@営業部` のロール ID、`#緊急対応`・`#お問い合わせ` のチャンネル ID。Bot を招待できる権限者
6. Slack チャンネル名（`#賃貸 #売買 #内見 #クレーム #未分類` で仮置き）。Incoming Webhook は 1 アプリで 5 本作れるため **アプリ枠は 1 つ消費**
7. **顧客の問い合わせ本文を OpenAI に送ることの同意**（個人情報を含み得る）。プライバシーポリシーへの記載要否
8. 「5 分以内」の起点は「相手が送った時刻」でよいか。Gmail 側は配送遅延を含めると保証できない場合がある

**想定リスク（設計で緩和済み、残存分を明記）**
- Gmail の `messages.list` は差分取得に `after:` クエリ（秒単位）を使うため、同一秒に複数届いた場合に取りこぼす可能性 → cursor を 60 秒巻き戻して取得し、重複は unique 制約で吸収
- OpenAI 障害中に「否定形に見える表現」（例「故障ではないでしょうか」）のクレームはキーワード経路で拾えない → 復旧後に `#未分類` から人が拾う運用
- Supabase Free はメトリクス行が毎分増える（月 4.3 万行）→ 30 日より古い `run_metrics` を日次で削除するクエリを README に記載
- Discord DM は Bot と相手が同じサーバーにいて、相手が DM を許可している必要がある → 失敗時は `#緊急対応` への投稿のみで代替し dead_letter に残す
- `gpt-5.6-luna` が廃止された場合 → `OPENAI_MODEL` の差し替えのみ。Structured Outputs 非対応モデルに変えるとスキーマ検証で検知される

---

## 実装の進め方（承認後）

1. 本プランを `PLAN.md` として出力
2. main に雛形＋共有型＋マイグレーション＋CSV 移動をコミット（変更対象一覧を先に提示）
3. 3 つの worktree を作成し、ブランチごとに実装（各ブランチで差分提示→適用）
4. `npm test`（A）と `npm run fixtures`（B）を各ブランチで通す
5. ingest → classify → notify の順にマージし、`npm run eval:llm`（C）を実行
6. README の手順どおりにデプロイし、D を手動確認

コスト見積：Cloudflare Free 0 円 ＋ OpenAI 約 100 円未満（700 件 × 約 600 トークン。キーワード確定分はさらに減る）＋ Supabase 0 円 ＋ Slack Free 0 円 ＝ **月 100 円前後**（上限 1,000 円未満を満たす）。

---

## 実装時の設計変更（承認済みプランからの差分）

- モック 4 本（fixtures-source / memory-repo / fake-classifier / recording-notifier）は各ブランチではなく main に置いた。classify / notify ブランチも CSV で単体確認する必要があったため
- dead_letter を使うステージは notify のみ。ingest は cursor が進まないことで、classify は status='ingested' のままになることで、それぞれ次ティックが自然に再試行する。notify は失敗行を failed にして通常バッチから外し、dead_letter で 1→2→4→8→16 分後に 5 回再処理する（壊れた行がバッチを占有して新しい通知を止めないため）
- `Repo.getById` を追加（dead_letter 再処理で DB の最新フラグを見るため）
- OpenAI 呼び出しに `temperature` は送らない（gpt-5 系は受け付けないため）。出力の形は json_schema で固定
- LLM が使えないときの fallback は、キーワードのヒントがあれば推定カテゴリを confidence=low で残す（Slack には「要確認（推定: ○○）」と出る）。振り分けは常に #未分類
- 営業部長 DM の失敗は例外にせず、#緊急対応 に失敗した旨を投稿する（チャンネル投稿が成立していれば緊急通知は届いたとみなす）
- Discord API のクライアントは discord-client.ts に共通化し、受信は discord-source.ts、送信は discord-notify.ts に分離
- 環境変数は空文字列を未設定として扱う（.dev.vars の空値対策）
