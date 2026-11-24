-- Google Play billing beside Razorpay (docs/PAYMENTS.md). Play subscriptions use the same tables (provider = 'play';
-- the purchase token is provider_subscription_id; each Play order is a payment).
-- User choice billing: when a learner picks Razorpay on Play's choice screen, Play gives a token, and every Razorpay
-- payment of that subscription must be reported to Google within 24 hours.
alter table subscriptions add column play_external_token text;
alter table payments add column play_reported_at timestamptz;
