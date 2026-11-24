#!/usr/bin/env bash
# One-time setup of extra AI providers for the server (server/llm/): Claude (Anthropic), OpenAI and Gemini.
#   - stores each API key in Secret Manager (it asks; typed input is hidden; it never goes in a file),
#   - lets the server's account read them, and gives them to the server (one new revision).
#
#   PROJECT=cool-arch-515210-b0 PROVIDERS=anthropic,gemini ./deploy/llm-keys-setup.sh
#   PROVIDERS: any of anthropic, openai, gemini, comma-separated.
#   NEW_KEY=1 replaces keys that are already stored (otherwise they are kept).
#
# Before: make an API key at console.anthropic.com (Claude), platform.openai.com (OpenAI) or aistudio.google.com
# (Gemini). Gemini needs no key by default: it goes through Vertex AI (deploy/vertex-setup.sh). Its key is only used
# with GOOGLE_GENAI_USE_VERTEXAI=false, and by the Compare voices page's "Google Gemini API" voices. Run in Cloud Shell after deploy/cloudrun.sh. Safe to run again: to add a provider or change a key.
# Having a key only makes a provider available: which model each job uses is chosen in the admin console.
set -euo pipefail

PROJECT="${PROJECT:?Set PROJECT to your Google Cloud project ID}"
PROVIDERS="${PROVIDERS:?Set PROVIDERS to the providers to set up, like PROVIDERS=anthropic,gemini}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-adam}"
RUNTIME_SA="adam-runtime@${PROJECT}.iam.gserviceaccount.com"
step() { echo; echo "› $*"; }
gcloud config set project "$PROJECT" >/dev/null

name_of() { case "$1" in anthropic) echo "Claude (Anthropic)";; openai) echo "OpenAI";; gemini) echo "Gemini (Google)";; esac; }
IFS=',' read -ra LIST <<< "$PROVIDERS"
for p in "${LIST[@]}"; do
  case "$p" in anthropic|openai|gemini) ;; *) echo "Unknown provider '$p': use anthropic, openai or gemini"; exit 1;; esac
done

SECRETS=""
for p in "${LIST[@]}"; do
  SECRET="${p}-api-key"
  VAR="$(echo "$p" | tr '[:lower:]' '[:upper:]')_API_KEY"
  step "$(name_of "$p") API key (Secret Manager: ${SECRET})"
  if gcloud secrets describe "$SECRET" >/dev/null 2>&1 && [[ "${NEW_KEY:-}" != "1" ]]; then
    echo "  already stored (to replace it: NEW_KEY=1 and run again)"
  else
    read -rsp "  Paste your $(name_of "$p") API key (typed input is hidden): " KEY; echo
    [[ -n "$KEY" ]] || { echo "  No key entered."; exit 1; }
    if gcloud secrets describe "$SECRET" >/dev/null 2>&1; then printf %s "$KEY" | gcloud secrets versions add "$SECRET" --data-file=- >/dev/null
    else printf %s "$KEY" | gcloud secrets create "$SECRET" --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null; fi
    unset KEY
    echo "  stored"
  fi
  gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
  echo "  the server's account can read it"
  SECRETS="${SECRETS:+${SECRETS},}${VAR}=${SECRET}:latest"
done

step "Giving the server its keys (a new revision, about a minute)"
gcloud run services update "$SERVICE" --region "$REGION" --quiet --update-secrets "$SECRETS" >/dev/null

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "Done. The server now has keys for:"
for p in "${LIST[@]}"; do echo "  - $(name_of "$p")"; done
echo "Nothing changes for learners yet: choose the models in the admin console (${URL}/admin/):"
echo "Settings › Placement test, and the Compare models page."
