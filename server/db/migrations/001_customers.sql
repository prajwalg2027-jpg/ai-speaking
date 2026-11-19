-- Customers, their properties, consents, placement tests, answers, recordings, levels and the event log.
-- Times are timestamptz (stored in UTC). Personal data lives in users, attribute_history, assessment_answers
-- (transcripts) and recordings; erase_user() in server/store.js removes it on a customer's request.

create table users (
  id                uuid primary key default gen_random_uuid(),
  firebase_uid      text not null unique,          -- from Firebase phone login
  phone             text unique,                    -- E.164, e.g. +919876543210
  name              text,
  language          text,                           -- the language they asked Sakhi to use (null = English)
  attributes        jsonb not null default '{}',   -- current value of every property (keys in attribute_definitions)
  age_confirmed_at  timestamptz,                    -- confirmed 18 or older
  status            text not null default 'active' check (status in ('active', 'blocked')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_seen_at      timestamptz
);
create index users_attributes_idx on users using gin (attributes jsonb_path_ops);

-- The allowed property names. Adding a property = adding a row (no table change).
create table attribute_definitions (
  key          text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  type         text not null check (type in ('string', 'number', 'boolean', 'date', 'list')),
  description  text not null,
  personal     boolean not null default true,       -- personal data: erased on request
  created_at   timestamptz not null default now()
);
insert into attribute_definitions (key, type, description, personal) values
  ('name',               'string', 'First name, as the learner said it', true),
  ('city',               'string', 'City they live in', true),
  ('occupation',         'string', 'What they do for work or study', true),
  ('goal',               'string', 'Why they want English (job, interview, travel, studies, confidence…)', false),
  ('conversation_facts', 'list',   'Short facts about their life that Sakhi heard in conversation', true),
  ('current_level',      'number', 'Latest English level (1–4)', false);

-- Every change to a property: what it was, what it became, where it came from.
create table attribute_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references users (id) on delete cascade,
  key         text not null references attribute_definitions (key),
  old_value   jsonb,
  new_value   jsonb,
  source      text not null check (source in ('signup', 'conversation', 'app', 'assessment', 'support')),
  created_at  timestamptz not null default now()
);
create index attribute_history_user_idx on attribute_history (user_id, created_at);

-- What the customer agreed to, with the wording version. Kept (without the person) after an erasure, as proof.
create table consents (
  id          bigint generated always as identity primary key,
  user_id     uuid references users (id) on delete set null,
  purpose     text not null check (purpose in ('terms', 'privacy', 'recordings', 'age_18_plus')),
  version     text not null,
  granted     boolean not null,
  created_at  timestamptz not null default now()
);
create index consents_user_idx on consents (user_id, purpose, created_at);

-- One placement test.
create table assessments (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references users (id) on delete set null,
  session_id       text not null unique,            -- the server's conversation id
  status           text not null default 'in_progress' check (status in ('in_progress', 'finished', 'abandoned')),
  level            smallint check (level between 1 and 4),
  level_name       text,
  overall          numeric(4, 2),
  dims             jsonb,                           -- skill scores
  reasons          jsonb,
  scoring_config   jsonb,                           -- the cut-offs used (shared/scoring-config.json)
  client           text,                            -- android / web
  app_version      text,
  cost_inr         numeric(10, 3),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);
create index assessments_user_idx on assessments (user_id, started_at);

-- Every answer, saved as it happens.
create table assessment_answers (
  id             uuid primary key default gen_random_uuid(),
  assessment_id  uuid not null references assessments (id) on delete cascade,
  seq            smallint not null,
  question_id    text not null,
  item_id        text,
  kind           text,
  variant_level  smallint,
  transcript     text,                              -- personal: blanked on erasure
  language       text,
  scores         jsonb,
  features       jsonb,                             -- speaking timing, words, accuracy…
  needed_hindi   boolean not null default false,
  skipped        boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (assessment_id, seq)
);

-- Voice recordings (files in Cloud Storage). Kept with no expiry; removed only on an erasure request.
create table recordings (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id) on delete cascade,
  assessment_id  uuid references assessments (id) on delete set null,
  answer_id      uuid references assessment_answers (id) on delete set null,
  storage_path   text not null unique,
  codec          text not null,
  duration_sec   numeric(8, 2),
  bytes          integer,
  created_at     timestamptz not null default now()
);
create index recordings_user_idx on recordings (user_id);

-- Each level a customer reaches, and what caused it.
create table level_history (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references users (id) on delete cascade,
  level          smallint not null check (level between 1 and 4),
  source         text not null check (source in ('placement', 'lesson', 'support')),
  assessment_id  uuid references assessments (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index level_history_user_idx on level_history (user_id, created_at);

-- The transaction log: one row per thing a customer (or the server for them) did. Never edited.
create table events (
  id               bigint generated always as identity primary key,
  user_id          uuid references users (id) on delete set null,
  name             text not null check (name ~ '^[a-z][a-z0-9_.]{1,60}$'),
  source           text not null check (source in ('server', 'app')),
  properties       jsonb not null default '{}',
  session_id       text,
  client_event_id  text,                            -- from the app, so a retried send isn't counted twice
  occurred_at      timestamptz not null default now(),
  received_at      timestamptz not null default now()
);
create unique index events_client_id_idx on events (user_id, client_event_id) where client_event_id is not null;
create index events_user_idx on events (user_id, occurred_at);
create index events_name_idx on events (name, occurred_at);

-- Erasure requests and when they were carried out (no personal data: proof that the law was followed).
create table erasures (
  id            bigint generated always as identity primary key,
  user_ref      text not null,                       -- a one-way hash of the old user id
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  recordings    integer not null default 0
);
