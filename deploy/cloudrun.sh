#!/usr/bin/env bash
# Deploy the Adam server to Google Cloud Run in Mumbai (asia-south1), with its database and recordings.
#
#   PROJECT=your-gcp-project-id ./deploy/cloudrun.sh
#
# Needs the gcloud CLI, logged in, with a project that has billing on (Cloud Shell has both). Safe to run
# again: each run deploys the current code; what already exists is left as it is. The first run also creates:
#   - the Sarvam key in Secret Manager (it asks; it never goes in a file),
#   - a PostgreSQL database (Cloud SQL, Mumbai) with daily backups and point-in-time recovery,
#   - a private Cloud Storage bucket (Mumbai) for voice recordings,
#   - a service account for the server that can use only these.
# Phone login uses Firebase in the same project: see deploy/README.md (Firebase console, one-time).
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
BUDGET_INR="${SAKHI_DAILY_BUDGET_INR:-3000}"
DB_INSTANCE="${DB_INSTANCE:-adam-db}"
DB_TIER="${DB_TIER:-db-g1-small}"   # small shared-core machine; raise to db-custom-1-3840 as use grows
BUCKET="${RECORDINGS_BUCKET:-${PROJECT}-adam-recordings}"
RUNTIME_SA="adam-runtime@${PROJECT}.iam.gserviceaccount.com"

cd "$(dirname "$0")/.."
gcloud config set project "$PROJECT" >/dev/null
step() { echo; echo "› $*"; }

step "Turning on the Google services Adam uses (first run only)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  sqladmin.googleapis.com storage.googleapis.com identitytoolkit.googleapis.com firebase.googleapis.com --quiet

if ! gcloud secrets describe sarvam-api-key >/dev/null 2>&1; then
  read -rsp "› Sarvam API key (typed input is hidden): " KEY; echo
  printf %s "$KEY" | gcloud secrets create sarvam-api-key --replication-policy=user-managed --locations="$REGION" --data-file=-
  unset KEY
fi

if ! gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1; then
  step "Creating the server's own account"
  gcloud iam service-accounts create adam-runtime --display-name="Adam server"
fi

# ---- Database ---------------------------------------------------------------------------------------
if ! gcloud sql instances describe "$DB_INSTANCE" >/dev/null 2>&1; then
  step "Creating the PostgreSQL database in Mumbai (about 10 minutes, first run only)"
  gcloud sql instances create "$DB_INSTANCE" --database-version=POSTGRES_16 --edition=ENTERPRISE --tier="$DB_TIER" \
    --region="$REGION" --availability-type=zonal --storage-type=SSD --storage-size=10 --storage-auto-increase \
    --backup-start-time=21:00 --enable-point-in-time-recovery --retained-backups-count=14 --deletion-protection --quiet
  gcloud sql databases create adam --instance="$DB_INSTANCE" --quiet
fi
if ! gcloud secrets describe adam-database-url >/dev/null 2>&1; then
  step "Creating the database user (its password goes straight into Secret Manager)"
  PASS="$(openssl rand -hex 24)"
  gcloud sql users create adam --instance="$DB_INSTANCE" --password="$PASS" --quiet
  printf %s "postgresql://adam:${PASS}@/adam?host=/cloudsql/${PROJECT}:${REGION}:${DB_INSTANCE}" \
    | gcloud secrets create adam-database-url --replication-policy=user-managed --locations="$REGION" --data-file=-
  unset PASS
fi

# ---- Voice recordings -------------------------------------------------------------------------------
if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  step "Creating the private recordings bucket in Mumbai"
  # No soft delete: when a customer asks for erasure, their recordings must really be gone.
  gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" --uniform-bucket-level-access \
    --public-access-prevention --soft-delete-duration=0
fi

# ---- What the server's account may do (only these) ----------------------------------------------------
step "Granting the server's account what it needs"
for s in sarvam-api-key adam-database-url; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${RUNTIME_SA}" --role=roles/cloudsql.client --condition=None --quiet >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${RUNTIME_SA}" --role=roles/firebaseauth.admin --condition=None --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectAdmin --quiet >/dev/null

# ---- Deploy -------------------------------------------------------------------------------------------
# One instance: conversations are kept in the server's memory, so every request of a conversation must reach
# the same instance. One instance comfortably handles dozens of conversations at once (it mostly waits on
# Sarvam). To scale past that, conversations move to the database first.
step "Building and deploying (about 4 minutes)"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUNTIME_SA" \
  --allow-unauthenticated \
  --add-cloudsql-instances "${PROJECT}:${REGION}:${DB_INSTANCE}" \
  --set-secrets "SARVAM_API_KEY=sarvam-api-key:latest,DATABASE_URL=adam-database-url:latest" \
  --set-env-vars "NODE_ENV=production,FIREBASE_PROJECT_ID=${PROJECT},RECORDINGS_BUCKET=${BUCKET},SAKHI_DAILY_BUDGET_INR=${BUDGET_INR}" \
  --min-instances 1 --max-instances 1 \
  --concurrency 80 --cpu 1 --memory 1Gi \
  --timeout 3600 --session-affinity --cpu-boost \
  --execution-environment gen2 \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
step "Checking ${URL}/healthz"
curl -fsS "${URL}/healthz" && echo
echo
echo "Deployed: ${URL}"
echo "Next: give this address to the Android release build (GitHub repository variable SAKHI_SERVER_URL),"
echo "and finish phone login in the Firebase console if you haven't (deploy/README.md)."
