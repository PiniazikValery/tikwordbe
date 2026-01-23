import { Request, Response, NextFunction } from 'express';
import { checkRateLimit, incrementRateLimit } from '../db/rateLimits';

export interface RateLimitConfig {
  userLimit: number;      // Requests per hour for authenticated users
  ipLimit: number;        // Requests per hour for unauthenticated requests
  windowMinutes: number;  // Time window in minutes (60 for 1 hour)
}

const DEFAULT_CONFIG: RateLimitConfig = {
  userLimit: parseInt(process.env.RATE_LIMIT_USER_PER_HOUR || '30'),
  ipLimit: parseInt(process.env.RATE_LIMIT_IP_PER_HOUR || '10'),
  windowMinutes: 60
};

export function rateLimitMiddleware(config: RateLimitConfig = DEFAULT_CONFIG) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Determine identifier (userId if authenticated, else IP)
      const userId = req.body.userId || req.headers['x-user-id'];
      const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';

      let identifier: string;
      let identifierType: 'user' | 'ip';
      let limit: number;

      if (userId) {
        identifier = userId as string;
        identifierType = 'user';
        limit = config.userLimit;
      } else {
        identifier = ipAddress;
        identifierType = 'ip';
        limit = config.ipLimit;
      }

      // Check rate limit
      const result = await checkRateLimit(
        identifier,
        identifierType,
        limit,
        config.windowMinutes
      );

      if (!result.allowed) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter: result.retryAfter
        }).header('Retry-After', result.retryAfter?.toString() || '3600');
      }

      // Increment counter
      await incrementRateLimit(identifier, identifierType);

      next();
    } catch (error: any) {
      console.error('Rate limit middleware error:', error);
      // On error, allow request to proceed (fail open)
      next();
    }
  };
}
