-- Razorpay keeps test-mode and live-mode data apart: a plan or subscription made with test keys doesn't exist in
-- live mode. So every row says which it was made in, and the server only uses rows from the mode its key is in
-- (rzp_test_… or rzp_live_…). Testing with test keys first, then switching to live, then needs no clean-up.
alter table payment_plans add column live boolean not null default true;
alter table subscriptions add column live boolean not null default true;
alter table payments      add column live boolean not null default true;
