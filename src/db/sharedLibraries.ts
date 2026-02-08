import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// --- Interfaces ---

export interface SharedLibrary {
  id: string;
  name: string;
  description: string | null;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  color: string | null;
  icon: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  authorId: string | null;
  authorName: string | null;
  wordCount: number;
  downloadCount: number;
  isPublic: boolean;
  isFeatured: boolean;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SharedWord {
  id: string;
  libraryId: string;
  word: string;
  translation: string;
  transcription: string | null;
  position: number;
  createdAt: Date;
}

export interface SharedLibraryWithWords extends SharedLibrary {
  words: SharedWord[];
}

export interface CreateSharedLibraryInput {
  name: string;
  description?: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  color?: string;
  icon?: string;
  sourceLanguage: string;
  targetLanguage: string;
  authorName?: string;
  tags?: string[];
  words: CreateSharedWordInput[];
}

export interface CreateSharedWordInput {
  word: string;
  translation: string;
  transcription?: string;
}

export interface UpdateSharedLibraryInput {
  name: string;
  description?: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  color?: string;
  icon?: string;
  words: CreateSharedWordInput[];
}

export interface QuerySharedLibrariesInput {
  targetLanguage: string;
  difficulty?: string;
  search?: string;
  tags?: string[];
  sortBy?: 'popular' | 'newest' | 'wordCount';
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  libraries: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// --- Database Initialization ---

export async function initializeSharedLibrariesDB(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS shared_libraries (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        difficulty VARCHAR(20) NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
        color VARCHAR(7),
        icon VARCHAR(50),
        source_language VARCHAR(10) NOT NULL,
        target_language VARCHAR(10) NOT NULL,
        author_id UUID,
        author_name VARCHAR(100),
        word_count INTEGER DEFAULT 0,
        download_count INTEGER DEFAULT 0,
        is_public BOOLEAN DEFAULT true,
        is_featured BOOLEAN DEFAULT false,
        tags VARCHAR(255)[] DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS shared_words (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        library_id UUID REFERENCES shared_libraries(id) ON DELETE CASCADE,
        word VARCHAR(255) NOT NULL,
        translation VARCHAR(500) NOT NULL,
        transcription VARCHAR(255),
        position INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS library_ratings (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        library_id UUID REFERENCES shared_libraries(id) ON DELETE CASCADE,
        device_id VARCHAR(255),
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(library_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS library_reports (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        library_id UUID REFERENCES shared_libraries(id) ON DELETE CASCADE,
        reason VARCHAR(100) NOT NULL,
        description TEXT,
        reporter_ip VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_shared_words_library ON shared_words(library_id);
      CREATE INDEX IF NOT EXISTS idx_libraries_target_lang ON shared_libraries(target_language);
      CREATE INDEX IF NOT EXISTS idx_libraries_difficulty ON shared_libraries(difficulty);
      CREATE INDEX IF NOT EXISTS idx_libraries_download_count ON shared_libraries(download_count DESC);
      CREATE INDEX IF NOT EXISTS idx_libraries_created_at ON shared_libraries(created_at DESC);
    `);
  } finally {
    client.release();
  }
}

// --- Query Functions ---

export async function createSharedLibrary(input: CreateSharedLibraryInput): Promise<SharedLibrary> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const libraryId = uuidv4();
    const libraryResult = await client.query(
      `INSERT INTO shared_libraries (id, name, description, difficulty, color, icon, source_language, target_language, author_name, word_count, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING
         id, name, description, difficulty, color, icon,
         source_language AS "sourceLanguage",
         target_language AS "targetLanguage",
         author_id AS "authorId",
         author_name AS "authorName",
         word_count AS "wordCount",
         download_count AS "downloadCount",
         is_public AS "isPublic",
         is_featured AS "isFeatured",
         tags,
         created_at AS "createdAt",
         updated_at AS "updatedAt"`,
      [
        libraryId,
        input.name,
        input.description || null,
        input.difficulty,
        input.color || null,
        input.icon || null,
        input.sourceLanguage,
        input.targetLanguage,
        input.authorName || null,
        input.words.length,
        input.tags || [],
      ]
    );

    // Insert words in batch
    if (input.words.length > 0) {
      const wordValues: any[] = [];
      const wordPlaceholders: string[] = [];
      let paramIndex = 1;

      for (let i = 0; i < input.words.length; i++) {
        const w = input.words[i];
        wordPlaceholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
        wordValues.push(uuidv4(), libraryId, w.word, w.translation, w.transcription || null, i);
        paramIndex += 6;
      }

      await client.query(
        `INSERT INTO shared_words (id, library_id, word, translation, transcription, position)
         VALUES ${wordPlaceholders.join(', ')}`,
        wordValues
      );
    }

    await client.query('COMMIT');
    return libraryResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function findSharedLibraries(query: QuerySharedLibrariesInput): Promise<PaginatedResult<SharedLibrary>> {
  const page = query.page || 1;
  const limit = Math.min(query.limit || 20, 100);
  const offset = (page - 1) * limit;

  const conditions: string[] = ['is_public = true'];
  const params: any[] = [];
  let paramIndex = 1;

  // Target language filter (required)
  conditions.push(`target_language = $${paramIndex}`);
  params.push(query.targetLanguage);
  paramIndex++;

  // Optional difficulty filter
  if (query.difficulty) {
    conditions.push(`difficulty = $${paramIndex}`);
    params.push(query.difficulty);
    paramIndex++;
  }

  // Optional search filter
  if (query.search) {
    conditions.push(`(name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
    params.push(`%${query.search}%`);
    paramIndex++;
  }

  // Optional tags filter
  if (query.tags && query.tags.length > 0) {
    conditions.push(`tags && $${paramIndex}`);
    params.push(query.tags);
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort
  let orderBy = 'download_count DESC';
  if (query.sortBy === 'newest') orderBy = 'created_at DESC';
  else if (query.sortBy === 'wordCount') orderBy = 'word_count DESC';

  // Count total
  const countResult = await pool.query(
    `SELECT COUNT(*) AS total FROM shared_libraries ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total);

  // Fetch page
  const dataResult = await pool.query(
    `SELECT
       id, name, description, difficulty, color, icon,
       source_language AS "sourceLanguage",
       target_language AS "targetLanguage",
       author_id AS "authorId",
       author_name AS "authorName",
       word_count AS "wordCount",
       download_count AS "downloadCount",
       is_public AS "isPublic",
       is_featured AS "isFeatured",
       tags,
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM shared_libraries
     ${whereClause}
     ORDER BY ${orderBy}
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  return {
    libraries: dataResult.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function findSharedLibraryById(id: string): Promise<SharedLibraryWithWords | null> {
  const libraryResult = await pool.query(
    `SELECT
       id, name, description, difficulty, color, icon,
       source_language AS "sourceLanguage",
       target_language AS "targetLanguage",
       author_id AS "authorId",
       author_name AS "authorName",
       word_count AS "wordCount",
       download_count AS "downloadCount",
       is_public AS "isPublic",
       is_featured AS "isFeatured",
       tags,
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM shared_libraries
     WHERE id = $1`,
    [id]
  );

  if (libraryResult.rows.length === 0) {
    return null;
  }

  const wordsResult = await pool.query(
    `SELECT
       id, library_id AS "libraryId", word, translation, transcription, position,
       created_at AS "createdAt"
     FROM shared_words
     WHERE library_id = $1
     ORDER BY position ASC`,
    [id]
  );

  return {
    ...libraryResult.rows[0],
    words: wordsResult.rows,
  };
}

export async function updateSharedLibrary(id: string, input: UpdateSharedLibraryInput): Promise<{ id: string; name: string; wordCount: number } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check library exists
    const existing = await client.query('SELECT id FROM shared_libraries WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    // Update library metadata
    await client.query(
      `UPDATE shared_libraries
       SET name = $1, description = $2, difficulty = $3, color = $4, icon = $5,
           word_count = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7`,
      [
        input.name,
        input.description || null,
        input.difficulty,
        input.color || null,
        input.icon || null,
        input.words.length,
        id,
      ]
    );

    // Delete old words
    await client.query('DELETE FROM shared_words WHERE library_id = $1', [id]);

    // Insert new words
    if (input.words.length > 0) {
      const wordValues: any[] = [];
      const wordPlaceholders: string[] = [];
      let paramIndex = 1;

      for (let i = 0; i < input.words.length; i++) {
        const w = input.words[i];
        wordPlaceholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
        wordValues.push(uuidv4(), id, w.word, w.translation, w.transcription || null, i);
        paramIndex += 6;
      }

      await client.query(
        `INSERT INTO shared_words (id, library_id, word, translation, transcription, position)
         VALUES ${wordPlaceholders.join(', ')}`,
        wordValues
      );
    }

    await client.query('COMMIT');
    return { id, name: input.name, wordCount: input.words.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function incrementDownloadCount(id: string): Promise<void> {
  await pool.query(
    `UPDATE shared_libraries
     SET download_count = download_count + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id]
  );
}

export async function getFeaturedLibraries(targetLanguage: string): Promise<SharedLibrary[]> {
  const result = await pool.query(
    `SELECT
       id, name, description, difficulty, color, icon,
       source_language AS "sourceLanguage",
       target_language AS "targetLanguage",
       author_id AS "authorId",
       author_name AS "authorName",
       word_count AS "wordCount",
       download_count AS "downloadCount",
       is_public AS "isPublic",
       is_featured AS "isFeatured",
       tags,
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM shared_libraries
     WHERE is_featured = true AND is_public = true AND target_language = $1
     ORDER BY download_count DESC`,
    [targetLanguage]
  );

  return result.rows;
}

export async function createLibraryReport(
  libraryId: string,
  reason: string,
  description: string | null,
  reporterIp: string | null
): Promise<void> {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO library_reports (id, library_id, reason, description, reporter_ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, libraryId, reason, description, reporterIp]
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
