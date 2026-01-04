# Local Development Setup Guide

## ✅ Current Configuration

Your backend is configured to use MongoDB from `.env` file:
- **File**: `backend/.env`
- **Variable**: `MONGO_URI`
- **Current Value**: `mongodb+srv://linkroomteam_db_user:3ShqCarYgdX2jozA@linkroom.ynwmqob.mongodb.net/linkchat`

## 🔧 Setup Steps for Local Development

### 1. Verify .env File

Make sure `backend/.env` exists and has:
```env
MONGO_URI=mongodb+srv://linkroomteam_db_user:3ShqCarYgdX2jozA@linkroom.ynwmqob.mongodb.net/linkchat
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key
PORT=8080
NODE_ENV=development
```

### 2. MongoDB Atlas IP Whitelist (REQUIRED)

**This is the most common issue!**

1. Go to [MongoDB Atlas](https://cloud.mongodb.com/)
2. Select your project → **Network Access** (left sidebar)
3. Click **"Add IP Address"**
4. Choose one:
   - **Option A**: Click **"Add Current IP Address"** (recommended)
   - **Option B**: Enter `0.0.0.0/0` (allows all IPs - development only!)
5. Click **Confirm**
6. **Wait 2-3 minutes** for changes to propagate

### 3. Start Backend Server

```bash
cd backend
npm install  # If you haven't already
npm run dev
```

The server should:
- ✅ Start on `http://localhost:8080`
- ✅ Load `.env` file automatically
- ✅ Attempt MongoDB connection
- ✅ Show connection status in logs

### 4. Verify Connection

**Option A: Check API Endpoint**
```bash
curl http://localhost:8080/api/admin/db-status
```

Expected response when connected:
```json
{
  "readyState": 1,
  "state": "connected",
  "isConnected": true,
  "hasMongoUri": true,
  "host": "linkroom.ynwmqob.mongodb.net",
  "database": "linkchat"
}
```

**Option B: Test Room Creation**
```bash
curl -X POST http://localhost:8080/api/rooms \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Room"}'
```

If connected, you'll get a 200 response with room data.
If not connected, you'll get a 503 error.

**Option C: Check Server Logs**

Look for these messages in your backend console:
- ✅ `Connected to MongoDB successfully` - Connection working!
- ❌ `MongoDB connection error` - Check IP whitelist
- ❌ `MongoServerSelectionError` - IP not whitelisted
- ❌ `MongoAuthenticationError` - Wrong credentials

### 5. Manual Reconnection (if needed)

If connection fails, try manual reconnection:
```bash
curl -X POST http://localhost:8080/api/admin/reconnect-db
```

## 🐛 Troubleshooting

### Issue: 503 Service Unavailable

**Cause**: MongoDB not connected

**Solutions**:
1. ✅ Check MongoDB Atlas IP whitelist (most common)
2. ✅ Verify `MONGO_URI` in `.env` is correct
3. ✅ Check network connectivity
4. ✅ Restart backend server after fixing IP whitelist

### Issue: Connection Timeout

**Cause**: Network/firewall blocking MongoDB

**Solutions**:
1. Check if you're behind a corporate firewall
2. Try using a VPN
3. Verify MongoDB Atlas cluster is running
4. Check your internet connection

### Issue: Authentication Error

**Cause**: Wrong username/password

**Solutions**:
1. Verify credentials in MongoDB Atlas
2. Check `MONGO_URI` in `.env` file
3. Make sure password doesn't have special characters that need URL encoding

## ✅ Verification Checklist

- [ ] `.env` file exists in `backend/` directory
- [ ] `MONGO_URI` is set in `.env`
- [ ] MongoDB Atlas IP whitelist includes your IP
- [ ] Backend server is running on port 8080
- [ ] `/api/admin/db-status` shows `"isConnected": true`
- [ ] `POST /api/rooms` returns 200 (not 503)

## 🚀 Quick Test Script

Run this to test everything:
```bash
cd backend
node test-all-endpoints.js
```

Expected output:
- ✅ Health check: 200
- ✅ Database: Connected
- ✅ Room creation: 200 with room data

## 📝 Notes

- The app automatically loads `.env` in development mode
- Connection retries up to 5 times automatically
- Server continues running even if DB is not connected (for health checks)
- Check server logs for detailed error messages


