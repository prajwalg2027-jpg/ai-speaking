#!/usr/bin/env bash
# Gemini through Vertex AI (Google Cloud) instead of the Gemini API (Google AI Studio). The models and their names
# are the same; only the billing path differs. Vertex AI is billed to this Google Cloud project, so the project's
# Google Cloud credits (the $300 free trial) pay for it. They can't pay for the Gemini API's key.
# Vertex AI is the default: deploy/cloudrun.sh already does what this does. This script is for a server deployed
# before that, to choose a LOCATION, or to switch Gemini back to the Gemini API key.
#   - turns on the Vertex AI API,
#   - lets the server's account call it (roles/aiplatform.user; no API key),
#   - switches the server over: GOOGLE_GENAI_USE_VERTEXAI=true (one new revision).
#
#   PROJECT=cool-arch-515210-b0 ./deploy/vertex-setup.sh
#   LOCATION=global (the default: every Gemini model, the newest first) or a region such as asia-south1.
#   OFF=1 switches back to the Gemini API (GOOGLE_GENAI_USE_VERTEXAI=false; it needs the key from
#   deploy/llm-keys-setup.sh PROVIDERS=gemini).
#
# Run in Cloud Shell after deploy/cloudrun.sh. Safe to run again. Only the Gemini chat models move: the Google
# Cloud TTS voices are already billed to the project, and the Compare voices page's "Google Gemini API" voices
# still use the Gemini API key.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
LOCATION="${LOCATION:-global}"
RUNTIME_SA="adam-runtime@${PROJECT}.iam.gserviceaccount.com"
step() { echo; echo "› $*"; }
gcloud config set project "$PROJECT" >/dev/null

if [[ "${OFF:-}" == "1" ]]; then
  step "Switching Gemini back to the Gemini API (a new revision, about a minute)"
  gcloud run services update "$SERVICE" --region "$REGION" --quiet --update-env-vars GOOGLE_GENAI_USE_VERTEXAI=false >/dev/null
  echo "Done. Gemini now uses the Gemini API key again (if none is stored, Gemini shows as not set up)."
  exit 0
fi

step "Billing account of ${PROJECT} (the credits must be on this one)"
gcloud billing projects describe "$PROJECT" --format='value(billingAccountName,billingEnabled)' 2>/dev/null \
  | awk '{ print "  " $1 ($2 == "True" ? "  (billing on)" : "  (BILLING OFF: Vertex AI will refuse calls)") }' \
  || echo "  couldn't read it (needs billing viewer); check console.cloud.google.com/billing"

step "Turning on the Vertex AI API"
gcloud services enable aiplatform.googleapis.com --quiet
echo "  on"

step "Letting the server's account call Vertex AI (roles/aiplatform.user)"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${RUNTIME_SA}" --role=roles/aiplatform.user --condition=None --quiet >/dev/null
echo "  done"

step "Switching the server's Gemini calls to Vertex AI (a new revision, about a minute)"
gcloud run services update "$SERVICE" --region "$REGION" --quiet \
  --update-env-vars "GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=${LOCATION}" >/dev/null

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "Done. Gemini models are now called through Vertex AI (${LOCATION}) and billed to ${PROJECT}."
echo "Check it on the admin console's Compare models page (${URL}/admin/): Gemini shows as \"Gemini (Vertex AI)\"."
echo "Spending shows under Vertex AI in console.cloud.google.com/billing (credits are taken off there)."
