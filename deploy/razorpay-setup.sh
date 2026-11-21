#!/usr/bin/env bash
# One-time setup of Razorpay subscriptions (server/payments.js): the ₹299/month learning plan after the score.
#   - checks your Razorpay key with Razorpay, then stores the key secret in Secret Manager (it asks; typed input is
#     hidden; it never goes in a file),
#   - makes a random webhook secret in Secret Manager and shows it to you once, to paste into Razorpay's webhook form,
#   - lets the server's account read both, gives the server the key id, and checks the webhook end to end.
#
#   PROJECT=cool-arch-515210-b0 RAZORPAY_KEY_ID=rzp_test_XXXXXXXXXXXXXX ./deploy/razorpay-setup.sh
#
# Start with TEST keys (rzp_test_…): pay with Razorpay's test UPI id success@razorpay, nothing is charged. When it all
# works, run it again with the LIVE key id (rzp_live_…) and NEW_KEY=1. Test and live data are kept apart by the server.
# The key id is public (it's in the app's checkout); the key secret is not: it is typed only into this script.
# Before: Razorpay Dashboard → Account & Settings → API Keys → Generate Key (in Test mode, then again in Live mode).
# Run in Cloud Shell after deploy/cloudrun.sh. Safe to run again.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
KEY_ID="${RAZORPAY_KEY_ID:?Set RAZORPAY_KEY_ID to your Razorpay key id (rzp_test_… or rzp_live_…)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
RUNTIME_SA="adam-runtime@${PROJECT}.iam.gserviceaccount.com"
step() { echo; echo "› $*"; }
gcloud config set project "$PROJECT" >/dev/null

[[ "$KEY_ID" =~ ^rzp_(test|live)_[A-Za-z0-9]{8,32}$ ]] || { echo "That doesn't look like a Razorpay key id: '$KEY_ID' (like rzp_test_AbC123…)"; exit 1; }
MODE="${BASH_REMATCH[1]}"
echo "Razorpay mode: ${MODE^^}"

put_secret() { # name, value on stdin
  if gcloud secrets describe "$1" >/dev/null 2>&1; then gcloud secrets versions add "$1" --data-file=- >/dev/null
  else gcloud secrets create "$1" --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null; fi
}
key_works() { # key id, secret → Razorpay accepts them (the secret goes to curl on stdin, not on the command line)
  printf 'user = "%s:%s"\n' "$1" "$2" | curl -sS -o /dev/null -w '%{http_code}' -K - "https://api.razorpay.com/v1/plans?count=1"
}

step "Razorpay key secret (Secret Manager: razorpay-key-secret)"
if gcloud secrets describe razorpay-key-secret >/dev/null 2>&1 && [[ "${NEW_KEY:-}" != "1" ]]; then
  CODE="$(key_works "$KEY_ID" "$(gcloud secrets versions access latest --secret=razorpay-key-secret)")"
  [[ "$CODE" == "200" ]] || { echo "  The stored secret doesn't work with $KEY_ID (Razorpay said HTTP $CODE). Switching key? Run again with NEW_KEY=1."; exit 1; }
  echo "  already stored, and it works with $KEY_ID"
else
  read -rsp "  Paste the key secret for $KEY_ID (typed input is hidden): " SECRET; echo
  [[ -n "$SECRET" ]] || { echo "  No secret entered."; exit 1; }
  CODE="$(key_works "$KEY_ID" "$SECRET")"
  [[ "$CODE" == "200" ]] || { echo "  Razorpay didn't accept that key id and secret (HTTP $CODE). Nothing was stored."; exit 1; }
  printf %s "$SECRET" | put_secret razorpay-key-secret
  unset SECRET
  echo "  Razorpay accepted it; stored"
fi

step "Webhook secret (Secret Manager: razorpay-webhook-secret)"
if gcloud secrets describe razorpay-webhook-secret >/dev/null 2>&1 && [[ "${NEW_WEBHOOK_SECRET:-}" != "1" ]]; then
  echo "  already there (to see it again: gcloud secrets versions access latest --secret=razorpay-webhook-secret)"
else
  openssl rand -hex 24 | tr -d '\n' | put_secret razorpay-webhook-secret
  echo "  made (random)"
fi
HOOK_SECRET="$(gcloud secrets versions access latest --secret=razorpay-webhook-secret)"

step "Letting the server's account read them"
for s in razorpay-key-secret razorpay-webhook-secret; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done

step "Giving the server the key (a new revision, about a minute)"
gcloud run services update "$SERVICE" --region "$REGION" --quiet \
  --update-secrets "RAZORPAY_KEY_SECRET=razorpay-key-secret:latest,RAZORPAY_WEBHOOK_SECRET=razorpay-webhook-secret:latest" \
  --update-env-vars "RAZORPAY_KEY_ID=${KEY_ID}" >/dev/null
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

step "Checking the webhook (a signed test event to ${URL}/api/razorpay/webhook)"
BODY="{\"entity\":\"event\",\"event\":\"setup.check\",\"payload\":{},\"created_at\":$(date +%s)}"
SIG="$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$HOOK_SECRET" -r | cut -d' ' -f1)"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${URL}/api/razorpay/webhook" -H 'content-type: application/json' \
  -H "x-razorpay-signature: ${SIG}" -H "x-razorpay-event-id: setup-check-$(date +%s)" --data "$BODY")"
if [[ "$CODE" == "200" ]]; then echo "  The server accepts signed webhooks."
else echo "  The server answered HTTP $CODE (expected 200). Is the latest code deployed? (deploy/README.md)"; fi

cat <<EOF

Now in the Razorpay Dashboard (in ${MODE^^} mode; switch with the toggle at the top):
  Account & Settings → Webhooks → Add New Webhook
    Webhook URL:     ${URL}/api/razorpay/webhook
    Secret:          ${HOOK_SECRET}
    Active events:   all the subscription.* events (subscription.authenticated, .activated, .charged,
                     .pending, .halted, .cancelled, .completed, .paused, .resumed, .updated)
    Alert email:     yours
  (Test mode and live mode each need their own webhook; use the same URL and secret for both.)

Then turn the paywall on: admin console → Settings → Payments → "Learning needs a subscription".
Admin console: ${URL}/admin/
EOF
unset HOOK_SECRET
