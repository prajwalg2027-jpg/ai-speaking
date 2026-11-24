-- Sakhi's memory of each learner (server/learning/memory.js, docs/LEARNING.md "Learner memory"): short notes about
-- what the learner has told her (facts, goals, coming events, interests, how they like to learn), written by a
-- background "memory note" every few messages, and a short summary of each practice conversation. Text only.
-- Everything goes with the account (on delete cascade); the learner can see, delete or switch it off.

create table learner_memories (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references users (id) on delete cascade,
  kind             text not null check (kind in ('fact', 'goal', 'event', 'interest', 'preference')),
  content          text not null,                     -- short, in English, about the learner ("Works in a call centre in Pune")
  due_on           date,                              -- events: when it happens; Sakhi asks how it went afterwards
  importance       smallint not null default 2 check (importance between 1 and 3),
  source           text not null default 'conversation' check (source in ('placement', 'conversation')),
  conversation_id  uuid references conversations (id) on delete set null,
  status           text not null default 'active' check (status in ('active', 'done', 'faded')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index learner_memories_user_idx on learner_memories (user_id, status, importance desc, updated_at desc);

-- What each practice conversation was about, and how far the memory note has read it.
alter table conversations
  add column summary          text,
  add column topics           jsonb not null default '[]',
  add column memory_through   timestamptz;              -- the last message the memory note has read

-- The learner's own switch.
alter table learner_profiles add column memory_enabled boolean not null default true;

-- Facts from placement tests so far (users.attributes.conversation_facts) start the memory, so nobody starts empty.
insert into learner_memories (user_id, kind, content, source, importance)
select u.id, 'fact', left(f.value, 300), 'placement', 2
from users u
cross join lateral jsonb_array_elements_text(
  case when jsonb_typeof(u.attributes -> 'conversation_facts') = 'array' then u.attributes -> 'conversation_facts' else '[]'::jsonb end
) as f(value)
where length(trim(f.value)) > 0;
