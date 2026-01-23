import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'tickword',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

export interface WordBreakdown {
  word: string;
  baseForm: string;
  partOfSpeech: string;
  translation: string;
  meaningInSentence: string;
  function: string;
  usageInContext: string;
  alternativeMeanings: string[];
}

export interface Idiom {
  phrase: string;
  meaning: string;
  literalTranslation: string;
}

export interface ChunkMetadata {
  text: string;
  timestamp: number;
}

export interface SentenceAnalysis {
  id: string;
  hash: string;
  sentence: string;
  targetWord: string;
  targetLanguage: string;
  nativeLanguage: string;
  contextBefore?: string;
  contextAfter?: string;
  videoTimestamp?: number;
  fullTranslation: string;
  literalTranslation: string;
  grammarAnalysis: string;
  breakdown: WordBreakdown[];
  idioms: Idiom[];
  difficultyNotes?: string;
  responseChunks?: ChunkMetadata[];
  accessCount: number;
  createdAt: Date;
  lastAccessedAt: Date;
}

export interface SentenceAnalysisInsert {
  hash: string;
  sentence: string;
  targetWord: string;
  targetLanguage: string;
  nativeLanguage: string;
  contextBefore?: string;
  contextAfter?: string;
  videoTimestamp?: number;
  fullTranslation: string;
  literalTranslation: string;
  grammarAnalysis: string;
  breakdown: WordBreakdown[];
  idioms: Idiom[];
  difficultyNotes?: string;
  responseChunks?: ChunkMetadata[];
}

export interface AnalysisRequestInsert {
  sentenceAnalysisId?: string;
  userId?: string;
  ipAddress?: string;
  wasCached: boolean;
  processingTimeMs?: number;
  error?: string;
}

export async function initializeSentenceAnalysisDB(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sentence_analyses (
        id UUID PRIMARY KEY,
        hash TEXT UNIQUE NOT NULL,
        sentence TEXT NOT NULL,
        target_word TEXT NOT NULL,
        target_language TEXT NOT NULL,
        native_language TEXT NOT NULL,
        context_before TEXT,
        context_after TEXT,
        video_timestamp FLOAT,
        full_translation TEXT NOT NULL,
        literal_translation TEXT NOT NULL,
        grammar_analysis TEXT NOT NULL,
        breakdown JSONB NOT NULL,
        idioms JSONB NOT NULL,
        difficulty_notes TEXT,
        response_chunks JSONB,
        access_count INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_sentence_analyses_hash ON sentence_analyses(hash);
      CREATE INDEX IF NOT EXISTS idx_sentence_analyses_access_count ON sentence_analyses(access_count);

      CREATE TABLE IF NOT EXISTS analysis_requests (
        id UUID PRIMARY KEY,
        sentence_analysis_id UUID REFERENCES sentence_analyses(id),
        user_id TEXT,
        ip_address TEXT,
        was_cached BOOLEAN NOT NULL,
        processing_time_ms INTEGER,
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_analysis_requests_user_id ON analysis_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_analysis_requests_ip ON analysis_requests(ip_address);
      CREATE INDEX IF NOT EXISTS idx_analysis_requests_created_at ON analysis_requests(created_at);
    `);
  } finally {
    client.release();
  }
}

export async function findAnalysisByHash(hash: string): Promise<SentenceAnalysis | null> {
  const result = await pool.query(
    `SELECT
      id,
      hash,
      sentence,
      target_word as "targetWord",
      target_language as "targetLanguage",
      native_language as "nativeLanguage",
      context_before as "contextBefore",
      context_after as "contextAfter",
      video_timestamp as "videoTimestamp",
      full_translation as "fullTranslation",
      literal_translation as "literalTranslation",
      grammar_analysis as "grammarAnalysis",
      breakdown,
      idioms,
      difficulty_notes as "difficultyNotes",
      response_chunks as "responseChunks",
      access_count as "accessCount",
      created_at as "createdAt",
      last_accessed_at as "lastAccessedAt"
    FROM sentence_analyses
    WHERE hash = $1`,
    [hash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

export async function insertSentenceAnalysis(data: SentenceAnalysisInsert): Promise<SentenceAnalysis> {
  const id = uuidv4();
  const result = await pool.query(
    `INSERT INTO sentence_analyses (
      id,
      hash,
      sentence,
      target_word,
      target_language,
      native_language,
      context_before,
      context_after,
      video_timestamp,
      full_translation,
      literal_translation,
      grammar_analysis,
      breakdown,
      idioms,
      difficulty_notes,
      response_chunks
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING
      id,
      hash,
      sentence,
      target_word as "targetWord",
      target_language as "targetLanguage",
      native_language as "nativeLanguage",
      context_before as "contextBefore",
      context_after as "contextAfter",
      video_timestamp as "videoTimestamp",
      full_translation as "fullTranslation",
      literal_translation as "literalTranslation",
      grammar_analysis as "grammarAnalysis",
      breakdown,
      idioms,
      difficulty_notes as "difficultyNotes",
      response_chunks as "responseChunks",
      access_count as "accessCount",
      created_at as "createdAt",
      last_accessed_at as "lastAccessedAt"`,
    [
      id,
      data.hash,
      data.sentence,
      data.targetWord,
      data.targetLanguage,
      data.nativeLanguage,
      data.contextBefore || null,
      data.contextAfter || null,
      data.videoTimestamp || null,
      data.fullTranslation,
      data.literalTranslation,
      data.grammarAnalysis,
      JSON.stringify(data.breakdown),
      JSON.stringify(data.idioms),
      data.difficultyNotes || null,
      data.responseChunks ? JSON.stringify(data.responseChunks) : null
    ]
  );

  return result.rows[0];
}

export async function incrementAccessCount(hash: string): Promise<void> {
  await pool.query(
    `UPDATE sentence_analyses
     SET access_count = access_count + 1, last_accessed_at = CURRENT_TIMESTAMP
     WHERE hash = $1`,
    [hash]
  );
}

export async function logAnalysisRequest(data: AnalysisRequestInsert): Promise<void> {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO analysis_requests (
      id,
      sentence_analysis_id,
      user_id,
      ip_address,
      was_cached,
      processing_time_ms,
      error
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      data.sentenceAnalysisId || null,
      data.userId || null,
      data.ipAddress || null,
      data.wasCached,
      data.processingTimeMs || null,
      data.error || null
    ]
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
