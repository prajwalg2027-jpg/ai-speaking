-- The admin console's team: people (by phone number, the way they sign in), roles with permissions, and a record
-- of every change to either. Numbers in ADMIN_PHONES (server settings) are always owners, so nobody can be locked
-- out from the console itself.

create table admin_roles (
  id            text primary key,                      -- a slug: owner, admin, analyst, support, or made from the name
  name          text not null,
  description   text,
  permissions   text[] not null default '{}',          -- '*' = everything (owner only)
  builtin       boolean not null default false,        -- can't be deleted
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table admin_members (
  phone         text primary key,                      -- +91…
  name          text,
  role_id       text not null references admin_roles (id),
  active        boolean not null default true,         -- paused members can't open the console
  added_by      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

create table admin_audit (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  actor         text not null,                         -- who did it (phone)
  action        text not null,                         -- member.added, member.changed, member.removed, role.created, …
  target        text,
  detail        jsonb
);
create index admin_audit_at_idx on admin_audit (at desc);

insert into admin_roles (id, name, description, permissions, builtin) values
  ('owner',   'Owner',   'Everything, including the team.', '{*}', true),
  ('admin',   'Admin',   'Everything except managing the team.',
     '{dashboard.view,conversations.view,lessons.view,settings.view,settings.edit,playground.use,evals.view,evals.run}', true),
  ('analyst', 'Analyst', 'Reads the numbers, lessons, settings and evaluations; changes nothing.',
     '{dashboard.view,lessons.view,settings.view,evals.view}', true),
  ('support', 'Support', 'Helps learners: reads their conversations and lessons.',
     '{dashboard.view,conversations.view,lessons.view}', true);
