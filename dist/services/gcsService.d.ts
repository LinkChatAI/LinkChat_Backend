/**
 * Probe GCS with a real API call to verify billing + auth are working.
 * Result is cached for GCS_HEALTH_CACHE_MS to avoid repeated probing.
 */
/** Mark GCS unavailable (e.g. client reported billing/auth failure on upload). */
export declare const markGcsUnavailable: () => void;
export declare const probeGcsHealth: () => Promise<boolean>;
export declare const generateLocalUploadUrl: (roomCode: string, fileName: string) => Promise<{
    uploadUrl: string;
    filePath: string;
}>;
/**
 * Generate an upload URL.
 *
 * Priority:
 *   1. GCS (if configured AND health probe passes — billing + auth must be working)
 *   2. Local storage (automatic hard fallback on ANY GCS issue)
 *
 * NEVER throws due to GCS issues.
 */
export declare const generateUploadUrl: (roomCode: string, fileName: string, mimeType: string, fileSize: number) => Promise<{
    uploadUrl: string;
    filePath: string;
    isLocal?: boolean;
}>;
/**
 * Get the public/serve URL for a stored file.
 * Hard-falls back to local URL if GCS is unavailable.
 * NEVER throws.
 */
export declare const getFileUrl: (filePath: string) => string;
/**
 * Get a signed inline URL for displaying an image/video.
 * Hard-falls back to local URL on any GCS error.
 * NEVER throws.
 */
export declare const getImageUrl: (filePath: string) => Promise<string>;
/**
 * Get a signed download URL for a file attachment.
 * Hard-falls back to local URL on any GCS error.
 * NEVER throws.
 */
export declare const getDownloadUrl: (filePath: string, fileName: string) => Promise<string>;
/**
 * Expose current GCS health status for fileController to use.
 */
export declare const isGcsHealthy: () => boolean;
/**
 * Delete files for a specific room.
 * Failures are logged but never propagated.
 */
export declare const deleteRoomFiles: (roomCode: string) => Promise<{
    gcs: number;
    local: boolean;
}>;
/**
 * Whether any file bytes remain for a room, across both backends. Used by the
 * cleanup verifier to assert a purge actually left nothing behind.
 */
export declare const countRoomFiles: (roomCode: string) => Promise<{
    gcs: number;
    local: number;
}>;
//# sourceMappingURL=gcsService.d.ts.map