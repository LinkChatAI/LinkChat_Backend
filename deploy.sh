#!/bin/bash

# Simple deployment script for Google Cloud Run
# Usage: ./deploy.sh [project-id] [region]

set -e

PROJECT_ID=${1:-${GOOGLE_CLOUD_PROJECT}}
REGION=${2:-us-central1}

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

# Deploy to Cloud Run
echo "Deploying to Cloud Run..."
gcloud run deploy linkchat-backend \
  --image gcr.io/$PROJECT_ID/linkchat-backend:latest \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --timeout 300 \
  --set-env-vars "PORT=8080,NODE_ENV=production"

echo "Deployment complete!"
echo "Get your backend URL with:"
echo "gcloud run services describe linkchat-backend --region $REGION --format='value(status.url)'"

