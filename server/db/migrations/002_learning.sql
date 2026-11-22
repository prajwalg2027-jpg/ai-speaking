-- The learning module: free conversation practice and lessons with personalised corrections, learner memory and
-- evidence-based progress; plus admin settings (changeable without a deploy), their audit log, and evaluation runs.
-- Raw evidence (learning_events) is kept apart from what's derived from it (learner_skills, the level estimate),
-- so progress calculations can be improved later and recomputed from the evidence.

-- One row per learner: their learning preferences and the derived level estimate.
create table learner_profiles (
  user_id              uuid primary key references users (id) on delete cascade,
  correction_intensity text not null default 'balanced' check (correction_intensity in ('gentle', 'balanced', 'strict')),
  goals                jsonb not null default '[]',      -- e.g. ["job interview", "speak with customers"]
  support_language     text,                              -- explanations in this language when needed (e.g. hi-IN)
  estimated_level      smallint check (estimated_level between 1 and 4),
  level_confidence     numeric(3, 2),                     -- 0..1, from the amount of evidence
  level_updated_at     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Lessons and their exercises (content is seeded from shared/lessons.json; versioned).
create table lessons (
  id          text primary key,                           -- slug, e.g. past-simple-1
  category    text not null check (category in ('grammar', 'vocabulary', 'sentence', 'reading', 'writing', 'pronunciation')),
  title       text not null,
  level       smallint not null check (level between 1 and 4),
  objective   text not null,
  content     jsonb not null,                             -- explanation, examples, concept keys
  version     integer not null default 1,
  active      boolean not null default true,
  position    integer not null default 0,
  updated_at  timestamptz not null default now()
);

create table exercises (
  id               text primary key,                      -- e.g. past-simple-1/3
  lesson_id        text not null references lessons (id) on delete cascade,
  position         smallint not null,
  kind             text not null check (kind in ('fill_blank', 'transform', 'choose', 'free_response')),
  prompt           text not null,
  accepted_answers jsonb not null default '[]',           -- exact answers (normalised); empty = judged by the tutor
  options          jsonb,                                  -- for 'choose'
  concept_key      text,
  unique (lesson_id, position)
);

-- One learner working through one lesson.
create table lesson_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users (id) on delete cascade,
  lesson_id         text not null references lessons (id),
  lesson_version    integer not null,
  status            text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  current_position  smallint not null default 1,
  correct_count     smallint not null default 0,
  attempt_count     smallint not null default 0,
  started_at        timestamptz not null default now(),
  completed_at      timestamptz
);
create index lesson_sessions_user_idx on lesson_sessions (user_id, started_at);

-- A conversation thread: free practice, or the talk around a lesson.
create table conversations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references users (id) on delete cascade,
  mode               text not null check (mode in ('conversation', 'lesson')),
  lesson_session_id  uuid references lesson_sessions (id) on delete set null,
  title              text,
  started_at         timestamptz not null default now(),
  last_message_at    timestamptz not null default now()
);
create index conversations_user_idx on conversations (user_id, last_message_at desc);

-- Every message. client_message_id makes sending safe to retry: the same id returns the stored reply.
create table messages (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversations (id) on delete cascade,
  role               text not null check (role in ('learner', 'tutor')),
  content            text not null,
  channel            text not null default 'text' check (channel in ('text', 'voice')),
  client_message_id  text,
  reply_to           uuid references messages (id) on delete set null,
  metadata           jsonb not null default '{}',          -- tutor: provider, model, prompt version, strategy, latency, tokens; learner: speech confidence
  created_at         timestamptz not null default now()
);
create unique index messages_client_id_idx on messages (conversation_id, client_message_id) where client_message_id is not null;
create index messages_conversation_idx on messages (conversation_id, created_at);

-- Corrections the learner was shown (attached to the learner's message they correct).
create table corrections (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references messages (id) on delete cascade,
  original     text not null,
  corrected    text not null,
  category     text not null check (category in ('grammar', 'vocabulary', 'spelling', 'word_order', 'naturalness')),
  concept_key  text,
  explanation  text not null,
  severity     text not null check (severity in ('minor', 'moderate', 'important')),
  verified     boolean,                                     -- null: not checked; true: kept by the check
  created_at   timestamptz not null default now()
);
create index corrections_message_idx on corrections (message_id);

-- Raw learning evidence. Never edited; progress is derived from it.
create table learning_events (
  id                   bigint generated always as identity primary key,
  user_id              uuid references users (id) on delete cascade,
  kind                 text not null check (kind in ('mistake', 'correct_use', 'exercise_attempt', 'lesson_completed')),
  concept_key          text,
  category             text,
  detail               jsonb not null default '{}',
  message_id           uuid references messages (id) on delete set null,
  exercise_attempt_id  uuid,
  occurred_at          timestamptz not null default now()
);
create index learning_events_user_idx on learning_events (user_id, occurred_at);
create index learning_events_concept_idx on learning_events (user_id, concept_key);

create table exercise_attempts (
  id                 uuid primary key default gen_random_uuid(),
  lesson_session_id  uuid not null references lesson_sessions (id) on delete cascade,
  exercise_id        text not null references exercises (id),
  user_id            uuid not null references users (id) on delete cascade,
  answer             text not null,
  verdict            text not null check (verdict in ('correct', 'partly', 'incorrect')),
  feedback           text,
  client_attempt_id  text,
  created_at         timestamptz not null default now()
);
create unique index exercise_attempts_client_idx on exercise_attempts (lesson_session_id, client_attempt_id) where client_attempt_id is not null;

-- Derived from learning_events (recomputable): what the learner has mastered and what needs practice.
create table learner_skills (
  user_id        uuid not null references users (id) on delete cascade,
  concept_key    text not null,
  category       text,
  mistakes       integer not null default 0,
  correct_uses   integer not null default 0,
  mastery        numeric(4, 3) not null default 0,         -- 0..1
  status         text not null default 'learning' check (status in ('learning', 'practising', 'mastered')),
  last_seen_at   timestamptz not null default now(),
  primary key (user_id, concept_key)
);

-- Admin settings, changeable from the admin console without a deploy, and every change.
create table app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
create table settings_audit (
  id          bigint generated always as identity primary key,
  key         text not null,
  old_value   jsonb,
  new_value   jsonb,
  changed_by  text,
  changed_at  timestamptz not null default now()
);

-- Evaluation runs (correction quality, strategies side by side).
create table eval_runs (
  id               uuid primary key default gen_random_uuid(),
  status           text not null default 'running' check (status in ('running', 'done', 'failed')),
  dataset_version  text not null,
  prompt_version   text not null,
  config           jsonb not null,
  summary          jsonb,
  results          jsonb,
  started_by       text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);
