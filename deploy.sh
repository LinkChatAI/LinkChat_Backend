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
# IMPORTANT: keep these flags in sync with cloudbuild.yaml. In particular:
#   --min-instances 1  → scale-to-zero kills active Socket.IO sessions
#   --timeout 3600     → a WebSocket is one long-lived request; 300s would
#                        force-close every socket after 5 minutes
#   --concurrency 250  → each open socket holds a concurrency slot
echo "Deploying to Cloud Run..."
gcloud run deploy linkroom-backend \
  --image gcr.io/$PROJECT_ID/linkchat-backend:latest \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 10 \
  --timeout 3600 \
  --concurrency 250 \
  --session-affinity \
  --set-env-vars "PORT=8080,NODE_ENV=production"

echo "Deployment complete!"
echo "Get your backend URL with:"
echo "gcloud run services describe linkroom-backend --region $REGION --format='value(status.url)'"

