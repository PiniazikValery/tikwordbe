import { Response } from 'express';
import { generateHash } from '../utils/hash';
import {
  findAnalysisByHash,
  insertSentenceAnalysis,
  incrementAccessCount,
  SentenceAnalysis,
  ChunkMetadata
} from '../db/sentenceAnalyses';
import { StreamParams } from './streamManager';

export interface ClaudeAnalysisResponse {
  fullTranslation: string;
  literalTranslation: string;
  grammarAnalysis: string;
  breakdown: Array<{
    word: string;
    baseForm: string;
    partOfSpeech: string;
    translation: string;
    meaningInSentence: string;
    function: string;
    usageInContext: string;
    alternativeMeanings: string[];
  }>;
  idioms: Array<{
    phrase: string;
    meaning: string;
    literalTranslation: string;
  }>;
  difficultyNotes?: string;
}

export function generateStreamCacheKey(
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

export async function loadStreamCache(cacheKey: string): Promise<SentenceAnalysis | null> {
  return await findAnalysisByHash(cacheKey);
}

export async function saveStreamCache(
  cacheKey: string,
  params: StreamParams,
  fullResponse: string,
  chunks: ChunkMetadata[]
): Promise<SentenceAnalysis | null> {
  try {
    // Strip markdown code fences if present
    let cleanedResponse = fullResponse.trim();
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    // Parse the full response as JSON
    const parsedResponse: ClaudeAnalysisResponse = JSON.parse(cleanedResponse);

    // Save to database
    const analysis = await insertSentenceAnalysis({
      hash: cacheKey,
      sentence: params.sentence,
      targetWord: params.targetWord,
      targetLanguage: params.targetLanguage,
      nativeLanguage: params.nativeLanguage,
      contextBefore: params.contextBefore,
      contextAfter: params.contextAfter,
      fullTranslation: parsedResponse.fullTranslation,
      literalTranslation: parsedResponse.literalTranslation,
      grammarAnalysis: parsedResponse.grammarAnalysis,
      breakdown: parsedResponse.breakdown,
      idioms: parsedResponse.idioms,
      difficultyNotes: parsedResponse.difficultyNotes,
      responseChunks: chunks
    });

    console.log(`✓ Stream cached successfully: ${cacheKey} (${chunks.length} chunks)`);
    return analysis;
  } catch (error: any) {
    console.error(`Failed to save stream cache for ${cacheKey}:`, error.message);
    // Don't throw - allow the stream to complete even if caching fails
    return null;
  }
}

export async function incrementStreamAccess(cacheKey: string): Promise<void> {
  await incrementAccessCount(cacheKey);
}

export async function simulateStreamReplay(
  res: Response,
  cachedAnalysis: SentenceAnalysis
): Promise<void> {
  const chunks = cachedAnalysis.responseChunks;

  if (!chunks || chunks.length === 0) {
    // No chunks stored, generate artificial chunks from the full response
    const fullResponse = JSON.stringify({
      fullTranslation: cachedAnalysis.fullTranslation,
      literalTranslation: cachedAnalysis.literalTranslation,
      grammarAnalysis: cachedAnalysis.grammarAnalysis,
      breakdown: cachedAnalysis.breakdown,
      idioms: cachedAnalysis.idioms,
      difficultyNotes: cachedAnalysis.difficultyNotes
    });

    // Split into chunks of roughly 100 characters
    const artificialChunks = generateArtificialChunks(fullResponse);

    // Send chunks with realistic delays
    for (let i = 0; i < artificialChunks.length; i++) {
      const chunk = artificialChunks[i];

      // Send the chunk
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);

      // Add small delay between chunks (faster than API but not instant)
      if (i < artificialChunks.length - 1) {
        await delay(15);
      }
    }

    // Send completion
    res.write(`data: ${JSON.stringify({ done: true, fullResponse })}\n\n`);
    res.end();
    return;
  }

  // Replay stored chunks with realistic delays
  console.log(`✓ Replaying ${chunks.length} cached chunks`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Send the chunk
    res.write(`data: ${JSON.stringify({ chunk: chunk.text })}\n\n`);

    // Add small delay between chunks (faster than real API but feels natural)
    // Using original timestamp differences divided by 3 for 3x speed, capped at 5-30ms
    if (i < chunks.length - 1) {
      const timeDiff = chunks[i + 1].timestamp - chunk.timestamp;
      const delayMs = Math.min(Math.max(Math.floor(timeDiff / 3), 5), 30);
      await delay(delayMs);
    }
  }

  // Reconstruct full response
  const fullResponse = JSON.stringify({
    fullTranslation: cachedAnalysis.fullTranslation,
    literalTranslation: cachedAnalysis.literalTranslation,
    grammarAnalysis: cachedAnalysis.grammarAnalysis,
    breakdown: cachedAnalysis.breakdown,
    idioms: cachedAnalysis.idioms,
    difficultyNotes: cachedAnalysis.difficultyNotes
  });

  // Send completion
  res.write(`data: ${JSON.stringify({ done: true, fullResponse })}\n\n`);
  res.end();
}

function generateArtificialChunks(text: string, chunkSize: number = 100): string[] {
  const chunks: string[] = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    // Try to find a good breaking point (space, comma, period, bracket)
    let endIndex = Math.min(currentIndex + chunkSize, text.length);

    if (endIndex < text.length) {
      // Look for a natural breaking point
      const breakChars = [' ', ',', '.', '}', ']', '\n'];
      let bestBreakIndex = -1;

      for (let i = endIndex; i > currentIndex + chunkSize * 0.5; i--) {
        if (breakChars.includes(text[i])) {
          bestBreakIndex = i + 1;
          break;
        }
      }

      if (bestBreakIndex > 0) {
        endIndex = bestBreakIndex;
      }
    }

    chunks.push(text.substring(currentIndex, endIndex));
    currentIndex = endIndex;
  }

  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function saveStreamCacheWithRetry(
  cacheKey: string,
  params: StreamParams,
  fullResponse: string,
  chunks: ChunkMetadata[],
  maxRetries: number = 3
): Promise<SentenceAnalysis | null> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await saveStreamCache(cacheKey, params, fullResponse, chunks);
    } catch (error: any) {
      lastError = error;
      console.error(`Failed to save stream cache (attempt ${attempt}/${maxRetries}):`, error.message);

      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        console.log(`Retrying in ${delayMs}ms...`);
        await delay(delayMs);
      }
    }
  }

  console.error(`Failed to save stream cache after ${maxRetries} attempts:`, lastError?.message);
  return null;
}
