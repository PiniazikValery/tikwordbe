import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

export async function initializeIndexedVideosTable(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS indexed_videos (
        video_id TEXT PRIMARY KEY,
        title TEXT,
        popularity_score INTEGER,
        view_count BIGINT,
        like_count BIGINT,
        comment_count BIGINT,
        indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✓ Indexed videos table initialized');
  } finally {
    client.release();
  }
}

export async function isVideoIndexed(videoId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM indexed_videos WHERE video_id = $1',
    [videoId]
  );
  return result.rows.length > 0;
}

export async function markVideoIndexed(
  videoId: string,
  title: string,
  popularityScore: number | undefined,
  viewCount: number | undefined,
  likeCount: number | undefined,
  commentCount: number | undefined
): Promise<void> {
  await pool.query(
    `INSERT INTO indexed_videos (video_id, title, popularity_score, view_count, like_count, comment_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (video_id) DO UPDATE SET
       popularity_score = $3,
       view_count = $4,
       like_count = $5,
       comment_count = $6`,
    [videoId, title, popularityScore ?? null, viewCount ?? null, likeCount ?? null, commentCount ?? null]
  );
}

export async function getIndexedVideoCount(): Promise<number> {
  const result = await pool.query('SELECT COUNT(*) as count FROM indexed_videos');
  return parseInt(result.rows[0].count || '0');
}

export async function closeIndexedVideosPool(): Promise<void> {
  await pool.end();
}
