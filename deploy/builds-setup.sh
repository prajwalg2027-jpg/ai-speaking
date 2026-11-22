#!/usr/bin/env bash
# PRE-PRODUCTION ONLY (remove before launch: deploy/builds-teardown.sh, docs/HANDOFF.md › Before production).
#
# One-time setup of the team's download page for the latest Android test build:
#   https://adamspeaks.in/internal/<random token>   (not linked anywhere, not indexed)
# Every push to tutor-conversation or main builds the APK in GitHub Actions and uploads it here automatically.
#
#   PROJECT=cool-arch-515210-b0 ./deploy/builds-setup.sh
#
# It makes:
#   - a private bucket for the build (<project>-adam-builds), readable by the server only,
#   - a service account GitHub Actions signs in as without any stored key (Workload Identity Federation, only for
#     pushes to tutor-conversation and main of this repository), allowed to write to that bucket only,
#   - a random token for the page's address, given to the server (NEW_TOKEN=1 makes a new one: the old link stops),
#   - the website rewrite (/internal/** → the server), by deploying adamspeaks.in from its branch.
# At the end it prints the page's address and three GitHub variables to add.
# Run in Cloud Shell after deploy/cloudrun.sh, with the latest server deployed. Safe to run again.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
REPO="${GITHUB_REPO:-prajwalg2027-jpg/ai-speaking}"
WEBSITE_BRANCH="${WEBSITE_BRANCH:-claude/dazzling-cray-ni75q7}"
DOMAIN="${DOMAIN:-adamspeaks.in}"
BUCKET="${BUILDS_BUCKET:-${PROJECT}-adam-builds}"
CI_SA="adam-ci-builds@${PROJECT}.iam.gserviceaccount.com"
RUNTIME_SA="adam-runtime@${PROJECT}.iam.gserviceaccount.com"
POOL=github PROVIDER_ID=ai-speaking
step() { echo; echo "› $*"; }
gcloud config set project "$PROJECT" >/dev/null
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"

step "APIs"
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com storage.googleapis.com --quiet

step "Private bucket gs://${BUCKET}"
if gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then echo "  already there"
else gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" --uniform-bucket-level-access --public-access-prevention >/dev/null; echo "  made"; fi

step "GitHub Actions' account (writes builds, nothing else)"
gcloud iam service-accounts describe "$CI_SA" >/dev/null 2>&1 || gcloud iam service-accounts create adam-ci-builds --display-name="Adam CI: test builds (pre-production)" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${CI_SA}" --role=roles/storage.objectUser >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectViewer >/dev/null
echo "  ok"

step "Keyless sign-in from GitHub Actions (only ${REPO}, branches tutor-conversation and main)"
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions" >/dev/null
CONDITION="assertion.repository=='${REPO}' && (assertion.ref=='refs/heads/tutor-conversation' || assertion.ref=='refs/heads/main')"
if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --workload-identity-pool="$POOL" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" --workload-identity-pool="$POOL" --location=global --attribute-condition="$CONDITION" >/dev/null
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" --workload-identity-pool="$POOL" --location=global \
    --display-name="ai-speaking" --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="$CONDITION" >/dev/null
fi
gcloud iam service-accounts add-iam-policy-binding "$CI_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" >/dev/null
WIF="projects/${NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER_ID}"
echo "  ok"

step "The page's token, given to the server (a new revision, about a minute)"
TOKEN="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json | jq -r '[.spec.template.spec.containers[0].env[]? | select(.name=="BUILDS_TOKEN") | .value][0] // empty')"
if [[ -z "$TOKEN" || "${NEW_TOKEN:-}" == "1" ]]; then TOKEN="$(openssl rand -hex 12)"; echo "  new token made"; else echo "  keeping the current token"; fi
gcloud run services update "$SERVICE" --region "$REGION" --quiet --update-env-vars "BUILDS_BUCKET=${BUCKET},BUILDS_TOKEN=${TOKEN}" >/dev/null

step "Website: sending ${DOMAIN}/internal/** to the server (deploys the site from ${WEBSITE_BRANCH})"
WEB="$(mktemp -d)"
git clone -q --depth 1 -b "$WEBSITE_BRANCH" "https://github.com/${REPO}.git" "$WEB"
if grep -q '"/internal/\*\*"' "$WEB/website/firebase.json"; then
  (cd "$WEB/website" && firebase deploy --only hosting --project "$PROJECT" --non-interactive) \
    || echo "  The website deploy failed. Run it yourself: cd $WEB/website && firebase deploy --only hosting --project $PROJECT"
else
  echo "  The website branch has no /internal rewrite yet (website/firebase.json). Ask Claude to add it, then run this again."
fi

step "Checking"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' "https://${DOMAIN}/internal/${TOKEN}")"
if [[ "$CODE" == "200" ]]; then echo "  The page answers."; else echo "  https://${DOMAIN}/internal/…/ answered HTTP $CODE (expected 200). Is the latest server deployed?"; fi

cat <<EOF

Add these three in GitHub: ${REPO} → Settings → Secrets and variables → Actions → Variables tab → New repository
variable (they're not secrets):
  GCP_WIF_PROVIDER = ${WIF}
  GCP_BUILDS_SA    = ${CI_SA}
  BUILDS_BUCKET    = ${BUCKET}

After that, every push to tutor-conversation or main publishes the APK here (a few minutes after the push):

  https://${DOMAIN}/internal/${TOKEN}

Share it only with testers. To change the link: NEW_TOKEN=1 and run this again.
EOF
