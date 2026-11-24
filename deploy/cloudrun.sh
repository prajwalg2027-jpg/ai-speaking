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
# Phone login (SMS codes through MSG91) is set up after this, with deploy/msg91-setup.sh.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
BUDGET_INR="${SAKHI_DAILY_BUDGET_INR:-3000}"
DB_INSTANCE="${DB_INSTANCE:-adam-db}"
DB_TIER="${DB_TIER:-db-g1-small}"   # small shared-core machine; raise to db-custom-1-3840 as use grows
BUCKET="${RECORDINGS_BUCKET:-${PROJECT}-adam-recordings}"
VOICE_BUCKET="${VOICE_CACHE_BUCKET:-${PROJECT}-adam-voice}"
RUNTIME_SA="adam-runtime@${PROJECT}.iam.gserviceaccount.com"

cd "$(dirname "$0")/.."
gcloud config set project "$PROJECT" >/dev/null
step() { echo; echo "› $*"; }

step "Turning on the Google services Adam uses (first run only)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  sqladmin.googleapis.com storage.googleapis.com firebase.googleapis.com texttospeech.googleapis.com \
  aiplatform.googleapis.com --quiet

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

# ---- Sakhi's fixed voice lines (kept between server starts) ------------------------------------------------
if ! gcloud storage buckets describe "gs://${VOICE_BUCKET}" >/dev/null 2>&1; then
  step "Creating the bucket for Sakhi's fixed voice lines (saves about ₹15 per server restart)"
  gcloud storage buckets create "gs://${VOICE_BUCKET}" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
fi

# ---- What the server's account may do (only these) ----------------------------------------------------
step "Granting the server's account what it needs"
for s in sarvam-api-key adam-database-url; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${RUNTIME_SA}" --role=roles/cloudsql.client --condition=None --quiet >/dev/null
# Gemini goes through Vertex AI by default (billed to this project, so Google Cloud credits pay): no key, this role.
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${RUNTIME_SA}" --role=roles/aiplatform.user --condition=None --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectAdmin --quiet >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${VOICE_BUCKET}" --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectAdmin --quiet >/dev/null

# Organizations created recently have "secure by default" policies: Google's own build account no longer gets
# permissions automatically, so building from source needs this grant (Google's documented fix).
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/run.builder --condition=None --quiet >/dev/null
# Releases from GitHub (deploy/cloudbuild.yaml) run as that same account: it may update the service and run it
# as the server's own account, nothing more.
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/run.developer --condition=None --quiet >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/iam.serviceAccountUser --quiet >/dev/null

# ---- Deploy -------------------------------------------------------------------------------------------
# Public: the app calls the server directly (every request is checked by the server's own phone-login check).
# --no-invoker-iam-check makes it public without granting "allUsers", which a secure-by-default organization
# policy (domain-restricted sharing) forbids.
# One instance: conversations are kept in the server's memory, so every request of a conversation must reach
# the same instance. One instance comfortably handles dozens of conversations at once (it mostly waits on
# Sarvam). To scale past that, conversations move to the database first.
step "Building and deploying (about 4 minutes)"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUNTIME_SA" \
  --no-invoker-iam-check \
  --add-cloudsql-instances "${PROJECT}:${REGION}:${DB_INSTANCE}" \
  --update-secrets "SARVAM_API_KEY=sarvam-api-key:latest,DATABASE_URL=adam-database-url:latest" \
  --update-env-vars "NODE_ENV=production,RECORDINGS_BUCKET=${BUCKET},VOICE_CACHE_BUCKET=${VOICE_BUCKET},SAKHI_DAILY_BUDGET_INR=${BUDGET_INR}" \
  --min-instances 1 --max-instances 1 \
  --concurrency 80 --cpu 1 --memory 1Gi \
  --timeout 3600 --session-affinity --cpu-boost \
  --execution-environment gen2 \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
step "Checking ${URL}/api/health"
curl -fsS "${URL}/api/health" && echo
echo
echo "Deployed: ${URL}"
echo "Next: give this address to the Android release build (GitHub repository variable SAKHI_SERVER_URL)"
echo "and set up phone login if you haven't: deploy/msg91-setup.sh."
