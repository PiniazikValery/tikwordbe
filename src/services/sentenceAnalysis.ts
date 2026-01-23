import { analyzeSentenceWithClaude } from './claude';
import {
  findAnalysisByHash,
  insertSentenceAnalysis,
  incrementAccessCount,
  logAnalysisRequest,
  SentenceAnalysis
} from '../db/sentenceAnalyses';
import { generateHash } from '../utils/hash';

function generateCacheKey(
  sentence: string,
  targetWord: string,
  targetLanguage: string,
  nativeLanguage: string,
  contextBefore?: string,
  contextAfter?: string
): string {
  // Normalize inputs for consistent caching
  const normalized = [
    sentence.trim().toLowerCase(),
    targetWord.trim().toLowerCase(),
    targetLanguage.trim().toLowerCase(),
    nativeLanguage.trim().toLowerCase(),
    contextBefore?.trim().toLowerCase() || '',
    contextAfter?.trim().toLowerCase() || ''
  ].join('|');

  return generateHash(normalized);
}

export async function analyzeSentence(
  sentence: string,
  targetWord: string,
  targetLanguage: string,
  nativeLanguage: string,
  contextBefore?: string,
  contextAfter?: string,
  videoTimestamp?: number,
  userId?: string,
  ipAddress?: string
): Promise<SentenceAnalysis> {
  const startTime = Date.now();

  try {
    // Generate cache key (hash of normalized inputs)
    const cacheKey = generateCacheKey(
      sentence,
      targetWord,
      targetLanguage,
      nativeLanguage,
      contextBefore,
      contextAfter
    );

    // Check cache first
    const cached = await findAnalysisByHash(cacheKey);

    if (cached) {
      console.log(`✓ Cache hit for sentence analysis: ${cacheKey}`);

      // Update access count
      await incrementAccessCount(cacheKey);

      // Log request (cached)
      const processingTime = Date.now() - startTime;
      await logAnalysisRequest({
        sentenceAnalysisId: cached.id,
        userId,
        ipAddress,
        wasCached: true,
        processingTimeMs: processingTime
      });

      return cached;
    }

    console.log(`✗ Cache miss for sentence analysis: ${cacheKey}`);

    // Call Claude API
    const claudeResponse = await analyzeSentenceWithClaude(
      sentence,
      targetWord,
      targetLanguage,
      nativeLanguage,
      contextBefore,
      contextAfter
    );

    // Save to cache
    const analysis = await insertSentenceAnalysis({
      hash: cacheKey,
      sentence,
      targetWord,
      targetLanguage,
      nativeLanguage,
      contextBefore,
      contextAfter,
      videoTimestamp,
      fullTranslation: claudeResponse.fullTranslation,
      literalTranslation: claudeResponse.literalTranslation,
      grammarAnalysis: claudeResponse.grammarAnalysis,
      breakdown: claudeResponse.breakdown,
      idioms: claudeResponse.idioms,
      difficultyNotes: claudeResponse.difficultyNotes
    });

    console.log(`✓ Sentence analysis saved to cache: ${cacheKey}`);

    // Log request (uncached)
    const processingTime = Date.now() - startTime;
    await logAnalysisRequest({
      sentenceAnalysisId: analysis.id,
      userId,
      ipAddress,
      wasCached: false,
      processingTimeMs: processingTime
    });

    return analysis;

  } catch (error: any) {
    // Log failed request
    const processingTime = Date.now() - startTime;
    await logAnalysisRequest({
      userId,
      ipAddress,
      wasCached: false,
      processingTimeMs: processingTime,
      error: error.message
    });

    throw error;
  }
}
