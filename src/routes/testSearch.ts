import { Router, Request, Response } from 'express';
import { normalizeQuery } from '../utils/normalize';
import { generateHash } from '../utils/hash';
import { findByHash, insertVideoExample } from '../db/videoExamples';
import { findMatchingSegment, detectSentenceBoundary } from '../services/sentenceDetector';
import { CaptionSegment } from '../services/sentenceDetector';
import { findByWord, VideoResponse } from '../db/wordIndex';

const router = Router();

// Mock caption data for testing (simulates a Python tutorial video)
const MOCK_CAPTIONS: CaptionSegment[] = [
  { text: "Hello everyone and welcome to this Python tutorial.", start: 0.5, duration: 3.2 },
  { text: "In this video we'll learn about Python programming.", start: 3.7, duration: 3.5 },
  { text: "Python is a high-level programming language.", start: 7.2, duration: 3.0 },
  { text: "It's known for its simplicity and readability.", start: 10.2, duration: 2.8 },
  { text: "Let's start with variables in Python.", start: 13.0, duration: 2.5 },
  { text: "A variable is a container for storing data.", start: 15.5, duration: 3.0 },
  { text: "You can create a variable by using the assignment operator.", start: 18.5, duration: 3.5 },
  { text: "For example, x equals 10 creates a variable named x.", start: 22.0, duration: 4.0 },
  { text: "Python supports different data types.", start: 26.0, duration: 2.5 },
  { text: "These include integers, floats, strings, and booleans.", start: 28.5, duration: 3.5 },
  { text: "Next, let's talk about functions.", start: 32.0, duration: 2.2 },
  { text: "Functions are reusable blocks of code.", start: 34.2, duration: 2.8 },
  { text: "You define a function using the def keyword.", start: 37.0, duration: 3.0 },
  { text: "Machine learning is becoming very popular with Python.", start: 40.0, duration: 3.5 },
  { text: "Libraries like TensorFlow and PyTorch make it easy.", start: 43.5, duration: 3.2 },
  { text: "That's all for today's tutorial.", start: 46.7, duration: 2.3 },
  { text: "Thanks for watching!", start: 49.0, duration: 1.5 },
];

const MOCK_VIDEO_ID = 'dQw4w9WgXcQ'; // Sample video ID

interface SearchRequest {
  query: string;
}

interface SearchResponse {
  videoId: string;
  startTime: number;
  endTime: number;
  caption: string;
}

interface ErrorResponse {
  error: string;
}

router.post('/search', async (req: Request<{}, {}, SearchRequest>, res: Response<SearchResponse | ErrorResponse>) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Step 1: Normalize & Analyze Input
    let normalizedData;
    try {
      normalizedData = normalizeQuery(query);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }

    const { normalized, type } = normalizedData;
    console.log(`Test search for: "${normalized}" (type: ${type})`);

    // Generate hash from normalized query
    const hash = generateHash(normalized);

    // Step 2: Cache Lookup
    const cached = await findByHash(hash);
    if (cached) {
      console.log('  Found in cache!');
      return res.json({
        videoId: cached.videoId,
        startTime: cached.startTime,
        endTime: cached.endTime,
        caption: cached.caption
      });
    }

    // Step 3: Use mock captions (instead of fetching from YouTube)
    console.log('  Using mock captions for testing');

    // Step 4: Caption Matching
    const matchIndex = findMatchingSegment(MOCK_CAPTIONS, normalized, type);

    if (matchIndex === -1) {
      console.log('  No match found in mock captions');
      return res.status(404).json({ error: 'No matching sentence found in captions' });
    }

    console.log(`  Match found at index: ${matchIndex}`);

    // Step 5: Sentence Boundary Detection
    const boundary = detectSentenceBoundary(MOCK_CAPTIONS, matchIndex);

    const result = {
      videoId: MOCK_VIDEO_ID,
      startTime: boundary.startTime,
      endTime: boundary.endTime,
      caption: boundary.caption
    };

    // Step 6: Save to Cache
    // Convert MOCK_CAPTIONS format to match database CaptionSegment format
    const captionsForDb = MOCK_CAPTIONS.map(seg => ({
      start: seg.start,
      end: seg.start + seg.duration,
      text: seg.text
    }));

    await insertVideoExample({
      hash,
      query: normalized,
      videoId: result.videoId,
      startTime: result.startTime,
      endTime: result.endTime,
      caption: result.caption,
      captions: captionsForDb
    });

    console.log('  Result cached successfully');

    return res.json(result);
  } catch (error: any) {
    console.error('Error in /test/search:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /test/word-examples/:word - Test endpoint to get all video responses for a word
router.get('/word-examples/:word', async (req: Request, res: Response<VideoResponse[] | ErrorResponse>) => {
  try {
    const { word } = req.params;

    if (!word) {
      return res.status(400).json({ error: 'Word parameter is required' });
    }

    console.log(`Test word lookup: "${word}"`);

    const examples = await findByWord(word);

    if (!examples || examples.length === 0) {
      console.log(`  No examples found for: "${word}"`);
      return res.status(404).json({ error: `No examples found for word: "${word}"` });
    }

    console.log(`  Found ${examples.length} example(s) for: "${word}"`);
    return res.json(examples);
  } catch (error: any) {
    console.error('Error in /test/word-examples:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export default router;
