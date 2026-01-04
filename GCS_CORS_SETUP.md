# GCS CORS Configuration

To fix the CORS error when uploading files to Google Cloud Storage, you need to configure CORS on your GCS bucket.

## Method 1: Using gsutil (Recommended)

1. Create a CORS configuration file (see `cors-config.json` in this directory)
2. Update the file with your frontend origins
3. Apply the CORS configuration:

```bash
gsutil cors set cors-config.json gs://your-bucket-name
```

## Method 2: Using Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/storage/browser)
2. Select your bucket
3. Click on the "Configuration" tab
4. Scroll to "CORS configuration"
5. Click "Edit"
6. Add the following JSON:

```json
[
  {
    "origin": ["http://localhost:5173", "http://localhost:3000", "https://your-frontend-domain.com"],
    "method": ["PUT", "GET", "POST", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "Content-Length", "x-goog-resumable"],
    "maxAgeSeconds": 3600
  }
]
```

7. Click "Save"

## Method 3: Using gcloud CLI

```bash
gcloud storage buckets update gs://your-bucket-name --cors-file=cors-config.json
```

## Important Notes

- Replace `your-bucket-name` with your actual bucket name
- Replace `your-frontend-domain.com` with your production domain
- For development, include `http://localhost:5173` (or whatever port your frontend uses)
- For production, include your production domain (e.g., `https://your-app.com`)

## Verify CORS Configuration

To verify your CORS configuration is set correctly:

```bash
gsutil cors get gs://your-bucket-name
```

