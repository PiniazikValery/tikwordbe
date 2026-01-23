/**
 * RevenueCat API integration for subscription verification
 */

interface RevenueCatSubscriber {
  request_date: string;
  request_date_ms: number;
  subscriber: {
    entitlements: {
      [key: string]: {
        expires_date: string | null;
        grace_period_expires_date: string | null;
        product_identifier: string;
        purchase_date: string;
      };
    };
    subscriptions: {
      [key: string]: {
        billing_issues_detected_at: string | null;
        expires_date: string;
        grace_period_expires_date: string | null;
        is_sandbox: boolean;
        original_purchase_date: string;
        ownership_type: string;
        period_type: string;
        purchase_date: string;
        store: string;
        unsubscribe_detected_at: string | null;
      };
    };
    non_subscriptions: Record<string, unknown>;
    first_seen: string;
    last_seen: string;
    management_url: string | null;
    original_app_user_id: string;
    original_application_version: string | null;
    original_purchase_date: string | null;
    other_purchases: Record<string, unknown>;
  };
}

export interface SubscriptionStatus {
  isActive: boolean;
  entitlementId?: string;
  expiresDate?: Date;
  productId?: string;
  willRenew: boolean;
}

// Cache for subscription status to avoid hammering RevenueCat API
const subscriptionCache = new Map<string, { status: SubscriptionStatus; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

/**
 * Check if a user has an active subscription via RevenueCat
 * @param appUserId - The RevenueCat user ID
 * @param forceRefresh - If true, bypasses cache and fetches fresh data from RevenueCat
 */
export async function checkSubscription(appUserId: string, forceRefresh: boolean = false): Promise<SubscriptionStatus> {
  console.log('Checking subscription for user:', appUserId, forceRefresh ? '(force refresh)' : '');
  const apiKey = process.env.REVENUECAT_API_KEY;

  if (!apiKey) {
    console.warn('REVENUECAT_API_KEY not configured, treating all users as free');
    return { isActive: false, willRenew: false };
  }

  // Check cache first (unless force refresh)
  if (!forceRefresh) {
    const cached = subscriptionCache.get(appUserId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.status;
    }
  } else {
    // Clear cache for this user on force refresh
    subscriptionCache.delete(appUserId);
  }

  try {
    const response = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`RevenueCat API response status for user ${appUserId}: ${response.status}`);

    if (!response.ok) {
      if (response.status === 404) {
        // User not found in RevenueCat - treat as free user
        // Don't cache - user might register/purchase soon
        return { isActive: false, willRenew: false };
      }

      console.error(`RevenueCat API error: ${response.status} ${response.statusText}`);
      // On API error, fail open (allow request) but don't cache
      return { isActive: false, willRenew: false };
    }

    const data = await response.json() as RevenueCatSubscriber;

    // Debug: log entitlements and subscriptions from RevenueCat
    console.log(`RevenueCat entitlements for ${appUserId}:`, JSON.stringify(data.subscriber.entitlements, null, 2));
    console.log(`RevenueCat subscriptions for ${appUserId}:`, JSON.stringify(data.subscriber.subscriptions, null, 2));

    const status = parseSubscriptionStatus(data);

    // Only cache active subscriptions - don't cache inactive status
    // so users get immediate access after purchasing
    if (status.isActive) {
      subscriptionCache.set(appUserId, { status, cachedAt: Date.now() });
    } else {
      // Clear any stale cache for this user
      subscriptionCache.delete(appUserId);
    }

    return status;
  } catch (error) {
    console.error('Error checking RevenueCat subscription:', error);
    // On network error, fail open (allow request)
    return { isActive: false, willRenew: false };
  }
}

/**
 * Parse RevenueCat response to determine subscription status
 */
function parseSubscriptionStatus(data: RevenueCatSubscriber): SubscriptionStatus {
  const entitlements = data.subscriber.entitlements;
  const subscriptions = data.subscriber.subscriptions;

  // Check for active entitlements
  // You can configure the entitlement ID in environment variable
  const premiumEntitlementId = process.env.REVENUECAT_ENTITLEMENT_ID || 'premium';

  // First check specific entitlement
  if (entitlements[premiumEntitlementId]) {
    const entitlement = entitlements[premiumEntitlementId];
    const expiresDate = entitlement.expires_date ? new Date(entitlement.expires_date) : null;

    if (!expiresDate || expiresDate > new Date()) {
      return {
        isActive: true,
        entitlementId: premiumEntitlementId,
        expiresDate: expiresDate || undefined,
        productId: entitlement.product_identifier,
        willRenew: true, // Assume will renew if active
      };
    }
  }

  // Check all entitlements if specific one not found
  for (const [entitlementId, entitlement] of Object.entries(entitlements)) {
    const expiresDate = entitlement.expires_date ? new Date(entitlement.expires_date) : null;

    if (!expiresDate || expiresDate > new Date()) {
      // Check if subscription is set to not renew
      const productSub = subscriptions[entitlement.product_identifier];
      const willRenew = productSub ? !productSub.unsubscribe_detected_at : true;

      return {
        isActive: true,
        entitlementId,
        expiresDate: expiresDate || undefined,
        productId: entitlement.product_identifier,
        willRenew,
      };
    }
  }

  return { isActive: false, willRenew: false };
}

/**
 * Clear subscription cache for a specific user
 */
export function clearSubscriptionCache(appUserId: string): void {
  subscriptionCache.delete(appUserId);
}

/**
 * Clear entire subscription cache
 */
export function clearAllSubscriptionCache(): void {
  subscriptionCache.clear();
}
