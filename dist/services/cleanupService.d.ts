/**
 * Purges rooms sequentially rather than in parallel. Each purge does GCS list
 * + delete, several Mongo deletes, a Redis pipeline, and a socket fan-out;
 * running 200 of those concurrently is exactly the kind of burst that stalls
 * the event loop and drops live connections on a shared instance.
 */
export declare const cleanupExpiredRooms: () => Promise<number>;
export declare const cleanupEndedRooms: () => Promise<number>;
export declare const runCleanupTick: () => Promise<void>;
export declare const startCleanupJob: () => NodeJS.Timeout;
//# sourceMappingURL=cleanupService.d.ts.map