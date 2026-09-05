-- 問い合わせ集約システム 初期スキーマ
-- Supabase ダッシュボード > SQL Editor に貼り付けて実行する

-- 問い合わせ本体。Slack Free は履歴 90 日で消えるため、ここが唯一の正本
create table if not exists inquiries (
  id                    uuid primary key default gen_random_uuid(),
  source                text not null check (source in ('gmail','discord')),
  source_message_id     text not null,           -- Gmail/Discord のメッセージ ID
  source_thread_id      text,                    -- Gmail threadId / Discord channel_id。返信スレッドの追跡用
  sender                text,                    -- 送信者（メールアドレス or Discord user id）
  subject               text,                    -- Gmail のみ。分類プロンプトに含める
  body_raw              text not null,           -- 原文。除去処理のバグ調査と再分類のため保持
  body_clean            text not null,           -- 署名・引用除去後。分類はこちらを使う
  content_hash          text not null,           -- sender+body_clean の SHA-256。同一内容の再送検出
  received_at           timestamptz not null,    -- 相手が送った時刻。「5 分以内」の起点
  ingested_at           timestamptz not null default now(),
  category              text check (category in ('賃貸','売買','内見','クレーム','対象外')),
  confidence            text check (confidence in ('high','low')),
  classified_by         text check (classified_by in ('keyword','llm','fallback')), -- どの経路で決まったか
  classification_reason text,                    -- LLM の理由／ヒットした語。誤分類の説明責任
  is_urgent             boolean not null default false,
  target_channel        text,                    -- 振り分け先 Slack チャンネル名
  status                text not null default 'ingested'
                        check (status in ('ingested','duplicate','classified','notified','failed')),
  duplicate_of          uuid references inquiries(id),
  slack_notified_at     timestamptz,             -- 通知済みフラグ（冪等性）。null なら未送信
  urgent_notified_at    timestamptz,             -- 緊急通知の通知済みフラグ。Slack と独立に持つ
  classified_at         timestamptz,
  unique (source, source_message_id)             -- 二重取り込み防止の要
);
create index if not exists inquiries_pending_idx on inquiries (status, received_at)
  where status in ('ingested','classified');
create index if not exists inquiries_hash_idx on inquiries (content_hash, received_at);

-- 差分取得の「どこまで読んだか」
create table if not exists source_cursors (
  source     text primary key,                   -- 'gmail' | 'discord'
  cursor     text not null,                      -- gmail: 最終取得 epoch 秒 / discord: last message id
  updated_at timestamptz not null default now()
);

-- 毎分 Cron の多重実行防止（前回が 60 秒を超えたときに 2 本走らないように）
create table if not exists run_locks (
  name         text primary key,
  locked_until timestamptz not null,
  holder       text
);

-- 失敗した処理の退避先。次回ティックで再処理
create table if not exists dead_letter (
  id            bigserial primary key,
  stage         text not null check (stage in ('ingest','classify','notify_slack','notify_urgent')),
  inquiry_id    uuid references inquiries(id),
  payload       jsonb,
  error         text not null,
  attempts      int not null default 1,
  next_retry_at timestamptz not null,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz                      -- 成功したら埋める。削除せず履歴として残す
);
create index if not exists dead_letter_due_idx on dead_letter (next_retry_at) where resolved_at is null;

-- サーキットブレーカーの状態。Workers はステートレスなので DB に置く
create table if not exists circuit_breakers (
  service              text primary key,
  consecutive_failures int not null default 0,
  state                text not null default 'closed' check (state in ('closed','open','half_open')),
  opened_until         timestamptz,
  updated_at           timestamptz not null default now()
);

-- 監視用。1 ティック 1 行
create table if not exists run_metrics (
  id                  bigserial primary key,
  run_at              timestamptz not null default now(),
  duration_ms         int,
  fetched_gmail       int default 0,
  fetched_discord     int default 0,
  stored              int default 0,
  duplicates          int default 0,
  classified_keyword  int default 0,
  classified_llm      int default 0,
  classified_fallback int default 0,
  openai_calls        int default 0,
  notified_slack      int default 0,
  notified_urgent     int default 0,
  failed              int default 0,
  errors              jsonb
);

-- 日次カウンタ（OpenAI の 1 日上限など）
create table if not exists daily_counters (
  day   date not null,
  key   text not null,
  value int not null default 0,
  primary key (day, key)
);

-- 運用アラートの送信抑制（同じ警告を毎分連打しない）
create table if not exists ops_alerts (
  key          text primary key,
  last_sent_at timestamptz not null
);

-- 日次カウンタを 1 回の呼び出しで加算して返す（PostgREST から rpc で呼ぶ）
create or replace function increment_daily_counter(p_key text)
returns int language sql as $$
  insert into daily_counters (day, key, value) values (current_date, p_key, 1)
  on conflict (day, key) do update set value = daily_counters.value + 1
  returning value;
$$;

-- ロック取得。期限切れか未存在なら取れる（true）。取れなければ false
create or replace function acquire_run_lock(p_name text, p_holder text, p_ttl_sec int)
returns boolean language plpgsql as $$
begin
  insert into run_locks (name, locked_until, holder)
  values (p_name, now() + make_interval(secs => p_ttl_sec), p_holder)
  on conflict (name) do update
    set locked_until = excluded.locked_until, holder = excluded.holder
    where run_locks.locked_until < now();
  return exists (select 1 from run_locks where name = p_name and holder = p_holder);
end;
$$;

-- Worker は service_role キーで接続するため RLS を有効にしても影響なし。
-- 万一 anon キーが漏れても何も読めない状態にしておく
alter table inquiries        enable row level security;
alter table source_cursors   enable row level security;
alter table run_locks        enable row level security;
alter table dead_letter      enable row level security;
alter table circuit_breakers enable row level security;
alter table run_metrics      enable row level security;
alter table daily_counters   enable row level security;
alter table ops_alerts       enable row level security;
