import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

export type JobStatus = 'queued' | 'searching' | 'downloading' | 'transcribing' | 'completed' | 'failed';

export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface JobResult {
  videoId: string;
  videoUrl: string;
  startTime: number;
  endTime: number;
  caption: string;
  captions: CaptionSegment[];
}

export interface Job {
  id: string;
  hash: string;
  query: string;
  normalizedQuery: string;
  queryType: 'word' | 'sentence';
  status: JobStatus;
  currentVideoId?: string;
  result?: JobResult;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobInsert {
  hash: string;
  query: string;
  normalizedQuery: string;
  queryType: 'word' | 'sentence';
}

export async function initializeJobQueue(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS job_queue (
        id UUID PRIMARY KEY,
        hash TEXT UNIQUE NOT NULL,
        query TEXT NOT NULL,
        normalized_query TEXT NOT NULL,
        query_type TEXT NOT NULL DEFAULT 'word',
        status TEXT NOT NULL,
        current_video_id TEXT,
        result JSONB,
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_job_queue_hash ON job_queue(hash);
      CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
    `);

    // Add query_type column if it doesn't exist (for existing tables)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'job_queue' AND column_name = 'query_type'
        ) THEN
          ALTER TABLE job_queue ADD COLUMN query_type TEXT NOT NULL DEFAULT 'word';
        END IF;
      END $$;
    `);
  } finally {
    client.release();
  }
}

export async function findJobByHash(hash: string): Promise<Job | null> {
  const result = await pool.query(
    `SELECT id, hash, query, normalized_query as "normalizedQuery",
            query_type as "queryType", status,
            current_video_id as "currentVideoId", result, error,
            created_at as "createdAt", updated_at as "updatedAt"
     FROM job_queue WHERE hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

export async function findJobById(id: string): Promise<Job | null> {
  const result = await pool.query(
    `SELECT id, hash, query, normalized_query as "normalizedQuery",
            query_type as "queryType", status,
            current_video_id as "currentVideoId", result, error,
            created_at as "createdAt", updated_at as "updatedAt"
     FROM job_queue WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

export async function createJob(data: JobInsert): Promise<Job> {
  const id = uuidv4();
  const result = await pool.query(
    `INSERT INTO job_queue (id, hash, query, normalized_query, query_type, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')
     RETURNING id, hash, query, normalized_query as "normalizedQuery",
               query_type as "queryType", status,
               current_video_id as "currentVideoId", result, error,
               created_at as "createdAt", updated_at as "updatedAt"`,
    [id, data.hash, data.query, data.normalizedQuery, data.queryType]
  );

  return result.rows[0];
}

export async function updateJobStatus(
  hash: string,
  status: JobStatus,
  currentVideoId?: string
): Promise<void> {
  await pool.query(
    `UPDATE job_queue
     SET status = $1, current_video_id = $2, updated_at = CURRENT_TIMESTAMP
     WHERE hash = $3`,
    [status, currentVideoId, hash]
  );
}

export async function updateJobResult(
  hash: string,
  result: JobResult
): Promise<void> {
  await pool.query(
    `UPDATE job_queue
     SET status = 'completed', result = $1, updated_at = CURRENT_TIMESTAMP
     WHERE hash = $2`,
    [JSON.stringify(result), hash]
  );
}

export async function updateJobError(
  hash: string,
  error: string
): Promise<void> {
  await pool.query(
    `UPDATE job_queue
     SET status = 'failed', error = $1, updated_at = CURRENT_TIMESTAMP
     WHERE hash = $2`,
    [error, hash]
  );
}

export async function getQueuedJobs(): Promise<Job[]> {
  const result = await pool.query(
    `SELECT id, hash, query, normalized_query as "normalizedQuery",
            query_type as "queryType", status,
            current_video_id as "currentVideoId", result, error,
            created_at as "createdAt", updated_at as "updatedAt"
     FROM job_queue
     WHERE status = 'queued'
     ORDER BY created_at ASC`
  );

  return result.rows;
}

export async function closeJobQueuePool(): Promise<void> {
  await pool.end();
}
