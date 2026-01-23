import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

export interface PaywallCheckResult {
  allowed: boolean;
  requestsUsed: number;
  requestsLimit: number;
  retryAfterSeconds?: number;
  hasSubscription: boolean;
}

// Default: 3 free requests per 4 hours (240 minutes)
const FREE_REQUESTS_LIMIT = parseInt(process.env.AI_FREE_REQUESTS_LIMIT || '3');
const FREE_REQUESTS_WINDOW_MINUTES = parseInt(process.env.AI_FREE_REQUESTS_WINDOW_MINUTES || '240');

export async function initializeAiPaywallDB(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_paywall_usage (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        request_count INTEGER NOT NULL DEFAULT 0,
        window_start TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_ai_paywall_user_id ON ai_paywall_usage(user_id);
      CREATE INDEX IF NOT EXISTS idx_ai_paywall_window_start ON ai_paywall_usage(window_start);
    `);
    console.log('AI paywall table initialized');
  } finally {
    client.release();
  }
}

/**
 * Check if user can make an AI request (for free tier)
 * Returns remaining requests and whether request is allowed
 */
export async function checkAiPaywall(
  userId: string,
  hasSubscription: boolean
): Promise<PaywallCheckResult> {
  // Subscribers have unlimited access
  if (hasSubscription) {
    return {
      allowed: true,
      requestsUsed: 0,
      requestsLimit: Infinity,
      hasSubscription: true,
    };
  }

  const windowDurationMs = FREE_REQUESTS_WINDOW_MINUTES * 60 * 1000;

  const result = await pool.query(
    `SELECT request_count as "requestCount", window_start as "windowStart"
     FROM ai_paywall_usage
     WHERE user_id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    // No existing record, user has full quota
    return {
      allowed: true,
      requestsUsed: 0,
      requestsLimit: FREE_REQUESTS_LIMIT,
      hasSubscription: false,
    };
  }

  const record = result.rows[0];
  const windowStartTime = new Date(record.windowStart).getTime();
  const currentTime = Date.now();
  const windowEndTime = windowStartTime + windowDurationMs;

  // Check if window has expired
  if (currentTime >= windowEndTime) {
    // Window expired, user has full quota again
    return {
      allowed: true,
      requestsUsed: 0,
      requestsLimit: FREE_REQUESTS_LIMIT,
      hasSubscription: false,
    };
  }

  // Window is still active
  const requestsUsed = record.requestCount;

  if (requestsUsed >= FREE_REQUESTS_LIMIT) {
    // Limit exceeded
    const retryAfterSeconds = Math.ceil((windowEndTime - currentTime) / 1000);
    return {
      allowed: false,
      requestsUsed,
      requestsLimit: FREE_REQUESTS_LIMIT,
      retryAfterSeconds,
      hasSubscription: false,
    };
  }

  return {
    allowed: true,
    requestsUsed,
    requestsLimit: FREE_REQUESTS_LIMIT,
    hasSubscription: false,
  };
}

/**
 * Increment AI usage counter for a user
 */
export async function incrementAiUsage(userId: string): Promise<void> {
  const windowDurationMs = FREE_REQUESTS_WINDOW_MINUTES * 60 * 1000;

  // Check if existing record exists and if window expired
  const existingResult = await pool.query(
    `SELECT id, window_start as "windowStart"
     FROM ai_paywall_usage
     WHERE user_id = $1`,
    [userId]
  );

  if (existingResult.rows.length === 0) {
    // No existing record, insert new one
    const id = uuidv4();
    await pool.query(
      `INSERT INTO ai_paywall_usage (id, user_id, request_count, window_start)
       VALUES ($1, $2, 1, CURRENT_TIMESTAMP)`,
      [id, userId]
    );
  } else {
    // Existing record found
    const record = existingResult.rows[0];
    const windowStartTime = new Date(record.windowStart).getTime();
    const currentTime = Date.now();
    const windowEndTime = windowStartTime + windowDurationMs;

    if (currentTime >= windowEndTime) {
      // Window expired, reset counter and start new window
      await pool.query(
        `UPDATE ai_paywall_usage
         SET request_count = 1, window_start = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [userId]
      );
    } else {
      // Window still active, increment counter
      await pool.query(
        `UPDATE ai_paywall_usage
         SET request_count = request_count + 1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [userId]
      );
    }
  }
}

/**
 * Get usage stats for a user (for displaying in UI)
 */
export async function getAiUsageStats(
  userId: string,
  hasSubscription: boolean
): Promise<{
  requestsUsed: number;
  requestsLimit: number;
  windowResetAt: Date | null;
  hasSubscription: boolean;
}> {
  if (hasSubscription) {
    return {
      requestsUsed: 0,
      requestsLimit: Infinity,
      windowResetAt: null,
      hasSubscription: true,
    };
  }

  const windowDurationMs = FREE_REQUESTS_WINDOW_MINUTES * 60 * 1000;

  const result = await pool.query(
    `SELECT request_count as "requestCount", window_start as "windowStart"
     FROM ai_paywall_usage
     WHERE user_id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return {
      requestsUsed: 0,
      requestsLimit: FREE_REQUESTS_LIMIT,
      windowResetAt: null,
      hasSubscription: false,
    };
  }

  const record = result.rows[0];
  const windowStartTime = new Date(record.windowStart).getTime();
  const currentTime = Date.now();
  const windowEndTime = windowStartTime + windowDurationMs;

  // Check if window has expired
  if (currentTime >= windowEndTime) {
    return {
      requestsUsed: 0,
      requestsLimit: FREE_REQUESTS_LIMIT,
      windowResetAt: null,
      hasSubscription: false,
    };
  }

  return {
    requestsUsed: record.requestCount,
    requestsLimit: FREE_REQUESTS_LIMIT,
    windowResetAt: new Date(windowEndTime),
    hasSubscription: false,
  };
}

/**
 * Cleanup expired paywall records (older than 8 hours)
 */
export async function cleanupExpiredPaywallRecords(): Promise<void> {
  await pool.query(
    `DELETE FROM ai_paywall_usage
     WHERE window_start < NOW() - INTERVAL '8 hours'`
  );
}
