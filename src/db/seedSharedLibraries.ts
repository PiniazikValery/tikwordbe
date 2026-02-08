import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { createSharedLibrary, CreateSharedLibraryInput } from './sharedLibraries';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

interface SeedLibraryFile extends CreateSharedLibraryInput {
  isFeatured?: boolean;
}

export async function seedSharedLibraries(): Promise<void> {
  const seedDir = path.join(__dirname, '..', 'data', 'seed-libraries');

  if (!fs.existsSync(seedDir)) {
    console.log('No seed-libraries directory found, skipping seed.');
    return;
  }

  const files = fs.readdirSync(seedDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No seed files found, skipping seed.');
    return;
  }

  let seeded = 0;
  let skipped = 0;

  for (const file of files) {
    const filePath = path.join(seedDir, file);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: SeedLibraryFile = JSON.parse(raw);

    // Check if a library with this exact name + target language already exists
    const existing = await pool.query(
      `SELECT id FROM shared_libraries WHERE name = $1 AND target_language = $2 LIMIT 1`,
      [data.name, data.targetLanguage]
    );

    if (existing.rows.length > 0) {
      skipped++;
      continue;
    }

    const library = await createSharedLibrary({
      name: data.name,
      description: data.description,
      difficulty: data.difficulty,
      color: data.color,
      icon: data.icon,
      sourceLanguage: data.sourceLanguage,
      targetLanguage: data.targetLanguage,
      authorName: data.authorName,
      tags: data.tags,
      words: data.words,
    });

    // Mark as featured if specified in seed file
    if (data.isFeatured) {
      await pool.query(
        `UPDATE shared_libraries SET is_featured = true WHERE id = $1`,
        [library.id]
      );
    }

    seeded++;
    console.log(`  Seeded: ${data.name} (${data.targetLanguage}, ${data.words.length} words)`);
  }

  console.log(`Seed complete: ${seeded} added, ${skipped} already existed.`);
}
