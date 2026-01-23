import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

export interface CaptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface VideoExample {
  id: string;
  hash: string;
  query: string;
  videoId: string;
  startTime: number;
  endTime: number;
  caption: string;
  captions: CaptionSegment[];
  createdAt: Date;
}

export interface VideoExampleInsert {
  hash: string;
  query: string;
  videoId: string;
  startTime: number;
  endTime: number;
  caption: string;
  captions: CaptionSegment[];
}

export async function initializeDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_examples (
        id UUID PRIMARY KEY,
        hash TEXT UNIQUE NOT NULL,
        query TEXT NOT NULL,
        video_id TEXT NOT NULL,
        start_time FLOAT NOT NULL,
        end_time FLOAT NOT NULL,
        caption TEXT NOT NULL,
        captions JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_video_examples_hash ON video_examples(hash);
    `);

    // Migration: Add captions column if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'video_examples' AND column_name = 'captions'
        ) THEN
          ALTER TABLE video_examples ADD COLUMN captions JSONB NOT NULL DEFAULT '[]'::jsonb;
        END IF;
      END $$;
    `);
  } finally {
    client.release();
  }
}

export async function findByHash(hash: string): Promise<VideoExample | null> {
  const result = await pool.query(
    'SELECT id, hash, query, video_id as "videoId", start_time as "startTime", end_time as "endTime", caption, captions, created_at as "createdAt" FROM video_examples WHERE hash = $1',
    [hash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

export async function insertVideoExample(data: VideoExampleInsert): Promise<VideoExample> {
  const id = uuidv4();
  const result = await pool.query(
    `INSERT INTO video_examples (id, hash, query, video_id, start_time, end_time, caption, captions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, hash, query, video_id as "videoId", start_time as "startTime", end_time as "endTime", caption, captions, created_at as "createdAt"`,
    [id, data.hash, data.query, data.videoId, data.startTime, data.endTime, data.caption, JSON.stringify(data.captions)]
  );

  return result.rows[0];
}

export async function closePool(): Promise<void> {
  await pool.end();
}
