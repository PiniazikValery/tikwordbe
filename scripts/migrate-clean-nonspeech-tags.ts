import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

function stripNonSpeechTags(text: string): string {
  return text
    .replace(/\[[\w\s]+\]/gi, '')
    .replace(/>>\s*[\w\s]*:/g, '')
    .replace(/>>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Starting migration: Cleaning non-speech tags ([Music], [Applause], etc.)...\n');

    // Step 1: Clean video_examples table
    console.log('Step 1: Cleaning video_examples table...');
    const videoExamples = await client.query(
      `SELECT id, caption, captions FROM video_examples WHERE caption ~ '\\[\\w+\\]' OR caption ~ '>>'`
    );
    console.log(`  Found ${videoExamples.rows.length} rows with non-speech tags`);

    for (const row of videoExamples.rows) {
      const cleanedCaption = stripNonSpeechTags(row.caption);
      const cleanedCaptions = (row.captions as Array<{ start: number; end: number; text: string }>)
        .map(c => ({ ...c, text: stripNonSpeechTags(c.text) }))
        .filter(c => c.text.length > 0);

      await client.query(
        `UPDATE video_examples SET caption = $1, captions = $2 WHERE id = $3`,
        [cleanedCaption, JSON.stringify(cleanedCaptions), row.id]
      );
    }
    console.log(`  ✓ Cleaned ${videoExamples.rows.length} rows in video_examples`);

    // Step 2: Clean word_index table
    console.log('\nStep 2: Cleaning word_index table...');
    const wordIndexRows = await client.query(
      `SELECT word, video_examples FROM word_index WHERE video_examples::text ~ '\\[\\w+\\]' OR video_examples::text ~ '>>'`
    );
    console.log(`  Found ${wordIndexRows.rows.length} rows with non-speech tags`);

    for (const row of wordIndexRows.rows) {
      const examples = row.video_examples as Array<{
        caption: string;
        captions: Array<{ start: number; end: number; text: string }>;
      }>;

      const cleanedExamples = examples.map(example => ({
        ...example,
        caption: stripNonSpeechTags(example.caption),
        captions: example.captions
          .map(c => ({ ...c, text: stripNonSpeechTags(c.text) }))
          .filter(c => c.text.length > 0)
      }));

      await client.query(
        `UPDATE word_index SET video_examples = $1, updated_at = CURRENT_TIMESTAMP WHERE word = $2`,
        [JSON.stringify(cleanedExamples), row.word]
      );
    }
    console.log(`  ✓ Cleaned ${wordIndexRows.rows.length} rows in word_index`);

    // Step 3: Remove short clips from word_index (clips shorter than 10s were
    // created with old sentence-boundary logic that cut clips too short).
    // These entries will be re-indexed with the new 15s before/after logic.
    const MIN_CLIP_DURATION = 10; // seconds
    console.log(`\nStep 3: Removing short clips (< ${MIN_CLIP_DURATION}s) from word_index...`);
    const allWords = await client.query('SELECT word, video_examples FROM word_index');
    let removedClips = 0;
    let updatedWords = 0;

    for (const row of allWords.rows) {
      const examples = row.video_examples as Array<{
        startTime: number;
        endTime: number;
        [key: string]: any;
      }>;

      const filtered = examples.filter(example => {
        const duration = example.endTime - example.startTime;
        if (duration < MIN_CLIP_DURATION) {
          removedClips++;
          return false;
        }
        return true;
      });

      if (filtered.length !== examples.length) {
        updatedWords++;
        if (filtered.length === 0) {
          await client.query('DELETE FROM word_index WHERE word = $1', [row.word]);
        } else {
          await client.query(
            'UPDATE word_index SET video_examples = $1, updated_at = CURRENT_TIMESTAMP WHERE word = $2',
            [JSON.stringify(filtered), row.word]
          );
        }
      }
    }
    console.log(`  ✓ Removed ${removedClips} short clips across ${updatedWords} words`);

    // Step 4: Remove short clips from video_examples table
    console.log('\nStep 4: Removing short clips from video_examples...');
    const deletedExamples = await client.query(
      `DELETE FROM video_examples WHERE (end_time - start_time) < $1`,
      [MIN_CLIP_DURATION]
    );
    console.log(`  ✓ Removed ${deletedExamples.rowCount} short clips from video_examples`);

    console.log('\n✓ Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migration
migrate()
  .then(() => {
    console.log('Migration script finished');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration script failed:', error);
    process.exit(1);
  });
