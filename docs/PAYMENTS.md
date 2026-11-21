# Payments (Razorpay subscriptions)

The placement test and its score stay free. **"Start learning"** on the result screen opens the paywall: the
learning module (practice with Sakhi, lessons) is **₹299 a month**, renewing until cancelled. The price is a
placeholder and an admin setting (Settings › Payments). The paywall is off until an admin turns it on.

```
app (after the score)               Adam server (server/payments.js)                 Razorpay
  │ "Start learning"                  │                                                  │
  │ GET /api/pay/status ─────────────▶│ subscribed? (its own records)                    │
  │◀── {required, active, priceInr} ──│                                                  │
  │ "Subscribe · ₹299 a month"        │                                                  │
  │ POST /api/pay/razorpay/subscription▶ plan for the price (made once) ──────────────▶│ POST /v1/plans
  │                                   │ a subscription for this learner ─────────────▶│ POST /v1/subscriptions
  │◀── {subscriptionId, keyId} ───────│                                                  │
  │ Razorpay Checkout (UPI, cards, net banking): the first payment and the mandate ────▶│
  │◀── paymentId + signature ───────────────────────────────────────────────────────────│
  │ POST /api/pay/razorpay/verify ───▶│ signature = HMAC(paymentId|our subscriptionId)   │
  │                                   │ state fetched from Razorpay ──────────────────▶│ GET /v1/subscriptions/:id
  │◀── {active: true, paidUntil} ─────│                                                  │
  │                                   │◀── webhooks: subscription.charged/halted/… ───────│ (each month)
```

## Rules the server keeps

- **The server decides who has access**, never the app. A payment counts only with Razorpay's signature, checked
  against the subscription id the server created for that learner. Subscription state is always fetched from
  Razorpay, so webhooks arriving out of order can't mislead it.
- **Access:** an active subscription; or one being retried after a failed renewal ("pending": access continues);
  or one that was cancelled or stopped but whose paid month isn't over.
- **Practice needs access:** starting a conversation, sending a message, starting a lesson, answering an exercise
  and voice transcription answer HTTP 402 `payment_required` without it. Reading past conversations and progress
  stays open.
- **Webhooks** (`POST /api/razorpay/webhook`) must carry Razorpay's signature (`X-Razorpay-Signature`, made with
  the webhook secret) and are handled once each (`x-razorpay-event-id`).
- **Cancelling** (Account in the app) stops renewal; access lasts to the end of the paid month.
- **Deleting an account** cancels its subscriptions immediately (no more charges). Payment records stay for the
  accounts and tax records, without the link to the person.
- **A new price** makes a new Razorpay plan (plans can't change price). People already subscribed keep their price.
- **Test and live mode are kept apart.** Razorpay's test and live data are separate, so every plan, subscription
  and payment is marked with the mode it was made in (from the key: `rzp_test_…` or `rzp_live_…`), and the server
  only uses rows from its current mode. The admin dashboard shows the current mode's numbers and says
  "Razorpay TEST mode" while testing.

## Setting it up (Cloud Shell, about 15 minutes)

1. Razorpay Dashboard, switched to **Test mode**: Account & Settings › API Keys › Generate Key. Keep the key
   secret to yourself: it's only ever typed into the script's hidden prompt.
2. In Cloud Shell, with the latest code deployed:

   ```bash
   PROJECT=cool-arch-515210-b0 RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXX ./deploy/razorpay-setup.sh
   ```

   It checks the key with Razorpay, stores the secret in Secret Manager, makes a webhook secret, gives the
   server the key id, and checks that the server accepts signed webhooks. At the end it prints the webhook URL
   and secret.
3. Razorpay Dashboard (still Test mode): Account & Settings › Webhooks › Add New Webhook, with that URL and
   secret, and all the `subscription.*` events.
4. Admin console › Settings › Payments: turn on "Learning needs a subscription".
5. Try it in the app: take the test, tap "Start learning", subscribe, pay with UPI id **`success@razorpay`**, or a
   recurring-capable test card from Razorpay's test-card docs (test mode; nothing is charged). The sheet should say "You're in". Check Account (subscription line, cancel) and the
   admin dashboard (1 subscriber, TEST mode).
6. Going live: Razorpay Dashboard in **Live mode**: generate live keys, add the same webhook (same URL and
   secret), then:

   ```bash
   PROJECT=cool-arch-515210-b0 RAZORPAY_KEY_ID=rzp_live_XXXXXXXXXXXXXX NEW_KEY=1 ./deploy/razorpay-setup.sh
   ```

   Test-mode subscriptions stop counting automatically. To go back to testing, run it again with the test key and
   `NEW_KEY=1`.

Razorpay's standard fee is about 2% per payment plus GST on the fee (check your plan in the Dashboard). Under RBI's
e-mandate rules, renewals up to ₹15,000 go through without the customer approving each one; Razorpay sends the
required pre-debit notice.

## Google Play: needed before the Play Store release

Razorpay in the app is fine for the sideloaded test builds. **For the Play Store**, Google requires Google Play
Billing for digital content such as this subscription. In India, Google also allows **user choice billing**: show
Play Billing *and* Razorpay side by side, and the person picks. That's the plan:

1. Play Console: enrol in user choice billing (India) and accept its terms. It needs a PCI DSS attestation for
   the alternative payment (Razorpay is PCI DSS certified; we never handle card data).
2. Add Google Play Billing (`com.android.billingclient`) with a ₹299 monthly subscription product in Play
   Console. The server records Play purchases with `provider = 'play'` (the column already exists) after checking
   them with the Google Play Developer API.
3. The paywall's "Subscribe" opens Play's user choice screen; choosing Razorpay goes through this flow.
4. Each Razorpay purchase made in the Play build is reported to Google within 24 hours (the alternative billing
   reporting API). Google's service fee is 4 percentage points lower on those.

Until that's built, keep Razorpay builds off the Play Store. The rules here are under legal challenge in India
(as of November 2026), so check Google's current policy before starting.

## Where things are

`server/razorpay.js` (Razorpay's API and signatures), `server/payments.js` (access, routes, webhooks),
`server/db/migrations/005_payments.sql` and `006_payment_mode.sql`, `test/payments.test.js` (a fake Razorpay);
app: `android/app/src/main/java/com/sakhi/app/pay/` (paywall sheet, view model, Checkout), `MainActivity.kt`
(Checkout's result, the account dialog's subscription line and cancel).
