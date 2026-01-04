// Simple connection test using the same logic as the app
import http from 'http';

const testConnection = () => {
  return new Promise((resolve) => {
    http.get('http://localhost:8080/api/admin/db-status', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    }).on('error', err => resolve({ error: err.message }));
  });
};

testConnection().then(result => {
  console.log('\n=== MongoDB Connection Status ===\n');
  if (result.error) {
    console.error('❌ Error:', result.error);
    console.error('Make sure the backend server is running on port 8080');
  } else if (result.data) {
    const db = result.data;
    console.log('Ready State:', db.readyState, `(${db.state})`);
    console.log('Connected:', db.isConnected ? '✅ YES' : '❌ NO');
    console.log('Has MONGO_URI:', db.hasMongoUri ? '✅ YES' : '❌ NO');
    console.log('Host:', db.host || 'N/A');
    console.log('Database:', db.database || 'N/A');
    console.log('');
    
    if (db.isConnected) {
      console.log('✅ MongoDB is connected correctly!');
    } else {
      console.log('❌ MongoDB is NOT connected');
      console.log('');
      console.log('To fix:');
      console.log('1. Check MongoDB Atlas IP whitelist');
      console.log('2. Verify MONGO_URI in backend/.env');
      console.log('3. Check network connectivity');
      console.log('4. Try: POST http://localhost:8080/api/admin/reconnect-db');
    }
  }
  console.log('');
});


