#!/usr/bin/env bash
# BEFORE PRODUCTION: removes the pre-production test build page (made by deploy/builds-setup.sh).
# Also delete, in code: server/builds.js (and its two lines in server/index.js), test/builds.test.js, the
# "test build page" steps in .github/workflows/android.yml, the /internal rewrite in the website's firebase.json,
# the GitHub variables GCP_WIF_PROVIDER, GCP_BUILDS_SA and BUILDS_BUCKET, and these two scripts.
#
#   PROJECT=cool-arch-515210-b0 ./deploy/builds-teardown.sh
set -euo pipefail
PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
BUCKET="${BUILDS_BUCKET:-${PROJECT}-adam-builds}"
gcloud config set project "$PROJECT" >/dev/null

echo "› The server stops serving the page"
gcloud run services update "$SERVICE" --region "$REGION" --quiet --remove-env-vars BUILDS_BUCKET,BUILDS_TOKEN >/dev/null
echo "› GitHub Actions can no longer sign in"
gcloud iam workload-identity-pools providers delete ai-speaking --workload-identity-pool=github --location=global --quiet || true
gcloud iam service-accounts delete "adam-ci-builds@${PROJECT}.iam.gserviceaccount.com" --quiet || true
echo "› The bucket and its builds"
gcloud storage rm --recursive "gs://${BUCKET}" --quiet || true
echo "Done. Now remove the code listed at the top of this script."
