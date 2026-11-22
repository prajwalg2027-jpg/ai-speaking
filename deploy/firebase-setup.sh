#!/usr/bin/env bash
# One-time Firebase setup for Adam's phone login, done through Google's APIs (no console clicking):
#   - adds Firebase to the Google Cloud project,
#   - turns on phone sign-in (only phone), with a test number for the team: +91 99999 00000 / code 123456,
#   - registers the Android apps in.adamspeaks.app and in.adamspeaks.app.dev (+ the test build's fingerprints),
#   - writes google-services.json and offers it as a download.
#
#   PROJECT=cool-arch-515210-b0 ./deploy/firebase-setup.sh
#
# Run in Cloud Shell (signed in as a project owner). Safe to run again: what exists is left as it is.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
TEST_PHONE="${TEST_PHONE:-+919999900000}"
TEST_CODE="${TEST_CODE:-123456}"
# The shared signing key of test builds (android/app/debug.keystore).
DEV_SHA1="a82fbb92c2a9dfbaf4477d383f3cbda088286236"
DEV_SHA256="0cd0b260cf798531507c6fa717ae0d5732fb99081ed918bcb0d2c08c0a978f65"

FB="https://firebase.googleapis.com/v1beta1"
step() { echo; echo "› $*"; }
api() { # METHOD URL [JSON]
  curl -sS -X "$1" "$2" -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: ${PROJECT}" \
    -H "Content-Type: application/json" ${3:+-d "$3"}
}
need() { command -v "$1" >/dev/null || { echo "Needs $1 (Cloud Shell has it)"; exit 1; }; }
need jq; need curl
gcloud config set project "$PROJECT" >/dev/null
gcloud services enable firebase.googleapis.com identitytoolkit.googleapis.com --quiet

step "Adding Firebase to ${PROJECT}"
if [ "$(api GET "${FB}/projects/${PROJECT}" | jq -r '.projectId // empty')" = "" ]; then
  api POST "${FB}/projects/${PROJECT}:addFirebase" '{}' | jq -r '.name // .error.message'
  for i in $(seq 1 30); do
    [ "$(api GET "${FB}/projects/${PROJECT}" | jq -r '.projectId // empty')" != "" ] && break
    sleep 5
  done
fi
api GET "${FB}/projects/${PROJECT}" | jq -r '"  Firebase project: \(.projectId) (\(.displayName))"'

step "Turning on phone sign-in, with the test number ${TEST_PHONE} / ${TEST_CODE}"
# SMS codes only to Indian numbers: blocks "SMS pumping" fraud (bots sending paid OTPs to foreign numbers).
BODY="$(jq -nc --arg p "$TEST_PHONE" --arg c "$TEST_CODE" '{signIn: {phoneNumber: {enabled: true, testPhoneNumbers: {($p): $c}}}, smsRegionConfig: {allowlistOnly: {allowedRegions: ["IN"]}}}')"
R="$(api PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=signIn.phoneNumber,smsRegionConfig" "$BODY")"
if echo "$R" | jq -e '.signIn.phoneNumber.enabled == true' >/dev/null; then echo "  Phone sign-in: on (SMS to Indian numbers only)"
else
  echo "  Couldn't turn it on through the API: $(echo "$R" | jq -r '.error.message // .')"
  echo "  Do it in the browser instead: Firebase console › Authentication › Get started › Sign-in method › Phone › Enable"
  echo "  (and add the test number there). Then run this script again for the rest."
fi

app_id() { api GET "${FB}/projects/${PROJECT}/androidApps?pageSize=100" | jq -r --arg p "$1" '.apps[]? | select(.packageName == $p) | .appId' | head -1; }
ensure_app() { # package, name
  local id; id="$(app_id "$1")"
  if [ -z "$id" ]; then
    api POST "${FB}/projects/${PROJECT}/androidApps" "$(jq -nc --arg p "$1" --arg n "$2" '{packageName: $p, displayName: $n}')" >/dev/null
    for i in $(seq 1 30); do id="$(app_id "$1")"; [ -n "$id" ] && break; sleep 3; done
  fi
  [ -n "$id" ] || { echo "  Couldn't register $1"; exit 1; }
  echo "$id"
}

step "Registering the Android apps"
DEV_ID="$(ensure_app in.adamspeaks.app.dev "Adam (test)")"; echo "  in.adamspeaks.app.dev → ${DEV_ID}"
REL_ID="$(ensure_app in.adamspeaks.app "Adam")";            echo "  in.adamspeaks.app     → ${REL_ID}"

step "Adding the test build's signing fingerprints"
HAVE="$(api GET "${FB}/projects/${PROJECT}/androidApps/${DEV_ID}/sha" | jq -r '.certificates[]?.shaHash')"
for pair in "SHA_1:${DEV_SHA1}" "SHA_256:${DEV_SHA256}"; do
  type="${pair%%:*}"; hash="${pair#*:}"
  if echo "$HAVE" | grep -qi "$hash"; then echo "  ${type}: already there"
  else api POST "${FB}/projects/${PROJECT}/androidApps/${DEV_ID}/sha" "$(jq -nc --arg h "$hash" --arg t "$type" '{shaHash: $h, certType: $t}')" >/dev/null && echo "  ${type}: added"; fi
done

step "Writing google-services.json"
api GET "${FB}/projects/${PROJECT}/androidApps/${DEV_ID}/config" | jq -r '.configFileContents' | base64 -d > google-services.json
jq -e '.client | length >= 2' google-services.json >/dev/null && echo "  google-services.json: both apps" || echo "  google-services.json written (check it lists both apps)"
if command -v cloudshell >/dev/null; then cloudshell download google-services.json; echo "  Your browser is downloading it."; else echo "  Saved: $(pwd)/google-services.json"; fi
echo
echo "Done. Send google-services.json to the developer (it's app settings, not a password)."
echo "The release app's fingerprint is added later, from Google Play Console (App integrity › App signing)."
