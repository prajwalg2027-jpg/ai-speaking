-- Diagnostics: detailed logs from the team's own phones (server/diag.js, docs/DIAGNOSTICS.md). The app sends its
-- events in batches; the server adds its own lines (requests, each turn's trace) for requests that carry the same
-- diagnostics code. Kept 14 days.
create table diag_batches (
  id           bigint generated always as identity primary key,
  diag_id      text not null,                          -- the phone's diagnostics code (32 hex): reading needs it
  user_id      uuid references users (id) on delete cascade,
  source       text not null default 'app',            -- app | server
  received_at  timestamptz not null default now(),
  device       jsonb,                                  -- model, Android version, app version, run (app only)
  events       jsonb not null                          -- [{ t, seq, cat, name, sid?, data? }]
);
create index diag_batches_id_idx on diag_batches (diag_id, received_at);
create index diag_batches_received_idx on diag_batches (received_at);
