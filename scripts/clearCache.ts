import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function clearCache() {
  const client = await pool.connect();

  try {
    console.log('🗑️  Clearing database cache...\n');

    // Clear video_examples table
    const videoExamplesResult = await client.query('DELETE FROM video_examples');
    console.log(`✓ Cleared video_examples: ${videoExamplesResult.rowCount} rows deleted`);

    // Clear job_queue table
    const jobQueueResult = await client.query('DELETE FROM job_queue');
    console.log(`✓ Cleared job_queue: ${jobQueueResult.rowCount} rows deleted`);

    // Clear word_index table
    const wordIndexResult = await client.query('DELETE FROM word_index');
    console.log(`✓ Cleared word_index: ${wordIndexResult.rowCount} rows deleted`);

    console.log('\n✅ All cache tables cleared successfully!');
  } catch (error: any) {
    console.error('❌ Error clearing cache:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

clearCache().catch(console.error);
