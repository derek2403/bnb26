-- SplitStock services schema. Idempotent (CREATE ... IF NOT EXISTS); applied by `cli db migrate` and on boot.

create table if not exists kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Hash-chained service log. entry_hash = keccak256(prev_hash ‖ utf8(canonicalJSON(entry))), entry = the columns
-- seq..data (see src/lib/hashlog.ts for the exact field list). Merkle roots of [from_seq, to_seq] go to LogAnchor.
create table if not exists log_entries (
  seq          bigint primary key,
  ts           timestamptz not null,
  service      text not null,
  kind         text not null,            -- cmc | mcp | tx | snapshot | agent | mirror | note
  endpoint     text,
  params       jsonb,
  http         integer,
  cmc_ts       bigint,                   -- CMC status.timestamp, ms
  credit_count integer,
  elapsed_ms   integer,
  body_hash    text,                     -- keccak256(raw body bytes)
  tx_hash      text,
  chain_id     integer,
  data         jsonb,
  prev_hash    text not null,
  entry_hash   text not null unique
);
create index if not exists log_entries_kind_idx on log_entries (kind, seq desc);
create index if not exists log_entries_body_idx on log_entries (body_hash);
create index if not exists log_entries_tx_idx on log_entries (tx_hash);

-- Raw bodies addressed by keccak256 of their exact bytes: CMC responses, MCP results, agent inputs/outputs.
create table if not exists raw_bodies (
  hash         text primary key,
  kind         text not null,            -- cmc | mcp | agent_input | agent_output | agent_uri
  content_type text not null default 'application/json',
  body         bytea not null,
  created_at   timestamptz not null default now()
);

-- Latest parsed value per CMC endpoint+key (what risk-engine and the API read).
create table if not exists cmc_latest (
  kind       text not null,              -- dex_price | kline | quotes | rwa | pools | fear_greed | key_info | info | quotes_hist
  key        text not null,              -- asset symbol or '*'
  parsed     jsonb not null,
  body_hash  text not null,
  log_seq    bigint,
  cmc_ts     bigint,
  fetched_at timestamptz not null default now(),
  primary key (kind, key)
);

create table if not exists key_info (
  id                   bigserial primary key,
  ts                   timestamptz not null default now(),
  body_hash            text not null,
  credits_used_day     integer,
  credits_used_month   integer,
  credits_left_month   integer,
  credit_limit_monthly integer,
  rate_limit_minute    integer,
  summed_credit_count  integer,          -- our own sum of status.credit_count for the same UTC day
  raw                  jsonb
);

create table if not exists candles (
  asset    text not null,
  interval text not null,
  ts       bigint not null,               -- seconds
  o double precision, h double precision, l double precision, c double precision, v double precision,
  primary key (asset, interval, ts)
);

create table if not exists risk_snapshots (
  id             bigserial primary key,
  chain_id       integer not null,
  asset          text not null,
  asset_id       text not null,
  snapshot_id    bigint not null,
  ref_price      numeric not null,        -- WAD
  vol_bps        bigint not null,
  liq_usd        numeric not null,        -- WAD
  premium_bps    bigint not null,
  cmc_ts         bigint not null,         -- seconds
  response_hash  text not null,
  components     jsonb not null,          -- body hashes + parsed inputs the snapshot was built from
  tx_hash        text,
  status         text not null,           -- posted | failed | skipped | dry
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists risk_snapshots_asset_idx on risk_snapshots (asset, chain_id, id desc);
create index if not exists risk_snapshots_tx_idx on risk_snapshots (tx_hash);

create table if not exists mirror_pushes (
  id             bigserial primary key,
  asset          text not null,
  mirror         text not null,
  src_feed       text not null,
  src_round_id   numeric not null,
  answer         numeric not null,
  src_updated_at bigint not null,
  src_block      bigint,
  src_tx_hash    text,
  tx_hash        text,
  status         text not null,
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists mirror_pushes_asset_idx on mirror_pushes (asset, id desc);

create table if not exists agent_runs (
  id             bigserial primary key,
  asset          text not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  model          text,
  served_model   text,
  inputs_hash    text,
  output_hash    text,
  model_id_hash  text,
  raw_output     jsonb,
  validated      jsonb,                   -- clamped + step-capped params, classification, notes
  classification text,                    -- tighten | loosen | hold
  status         text not null,           -- proposed | held | refused | invalid | failed | dry
  tx_hash        text,
  proposal_id    numeric,
  applied        boolean,
  usage          jsonb,
  error          text
);
create index if not exists agent_runs_asset_idx on agent_runs (asset, id desc);

create table if not exists events (
  chain_id     integer not null,
  block_number bigint not null,
  block_time   bigint,
  tx_hash      text not null,
  log_index    integer not null,
  address      text not null,
  contract     text not null,             -- role label, e.g. riskOracle, pool:nvda-flap, mirror:NVDA
  kind         text not null,             -- mirror | risk | agent | pool | zone | launch | openfour | anchor | backstop | factory | stability | cmcAnchor | other
  name         text,                      -- decoded event name, null if undecodable
  args         jsonb,
  topic0       text,
  primary key (chain_id, tx_hash, log_index)
);
create index if not exists events_kind_idx on events (kind, chain_id, block_number desc);
create index if not exists events_name_idx on events (name, block_number desc);

create table if not exists indexer_cursors (
  chain_id   integer not null,
  name       text not null,
  last_block bigint not null,
  updated_at timestamptz not null default now(),
  primary key (chain_id, name)
);

create table if not exists anchors (
  id         bigserial primary key,
  chain_id   integer not null,
  idx        numeric,
  root       text not null,
  from_seq   bigint not null,
  to_seq     bigint not null,
  tx_hash    text,
  status     text not null,
  created_at timestamptz not null default now()
);
create index if not exists anchors_range_idx on anchors (chain_id, from_seq, to_seq);

create table if not exists job_state (
  job         text primary key,
  last_run_at timestamptz,
  last_ok_at  timestamptz,
  last_err_at timestamptz,
  last_err    text,
  last_detail jsonb,
  runs        bigint not null default 0,
  fails       bigint not null default 0
);
