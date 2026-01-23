import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

export interface VideoResponse {
  videoId: string;
  videoUrl: string;
  startTime: number;
  endTime: number;
  caption: string;
  captions: Array<{
    start: number;
    end: number;
    text: string;
  }>;
}

export interface WordIndexEntry {
  word: string;
  videoExamples: VideoResponse[];
  createdAt: Date;
  updatedAt: Date;
}

export async function initializeWordIndexTable(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS word_index (
        word TEXT PRIMARY KEY,
        video_examples JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_word_index_word ON word_index(word);
    `);
    console.log('✓ Word index table initialized');
  } finally {
    client.release();
  }
}

/**
 * Extract all unique words from captions
 */
export function extractWords(caption: string): string[] {
  // Remove punctuation and split by whitespace
  const words = caption
    .toLowerCase()
    .replace(/[.,!?;:'"()\[\]{}—–-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 0);

  // Return unique words
  return [...new Set(words)];
}

/**
 * Add a video example to the word index for the given words
 */
export async function addVideoToWordIndex(
  words: string[],
  videoResponse: VideoResponse
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const word of words) {
      // Check if word already exists
      const existingResult = await client.query(
        'SELECT video_examples FROM word_index WHERE word = $1',
        [word]
      );

      let videoExamples: VideoResponse[] = [];

      if (existingResult.rows.length > 0) {
        videoExamples = existingResult.rows[0].video_examples;

        // Check if this video is already in the array (prevent duplicates)
        const isDuplicate = videoExamples.some(
          example => example.videoId === videoResponse.videoId &&
                     example.startTime === videoResponse.startTime &&
                     example.endTime === videoResponse.endTime
        );

        if (isDuplicate) {
          continue; // Skip if already exists
        }

        // Add new video to the array
        videoExamples.push(videoResponse);

        // Update existing entry
        await client.query(
          `UPDATE word_index
           SET video_examples = $1, updated_at = CURRENT_TIMESTAMP
           WHERE word = $2`,
          [JSON.stringify(videoExamples), word]
        );
      } else {
        // Insert new entry
        await client.query(
          `INSERT INTO word_index (word, video_examples, created_at, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [word, JSON.stringify([videoResponse])]
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Find all video examples for a given word
 */
export async function findByWord(word: string): Promise<VideoResponse[] | null> {
  const result = await pool.query(
    'SELECT video_examples FROM word_index WHERE word = $1',
    [word.toLowerCase()]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].video_examples;
}

/**
 * Get all indexed words (for debugging/admin purposes)
 */
export async function getAllWords(limit: number = 100, offset: number = 0): Promise<string[]> {
  const result = await pool.query(
    'SELECT word FROM word_index ORDER BY word LIMIT $1 OFFSET $2',
    [limit, offset]
  );

  return result.rows.map(row => row.word);
}

/**
 * Get word count statistics
 */
export async function getWordIndexStats(): Promise<{ totalWords: number; totalMappings: number }> {
  const result = await pool.query(`
    SELECT
      COUNT(*) as total_words,
      SUM(jsonb_array_length(video_examples)) as total_mappings
    FROM word_index
  `);

  return {
    totalWords: parseInt(result.rows[0].total_words || '0'),
    totalMappings: parseInt(result.rows[0].total_mappings || '0')
  };
}

export async function closePool(): Promise<void> {
  await pool.end();
}
