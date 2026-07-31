import type { File } from '@google-cloud/storage';
import { getBucket } from '../config/gcs.js';
import { RoomModel } from '../models/Room.js';
import { logger } from '../utils/logger.js';

// Objects younger than this are left alone — an in-progress upload (signed URL
// issued, browser still uploading, or the room-create request hasn't landed in
// Mongo yet) must never look like an orphan. 24h comfortably exceeds every
// legitimate delay between issuing an upload URL and its Room document
// existing.
const MIN_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
// Bounds one run's GCS list + Mongo lookup cost, same pattern as the other
// maintenance jobs (cleanupService/autoVanishService also process in batches).
const MAX_OBJECTS_PER_RUN = 1000;

/**
 * Deletes GCS objects under rooms/<code>/ whose <code> has NO matching Room
 * document at all — never objects belonging to a room that exists or ever
 * existed in Mongo. Normal room deletion already calls deleteRoomFiles() for
 * real rooms; if a Room document is gone, its files should already be gone
 * too (or that deletion partially failed, which is exactly the other case
 * this safely catches).
 *
 * Deliberately narrower than a GCS lifecycle age-rule: an age-only rule can't
 * tell an abandoned upload apart from an attachment still owned by a
 * long-lived saved/premium room. This only ever removes files with literally
 * no owner, verified against Mongo before every delete.
 */
export const reapOrphanedUploads = async (): Promise<{ scanned: number; deleted: number }> => {
  const bucket = getBucket();
  if (!bucket) {
    logger.debug('reapOrphanedUploads: GCS not configured, skipping');
    return { scanned: 0, deleted: 0 };
  }

  const [files] = await bucket.getFiles({ prefix: 'rooms/', maxResults: MAX_OBJECTS_PER_RUN });
  const now = Date.now();

  const candidatesByCode = new Map<string, File[]>();
  for (const file of files) {
    const code = file.name.split('/')[1];
    if (!code) continue;

    const timeCreated = file.metadata?.timeCreated;
    const createdAt = timeCreated ? new Date(timeCreated).getTime() : NaN;
    if (!Number.isFinite(createdAt) || now - createdAt < MIN_ORPHAN_AGE_MS) continue;

    const list = candidatesByCode.get(code) ?? [];
    list.push(file);
    candidatesByCode.set(code, list);
  }

  if (candidatesByCode.size === 0) {
    return { scanned: files.length, deleted: 0 };
  }

  const codes = [...candidatesByCode.keys()];
  const existingRooms = await RoomModel.find({ code: { $in: codes } }).select('code').lean();
  const existingCodes = new Set(existingRooms.map((r) => r.code));

  let deleted = 0;
  for (const [code, codeFiles] of candidatesByCode) {
    if (existingCodes.has(code)) continue; // a real room owns this — leave it to normal cleanup

    for (const file of codeFiles) {
      try {
        await file.delete();
        deleted++;
      } catch (error) {
        logger.warn(`reapOrphanedUploads: failed to delete ${file.name}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info(`reapOrphanedUploads: removed ${codeFiles.length} orphaned object(s) under unknown room code "${code}"`);
  }

  return { scanned: files.length, deleted };
};
