#!/usr/bin/env node
/**
 * Drops the legacy TTL index on rooms.expiresAt.
 *
 * WHY THIS MIGRATION EXISTS
 * -------------------------
 * The Room schema used to declare `{ expiresAt: 1 }, { expireAfterSeconds: 0 }`.
 * A TTL index makes mongod delete the document itself, running zero application
 * code. Everything else a room owns — GCS/local file objects, Redis keys,
 * per-instance in-memory state, connected sockets — is cleaned up by app code
 * that finds the expired Room first. Mongo's TTL monitor sweeps every 60s and
 * always won that race, so the cleanup sweep found nothing and every other
 * resource was orphaned.
 *
 * Removing `expireAfterSeconds` from the schema is NOT enough: Mongoose only
 * creates indexes, it never drops ones that already exist. Until this script
 * runs against a deployment, mongod keeps deleting rooms behind the app's back
 * and the cleanup fix has no effect there.
 *
 * The replacement plain index on expiresAt is created by Mongoose on boot; this
 * script also creates it directly so ordering doesn't matter.
 *
 * USAGE
 *   node scripts/drop-room-ttl-index.mjs            # dry run, reports only
 *   node scripts/drop-room-ttl-index.mjs --apply    # actually drop
 *
 * Reads MONGODB_URI (or MONGO_URI) from the environment.
 */

import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const uri = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!uri) {
  console.error('ERROR: set MONGODB_URI (or MONGO_URI) before running this script.');
  process.exit(1);
}

const REPLACEMENT_INDEX_NAME = 'expiresAt_1';

const main = async () => {
  console.log(`Connecting to MongoDB... (mode: ${APPLY ? 'APPLY' : 'DRY RUN'})`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  const collection = mongoose.connection.db.collection('rooms');
  const indexes = await collection.indexes();

  console.log(`\nIndexes currently on "rooms" (${indexes.length}):`);
  for (const index of indexes) {
    const ttl =
      index.expireAfterSeconds !== undefined
        ? `  <-- TTL expireAfterSeconds=${index.expireAfterSeconds}`
        : '';
    console.log(`  ${index.name}: ${JSON.stringify(index.key)}${ttl}`);
  }

  const ttlIndexes = indexes.filter((i) => i.expireAfterSeconds !== undefined);

  if (ttlIndexes.length === 0) {
    console.log('\nNo TTL index on "rooms" — nothing to drop. Already migrated.');
  } else {
    console.log(`\nFound ${ttlIndexes.length} TTL index(es) to drop:`);
    for (const index of ttlIndexes) {
      console.log(`  ${index.name} ${JSON.stringify(index.key)}`);
    }

    if (!APPLY) {
      console.log('\nDRY RUN — nothing changed. Re-run with --apply to drop these.');
    } else {
      for (const index of ttlIndexes) {
        await collection.dropIndex(index.name);
        console.log(`  dropped ${index.name}`);
      }
    }
  }

  // The expiry sweep queries { expiresAt: { $lt: now } } every few minutes and
  // needs a plain index to stay cheap.
  const hasReplacement = (await collection.indexes()).some(
    (i) => i.name === REPLACEMENT_INDEX_NAME && i.expireAfterSeconds === undefined,
  );

  if (hasReplacement) {
    console.log(`\nReplacement index "${REPLACEMENT_INDEX_NAME}" is present.`);
  } else if (!APPLY) {
    console.log(`\nDRY RUN — would create plain index "${REPLACEMENT_INDEX_NAME}".`);
  } else {
    await collection.createIndex({ expiresAt: 1 }, { name: REPLACEMENT_INDEX_NAME });
    console.log(`\nCreated plain index "${REPLACEMENT_INDEX_NAME}".`);
  }

  if (APPLY) {
    const expiredCount = await collection.countDocuments({ expiresAt: { $lt: new Date() } });
    console.log(
      `\nDone. ${expiredCount} already-expired room(s) are now visible to the cleanup sweep;` +
        ' they will be purged on its next tick (default: every 5 minutes).',
    );
    console.log(
      'Next: run the orphan reconciliation to clear the backlog the old TTL behaviour left behind:\n' +
        '  POST /api/admin/maintenance/run?job=reconcile-orphans',
    );
  }

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error('Migration failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
