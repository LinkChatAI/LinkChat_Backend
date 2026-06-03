import { Storage } from '@google-cloud/storage';
import { logger } from '../utils/logger.js';
import { env } from './env.js';
// Lazy singleton — only created when a file operation actually needs it
let storageClient = null;
let gcsInitAttempted = false;
/**
 * Lazily initialize the GCS Storage client.
 * Returns null (and logs a warning) if:
 *   - GCS_BUCKET is not configured (local fallback mode)
 *   - SDK initialization throws (bad credentials, billing closed, etc.)
 *
 * NEVER called during server startup, room creation, or text messaging.
 */
export const getStorageClient = () => {
    if (!env.GCS_BUCKET) {
        // No bucket configured — silently use local storage
        return null;
    }
    if (!gcsInitAttempted) {
        gcsInitAttempted = true;
        try {
            storageClient = new Storage({
                projectId: env.GCS_PROJECT_ID,
                credentials: {
                    client_email: env.GCS_CLIENT_EMAIL,
                    private_key: env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
                },
            });
            logger.info('GCS client initialized (lazy, first file operation)');
        }
        catch (error) {
            logger.warn('GCS client initialization failed — falling back to local storage', {
                error: error instanceof Error ? error.message : String(error),
            });
            storageClient = null;
        }
    }
    return storageClient;
};
export const getBucket = () => {
    const client = getStorageClient();
    if (!client || !env.GCS_BUCKET) {
        return null;
    }
    return client.bucket(env.GCS_BUCKET);
};
/**
 * File uploads are ALWAYS available — local storage is the unconditional fallback.
 * This function never triggers GCS initialization.
 */
export const isFileUploadAvailable = () => {
    return true;
};
//# sourceMappingURL=gcs.js.map