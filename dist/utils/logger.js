const formatLog = (level, message, meta) => {
    const entry = {
        timestamp: new Date().toISOString(),
        level: level.toUpperCase(),
        message,
        ...meta,
    };
    if (process.env.NODE_ENV === 'production') {
        return JSON.stringify(entry);
    }
    // Pretty format for development
    const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `[${entry.timestamp}] [${entry.level}] ${message}${metaStr}`;
};
const log = (level, message, meta) => {
    const formatted = formatLog(level, message, meta);
    switch (level) {
        case 'error':
            console.error(formatted);
            break;
        case 'warn':
            console.warn(formatted);
            break;
        case 'debug':
            if (process.env.NODE_ENV === 'development') {
                console.debug(formatted);
            }
            break;
        default:
            console.log(formatted);
    }
};
export const logger = {
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
    debug: (message, meta) => log('debug', message, meta),
};
//# sourceMappingURL=logger.js.map