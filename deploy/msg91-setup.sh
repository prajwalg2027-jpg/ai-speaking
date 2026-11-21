#!/usr/bin/env bash
# One-time setup of phone OTP login through MSG91 (server/login.js), for the app and the admin console.
#   - stores the MSG91 authkey in Secret Manager (it asks; typed input is hidden; it never goes in a file),
#   - makes a random session secret in Secret Manager (nobody ever sees it),
#   - lets the server's account read both, and gives the server the widget id and the admin numbers,
#   - optionally a test number with a fixed code (for the team and the Play Store review; no SMS is sent).
#
#   PROJECT=cool-arch-515210-b0 MSG91_WIDGET_ID=<widget id> OTP_LENGTH=4 ADMIN_PHONES=+919812345678 \
#     DEMO_PHONES=+919000000001 ./deploy/msg91-setup.sh
#   (optional) TRUECALLER_CLIENT_IDS=<release id>,<test build id> for Truecaller one-tap sign-in.
#   OTP_LENGTH: the widget's OTP length (4 to 8). DEMO_PHONES: numbers set up under the widget's Demo Credentials
#   (they can never be admins). (optional) TEST_PHONE + TEST_CODE: a test number handled by this server instead.
#
# Before: in MSG91 (msg91.com) → OTP → Widget, create a widget for SMS, turn OFF captcha and invisible OTP (not
# supported for server-side use), and copy its Widget ID. Your authkey is under Authkey.
# Run in Cloud Shell after deploy/cloudrun.sh. Safe to run again: to change the key, the admins or the widget.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
WIDGET="${MSG91_WIDGET_ID:?Set MSG91_WIDGET_ID to the OTP widget id from MSG91 (OTP › Widget)}"
ADMIN_PHONES="${ADMIN_PHONES:-}"
OTP_LENGTH="${OTP_LENGTH:-6}"
DEMO_PHONES="${DEMO_PHONES:-}"
TRUECALLER_CLIENT_IDS="${TRUECALLER_CLIENT_IDS:-}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
RUNTIME_SA="adam-runtime@${PROJECT}.iam.gserviceaccount.com"
step() { echo; echo "› $*"; }
gcloud config set project "$PROJECT" >/dev/null

[[ "$WIDGET" =~ ^[A-Za-z0-9]{8,64}$ ]] || { echo "That doesn't look like a widget id: '$WIDGET'"; exit 1; }
[[ "$OTP_LENGTH" =~ ^[4-8]$ ]] || { echo "OTP_LENGTH must be the widget's OTP length, 4 to 8"; exit 1; }
phone_ok() { [[ "$1" =~ ^\+[1-9][0-9]{7,14}$ ]] || { echo "Not a phone number in international form: '$1' (like +919812345678)"; exit 1; }; }
IFS=',' read -ra DEMOS <<< "$DEMO_PHONES"
for d in "${DEMOS[@]}"; do phone_ok "$d"; done
if [[ -n "$ADMIN_PHONES" ]]; then
  IFS=',' read -ra PHONES <<< "$ADMIN_PHONES"
  for p in "${PHONES[@]}"; do
    phone_ok "$p"
    for no in "${TEST_PHONE:-+919999900000}" "${DEMOS[@]}"; do [[ "$p" != "$no" ]] || { echo "$p signs in with a shared code (test or demo): it can't be an admin."; exit 1; }; done
  done
fi
if [[ -n "${TEST_PHONE:-}" ]]; then
  [[ "$TEST_PHONE" =~ ^\+91[6-9][0-9]{9}$ ]] || { echo "TEST_PHONE must be an Indian mobile number like +919999900000"; exit 1; }
  [[ "${TEST_CODE:-}" =~ ^[0-9]{4,8}$ ]] || { echo "TEST_CODE must be 4 to 8 digits"; exit 1; }
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
VARS="^;^MSG91_WIDGET_ID=${WIDGET};OTP_LENGTH=${OTP_LENGTH}"
[[ -n "$ADMIN_PHONES" ]] && VARS="${VARS};ADMIN_PHONES=${ADMIN_PHONES}"
[[ -n "$DEMO_PHONES" ]] && VARS="${VARS};DEMO_PHONES=${DEMO_PHONES}"
[[ -n "$TRUECALLER_CLIENT_IDS" ]] && VARS="${VARS};TRUECALLER_CLIENT_IDS=${TRUECALLER_CLIENT_IDS}"
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
