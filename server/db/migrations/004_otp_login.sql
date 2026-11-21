-- Phone OTP login through MSG91 (server/login.js) and the server's own login sessions (server/sessions.js).
-- users.firebase_uid is the login id: a Firebase uid for people who signed in with Firebase, "phone:+91…" for
-- people who signed in with an OTP. Either way a phone number is one customer.

-- Each OTP sent. provider_ref is MSG91's request id (null for the team's test number, which sends nothing).
create table otp_requests (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null,
  provider_ref  text,
  ip            text,
  attempts      smallint not null default 0,      -- codes tried
  resends       smallint not null default 0,
  last_sent_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  verified_at   timestamptz
);
create index otp_requests_phone_idx on otp_requests (phone, created_at);
create index otp_requests_created_idx on otp_requests (created_at);

-- A signed-in device. The token the app holds names its session, so signing out (or deleting the account)
-- ends it at once.
create table sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users (id) on delete cascade,
  client             text,                          -- android / web / admin
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  last_refreshed_at  timestamptz,
  revoked_at         timestamptz
);
create index sessions_user_idx on sessions (user_id);
