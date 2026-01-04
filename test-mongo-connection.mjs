import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: resolve(__dirname, '.env') });

const MONGO_URI = process.env.MONGO_URI || '';

console.log('=== MongoDB Connection Test ===\n');

if (!MONGO_URI) {
  console.error('❌ ERROR: MONGO_URI is not set in .env file!');
  process.exit(1);
}

// Show masked URI
const maskedUri = MONGO_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
console.log('MONGO_URI:', maskedUri);
console.log('');

// Process URI the same way as the application does
let mongoUri = MONGO_URI.trim();

// Check if URI has database name
const hasDatabase = mongoUri.match(/\/[^\/\?]+(\?|$)/);
console.log('URI Analysis:');
console.log('  Has database name:', hasDatabase ? '✓ Yes' : '✗ No');

// If URI ends with just /, add database name
if (mongoUri.endsWith('/') && !mongoUri.endsWith('//')) {
  mongoUri = mongoUri + 'linkchat';
  console.log('  → Added database name "linkchat"');
} else if (!hasDatabase && mongoUri.includes('@')) {
  // URI has credentials but no database name
  const parts = mongoUri.split('?');
  const baseUri = parts[0];
  const queryString = parts[1] ? '?' + parts[1] : '';
  if (baseUri.endsWith('/')) {
    mongoUri = baseUri + 'linkchat' + queryString;
  } else {
    mongoUri = baseUri + '/linkchat' + queryString;
  }
  console.log('  → Added database name "linkchat"');
}

console.log('\nFinal URI:', mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));
console.log('');

const connectionOptions = {
  serverSelectionTimeoutMS: 10000, // 10 seconds
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  minPoolSize: 2,
  retryWrites: true,
  w: 'majority',
};

console.log('Attempting to connect...\n');

try {
  await mongoose.connect(mongoUri, connectionOptions);
  
  // Verify connection
  if (mongoose.connection.readyState === 1) {
    console.log('✅ SUCCESS: Connected to MongoDB!');
    console.log('');
    console.log('Connection Details:');
    console.log('  Database:', mongoose.connection.db?.databaseName || 'unknown');
    console.log('  Host:', mongoose.connection.host || 'unknown');
    console.log('  Port:', mongoose.connection.port || 'unknown');
    console.log('  Ready State:', mongoose.connection.readyState, '(1 = connected)');
    console.log('');
    
    // Test a simple operation
    try {
      const collections = await mongoose.connection.db.listCollections().toArray();
      console.log('  Collections:', collections.length);
      if (collections.length > 0) {
        console.log('  Collection names:', collections.map(c => c.name).join(', '));
      }
    } catch (err) {
      console.log('  (Could not list collections)');
    }
    
    console.log('');
    console.log('✅ MongoDB connection is working correctly!');
    process.exit(0);
  } else {
    console.error('❌ Connection established but readyState is', mongoose.connection.readyState, '(expected 1)');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ ERROR: Failed to connect to MongoDB\n');
  console.error('Error Details:');
  console.error('  Name:', error.name || 'Unknown');
  console.error('  Message:', error.message || 'Unknown error');
  
  if (error.reason) {
    console.error('  Reason:', error.reason);
  }
  
  console.error('');
  console.error('--- Troubleshooting ---');
  
  if (error.message?.includes('authentication') || error.name === 'MongoAuthenticationError') {
    console.error('1. Check MongoDB username and password in MONGO_URI');
    console.error('2. Verify credentials are correct in MongoDB Atlas');
  }
  
  if (error.message?.includes('timeout') || error.name === 'MongoServerSelectionError' || error.name === 'MongoNetworkError') {
    console.error('1. Check your network connection');
    console.error('2. Verify MongoDB Atlas IP whitelist includes your IP');
    console.error('   → Go to MongoDB Atlas → Network Access → Add IP Address');
    console.error('3. Check if MongoDB Atlas cluster is running');
    console.error('4. Try using 0.0.0.0/0 for development (less secure)');
  }
  
  if (error.message?.includes('ENOTFOUND') || error.message?.includes('getaddrinfo')) {
    console.error('1. Verify the MongoDB hostname is correct');
    console.error('2. Check DNS resolution');
  }
  
  console.error('');
  process.exit(1);
}


