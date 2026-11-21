#!/usr/bin/env bash
# One-time setup of phone OTP login through MSG91 (server/login.js), for the app and the admin console.
#   - stores the MSG91 authkey in Secret Manager (it asks; typed input is hidden; it never goes in a file),
#   - makes a random session secret in Secret Manager (nobody ever sees it),
#   - lets the server's account read both, and gives the server the widget id and the admin numbers,
#   - optionally a test number with a fixed code (for the team and the Play Store review; no SMS is sent).
#
#   PROJECT=cool-arch-515210-b0 MSG91_WIDGET_ID=<widget id> ADMIN_PHONES=+919812345678 ./deploy/msg91-setup.sh
#   (optional) TEST_PHONE=+919999900000 TEST_CODE=<6 digits you choose>
#
# Before: in MSG91 (msg91.com) → OTP → Widget, create a widget for SMS with a 6-digit OTP, turn OFF captcha and
# invisible OTP (not supported for server-side use), and copy its Widget ID. Your authkey is under Authkey.
# Run in Cloud Shell after deploy/cloudrun.sh. Safe to run again: to change the key, the admins or the widget.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
WIDGET="${MSG91_WIDGET_ID:?Set MSG91_WIDGET_ID to the OTP widget id from MSG91 (OTP › Widget)}"
ADMIN_PHONES="${ADMIN_PHONES:-}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
RUNTIME_SA="adam-runtime@${PROJECT}.iam.gserviceaccount.com"
step() { echo; echo "› $*"; }
gcloud config set project "$PROJECT" >/dev/null

[[ "$WIDGET" =~ ^[A-Za-z0-9]{8,64}$ ]] || { echo "That doesn't look like a widget id: '$WIDGET'"; exit 1; }
if [[ -n "$ADMIN_PHONES" ]]; then
  IFS=',' read -ra PHONES <<< "$ADMIN_PHONES"
  for p in "${PHONES[@]}"; do
    [[ "$p" =~ ^\+[1-9][0-9]{7,14}$ ]] || { echo "Not a phone number in international form: '$p' (like +919812345678)"; exit 1; }
    [[ "$p" != "${TEST_PHONE:-+919999900000}" ]] || { echo "$p is the test number: it can't be an admin."; exit 1; }
  done
fi
if [[ -n "${TEST_PHONE:-}" ]]; then
  [[ "$TEST_PHONE" =~ ^\+91[6-9][0-9]{9}$ ]] || { echo "TEST_PHONE must be an Indian mobile number like +919999900000"; exit 1; }
  [[ "${TEST_CODE:-}" =~ ^[0-9]{6}$ ]] || { echo "TEST_CODE must be 6 digits"; exit 1; }
fi

step "MSG91 authkey (Secret Manager: msg91-authkey)"
if gcloud secrets describe msg91-authkey >/dev/null 2>&1 && [[ "${NEW_AUTHKEY:-}" != "1" ]]; then
  echo "  already stored (to replace it: NEW_AUTHKEY=1 and run again)"
else
  read -rsp "  Paste your MSG91 authkey (typed input is hidden): " KEY; echo
  [[ -n "$KEY" ]] || { echo "  No key entered."; exit 1; }
  if gcloud secrets describe msg91-authkey >/dev/null 2>&1; then printf %s "$KEY" | gcloud secrets versions add msg91-authkey --data-file=- >/dev/null
  else printf %s "$KEY" | gcloud secrets create msg91-authkey --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null; fi
  unset KEY
  echo "  stored"
fi

step "Session secret (Secret Manager: adam-session-secret)"
if gcloud secrets describe adam-session-secret >/dev/null 2>&1; then echo "  already there"
else openssl rand -base64 48 | tr -d '\n' | gcloud secrets create adam-session-secret --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null; echo "  made (random; nobody sees it)"; fi

step "Letting the server's account read them"
for s in msg91-authkey adam-session-secret; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done

step "Giving the server its settings (a new revision, about a minute)"
# "^;^" makes ";" the separator, so commas inside ADMIN_PHONES stay in the value.
VARS="^;^MSG91_WIDGET_ID=${WIDGET}"
[[ -n "$ADMIN_PHONES" ]] && VARS="${VARS};ADMIN_PHONES=${ADMIN_PHONES}"
[[ -n "${TEST_PHONE:-}" ]] && VARS="${VARS};MSG91_TEST_PHONE=${TEST_PHONE};MSG91_TEST_CODE=${TEST_CODE};FIREBASE_TEST_PHONE=${TEST_PHONE}"
gcloud run services update "$SERVICE" --region "$REGION" --quiet \
  --update-secrets "MSG91_AUTHKEY=msg91-authkey:latest,SESSION_SECRET=adam-session-secret:latest" \
  --update-env-vars "$VARS" >/dev/null

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
step "Checking"
LOGIN="$(curl -fsS "${URL}/api/admin/config" | jq -r '.login')"
if [[ "$LOGIN" == "otp" ]]; then echo "  OTP login is on."; else echo "  The server doesn't report OTP login yet (got: ${LOGIN}). Is the latest code deployed? (deploy/README.md)"; fi
echo
echo "Done. The app signs in with an SMS code from MSG91. Admin console: ${URL}/admin/"
