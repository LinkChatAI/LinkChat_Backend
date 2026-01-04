import http from 'http';

const BASE_URL = 'http://localhost:8080';

const testEndpoint = (method, path, data = null) => {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: 8080,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    if (data) {
      const jsonData = JSON.stringify(data);
      options.headers['Content-Length'] = Buffer.byteLength(jsonData);
    }

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body,
          success: res.statusCode >= 200 && res.statusCode < 300
        });
      });
    });

    req.on('error', (error) => {
      resolve({
        status: 0,
        error: error.message,
        success: false
      });
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
};

const runTests = async () => {
  console.log('=== Testing Backend API Endpoints ===\n');

  // Test 1: Health Check
  console.log('1. Testing GET /healthz...');
  const healthCheck = await testEndpoint('GET', '/healthz');
  console.log(`   Status: ${healthCheck.status}`);
  if (healthCheck.success) {
    console.log('   ✓ Health check passed');
  } else {
    console.log('   ✗ Health check failed');
  }
  console.log('');

  // Test 2: Readiness Check
  console.log('2. Testing GET /ready...');
  const readiness = await testEndpoint('GET', '/ready');
  console.log(`   Status: ${readiness.status}`);
  try {
    const parsed = JSON.parse(readiness.body);
    console.log(`   Database: ${parsed.checks?.database ? '✓ Connected' : '✗ Not Connected'}`);
    console.log(`   Redis: ${parsed.checks?.redis ? '✓ Connected' : '✗ Not Connected'}`);
  } catch (e) {
    console.log(`   Response: ${readiness.body}`);
  }
  console.log('');

  // Test 3: Create Room (POST /api/rooms)
  console.log('3. Testing POST /api/rooms...');
  const createRoom = await testEndpoint('POST', '/api/rooms', { name: 'Test Room' });
  console.log(`   Status: ${createRoom.status}`);
  if (createRoom.success) {
    console.log('   ✓ Room created successfully');
    try {
      const parsed = JSON.parse(createRoom.body);
      console.log(`   Room Code: ${parsed.code}`);
      console.log(`   Room Slug: ${parsed.slug || 'N/A'}`);
    } catch (e) {
      console.log(`   Response: ${createRoom.body}`);
    }
  } else {
    console.log('   ✗ Failed to create room');
    try {
      const parsed = JSON.parse(createRoom.body);
      console.log(`   Error: ${parsed.error}`);
      if (createRoom.status === 503) {
        console.log('   ⚠ Database connection required for this endpoint');
      }
    } catch (e) {
      console.log(`   Response: ${createRoom.body}`);
    }
  }
  console.log('');

  // Test 4: Create Room without name
  console.log('4. Testing POST /api/rooms (no name)...');
  const createRoomNoName = await testEndpoint('POST', '/api/rooms', {});
  console.log(`   Status: ${createRoomNoName.status}`);
  if (createRoomNoName.success) {
    console.log('   ✓ Room created successfully');
  } else {
    console.log('   ✗ Failed to create room');
  }
  console.log('');

  // Summary
  console.log('=== Test Summary ===');
  const tests = [
    { name: 'Health Check', result: healthCheck.success },
    { name: 'Create Room', result: createRoom.success },
  ];
  
  const passed = tests.filter(t => t.result).length;
  const total = tests.length;
  
  console.log(`Passed: ${passed}/${total}`);
  
  if (createRoom.status === 503) {
    console.log('\n⚠ WARNING: Database connection is required for room creation.');
    console.log('   The server is running but MongoDB is not connected.');
    console.log('   Check:');
    console.log('   1. MongoDB Atlas IP whitelist includes your IP');
    console.log('   2. MONGO_URI in .env is correct');
    console.log('   3. Network connectivity to MongoDB Atlas');
    console.log('   4. Try: POST /api/admin/reconnect-db to manually reconnect');
  }
};

runTests().catch(console.error);

