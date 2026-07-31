interface LogEntry {
    timestamp: string;
    level: string;
    message: string;
    [key: string]: any;
}
/** Newest-first, optionally filtered by level (exact match) and a case-insensitive substring search over message. */
export declare const getRecentLogs: (options?: {
    level?: string;
    search?: string;
    limit?: number;
}) => LogEntry[];
export declare const logger: {
    info: (message: string, meta?: Record<string, any>) => void;
    warn: (message: string, meta?: Record<string, any>) => void;
    error: (message: string, meta?: Record<string, any>) => void;
    debug: (message: string, meta?: Record<string, any>) => void;
};
export {};
//# sourceMappingURL=logger.d.ts.map