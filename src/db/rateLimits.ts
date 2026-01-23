import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number; // seconds until next allowed request
}

export async function initializeRateLimitDB(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        id UUID PRIMARY KEY,
        identifier TEXT NOT NULL,
        identifier_type TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 1,
        window_start TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(identifier, identifier_type)
      );

      CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier ON rate_limits(identifier, identifier_type);
      CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits(window_start);
    `);
  } finally {
    client.release();
  }
}

export async function checkRateLimit(
  identifier: string,
  identifierType: 'user' | 'ip',
  limit: number,
  windowMinutes: number
): Promise<RateLimitResult> {
  const result = await pool.query(
    `SELECT request_count as "requestCount", window_start as "windowStart"
     FROM rate_limits
     WHERE identifier = $1 AND identifier_type = $2`,
    [identifier, identifierType]
  );

  if (result.rows.length === 0) {
    // No existing record, so allowed
    return { allowed: true };
  }

  const record = result.rows[0];
  const windowStartTime = new Date(record.windowStart).getTime();
  const currentTime = Date.now();
  const windowDurationMs = windowMinutes * 60 * 1000;
  const windowEndTime = windowStartTime + windowDurationMs;

  // Check if window has expired
  if (currentTime >= windowEndTime) {
    // Window expired, allowed (will be reset on increment)
    return { allowed: true };
  }

  // Window is still active, check if limit exceeded
  if (record.requestCount >= limit) {
    // Calculate retry after in seconds
    const retryAfter = Math.ceil((windowEndTime - currentTime) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

export async function incrementRateLimit(
  identifier: string,
  identifierType: 'user' | 'ip'
): Promise<void> {
  const windowMinutes = 60; // Use 60 minutes as default window
  const windowDurationMs = windowMinutes * 60 * 1000;

  // Check if existing record exists and if window expired
  const existingResult = await pool.query(
    `SELECT id, window_start as "windowStart"
     FROM rate_limits
     WHERE identifier = $1 AND identifier_type = $2`,
    [identifier, identifierType]
  );

  if (existingResult.rows.length === 0) {
    // No existing record, insert new one
    const id = uuidv4();
    await pool.query(
      `INSERT INTO rate_limits (id, identifier, identifier_type, request_count, window_start)
       VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP)`,
      [id, identifier, identifierType]
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
        `UPDATE rate_limits
         SET request_count = 1, window_start = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE identifier = $1 AND identifier_type = $2`,
        [identifier, identifierType]
      );
    } else {
      // Window still active, increment counter
      await pool.query(
        `UPDATE rate_limits
         SET request_count = request_count + 1, updated_at = CURRENT_TIMESTAMP
         WHERE identifier = $1 AND identifier_type = $2`,
        [identifier, identifierType]
      );
    }
  }
}

export async function cleanupExpiredRateLimits(): Promise<void> {
  // Delete rate limit records older than 2 hours
  await pool.query(
    `DELETE FROM rate_limits
     WHERE window_start < NOW() - INTERVAL '2 hours'`
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
