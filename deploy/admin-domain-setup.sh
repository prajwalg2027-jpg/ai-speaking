#!/usr/bin/env bash
# Moves the admin console to its own address, https://admin.adamspeaks.in (instead of <Cloud Run address>/admin/).
#
#   PROJECT=cool-arch-515210-b0 ./deploy/admin-domain-setup.sh
#
# admin.adamspeaks.in is a second Firebase Hosting site (beside adamspeaks.in) that forwards every request to the
# Adam server on Cloud Run; there, the server shows the console at "/". Run it twice:
#   1st run: makes the site and deploys it, then tells you how to connect admin.adamspeaks.in in the Firebase
#            console (two DNS records at GoDaddy; the security certificate takes from minutes to a few hours).
#   2nd run (once Firebase says "Connected"): checks the address reaches the server, then tells the server, so the
#            old address (<Cloud Run address>/admin/) redirects to the new one.
# Run in Cloud Shell, with the latest server deployed. Safe to run again.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-admin.adamspeaks.in}"
SITE="${ADMIN_SITE:-${PROJECT}-admin}"
step() { echo; echo "› $*"; }
gcloud config set project "$PROJECT" >/dev/null

step "Firebase Hosting site ${SITE}"
if firebase hosting:sites:get "$SITE" --project "$PROJECT" >/dev/null 2>&1; then echo "  already there"
else firebase hosting:sites:create "$SITE" --project "$PROJECT" --non-interactive >/dev/null; echo "  made"; fi

step "Deploying it: every request goes to the server (${SERVICE}, ${REGION})"
DIR="$(mktemp -d)"; mkdir -p "$DIR/empty"
cat > "$DIR/firebase.json" <<EOF
{
  "hosting": {
    "site": "${SITE}",
    "public": "empty",
    "rewrites": [{ "source": "**", "run": { "serviceId": "${SERVICE}", "region": "${REGION}" } }],
    "headers": [{ "source": "**", "headers": [
      { "key": "Strict-Transport-Security", "value": "max-age=31536000; includeSubDomains" },
      { "key": "X-Robots-Tag", "value": "noindex, nofollow" },
      { "key": "X-Frame-Options", "value": "DENY" },
      { "key": "Referrer-Policy", "value": "same-origin" }
    ] }]
  }
}
EOF
(cd "$DIR" && firebase deploy --only hosting --project "$PROJECT" --non-interactive >/dev/null)
echo "  deployed: https://${SITE}.web.app"

step "Is ${ADMIN_DOMAIN} connected?"
LOGIN="$(curl -fsS --max-time 15 "https://${ADMIN_DOMAIN}/api/admin/config" 2>/dev/null | jq -r '.login // empty' 2>/dev/null || true)"
if [[ -z "$LOGIN" ]]; then
  cat <<EOF
  Not yet. Connect it (one time):
    1. Firebase console (console.firebase.google.com) → project ${PROJECT} → Hosting → the site "${SITE}"
       → Add custom domain → ${ADMIN_DOMAIN} (no redirect).
    2. Add the DNS records it shows at GoDaddy (DNS for adamspeaks.in), with the host/name "admin".
       Leave the records for adamspeaks.in, www and api as they are.
    3. Wait until Firebase shows "Connected" (the certificate takes minutes to a few hours), then run this again.
  Until then the console stays at its current address.
EOF
  exit 0
fi
echo "  yes: it reaches the server"

step "Telling the server its admin address (a new revision, about a minute)"
gcloud run services update "$SERVICE" --region "$REGION" --quiet --update-env-vars "ADMIN_HOST=${ADMIN_DOMAIN}" >/dev/null
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

step "Checking"
if curl -fsS --max-time 15 "https://${ADMIN_DOMAIN}/" | grep -q '/admin/admin.js'; then echo "  https://${ADMIN_DOMAIN} shows the console."
else echo "  https://${ADMIN_DOMAIN} doesn't show the console yet. Is the latest server deployed? (deploy/README.md)"; fi
OLD="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "${URL}/admin/")"
echo "  old address ${URL}/admin/ → ${OLD}"
echo
echo "Done. Admin console: https://${ADMIN_DOMAIN}"
