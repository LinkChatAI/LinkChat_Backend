# Backend Deployment Guide

## Prerequisites

1. Install Google Cloud SDK: https://cloud.google.com/sdk/docs/install
2. Authenticate: `gcloud auth login`
3. Set your project: `gcloud config set project YOUR_PROJECT_ID`
4. Enable APIs:
   ```bash
   gcloud services enable cloudbuild.googleapis.com
   gcloud services enable run.googleapis.com
   gcloud services enable containerregistry.googleapis.com
   ```

## Deployment Steps

### Option 1: Deploy from Project Root (Recommended)

**Make sure you're in the project root directory** (`LinkRoom`):

```bash
# From: C:\Users\krish\OneDrive\Desktop\LinkRoom
gcloud builds submit --config backend/cloudbuild.yaml
```

### Option 2: Deploy from Backend Directory

If you're in the `backend` directory:

```bash
# From: C:\Users\krish\OneDrive\Desktop\LinkRoom\backend
cd ..
gcloud builds submit --config backend/cloudbuild.yaml
```

### Option 3: Use Absolute Path

```bash
gcloud builds submit --config "C:\Users\krish\OneDrive\Desktop\LinkRoom\backend\cloudbuild.yaml"
```

## Setting Up Secrets (Before First Deployment)

If using Secret Manager (recommended for production):

```bash
# Create secrets
echo -n "your-mongodb-connection-string" | gcloud secrets create MONGO_URI --data-file=-
echo -n "your-redis-url" | gcloud secrets create REDIS_URL --data-file=-
echo -n "your-jwt-secret-key" | gcloud secrets create JWT_SECRET --data-file=-

# Get your project number
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format="value(projectNumber)")

# Grant Cloud Run access to secrets
gcloud secrets add-iam-policy-binding MONGO_URI \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding REDIS_URL \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding JWT_SECRET \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## Alternative: Use Environment Variables Directly

If you prefer not to use Secret Manager, use `cloudbuild-simple.yaml`:

```bash
gcloud builds submit --config backend/cloudbuild-simple.yaml
```

Then set environment variables:

```bash
gcloud run services update linkchat-backend \
  --region us-central1 \
  --update-env-vars "MONGO_URI=your-mongo-uri,REDIS_URL=your-redis-url,JWT_SECRET=your-secret,FRONTEND_URL=https://your-app.netlify.app"
```

## Get Your Backend URL

After successful deployment:

```bash
gcloud run services describe linkchat-backend \
  --region us-central1 \
  --format="value(status.url)"
```

## Troubleshooting

### "No such file or directory" Error

**Solution**: Make sure you're running the command from the project root directory:
```bash
# Check your current directory
pwd  # Linux/Mac
cd   # Windows

# Navigate to project root if needed
cd C:\Users\krish\OneDrive\Desktop\LinkRoom
```

### Build Fails

Check the build logs:
```bash
gcloud builds list --limit=1
gcloud builds log BUILD_ID
```

### Service Won't Start

Check Cloud Run logs:
```bash
gcloud run services logs read linkchat-backend --region us-central1
```

### Health Check Fails

The server should start immediately. Verify:
1. Health endpoint: `https://your-service.run.app/healthz`
2. Readiness endpoint: `https://your-service.run.app/ready`

## Manual Docker Build (Alternative)

If Cloud Build doesn't work, build and push manually:

```bash
cd backend

# Build
docker build -t gcr.io/YOUR_PROJECT_ID/linkchat-backend:latest .

# Push
docker push gcr.io/YOUR_PROJECT_ID/linkchat-backend:latest

# Deploy
gcloud run deploy linkchat-backend \
  --image gcr.io/YOUR_PROJECT_ID/linkchat-backend:latest \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --timeout 300 \
  --startup-cpu-boost \
  --set-env-vars "PORT=8080,NODE_ENV=production"
```

