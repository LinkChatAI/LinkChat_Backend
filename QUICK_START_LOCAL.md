# Quick Start for Local Development

## 🚀 Get MongoDB Working in 3 Steps

### Step 1: Whitelist Your IP in MongoDB Atlas

**This is required!** Without this, MongoDB Atlas will reject your connection.

1. Go to https://cloud.mongodb.com/
2. Click **Network Access** (left sidebar)
3. Click **"Add IP Address"**
4. Click **"Add Current IP Address"** (or enter `0.0.0.0/0` for dev)
5. Click **Confirm**
6. **Wait 2-3 minutes** ⏰

### Step 2: Verify .env File

Check `backend/.env` has:
```env
MONGO_URI=mongodb+srv://linkroomteam_db_user:3ShqCarYgdX2jozA@linkroom.ynwmqob.mongodb.net/linkchat
```

### Step 3: Start Backend

```bash
cd backend
npm run dev
```

Watch the logs for:
- ✅ `Connected to MongoDB successfully` = Working!
- ❌ `MongoServerSelectionError` = IP not whitelisted (go back to Step 1)

## ✅ Test It Works

```bash
# Check connection status
curl http://localhost:8081/api/admin/db-status

# Auth smoke test (requires OAuth env vars in .env)
node test-auth.mjs

# Create a test room
curl -X POST http://localhost:8081/api/rooms \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Room"}'
```

**Google sign-in:** `http://localhost:8081/api/auth/google?returnTo=/` — see **`AUTH.md`**.

If you get a 200 response with room data, **it's working!** 🎉

## 🐛 Still Not Working?

**Most common issue**: IP not whitelisted in MongoDB Atlas
- Go back to Step 1
- Make sure you clicked "Confirm" and waited 2-3 minutes
- Try using `0.0.0.0/0` temporarily for testing

**Other issues**:
- Check your internet connection
- Verify MongoDB cluster is running in Atlas
- Check server logs for specific error messages

## 📝 Full Guide

See `LOCAL_DEVELOPMENT_SETUP.md` for detailed troubleshooting.


