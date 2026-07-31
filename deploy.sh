#!/bin/bash

# Simple deployment script for Google Cloud Run
# Usage: ./deploy.sh [project-id] [region]

set -e

PROJECT_ID=${1:-${GOOGLE_CLOUD_PROJECT}}
REGION=${2:-asia-south1}

if [ -z "$PROJECT_ID" ]; then
  echo "Error: Project ID is required"
  echo "Usage: ./deploy.sh [project-id] [region]"
  echo "Or set GOOGLE_CLOUD_PROJECT environment variable"
  exit 1
fi

echo "Deploying to project: $PROJECT_ID, region: $REGION"

# Set the project
gcloud config set project $PROJECT_ID

# Build the image
echo "Building Docker image..."
docker build -t gcr.io/$PROJECT_ID/linkchat-backend:latest .

# Push the image
echo "Pushing to Container Registry..."
docker push gcr.io/$PROJECT_ID/linkchat-backend:latest

# Deploy to Cloud Run.
# IMPORTANT: keep these flags in sync with cloudbuild.yaml — that file is the
# canonical source, reconciled 2026-07-24 against the actually-live service
# (`gcloud run services describe linkroom-backend --region asia-south1`).
#   --min-instances 0  → scale-to-zero is fine for the REST API; the real cost
#                        driver is that an open Socket.IO connection bills as
#                        active CPU for its whole duration regardless of this
#                        setting (see the cost audit) — raising this back to 1
#                        does not fix that, it only buys idle-rate billing for
#                        a guaranteed-warm instance.
#   --timeout 3600     → a WebSocket is one long-lived request; 300s would
#                        force-close every socket after 5 minutes
#   --concurrency 100  → each open socket holds a concurrency slot
#   --update-env-vars  → NEVER --set-env-vars here; that replaces the entire
#                        env var list and has previously wiped Mongo/Redis/
#                        OAuth secrets on deploy and taken prod down.
echo "Deploying to Cloud Run..."
gcloud run deploy linkroom-backend \
  --image gcr.io/$PROJECT_ID/linkchat-backend:latest \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 256Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --timeout 3600 \
  --concurrency 100 \
  --cpu-boost \
  --session-affinity \
  --update-env-vars "NODE_ENV=production"

echo "Deployment complete!"
echo "Get your backend URL with:"
echo "gcloud run services describe linkroom-backend --region $REGION --format='value(status.url)'"

