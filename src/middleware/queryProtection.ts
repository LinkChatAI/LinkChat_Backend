import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

interface QueryProtectionOptions {
  maxResultLimit?: number;
  defaultLimit?: number;
  timeoutMs?: number;
  requireIndex?: boolean;
}

const DEFAULT_OPTIONS: Required<QueryProtectionOptions> = {
  maxResultLimit: 10000,
  defaultLimit: 100,
  timeoutMs: 10000, // 10 seconds
  requireIndex: true,
};

export const protectQuery = (options: QueryProtectionOptions = {}) => {
  const config = { ...DEFAULT_OPTIONS, ...options };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Add query timeout
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn('Query timeout exceeded', {
          path: req.path,
          timeout: config.timeoutMs,
        });
        res.status(504).json({
          error: 'Query timeout',
          message: `Query exceeded maximum time limit of ${config.timeoutMs}ms`,
        });
      }
    }, config.timeoutMs);

    // Clear timeout on response
    const originalEnd = res.end.bind(res);
    res.end = function (chunk?: any) {
      clearTimeout(timeout);
      return originalEnd(chunk);
    };

    // Validate and set limits
    const limit = Math.min(
      parseInt(req.query.limit as string) || config.defaultLimit,
      config.maxResultLimit
    );
    
    // Add limit to request for controllers to use
    (req as any).queryLimit = limit;
    (req as any).queryTimeout = config.timeoutMs;

    next();
  };
};

// Circuit breaker for expensive operations
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private threshold: number = 5,
    private timeout: number = 60000 // 1 minute
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = 0;
      }
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();
      
      if (this.failures >= this.threshold) {
        this.state = 'open';
        logger.warn('Circuit breaker opened', {
          failures: this.failures,
          threshold: this.threshold,
        });
      }
      
      throw error;
    }
  }
}

const dashboardCircuitBreaker = new CircuitBreaker(5, 60000);

export const protectDashboardQuery = () => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await dashboardCircuitBreaker.execute(async () => {
        next();
      });
    } catch (error) {
      res.status(503).json({
        error: 'Service temporarily unavailable',
        message: 'Dashboard queries are currently rate-limited. Please try again later.',
      });
    }
  };
};

