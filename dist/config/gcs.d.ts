import { Storage } from '@google-cloud/storage';
/**
 * Lazily initialize the GCS Storage client.
 * Returns null (and logs a warning) if:
 *   - GCS_BUCKET is not configured (local fallback mode)
 *   - SDK initialization throws (bad credentials, billing closed, etc.)
 *
 * NEVER called during server startup, room creation, or text messaging.
 */
export declare const getStorageClient: () => Storage | null;
export declare const getBucket: () => import("@google-cloud/storage").Bucket | null;
/**
 * File uploads are ALWAYS available — local storage is the unconditional fallback.
 * This function never triggers GCS initialization.
 */
export declare const isFileUploadAvailable: () => boolean;
//# sourceMappingURL=gcs.d.ts.map