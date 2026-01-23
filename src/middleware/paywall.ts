import { Request, Response, NextFunction } from 'express';
import { checkSubscription } from '../services/revenueCat';
import { checkAiPaywall, incrementAiUsage } from '../db/aiPaywall';

/**
 * Paywall middleware for AI analysis endpoints
 *
 * - Checks if user has active RevenueCat subscription
 * - If no subscription: limits to 3 free requests per 4 hours
 * - If subscription active: unlimited requests
 *
 * Requires userId in request body or x-user-id header
 */
export function aiPaywallMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get user ID from body or header
      const userId = req.body.userId || req.headers['x-user-id'];

      if (!userId) {
        // No user ID provided - reject request
        // AI analysis requires user identification for paywall
        return res.status(401).json({
          error: 'User identification required',
          code: 'USER_ID_REQUIRED',
          message: 'Please provide userId in request body or x-user-id header',
        });
      }

      // Check if client wants to force refresh (e.g., after purchase)
      const forceRefresh = req.headers['x-refresh-subscription'] === 'true';

      // Check subscription status via RevenueCat
      const subscriptionStatus = await checkSubscription(userId as string, forceRefresh);
      console.log(`User ${userId} subscription status:`, subscriptionStatus);

      // Check paywall limits
      const paywallResult = await checkAiPaywall(
        userId as string,
        subscriptionStatus.isActive
      );

      // Add paywall info to response headers for client
      res.setHeader('X-Paywall-Requests-Used', paywallResult.requestsUsed.toString());
      res.setHeader('X-Paywall-Requests-Limit',
        paywallResult.requestsLimit === Infinity ? 'unlimited' : paywallResult.requestsLimit.toString()
      );
      res.setHeader('X-Paywall-Has-Subscription', subscriptionStatus.isActive.toString());

      if (!paywallResult.allowed) {
        // Rate limit exceeded for free tier
        const retryAfter = paywallResult.retryAfterSeconds || 14400; // 4 hours default

        // Set Retry-After header BEFORE sending response
        res.setHeader('Retry-After', retryAfter.toString());

        console.log("formatDuration(retryAfter):", formatDuration(retryAfter));

        return res.status(403).json({
          error: 'Free tier limit exceeded',
          code: 'PAYWALL_LIMIT_EXCEEDED',
          message: 'You have used all your free AI analysis requests. Upgrade to premium for unlimited access.',
          requestsUsed: paywallResult.requestsUsed,
          requestsLimit: paywallResult.requestsLimit,
          retryAfterSeconds: retryAfter,
          retryAfterFormatted: formatDuration(retryAfter),
        });
      }

      // Increment usage counter (only for free tier, before processing)
      if (!subscriptionStatus.isActive) {
        await incrementAiUsage(userId as string);

        // Update headers with new count
        res.setHeader('X-Paywall-Requests-Used', (paywallResult.requestsUsed + 1).toString());
      }

      // Attach subscription info to request for downstream use
      (req as any).subscriptionStatus = subscriptionStatus;
      (req as any).paywallResult = paywallResult;

      next();
    } catch (error: any) {
      console.error('Paywall middleware error:', error);
      // On error, allow request to proceed (fail open) to not block users
      // But only if headers haven't been sent yet
      if (!res.headersSent) {
        next();
      }
    }
  };
}

/**
 * Format duration in seconds to human-readable string
 */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${hours}h`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${seconds}s`;
}
