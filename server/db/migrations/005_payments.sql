-- Paid access to the learning module: a monthly subscription (Razorpay now; Google Play billing later, so the
-- provider is a column). Payments are kept for the accounts and tax records even after a customer is erased
-- (the link to the person is removed).

-- One Razorpay plan per price (plans can't change price; a new price gets a new plan).
create table payment_plans (
  id            bigint generated always as identity primary key,
  provider      text not null default 'razorpay',
  price_inr     integer not null check (price_inr > 0),
  period        text not null default 'monthly',
  provider_plan_id text not null unique,
  created_at    timestamptz not null default now()
);

create table subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references users (id) on delete cascade,
  provider                  text not null check (provider in ('razorpay', 'play')),
  provider_subscription_id  text not null unique,
  provider_plan_id          text,
  price_inr                 integer not null,
  status                    text not null,              -- the provider's: created, authenticated, active, pending, halted, cancelled, completed, expired, paused
  current_start             timestamptz,
  current_end               timestamptz,               -- paid until
  cancel_requested_at       timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index subscriptions_user_idx on subscriptions (user_id, created_at desc);

create table payments (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references users (id) on delete set null,
  subscription_id       uuid references subscriptions (id) on delete set null,
  provider              text not null,
  provider_payment_id   text not null unique,
  amount_paise          integer,
  status                text,                            -- captured, authorized, failed, …
  created_at            timestamptz not null default now()
);
create index payments_created_idx on payments (created_at);

-- Every webhook received, once (Razorpay can send an event more than once: x-razorpay-event-id).
create table payment_events (
  event_id      text primary key,
  provider      text not null,
  event         text not null,
  subject_id    text,                                    -- the subscription it was about
  received_at   timestamptz not null default now()
);
