import { Pool } from 'pg';
import dotenv from 'dotenv';

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
    console.log('Starting migration: Add response_chunks column to sentence_analyses table');

    // Check if column already exists
    const checkResult = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name='sentence_analyses'
      AND column_name='response_chunks';
    `);

    if (checkResult.rows.length > 0) {
      console.log('✓ Column response_chunks already exists. No migration needed.');
      return;
    }

    // Add the column
    console.log('Adding response_chunks column...');
    await client.query(`
      ALTER TABLE sentence_analyses
      ADD COLUMN response_chunks JSONB;
    `);

    console.log('✓ Migration completed successfully!');
    console.log('✓ Column response_chunks added to sentence_analyses table');

  } catch (error: any) {
    console.error('✗ Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate()
  .then(() => {
    console.log('Migration finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
