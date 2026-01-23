import { Router, Request, Response } from 'express';
import { findByWord, getAllWords, getWordIndexStats, VideoResponse } from '../db/wordIndex';

const router = Router();

interface WordQueryRequest {
  word: string;
}

interface WordQueryResponse {
  word: string;
  examples: Array<{
    videoId: string;
    videoUrl: string;
    startTime: number;
    endTime: number;
    caption: string;
    captions: Array<{
      start: number;
      end: number;
      text: string;
    }>;
  }>;
  count: number;
}

interface ErrorResponse {
  error: string;
}

// GET /word-index/examples/:word - Get video examples array for a word (simple format)
router.get('/examples/:word', async (req: Request, res: Response<VideoResponse[] | ErrorResponse>) => {
  try {
    const { word } = req.params;

    if (!word) {
      return res.status(400).json({ error: 'Word parameter is required' });
    }

    const examples = await findByWord(word);

    if (!examples || examples.length === 0) {
      return res.status(404).json({ error: `No examples found for word: "${word}"` });
    }

    return res.json(examples);
  } catch (error: any) {
    console.error('Error in GET /word-index/examples/:word:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /word-index/word/:word - Get all video examples for a specific word (detailed format)
router.get('/word/:word', async (req: Request, res: Response<WordQueryResponse | ErrorResponse>) => {
  try {
    const { word } = req.params;

    if (!word) {
      return res.status(400).json({ error: 'Word parameter is required' });
    }

    const examples = await findByWord(word);

    if (!examples || examples.length === 0) {
      return res.status(404).json({ error: `No examples found for word: "${word}"` });
    }

    return res.json({
      word: word.toLowerCase(),
      examples,
      count: examples.length
    });
  } catch (error: any) {
    console.error('Error in GET /word-index/:word:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /word-index/stats - Get word index statistics
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getWordIndexStats();
    return res.json(stats);
  } catch (error: any) {
    console.error('Error in GET /word-index/stats:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// GET /word-index/words - Get list of all indexed words (paginated)
router.get('/words', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    const words = await getAllWords(limit, offset);

    return res.json({
      words,
      limit,
      offset,
      count: words.length
    });
  } catch (error: any) {
    console.error('Error in GET /word-index/words:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export default router;
