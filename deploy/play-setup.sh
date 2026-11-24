#!/usr/bin/env bash
# One-time setup of Google Play billing on the server (server/play.js, docs/PAYMENTS.md), for Play Store builds:
#   - turns on the Google Play Developer API in this project,
#   - makes a Pub/Sub topic for Play's real-time notifications (renewals, cancellations, holds), lets Google Play
#     publish to it, and pushes it to the server (with a random secret in the address, kept in Secret Manager),
#   - gives the server the app's package name and the subscription product id.
#
#   PROJECT=cool-arch-515210-b0 PLAY_PRODUCT_ID=learning_monthly ./deploy/play-setup.sh
#
# Before: in Play Console, the subscription product (PLAY_PRODUCT_ID) with a monthly auto-renewing base plan, active.
# After: the two Play Console steps this script prints at the end (inviting the server's account, and the topic).
# Run in Cloud Shell after deploy/cloudrun.sh. Safe to run again.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
PRODUCT="${PLAY_PRODUCT_ID:?Set PLAY_PRODUCT_ID to the subscription product id from Play Console (e.g. learning_monthly)}"
PACKAGE="${PLAY_PACKAGE_NAME:-in.adamspeaks.app}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
TOPIC="${TOPIC:-play-rtdn}"
RUNTIME_SA="adam-runtime@${PROJECT}.iam.gserviceaccount.com"
step() { echo; echo "› $*"; }
gcloud config set project "$PROJECT" >/dev/null

[[ "$PRODUCT" =~ ^[a-z0-9][a-z0-9._]{0,39}$ ]] || { echo "That doesn't look like a Play product id: '$PRODUCT' (lowercase letters, digits, _ and .)"; exit 1; }

step "Turning on the Google Play Developer API and Pub/Sub"
gcloud services enable androidpublisher.googleapis.com pubsub.googleapis.com >/dev/null

put_secret() { # name, value on stdin
  if gcloud secrets describe "$1" >/dev/null 2>&1; then gcloud secrets versions add "$1" --data-file=- >/dev/null
  else gcloud secrets create "$1" --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null; fi
}

step "Notification secret (Secret Manager: play-rtdn-token)"
if gcloud secrets describe play-rtdn-token >/dev/null 2>&1; then echo "  already there"
else openssl rand -hex 24 | tr -d '\n' | put_secret play-rtdn-token; echo "  made (random)"; fi
gcloud secrets add-iam-policy-binding play-rtdn-token --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
RTDN_TOKEN="$(gcloud secrets versions access latest --secret=play-rtdn-token)"

step "Giving the server the app and product (a new revision, about a minute)"
gcloud run services update "$SERVICE" --region "$REGION" --quiet \
  --update-secrets "PLAY_RTDN_TOKEN=play-rtdn-token:latest" \
  --update-env-vars "PLAY_PACKAGE_NAME=${PACKAGE},PLAY_PRODUCT_ID=${PRODUCT}" >/dev/null
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

step "Pub/Sub topic ${TOPIC}, which Google Play publishes to"
gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1 || gcloud pubsub topics create "$TOPIC" >/dev/null
gcloud pubsub topics add-iam-policy-binding "$TOPIC" --member="serviceAccount:google-play-developer-notifications@system.gserviceaccount.com" \
  --role=roles/pubsub.publisher --quiet >/dev/null
ENDPOINT="${URL}/api/play/rtdn?token=${RTDN_TOKEN}"
if gcloud pubsub subscriptions describe "${TOPIC}-push" >/dev/null 2>&1; then
  gcloud pubsub subscriptions update "${TOPIC}-push" --push-endpoint="$ENDPOINT" >/dev/null
else
  gcloud pubsub subscriptions create "${TOPIC}-push" --topic="$TOPIC" --push-endpoint="$ENDPOINT" --ack-deadline=30 \
    --min-retry-delay=10s --max-retry-delay=600s >/dev/null
fi
echo "  pushes to ${URL}/api/play/rtdn"

step "Checking the server takes notifications"
BODY="{\"message\":{\"messageId\":\"setup-check-$(date +%s)\",\"data\":\"$(printf '{"packageName":"%s","testNotification":{"version":"1.0"}}' "$PACKAGE" | base64 -w0)\"}}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$ENDPOINT" -H 'content-type: application/json' --data "$BODY")"
if [[ "$CODE" == "200" ]]; then echo "  It does."
else echo "  The server answered HTTP $CODE (expected 200). Is the latest code deployed? (deploy/README.md)"; fi
unset RTDN_TOKEN

cat <<EOT

Now two steps in Play Console (https://play.google.com/console):

1. Users and permissions → Invite new users
     Email:        ${RUNTIME_SA}
     App:          ${PACKAGE}
     Permissions:  "View financial data, orders and cancellation survey responses" and "Manage orders and subscriptions"
   (It can take up to a day before Google lets the server check purchases.)

2. Your app → Monetize with Play → Monetization setup → Real-time developer notifications
     Topic name:   projects/${PROJECT}/topics/${TOPIC}
     Notifications: Subscriptions, voided purchases, and all one-time products
   Then press "Send test message"; the server log shows it (look for /api/play/rtdn).

For Razorpay beside Play (user choice billing, India): Monetize with Play → Monetization setup → Alternative billing,
enrol, and accept the terms (docs/PAYMENTS.md).
EOT
