#!/usr/bin/env bash
# One-time setup of the admin console (https://<server>/admin/): phone sign-in in the browser, and who may use it.
#   - registers a Firebase web app ("Adam admin") and gives its public web key to the server,
#   - allows the server's address for Firebase sign-in (authorized domains),
#   - sets ADMIN_PHONES: the phone numbers allowed into the console.
#
#   PROJECT=cool-arch-515210-b0 ADMIN_PHONES=+919812345678 ./deploy/admin-setup.sh
#   (several numbers: ADMIN_PHONES=+919812345678,+919876543210)
#
# Run in Cloud Shell after deploy/cloudrun.sh and deploy/firebase-setup.sh. Safe to run again (e.g. to change the
# admin numbers). The web key is not a secret: it only identifies the Firebase project to the browser.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
ADMIN_PHONES="${ADMIN_PHONES:?Set ADMIN_PHONES to the admin phone numbers, like +919812345678 (comma-separated for several)}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
TEST_PHONE="${TEST_PHONE:-+919999900000}"

FB="https://firebase.googleapis.com/v1beta1"
IDT="https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config"
step() { echo; echo "› $*"; }
api() { # METHOD URL [JSON]
  curl -sS -X "$1" "$2" -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: ${PROJECT}" \
    -H "Content-Type: application/json" ${3:+-d "$3"}
}
command -v jq >/dev/null || { echo "Needs jq (Cloud Shell has it)"; exit 1; }
gcloud config set project "$PROJECT" >/dev/null

# Every number must look like +91XXXXXXXXXX, and the team's test number (which anyone with its fixed code can use)
# must never be an admin.
IFS=',' read -ra PHONES <<< "$ADMIN_PHONES"
for p in "${PHONES[@]}"; do
  [[ "$p" =~ ^\+[1-9][0-9]{7,14}$ ]] || { echo "Not a phone number in international form: '$p' (like +919812345678)"; exit 1; }
  [[ "$p" != "$TEST_PHONE" ]] || { echo "$TEST_PHONE is the shared test number: it can't be an admin."; exit 1; }
done

step "Registering the admin console with Firebase (web app)"
web_id() { api GET "${FB}/projects/${PROJECT}/webApps?pageSize=100" | jq -r '.apps[]? | select(.displayName == "Adam admin") | .appId' | head -1; }
APP_ID="$(web_id)"
if [[ -z "$APP_ID" ]]; then
  api POST "${FB}/projects/${PROJECT}/webApps" '{"displayName":"Adam admin"}' >/dev/null
  for _ in $(seq 1 20); do sleep 3; APP_ID="$(web_id)"; [[ -n "$APP_ID" ]] && break; done
fi
[[ -n "$APP_ID" ]] || { echo "Could not create the web app; try again in a minute."; exit 1; }
WEB_KEY="$(api GET "${FB}/projects/${PROJECT}/webApps/${APP_ID}/config" | jq -r '.apiKey')"
[[ -n "$WEB_KEY" && "$WEB_KEY" != "null" ]] || { echo "Could not read the web app's key."; exit 1; }
echo "  web app: ${APP_ID}"

step "Allowing the server's address for sign-in"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
HOST="${URL#https://}"
DOMAINS="$(api GET "$IDT" | jq -c --arg h "$HOST" '(.authorizedDomains // []) + [$h] | unique')"
api PATCH "${IDT}?updateMask=authorizedDomains" "$(jq -nc --argjson d "$DOMAINS" '{authorizedDomains: $d}')" | jq -r '"  allowed: " + (.authorizedDomains | join(", "))'

step "Giving the server the web key and the admin numbers"
# "^;^" makes ";" the separator, so the commas in ADMIN_PHONES stay inside the value.
gcloud run services update "$SERVICE" --region "$REGION" --quiet \
  --update-env-vars "^;^FIREBASE_WEB_API_KEY=${WEB_KEY};ADMIN_PHONES=${ADMIN_PHONES}" >/dev/null

echo
echo "Done. Open ${URL}/admin/ and sign in with: ${ADMIN_PHONES}"
