import { Router, Request, Response } from 'express';
import { analyzeSentence } from '../services/sentenceAnalysis';
import { aiPaywallMiddleware } from '../middleware/paywall';

const router = Router();

// ISO 639-1 language codes (subset of most common)
const VALID_LANGUAGE_CODES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko', 'zh', 'zh-cn', 'zh-tw', 'zh-hk',
  'ar', 'hi', 'nl', 'pl', 'sv', 'tr', 'vi', 'th', 'id', 'cs',
  'uk', 'ro', 'el', 'he', 'da', 'fi', 'no', 'sk', 'bg', 'hr'
];

interface AnalyzeSentenceRequest {
  sentence: string;
  targetWord: string;
  targetLanguage: string;
  nativeLanguage: string;
  contextBefore?: string;
  contextAfter?: string;
  videoTimestamp?: number;
  userId?: string;
}

interface WordBreakdown {
  word: string;
  baseForm: string;
  partOfSpeech: string;
  translation: string;
  meaningInSentence: string;
  function: string;
  usageInContext: string;
  alternativeMeanings: string[];
}

interface Idiom {
  phrase: string;
  meaning: string;
  literalTranslation: string;
}

interface AnalyzeSentenceResponse {
  fullTranslation: string;
  literalTranslation: string;
  grammarAnalysis: string;
  breakdown: WordBreakdown[];
  idioms: Idiom[];
  difficultyNotes?: string;
  cached: boolean;
  accessCount: number;
}

interface ErrorResponse {
  error: string;
}

// Apply paywall middleware (3 free requests per 4 hours, unlimited for subscribers)
router.post(
  '/analyze',
  aiPaywallMiddleware(),
  async (
    req: Request<{}, {}, AnalyzeSentenceRequest>,
    res: Response<AnalyzeSentenceResponse | ErrorResponse>
  ) => {
    try {
      const {
        sentence,
        targetWord,
        targetLanguage,
        nativeLanguage,
        contextBefore,
        contextAfter,
        videoTimestamp,
        userId
      } = req.body;

      // Validation: Required fields
      if (!sentence) {
        return res.status(400).json({ error: 'sentence is required' });
      }
      if (!targetWord) {
        return res.status(400).json({ error: 'targetWord is required' });
      }
      if (!targetLanguage) {
        return res.status(400).json({ error: 'targetLanguage is required' });
      }
      if (!nativeLanguage) {
        return res.status(400).json({ error: 'nativeLanguage is required' });
      }

      // Validation: String types
      if (typeof sentence !== 'string') {
        return res.status(400).json({ error: 'sentence must be a string' });
      }
      if (typeof targetWord !== 'string') {
        return res.status(400).json({ error: 'targetWord must be a string' });
      }
      if (typeof targetLanguage !== 'string') {
        return res.status(400).json({ error: 'targetLanguage must be a string' });
      }
      if (typeof nativeLanguage !== 'string') {
        return res.status(400).json({ error: 'nativeLanguage must be a string' });
      }

      // Validation: Max lengths
      if (sentence.trim().length > 1000) {
        return res.status(400).json({
          error: 'sentence exceeds maximum length of 1000 characters'
        });
      }
      if (targetWord.trim().length > 100) {
        return res.status(400).json({
          error: 'targetWord exceeds maximum length of 100 characters'
        });
      }
      if (contextBefore && contextBefore.length > 500) {
        return res.status(400).json({
          error: 'contextBefore exceeds maximum length of 500 characters'
        });
      }
      if (contextAfter && contextAfter.length > 500) {
        return res.status(400).json({
          error: 'contextAfter exceeds maximum length of 500 characters'
        });
      }

      // Validation: Empty after trim
      if (sentence.trim().length === 0) {
        return res.status(400).json({ error: 'sentence cannot be empty' });
      }
      if (targetWord.trim().length === 0) {
        return res.status(400).json({ error: 'targetWord cannot be empty' });
      }

      // Validation: Language codes
      if (!VALID_LANGUAGE_CODES.includes(targetLanguage.toLowerCase())) {
        return res.status(400).json({
          error: `Invalid targetLanguage. Must be one of: ${VALID_LANGUAGE_CODES.join(', ')}`
        });
      }
      if (!VALID_LANGUAGE_CODES.includes(nativeLanguage.toLowerCase())) {
        console.log('VALID_LANGUAGE_CODES: ', VALID_LANGUAGE_CODES);
        console.log("nativeLanguage: ", nativeLanguage);
        return res.status(400).json({
          error: `Invalid nativeLanguage. Must be one of: ${VALID_LANGUAGE_CODES.join(', ')}`
        });
      }

      // Validation: Video timestamp (if provided)
      if (videoTimestamp !== undefined) {
        if (typeof videoTimestamp !== 'number' || videoTimestamp < 0) {
          return res.status(400).json({
            error: 'videoTimestamp must be a non-negative number'
          });
        }
      }

      // Get IP address for rate limiting and analytics
      const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';

      // Call service
      const analysis = await analyzeSentence(
        sentence.trim(),
        targetWord.trim(),
        targetLanguage.toLowerCase(),
        nativeLanguage.toLowerCase(),
        contextBefore?.trim(),
        contextAfter?.trim(),
        videoTimestamp,
        userId,
        ipAddress
      );

      // Return response
      return res.json({
        fullTranslation: analysis.fullTranslation,
        literalTranslation: analysis.literalTranslation,
        grammarAnalysis: analysis.grammarAnalysis,
        breakdown: analysis.breakdown,
        idioms: analysis.idioms,
        difficultyNotes: analysis.difficultyNotes,
        cached: analysis.accessCount > 1,
        accessCount: analysis.accessCount
      });

    } catch (error: any) {
      console.error('Error in /api/analyze:', error);

      // Handle specific error types
      if (error.message.includes('Claude API')) {
        return res.status(503).json({
          error: 'AI service temporarily unavailable. Please try again later.'
        });
      }

      if (error.message.includes('API key')) {
        return res.status(500).json({
          error: 'Service configuration error. Please contact support.'
        });
      }

      // Generic error
      return res.status(500).json({
        error: 'An error occurred while analyzing the sentence'
      });
    }
  }
);

export default router;
