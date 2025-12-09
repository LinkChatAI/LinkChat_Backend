type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: any;
}

const formatLog = (level: LogLevel, message: string, meta?: Record<string, any>): string => {
  const entry: LogEntry = {
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

const log = (level: LogLevel, message: string, meta?: Record<string, any>): void => {
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
  info: (message: string, meta?: Record<string, any>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, any>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, any>) => log('error', message, meta),
  debug: (message: string, meta?: Record<string, any>) => log('debug', message, meta),
};
