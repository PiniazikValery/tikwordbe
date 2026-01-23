import { Router, Request, Response } from 'express';
import { aiPaywallMiddleware } from '../middleware/paywall';
import { getStreamManager, StreamParams } from '../services/streamManager';
import {
  generateStreamCacheKey,
  loadStreamCache,
  saveStreamCacheWithRetry,
  simulateStreamReplay,
  incrementStreamAccess
} from '../services/streamCache';
import { logAnalysisRequest } from '../db/sentenceAnalyses';

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
  userId?: string;
}

router.post(
  '/analyze/stream',
  aiPaywallMiddleware(),
  async (
    req: Request<{}, {}, AnalyzeSentenceRequest>,
    res: Response
  ) => {
    const startTime = Date.now();

    try {
      const {
        sentence,
        targetWord,
        targetLanguage,
        nativeLanguage,
        contextBefore,
        contextAfter,
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
        return res.status(400).json({
          error: `Invalid nativeLanguage. Must be one of: ${VALID_LANGUAGE_CODES.join(', ')}`
        });
      }

      // Generate cache key
      const cacheKey = generateStreamCacheKey(
        sentence.trim(),
        targetWord.trim(),
        targetLanguage.toLowerCase(),
        nativeLanguage.toLowerCase(),
        contextBefore?.trim(),
        contextAfter?.trim()
      );

      // Set Server-Sent Events headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      // Check database cache first
      const cachedAnalysis = await loadStreamCache(cacheKey);

      if (cachedAnalysis) {
        // Cache hit - simulate streaming from cache
        console.log(`✓ Cache hit for stream: ${cacheKey}`);

        // Increment access count
        await incrementStreamAccess(cacheKey);

        // Simulate streaming replay
        await simulateStreamReplay(res, cachedAnalysis);

        // Log analytics
        const processingTime = Date.now() - startTime;
        await logAnalysisRequest({
          sentenceAnalysisId: cachedAnalysis.id,
          userId,
          ipAddress: req.ip,
          wasCached: true,
          processingTimeMs: processingTime
        });

        return;
      }

      console.log(`✗ Cache miss for stream: ${cacheKey}`);

      // Get or create stream manager instance
      const streamManager = getStreamManager();

      // Check if there's an active stream for this cache key
      const existingStream = streamManager.getStream(cacheKey);

      if (existingStream && existingStream.status === 'active') {
        // Active stream exists - join it
        console.log(`✓ Joining existing active stream: ${cacheKey}`);

        const subscriberId = streamManager.subscribe(cacheKey, res);

        // Wait for the stream to complete
        if (existingStream.apiCallPromise) {
          await existingStream.apiCallPromise;
        }

        // Log analytics (shared stream)
        const processingTime = Date.now() - startTime;
        await logAnalysisRequest({
          userId,
          ipAddress: req.ip,
          wasCached: false,
          processingTimeMs: processingTime
        });

        return;
      }

      // No cache and no active stream - create new stream
      const params: StreamParams = {
        sentence: sentence.trim(),
        targetWord: targetWord.trim(),
        targetLanguage: targetLanguage.toLowerCase(),
        nativeLanguage: nativeLanguage.toLowerCase(),
        contextBefore: contextBefore?.trim(),
        contextAfter: contextAfter?.trim()
      };

      console.log(`✓ Creating new stream: ${cacheKey}`);

      // Get or create stream
      const stream = streamManager.getOrCreateStream(cacheKey, params);

      // Subscribe to the stream
      const subscriberId = streamManager.subscribe(cacheKey, res);

      // Wait for the stream to complete
      if (stream.apiCallPromise) {
        await stream.apiCallPromise;

        // Save to cache with retry
        if (stream.status === 'completed' && stream.fullResponse) {
          await saveStreamCacheWithRetry(
            cacheKey,
            params,
            stream.fullResponse,
            stream.chunks
          );
        }
      }

      // Log analytics (new stream)
      const processingTime = Date.now() - startTime;
      await logAnalysisRequest({
        userId,
        ipAddress: req.ip,
        wasCached: false,
        processingTimeMs: processingTime
      });

    } catch (error: any) {
      console.error('Error in /api/analyze/stream:', error);

      // Only send error if response hasn't been ended
      if (!res.headersSent) {
        // Send error as SSE
        const errorMessage = error.message.includes('Claude API')
          ? 'AI service temporarily unavailable. Please try again later.'
          : error.message.includes('API key')
          ? 'Service configuration error. Please contact support.'
          : 'An error occurred while analyzing the sentence';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
        res.end();
      } else {
        // Response already started, try to send error via SSE
        try {
          const errorMessage = error.message.includes('Claude API')
            ? 'AI service temporarily unavailable. Please try again later.'
            : error.message.includes('API key')
            ? 'Service configuration error. Please contact support.'
            : 'An error occurred while analyzing the sentence';

          res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
          res.end();
        } catch (writeError) {
          console.error('Failed to send error to client:', writeError);
        }
      }

      // Log failed request
      const processingTime = Date.now() - startTime;
      try {
        await logAnalysisRequest({
          userId: req.body.userId,
          ipAddress: req.ip,
          wasCached: false,
          processingTimeMs: processingTime,
          error: error.message
        });
      } catch (logError) {
        console.error('Failed to log analysis request error:', logError);
      }
    }
  }
);

export default router;
