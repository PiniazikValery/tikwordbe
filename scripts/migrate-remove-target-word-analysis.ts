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

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Starting migration: Removing target_word_analysis column...');

    // Check if column exists
    const checkColumn = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'sentence_analyses'
      AND column_name = 'target_word_analysis'
    `);

    if (checkColumn.rows.length === 0) {
      console.log('Column target_word_analysis does not exist. Migration not needed.');
      return;
    }

    // Drop the column
    await client.query(`
      ALTER TABLE sentence_analyses
      DROP COLUMN IF EXISTS target_word_analysis
    `);

    console.log('✓ Successfully removed target_word_analysis column');
    console.log('✓ Migration completed successfully');

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
