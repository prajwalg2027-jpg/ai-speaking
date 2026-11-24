# Payments (Razorpay and Google Play subscriptions)

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

## Google Play billing (Play Store builds)

Google requires Google Play Billing for digital content such as this subscription on Play Store builds. In India,
Google also allows **user choice billing**: Play shows its own screen with **Google Play** *and* **Razorpay**, and the
learner picks. That's what the app does:

```
app ("Subscribe")                       Adam server (server/payments.js, server/play.js)       Google Play
  │ GET /api/pay/status ──────────────▶│ … play: { productId, accountId }  (when set up)          │
  │ Play's screen (product, accountId = the learner's id) ──────────────────────────────────────▶│
  │                                                                                               │
  │ picked Google Play: purchaseToken ◀──────────────────────────────────────────────────────────│
  │ POST /api/pay/play/verify ────────▶│ purchase fetched from Google: our product? this learner? ▶│ subscriptionsv2.get
  │                                    │ acknowledged (else Google refunds it after 3 days) ──────▶│ :acknowledge
  │◀── {active: true, paidUntil} ──────│                                                           │
  │                                    │◀── real-time notifications (Pub/Sub push): renewals, ────│
  │                                    │    holds, cancellations; state fetched from Google again  │
  │                                                                                               │
  │ picked Razorpay: externalTransactionToken ◀──────────────────────────────────────────────────│
  │ POST /api/pay/razorpay/subscription {playExternalToken} → Razorpay Checkout → verify (as above)│
  │                                    │ each Razorpay payment reported to Google within 24 h ────▶│ externalTransactions
```

- **The server still decides.** A Play purchase counts only after Google confirms it is for our product and was
  bought for this learner (Play keeps the learner's id on the purchase; it's a random id, not personal data).
  Notifications are only a hint: the state is always fetched from Google. They need the secret in the push address.
- **Same access rules.** Google's states map onto the ones above: active; grace period (renewal being retried) keeps
  access; on hold ends it; cancelled keeps access to the end of the paid month. Each Play order is a payment row.
- **Bought but the app closed first:** the notification links the purchase to the learner by that id, and the app
  also sends Play's purchases the next time the paywall opens.
- **Cancelling** in Account works for both (the server asks Google to stop renewing). Deleting an account cancels.
- **Razorpay through Play's screen:** the first payment is reported with Play's token, later monthly ones point at
  the first. Amounts are sent as ₹ before tax and tax. GST is 0% by default (not GST-registered, under the ₹20 lakh
  threshold); once registered, set it to 18 in the admin console › Settings › Payments › "GST in the price" (check
  with your accountant). Failed reports are tried again with the subscription's next payment or webhook.
- **Test builds:** Play can't sell to the `.dev` test app (it isn't on Play), so it goes straight to Razorpay, as before.

### Setting it up

1. Play Console › your app › Monetize with Play › Products › Subscriptions: create **`learning_monthly`** with a
   monthly auto-renewing base plan at ₹299, and activate it.
2. Monetize with Play › Monetization setup › Alternative billing: enrol in **user choice billing (India)** and
   accept its terms. It asks for a PCI DSS attestation for the alternative payment (Razorpay is PCI DSS certified;
   we never handle card data). Check Google's current policy first: the rules are under legal challenge in India
   (as of November 2026).
3. In Cloud Shell, with the latest code deployed:

   ```bash
   PROJECT=cool-arch-515210-b0 PLAY_PRODUCT_ID=learning_monthly ./deploy/play-setup.sh
   ```

   It turns on the Play API, makes the notifications topic and pushes it to the server, and gives the server the
   package and product. It ends with two Play Console steps: invite the server's account
   (`adam-runtime@…`, "View financial data" and "Manage orders and subscriptions"), and set the topic under
   Real-time developer notifications.
4. Try it with a closed test track build and a licence tester (Play Console › Settings › License testing):
   "Subscribe" shows Play's choice screen; both ways should end with "You're in".

Until steps 1 to 3 are done, the server doesn't offer Play and the app uses Razorpay only, so keep Play Store
releases waiting for them.

## Where things are

`server/razorpay.js` (Razorpay's API and signatures), `server/play.js` (Google Play's API), `server/payments.js`
(access, routes, webhooks, Play notifications), `server/db/migrations/005_payments.sql`, `006_payment_mode.sql` and
`008_play_billing.sql`, `test/payments.test.js` (a fake Razorpay), `test/play-billing.test.js` (a fake Google Play);
app: `android/app/src/main/java/com/sakhi/app/pay/` (paywall sheet, view model, Checkout, `PlayBilling.kt`),
`MainActivity.kt` (Checkout's result, the account dialog's subscription line and cancel).
