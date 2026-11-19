#!/usr/bin/env bash
# Deploy the Sakhi server to Google Cloud Run in Mumbai (asia-south1).
#
#   PROJECT=your-gcp-project-id ./deploy/cloudrun.sh
#
# Needs the gcloud CLI, logged in (`gcloud auth login`) with a project that has billing on.
# Safe to run again: each run builds and deploys the current code. The first run also turns on the
# Google services, stores the Sarvam key in Secret Manager (it asks for it; it never goes in a file),
# and creates a service account that can read only that secret.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-sakhi}"
BUDGET_INR="${SAKHI_DAILY_BUDGET_INR:-3000}"
RUNTIME_SA="sakhi-runtime@${PROJECT}.iam.gserviceaccount.com"

cd "$(dirname "$0")/.."
gcloud config set project "$PROJECT" >/dev/null

echo "› Turning on Cloud Run, Cloud Build, Artifact Registry and Secret Manager (first run only)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --quiet

if ! gcloud secrets describe sarvam-api-key >/dev/null 2>&1; then
  read -rsp "› Sarvam API key (typed input is hidden): " KEY; echo
  printf %s "$KEY" | gcloud secrets create sarvam-api-key --replication-policy=user-managed --locations="$REGION" --data-file=-
  unset KEY
fi

if ! gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1; then
  echo "› Creating the server's own account (it can read the Sarvam key and nothing else)"
  gcloud iam service-accounts create sakhi-runtime --display-name="Sakhi server"
fi
gcloud secrets add-iam-policy-binding sarvam-api-key --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null

# One instance: conversations are kept in the server's memory, so every request of a conversation must reach
# the same instance. One instance comfortably handles dozens of conversations at once (it mostly waits on
# Sarvam). To scale past that, conversations move to a shared store (Memorystore) first.
echo "› Building and deploying (about 3 minutes)"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUNTIME_SA" \
  --allow-unauthenticated \
  --set-secrets SARVAM_API_KEY=sarvam-api-key:latest \
  --set-env-vars "NODE_ENV=production,SAKHI_DAILY_BUDGET_INR=${BUDGET_INR}" \
  --min-instances 1 --max-instances 1 \
  --concurrency 80 --cpu 1 --memory 1Gi \
  --timeout 3600 --session-affinity --cpu-boost \
  --execution-environment gen2 \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "› Checking ${URL}/healthz"
curl -fsS "${URL}/healthz" && echo
echo
echo "Deployed: ${URL}"
echo "Give this address to the Android release build (GitHub repository variable SAKHI_SERVER_URL)."
